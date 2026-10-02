import { describe, expect, test } from 'claude-code/testing'
import type { ConfigRow, SessionMessage } from 'claude-code'
import { billingFrom, billingRow, BILLING_OPTIONS } from '../src/billing'
import { DEFAULTS, limitFor, readConfig } from '../src/config'
import { admit } from '../src/toasts'
import { collectFromMessages, collectFromTranscript, parseJsonl } from '../src/transcript'
import { alertStep, isAlertDue } from '../src/alerts'
import { cacheView, inferTtl, latestWriteTtl, parseTtl, ttlContradicts } from '../src/cache'
import { familyOf, rebuildUsd } from '../src/prices'
import { fmtDuration, fmtTokens, formatStatus } from '../src/status'
import { fiveHour, trackWindow } from '../src/window'
import { appendJunk, countLines, isAllowlisted, isAlreadyFiltered, isWholeTextRead, JUNK_LOG_MAX, outputPath, parseGlobs, trimOutput } from '../src/junk'
import { budgetConfig, isBudgetMode, monthStepsDue } from '../src/budget'
import { addSpend, calibrate, costDelta, LEDGER_DAYS, monthToDate, projectMonth } from '../src/ledger'
import { hogsOver, hogTarget, tallyHog, topHogs } from '../src/hogs'
import { handoffModelLine, isEffortCacheSafe, startAdvice, switchNote } from '../src/advisor'
import { backgroundSource, backgroundToast } from '../src/background'
import { fullSections, handoffFileName, handoffMarkdown, handoffTopic, newestUnread } from '../src/handoff'
import { avoidedRebuild, PING_LEAD_MS, pingUsd, pingVerdict } from '../src/keepwarm'
import { coldDropReason, coldQuestion, isColdAskDue } from '../src/cold'
import { planSpawn, REPORT_CAP, runningCount, turnUsd } from '../src/agents'
import { keptTail, lastAnswer, lastError, parseNumstat, planCompaction, snapshotText, summaryInstructions } from '../src/snapshot'

describe('config', () => {
  test('empty options read as the defaults, billing unset', () => {
    expect(readConfig({})).toEqual(DEFAULTS)
    expect(readConfig({ billing: 'ask' }).billing).toBeUndefined()
  })

  test('bad values fall back; steps and limits must be positive', () => {
    const c = readConfig({ billing: 'window', sessionAlertUsd: 0, limitHaiku: -1, coldMinTokens: 0, junkGuard: 'loud', keepWarm: 'yes' })
    expect(c.billing).toBe('window')
    expect(c.sessionAlertUsd).toBe(5)
    expect(c.limitHaiku).toBe(120_000)
    expect(c.coldMinTokens).toBe(0)
    expect(c.junkGuard).toBe('observe')
    expect(c.keepWarm).toBe(false) // off until Q2 is confirmed
  })

  test('the subagent allowlist is a comma list', () => {
    expect(readConfig({ subagentAllowlist: ' Plan, code-reviewer ,,' }).subagentAllowlist).toEqual(['Plan', 'code-reviewer'])
  })

  test('limits per model family', () => {
    expect(limitFor('claude-haiku-4-5-20251001', DEFAULTS)).toBe(120_000)
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) expect(limitFor(model, DEFAULTS)).toBe(300_000)
  })
})

describe('toast budget (R9)', () => {
  const MIN = 60_000

  test('three per hour; a slot frees an hour after its toast', () => {
    let times: number[] = []
    const shown = [0, 1, 2, 3].map(i => {
      const v = admit(times, i * MIN, 'spend')
      times = v.times
      return v.isShown
    })
    expect(shown).toEqual([true, true, true, false])
    expect(admit(times, 60 * MIN, 'spend').isShown).toBe(true)
  })

  test('lower priorities leave room for the spend alert', () => {
    const one = admit([], 0, 'advisor')
    expect(one.isShown).toBe(true)
    expect(admit(one.times, MIN, 'advisor').isShown).toBe(false)
    const two = admit(one.times, MIN, 'cold')
    expect(two.isShown).toBe(true)
    expect(admit(two.times, 2 * MIN, 'cold').isShown).toBe(false)
    expect(admit(two.times, 2 * MIN, 'spend').isShown).toBe(true)
  })
})

describe('billing answers', () => {
  test('choices map to a mode; anything else is unset', () => {
    expect(billingFrom(BILLING_OPTIONS[0])).toBe('metered')
    expect(billingFrom(BILLING_OPTIONS[1])).toBe('window')
    expect(billingFrom('Not now')).toBeUndefined()
    expect(billingFrom('metered please')).toBeUndefined()
    expect(billingFrom(undefined)).toBeUndefined()
  })

  test("the row is this plugin's own, by whatever name the load gave it", () => {
    const row = (key: string, plugin: string) => ({ key, provider: { plugin } }) as unknown as ConfigRow
    const rows = [row('other.billing', 'other'), row('ccwarden@inline.billing', 'ccwarden@inline')]
    expect(billingRow(rows, 'ccwarden@inline')?.key).toBe('ccwarden@inline.billing')
    expect(billingRow(rows, 'ccwarden')).toBeUndefined()
  })
})

describe('transcript facts', () => {
  const line = (o: unknown) => JSON.stringify(o)
  const user = (content: unknown, extra = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra })
  const tool = (id: string, name: string, input: unknown) =>
    line({ type: 'assistant', message: { id, content: [{ type: 'tool_use', name, input }] } })
  const TODOS = [
    { content: 'Reproduce timeout', status: 'completed' },
    { content: 'Add retry to refresh call', status: 'in_progress' },
  ]
  // The hooks edition's fixture (hooks-edition/test/ccwarden.test.js).
  const JSONL = [
    user('Fix the login timeout bug in the auth service'),
    user('<command-name>/model</command-name>'),
    user('Caveat: local command output', { isMeta: true }),
    tool('a1', 'Edit', { file_path: '/p/src/auth.ts' }),
    user([{ type: 'tool_result', content: 'ok' }]),
    tool('a2', 'TodoWrite', { todos: TODOS }),
    user('This session is being continued... summary', { isCompactSummary: true }),
    user('also keep the old cookie name for backwards compat'),
    tool('a3', 'Write', { file_path: '/p/test/auth.test.ts' }),
    tool('a4', 'Edit', { file_path: '/p/src/auth.ts' }),
    user([{ type: 'text', text: 'see screenshot, the spinner never stops' }, { type: 'image', source: {} }]),
    line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'skip the docs change', humanTurn: true } }),
    line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'from a hook', origin: { kind: 'hook' } } }),
    line({ type: 'attachment', attachment: { type: 'total_tokens_reminder' } }),
    user('subagent chatter', { isSidechain: true }),
    '{"truncated',
  ].join('\n')

  test('from the JSONL: verbatim asks incl. queued ones, files most recent first, latest todos', () => {
    const facts = collectFromTranscript(parseJsonl(JSONL))
    expect(facts.asks).toEqual([
      'Fix the login timeout bug in the auth service',
      'also keep the old cookie name for backwards compat',
      'see screenshot, the spinner never stops',
      'skip the docs change',
    ])
    expect(facts.files).toEqual(['/p/src/auth.ts', '/p/test/auth.test.ts'])
    expect(facts.todos).toEqual(TODOS)
  })

  test('from $.session.messages(): the same facts where they are present', () => {
    const msg = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
      ({ role, text, toolUses: [], ...extra })
    const use = (tool: string, input: Record<string, unknown>) => ({ tool_use_id: tool, tool, input })
    const facts = collectFromMessages([
      msg('user', 'Fix the login timeout bug'),
      msg('user', 'Fix the login timeout bug'),
      msg('assistant', '', { toolUses: [use('Edit', { file_path: '/p/a.ts' }), use('TodoWrite', { todos: TODOS })] }),
      msg('user', 'ok', { toolResults: [{ tool_use_id: 'Edit', text: 'ok' }] as never }),
      msg('user', '<command-name>/model</command-name>'),
      msg('assistant', '', { toolUses: [use('NotebookEdit', { notebook_path: '/p/n.ipynb' })] }),
      msg('user', 'now the tests'),
    ])
    expect(facts.asks).toEqual(['Fix the login timeout bug', 'now the tests'])
    expect(facts.files).toEqual(['/p/n.ipynb', '/p/a.ts'])
    expect(facts.todos).toEqual(TODOS)
  })
})

describe('T2 pure logic', () => {
  const MIN = 60_000

  const cents = (n: number | undefined) => (n === undefined ? n : Math.round(n * 100) / 100)

  test('prices: family and rebuild cost at the TTL write rate', () => {
    expect(familyOf('claude-opus-5-5')).toBe('opus')
    expect(familyOf('Sonnet')).toBe('sonnet')
    expect(familyOf('gpt')).toBeUndefined()
    // SPEC §3: re-caching 300K ≈ $3.75 on Fable 5.1, $1.50 Opus 5.5, $0.75 Sonnet at the 5m rate
    expect(cents(rebuildUsd(300_000, 'claude-fable-5-1', '5m'))).toBe(3.75)
    expect(cents(rebuildUsd(300_000, 'claude-opus-5-5', '5m'))).toBe(1.5)
    expect(cents(rebuildUsd(300_000, 'claude-sonnet-5-5', '5m'))).toBe(0.75)
    expect(cents(rebuildUsd(300_000, 'claude-sonnet-5-5', '1h'))).toBe(1.2)
    expect(rebuildUsd(1, 'mystery', '5m')).toBeUndefined()
  })

  test('cache: TTL sources in order, warm and cold', () => {
    expect(inferTtl({ observed: '1h', override: '5m', billing: 'metered' })).toEqual({ ttl: '1h', source: 'observed' })
    expect(inferTtl({ override: '1h', billing: 'metered' })).toEqual({ ttl: '1h', source: 'override' })
    expect(inferTtl({ billing: 'window' }).ttl).toBe('1h')
    expect(inferTtl({ billing: undefined }).ttl).toBe('5m')
    expect(parseTtl('1h')).toBe('1h')
    expect(parseTtl('60m')).toBeUndefined()

    expect(cacheView(undefined, '5m', 0)).toEqual({ kind: 'none' })
    expect(cacheView(0, '5m', 2 * MIN)).toEqual({ kind: 'warm', msLeft: 3 * MIN })
    expect(cacheView(0, '5m', 7 * MIN)).toEqual({ kind: 'cold', msCold: 2 * MIN })

    expect(ttlContradicts('metered', '1h', undefined)).toBe(true)
    expect(ttlContradicts('metered', '1h', '1h')).toBe(false)
    expect(ttlContradicts('window', '5m', undefined)).toBe(true)
    expect(ttlContradicts(undefined, '5m', undefined)).toBe(false)
  })

  test('cache: the latest main-loop write in the transcript decides', () => {
    const row = (w5m: number, w1h: number, extra = {}) =>
      ({ type: 'assistant', message: { usage: { cache_creation: { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h } } }, ...extra })
    expect(latestWriteTtl([row(10, 0), row(0, 10)])).toBe('1h')
    expect(latestWriteTtl([row(0, 10), row(10, 0), row(0, 0)])).toBe('5m') // a pure read writes nothing
    expect(latestWriteTtl([row(10, 0), row(0, 10, { isSidechain: true })])).toBe('5m')
    expect(latestWriteTtl([])).toBeUndefined()
  })

  test('window: the share since the baseline, across a reset', () => {
    const at = (percentUsed: number, resetsAt = 'A') => ({ kind: 'five_hour', percentUsed, resetsAt })
    let t = trackWindow(undefined, at(50))
    expect(t.chatPct).toBe(0)
    t = trackWindow(t, at(58.5))
    expect(t.chatPct).toBe(8.5)
    t = trackWindow(t, at(4, 'B')) // the window reset: 4% since
    expect(t.chatPct).toBe(12.5)
    t = trackWindow(t, at(3, 'B')) // never negative
    expect(t.chatPct).toBe(15.5)
    expect(fiveHour([{ kind: 'seven_day', percentUsed: 1 }, at(2)])?.percentUsed).toBe(2)
  })

  test('alerts: the step in the billing unit, and repeats', () => {
    const metered = readConfig({ billing: 'metered' })
    const window = readConfig({ billing: 'window' })
    expect(alertStep(metered, { usd: 10.2, chatPct: 90 })).toBe(2)
    expect(alertStep(window, { usd: 10.2, chatPct: 41 })).toBe(2)
    expect(alertStep(window, { usd: 10.2 })).toBe(0)
    expect(isAlertDue(1, 0, false)).toBe(true)
    expect(isAlertDue(2, 1, false)).toBe(false)
    expect(isAlertDue(2, 1, true)).toBe(true)
    expect(isAlertDue(1, 1, true)).toBe(false)
  })

  test('status: durations and token counts', () => {
    expect(fmtDuration(30_000)).toBe('1m')
    expect(fmtDuration(0)).toBe('<1m')
    expect(fmtDuration(101 * MIN)).toBe('1h 41m')
    expect(fmtTokens(262_400)).toBe('262k')
    expect(fmtTokens(1_200_000)).toBe('1.2M')
    expect(formatStatus({
      billing: 'metered', model: 'claude-fable-5-1', tokens: 262_000, limit: 300_000, ttl: '5m',
      cache: { kind: 'cold', msCold: 12 * MIN }, rebuildUsd: 3.3, usd: 5.12, now: 0, isAlerted: true,
    })).toBe('Fable · ctx 262k/300k · cache ○ cold 12m (rebuild ≈ $3.30) · this chat $5.12 ⚠')
    expect(formatStatus({
      billing: 'window', model: 'opus', limit: 300_000, ttl: '1h', cache: { kind: 'none' }, usd: 1, now: 0, isAlerted: false,
    })).toBe('Opus · ctx –/300k · cache – · this chat $1.00') // no 5h reading yet: falls back to $
  })
})

describe('T3 snapshot', () => {
  const msg = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
    ({ role, text, toolUses: [], handle: `h-${role}-${text}`, ...extra })

  test('plan: snapshot by default, summary for a focus or summary mode, veto precompute', () => {
    expect(planCompaction({ trigger: 'auto' }, 'snapshot')).toBe('snapshot')
    expect(planCompaction({ trigger: 'plugin' }, 'snapshot')).toBe('snapshot')
    expect(planCompaction({ trigger: 'manual' }, 'snapshot')).toBe('snapshot')
    expect(planCompaction({ trigger: 'manual', instructions: '  ' }, 'snapshot')).toBe('snapshot')
    expect(planCompaction({ trigger: 'manual', instructions: 'auth' }, 'snapshot')).toBe('summary+facts')
    expect(planCompaction({ trigger: 'precompute' }, 'snapshot')).toBe('skip')
    expect(planCompaction({ trigger: 'precompute' }, 'summary')).toBe('pass')
    expect(planCompaction({ trigger: 'auto' }, 'summary')).toBe('summary+facts')
    expect(planCompaction({ trigger: 'auto', agentId: 'a' }, 'snapshot')).toBe('pass')
  })

  test('tail: two turns when they fit, else one, else none; never a turn missing a handle', () => {
    const big = 'x'.repeat(1_000)
    const messages = [msg('user', 'one'), msg('assistant', big), msg('user', 'two'), msg('assistant', big), msg('user', 'three'), msg('assistant', 'ok')]
    expect(keptTail(messages, 10_000)).toEqual({ tail: messages.slice(2), turns: 2 })
    expect(keptTail(messages, 500)).toEqual({ tail: messages.slice(4), turns: 1 })
    expect(keptTail(messages, 5)).toEqual({ tail: [], turns: 0 })
    const unhandled = [...messages.slice(0, 5), { ...messages[5]!, handle: undefined }]
    expect(keptTail(unhandled, 10_000).turns).toBe(0)
    // tool results and wrappers don't start a turn
    const withTools = [msg('user', 'go'), msg('assistant', ''), msg('user', '', { toolResults: [{ tool_use_id: 't', text: 'r' }] as never }), msg('user', '<command-name>/model</command-name>')]
    expect(keptTail(withTools, 10_000)).toEqual({ tail: withTools, turns: 1 })
  })

  test('the last error and answer', () => {
    const fail = { tool_use_id: 'b', tool: 'Bash', input: {}, text: 'exit 1', isError: true as const }
    const messages = [msg('assistant', 'first', { toolUses: [fail] }), msg('assistant', 'second'), msg('assistant', '  ')]
    expect(lastError(messages)).toBe('Bash: exit 1')
    expect(lastAnswer(messages)).toBe('second')
    expect(lastError([msg('assistant', 'fine')])).toBeUndefined()
  })

  test('numstat: counts per path, binary as 0', () => {
    const stats = parseNumstat('12\t3\tsrc/a.ts\n-\t-\timg.png\n\n')
    expect(stats.get('src/a.ts')).toEqual({ added: 12, removed: 3 })
    expect(stats.get('img.png')).toEqual({ added: 0, removed: 0 })
    expect(stats.size).toBe(2)
  })

  test('text: sections, relative paths with diff stat, capped length', () => {
    const facts = {
      asks: ['Fix login', 'keep cookie', 'fix test'],
      todos: [{ content: 'done', status: 'completed' }, { content: 'retry', status: 'in_progress' }],
      files: ['/p/src/a.ts', '/elsewhere/b.ts'],
      diff: parseNumstat('12\t3\tsrc/a.ts\n'),
      branch: 'main',
      lastAnswer: 'All green.',
    }
    const text = snapshotText(facts, { cwd: '/p', keptTurns: 0 })
    expect(text).toContain('No earlier turns were kept.')
    expect(text).toContain('## Goal (first request)\nFix login')
    expect(text).toContain('1. keep cookie\n2. fix test')
    expect(text).toContain('- [in_progress] retry')
    expect(text).not.toContain('[completed]')
    expect(text).toContain('- src/a.ts (+12 -3)\n- /elsewhere/b.ts')
    expect(text).toContain('## Your last answer\nAll green.')
    expect(snapshotText(facts, { cwd: '/p', keptTurns: 2 })).not.toContain('## Your last answer')
    expect(snapshotText({ ...facts, asks: ['y'.repeat(50_000)] }, { keptTurns: 1, maxChars: 800 }).length).toBeLessThanOrEqual(800)
    expect(snapshotText({ ...facts, goal: 'Original goal' }, { keptTurns: 1 })).toContain('## Goal (first request)\nOriginal goal')
  })

  test('summary instructions keep the focus and add the facts', () => {
    expect(summaryInstructions('auth', 'FACTS')).toBe('auth\n\nKeep these facts from the session verbatim in the summary:\nFACTS')
    expect(summaryInstructions(undefined, 'FACTS')).toBe('Keep these facts from the session verbatim in the summary:\nFACTS')
  })
})

describe('T4 subagents', () => {
  const config = readConfig({ subagentAllowlist: 'Plan' })
  const facts = { subagentType: 'Explore', prompt: 'go', fork: false }

  test('plan: deny at the cap, pin the model, keep allowlisted and forks', () => {
    expect('deny' in planSpawn(facts, config, 3)).toBe(true)
    expect(planSpawn(facts, config, 2)).toEqual({ model: 'haiku', prompt: `go${REPORT_CAP}`, notes: ['model haiku', 'report capped at ~300 words'] })
    expect(planSpawn({ ...facts, model: 'sonnet' }, config, 0)).toMatchObject({ model: 'haiku', notes: ['model haiku (asked: sonnet)', 'report capped at ~300 words'] })
    expect(planSpawn({ ...facts, subagentType: 'Plan', model: 'opus' }, config, 0)).toMatchObject({ model: undefined })
    expect(planSpawn({ ...facts, fork: true }, config, 0)).toMatchObject({ model: undefined })
    expect(planSpawn({ ...facts, model: 'haiku' }, config, 0)).toMatchObject({ model: undefined })
  })

  test('cost of a turn at list price', () => {
    const usage = { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 200_000 }
    // Haiku: 0.1 + 0.05 + 0.1 + 0.25
    expect(Math.round((turnUsd({ ...usage, model: 'claude-haiku-4-5' }) ?? 0) * 100) / 100).toBe(0.5)
    expect(turnUsd({ ...usage, model: 'mystery' })).toBeUndefined()
  })

  test('running count', () => {
    expect(runningCount([{ status: 'running' }, { status: 'completed' }, { status: 'running' }, { status: 'killed' }])).toBe(2)
  })
})

describe('T5 cold-cache guard', () => {
  const cold = { kind: 'cold' as const, msCold: 12 * 60_000 }
  test('due: cold, large, and not yet asked for this cold spell', () => {
    const base = { cache: cold, tokens: 60_000, coldMinTokens: 50_000, lastResponseAt: 100, askedFor: undefined }
    expect(isColdAskDue(base)).toBe(true)
    expect(isColdAskDue({ ...base, askedFor: 100 })).toBe(false)
    expect(isColdAskDue({ ...base, askedFor: 50 })).toBe(true) // an earlier cold spell
    expect(isColdAskDue({ ...base, tokens: 40_000 })).toBe(false)
    expect(isColdAskDue({ ...base, tokens: undefined })).toBe(false)
    expect(isColdAskDue({ ...base, cache: { kind: 'warm', msLeft: 1 } })).toBe(false)
  })
  test('texts', () => {
    expect(coldQuestion({ msCold: 12 * 60_000, tokens: 262_000, rebuildUsd: 3.3 })).toContain('re-caches ~262k tokens (≈ $3.30 est.)')
    expect(coldQuestion({ msCold: 60_000, tokens: 1_000 })).not.toContain('$')
    expect(coldDropReason(180_000)).toContain('Your prompt is back in the box')
  })
})

describe('T6 junk guard', () => {
  test('which Reads are checked', () => {
    expect(isWholeTextRead({ file_path: '/a.ts' })).toBe(true)
    expect(isWholeTextRead({ file_path: '/a.ts', limit: 10 })).toBe(false)
    expect(isWholeTextRead({ file_path: '/a.ts', offset: 10 })).toBe(false)
    expect(isWholeTextRead({ file_path: '/a.pdf' })).toBe(false)
    expect(isWholeTextRead({ file_path: '/a.PNG' })).toBe(false)
  })
  test('lines, filtered commands, trimming', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb\nc')).toBe(3)
    expect(isAlreadyFiltered('npm test 2>&1 | tail -40')).toBe(true)
    expect(isAlreadyFiltered('git log | grep fix')).toBe(true)
    expect(isAlreadyFiltered('npm test')).toBe(false)
    expect(isAlreadyFiltered('echo "a|b"')).toBe(false)
    expect(trimOutput('abcdefghij', 20)).toEqual({ head: 'abcdefghij', tail: '', cut: 0 })
    expect(trimOutput('abcdefghij', 5)).toEqual({ head: 'abc', tail: 'ij', cut: 5 })
  })
  test('allowlist globs', () => {
    const globs = parseGlobs(' **/*.lock, docs/**, *.min.js ')
    expect(isAllowlisted('/p/yarn.lock', globs)).toBe(true)
    expect(isAllowlisted('/p/docs/a/b.md', globs)).toBe(true)
    expect(isAllowlisted('C:\\p\\app.min.js', globs)).toBe(true)
    expect(isAllowlisted('/p/src/app.js', globs)).toBe(false)
    expect(parseGlobs('')).toEqual([])
  })
  test('output path and log cap', () => {
    expect(outputPath('/home/u/', 's 1', 'toolu/9')).toBe('/home/u/.claude/ccwarden/outputs/s_1-toolu_9.txt')
    expect(outputPath('C:\\Users\\u', 's', 't')).toBe('C:\\Users\\u\\.claude\\ccwarden\\outputs\\s-t.txt')
    const ev = { at: 0, tool: 'Read' as const, mode: 'observe' as const, target: 'x', size: 1, savedChars: 1 }
    let log = appendJunk(undefined, ev)
    for (let i = 0; i < JUNK_LOG_MAX + 5; i++) log = appendJunk(log, { ...ev, at: i })
    expect(log).toHaveLength(JUNK_LOG_MAX)
    expect(log.at(-1)!.at).toBe(JUNK_LOG_MAX + 4)
  })
})

describe('T7 keep-warm', () => {
  const MIN = 60_000
  const base = {
    keepWarm: true, billing: 'metered' as const, isAttached: true, isTurnRunning: false, now: 10 * MIN,
    lastPromptAt: 6 * MIN, expiresAt: 10 * MIN + 30_000, maxMin: 30, spentUsd: 0, capUsd: 0.5, tokens: 150_000, model: 'claude-sonnet-5-5',
  }
  test('due only when every condition holds', () => {
    expect(pingVerdict(base)).toEqual({ isDue: true })
    const why = (over: Partial<typeof base> | Record<string, unknown>) => {
      const v = pingVerdict({ ...base, ...over })
      return v.isDue ? 'due' : v.why
    }
    expect(why({ keepWarm: false })).toBe('off')
    expect(why({ billing: 'window' })).toBe('off')
    expect(why({ isAttached: false })).toBe('no client attached')
    expect(why({ isTurnRunning: true })).toBe('a turn is running')
    expect(why({ lastPromptAt: undefined })).toBe('no prompt within keepWarmMaxMin')
    expect(why({ lastPromptAt: -21 * MIN })).toBe('no prompt within keepWarmMaxMin')
    expect(why({ expiresAt: 9 * MIN })).toBe('cache already cold')
    expect(why({ expiresAt: 10 * MIN + PING_LEAD_MS + 1 })).toBe('not yet')
    expect(why({ tokens: 0 })).toBe("a rebuild wouldn't cost more")
    expect(why({ spentUsd: 0.49 })).toBe('keepWarmCapUsd reached')
  })
  test('a ping costs a cache read; SPEC F6 example: Sonnet 150K ≈ $0.03', () => {
    expect(Math.round((pingUsd(150_000, 'claude-sonnet-5-5') ?? 0) * 100) / 100).toBe(0.03)
  })
  test('a rebuild is counted as avoided only when the ping made the difference', () => {
    const f = { now: 8 * MIN, lastResponseAt: 0, keepWarmAt: 4.5 * MIN, ttlMs: 5 * MIN, rebuildUsd: 0.38 }
    expect(avoidedRebuild(f)).toBe(0.38)
    expect(avoidedRebuild({ ...f, now: 3 * MIN })).toBe(0) // warm anyway
    expect(avoidedRebuild({ ...f, now: 12 * MIN })).toBe(0) // cold despite the ping
    expect(avoidedRebuild({ ...f, keepWarmAt: undefined })).toBe(0)
  })
})

describe('M2 F7 handoff', () => {
  test('topic and file name', () => {
    expect(handoffTopic('Fix the login timeout bug in the auth service, please!')).toBe('fix-the-login-timeout-bug-in')
    expect(handoffTopic('   ')).toBe('session')
    expect(handoffTopic(undefined)).toBe('session')
    expect(handoffTopic('ठीक करो')).toBe('session')
    expect(handoffFileName(Date.parse('2026-10-02T07:46:38Z'), 'x')).toBe('2026-10-02-0746-x.md')
  })
  test('the newest name not yet offered', () => {
    const names = ['2026-10-01-0900-a.md', '2026-10-02-0746-b.md', 'README.md', '2026-10-02-0746-b.md.bak']
    expect(newestUnread(names, [])).toBe('2026-10-02-0746-b.md')
    expect(newestUnread(names, ['2026-10-02-0746-b.md'])).toBe('2026-10-01-0900-a.md')
    expect(newestUnread(names, ['2026-10-02-0746-b.md', '2026-10-01-0900-a.md'])).toBeUndefined()
  })
  test('full sections: from the first heading, or nothing', () => {
    expect(fullSections('Here:\n## Decisions and why\nx\n## Next step\ny')).toBe('## Decisions and why\nx\n## Next step\ny')
    expect(fullSections('## Decisions and why only')).toBeUndefined()
  })
  test('the note: verbatim asks on one line, open todos, files with diff stat, last error', () => {
    const md = handoffMarkdown({
      asks: ['Fix login', 'keep\nthe cookie'], todos: [{ content: 'retry', status: 'in_progress' }, { content: 'done', status: 'completed' }],
      files: ['/p/src/a.ts'], diff: new Map([['src/a.ts', { added: 3, removed: 1 }]]), lastError: 'Bash: exit 1',
      model: 'opus', writtenAt: 0,
    }, { cwd: '/p' })
    expect(md).toContain('## Goal\nFix login')
    expect(md).toContain('1. keep ⏎ the cookie')
    expect(md).toContain('- [ ] retry (in progress)')
    expect(md).not.toContain('done')
    expect(md).toContain('- `src/a.ts` (+3 -1)')
    expect(md).toContain('## Last error\n```\nBash: exit 1\n```')
    expect(md.match(/quick handoff: run \/handoff/g)).toHaveLength(4)
  })
})

describe('M2 F8 background sources', () => {
  test("the user's own turns are not background", () => {
    for (const kind of ['composer', 'bridge', 'sdk', 'auto-continuation'] as const) expect(backgroundSource({ kind } as never)).toBeUndefined()
  })
  test('each other kind names a source and a way to stop it', () => {
    expect(backgroundSource({ kind: 'scheduled-trigger' } as never)?.kind).toBe('scheduled')
    expect(backgroundSource({ kind: 'peer' } as never)?.stop).toContain('"crossSessionInbound": "hold"')
    expect(backgroundSource({ kind: 'peer-send-message' } as never)?.kind).toBe('peer')
    expect(backgroundSource({ kind: 'channel' } as never)?.kind).toBe('channel')
    expect(backgroundSource({ kind: 'plugin', name: 'x' } as never)).toMatchObject({ kind: 'plugin:x', label: 'the x plugin' })
    expect(backgroundSource({ kind: 'unclassified' } as never)?.stop).toContain('CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0')
    expect(backgroundToast({ kind: 'k', label: 'L', stop: 'S' }, 0.123)).toBe('ccwarden: a turn started by L cost ~$0.12 (est.). To stop these, S.')
  })
})

describe('M2 F9 advisor', () => {
  test('effort is cache-safe on Opus 5.5, Sonnet 5.5 and Fable 5.1 only', () => {
    expect(isEffortCacheSafe('claude-opus-5-5')).toBe(true)
    expect(isEffortCacheSafe('claude-sonnet-5-5')).toBe(true)
    expect(isEffortCacheSafe('claude-fable-5-1')).toBe(true)
    expect(isEffortCacheSafe('claude-haiku-4-5-20251001')).toBe(false)
    expect(isEffortCacheSafe('claude-sonnet-5')).toBe(false)
  })
  test('start advice by family', () => {
    expect(startAdvice('claude-fable-5-1')).toContain('Opus 40%, Sonnet 20%, Haiku 10% of Fable')
    expect(startAdvice('claude-sonnet-5-5')).toContain('Haiku 50% of Sonnet')
    expect(startAdvice('claude-haiku-4-5')).toBeUndefined()
    expect(startAdvice('mystery')).toBeUndefined()
  })
  test('handoff line and switch note', () => {
    expect(handoffModelLine('claude-haiku-4-5')).toBeUndefined()
    expect(handoffModelLine('opus')).toContain('start on haiku')
    expect(switchNote({ toModel: 'h', contextTokens: 100, limit: 200 })).toBeUndefined()
    expect(switchNote({ toModel: 'h', contextTokens: 201_000, limit: 120_000 })).toContain("201k tokens is past h's 120k limit")
  })
})

describe('M3 ledger', () => {
  const at = (iso: string) => Date.parse(iso)
  test('deltas: the rise, or all of it when the total started over', () => {
    expect(costDelta(undefined, 1.5)).toBe(1.5)
    expect(costDelta(1, 1.5)).toBe(0.5)
    expect(costDelta(3, 0.2)).toBe(0.2)
  })
  test('days add up, old ones drop', () => {
    let l = addSpend(undefined, '2026-10-01', 1)
    l = addSpend(l, '2026-10-01', 0.5)
    l = addSpend(l, '2026-10-02', 2)
    expect(l.days).toEqual({ '2026-10-01': 1.5, '2026-10-02': 2 })
    for (let i = 0; i < LEDGER_DAYS + 5; i++) l = addSpend(l, `2027-01-${String(i).padStart(3, '0')}`, 1)
    expect(Object.keys(l.days)).toHaveLength(LEDGER_DAYS)
  })
  test('month to date, and after a /cw spent calibration', () => {
    let l = addSpend(addSpend(undefined, '2026-09-30', 50), '2026-10-01', 10)
    expect(monthToDate(l, at('2026-10-02T00:00:00Z'))).toBe(10)
    l = calibrate(l, 42, at('2026-10-02T00:00:00Z')) // the real figure was higher (other surfaces)
    l = addSpend(l, '2026-10-02', 3)
    expect(monthToDate(l, at('2026-10-02T12:00:00Z'))).toBe(45)
    expect(monthToDate(l, at('2026-11-01T12:00:00Z'))).toBe(0) // a new month: the calibration no longer applies
  })
  test('projection at this pace', () => {
    expect(projectMonth(10, at('2026-10-11T00:00:00Z'))).toBe(31) // 10 days in, 31-day month
    expect(projectMonth(5, at('2026-10-01T06:00:00Z'))).toBe(5) // too early to project
  })
})

describe('M3 hogs', () => {
  test('target, top list, tallies over days', () => {
    expect(hogTarget({ file_path: '/a.ts', command: 'x' })).toBe('/a.ts')
    expect(hogTarget({ command: 'y'.repeat(200) })).toHaveLength(120)
    expect(hogTarget({})).toBe('')
    const hog = (tokens: number) => ({ tool: 'Read', target: `/f${tokens}`, tokens })
    expect(topHogs([hog(5), hog(9)], hog(7), 2).map(h => h.tokens)).toEqual([9, 7])
    let days = tallyHog(undefined, '2026-10-01', hog(5))
    days = tallyHog(days, '2026-10-01', hog(5))
    days = tallyHog(days, '2026-10-02', hog(3))
    days = tallyHog(days, '2026-09-30', hog(100))
    expect(hogsOver(days, '2026-10')).toEqual([{ tool: 'Read', target: '/f5', tokens: 10 }, { tool: 'Read', target: '/f3', tokens: 3 }])
    expect(hogsOver(days, '', 1)).toEqual([{ tool: 'Read', target: '/f100', tokens: 100 }])
  })
})

describe('M3 budget', () => {
  test('month steps: those reached and not yet sent', () => {
    expect(monthStepsDue(40, 100, [])).toEqual([])
    expect(monthStepsDue(55, 100, [])).toEqual([50])
    expect(monthStepsDue(105, 100, [50])).toEqual([80, 100])
    expect(monthStepsDue(105, 0, [])).toEqual([])
  })
  test('budget mode: by hand, or by the month or the window', () => {
    const base = { manual: 'auto' as const, billing: 'metered' as const, budgetModeAt: 80 }
    expect(isBudgetMode({ ...base, mtd: 79, budget: 100 })).toBe(false)
    expect(isBudgetMode({ ...base, mtd: 80, budget: 100 })).toBe(true)
    expect(isBudgetMode({ ...base, mtd: 80 })).toBe(false) // no budget set
    expect(isBudgetMode({ ...base, billing: 'window', fiveHourPct: 85, mtd: 0, budget: 100 })).toBe(true)
    expect(isBudgetMode({ ...base, manual: 'on' })).toBe(true)
    expect(isBudgetMode({ ...base, manual: 'off', mtd: 99, budget: 100 })).toBe(false)
  })
  test('budget config tightens, never loosens', () => {
    const c = budgetConfig(readConfig({ readMaxLines: 500, sessionAlertPct: 20 }))
    expect(c.readMaxLines).toBe(500)
    expect(c.bashMaxChars).toBe(12_000)
    expect(c.sessionAlertPct).toBe(15)
    expect(c.compactAt).toBe(45)
  })
})
