import { describe, expect, mock, test } from 'claude-code/testing'
import type { ConfigRow, On, RenderSurface, SessionMessage, SessionRateLimit } from 'claude-code'
import { BILLING_OPTIONS, BILLING_QUESTION } from '../src/billing'

const SURFACES = ['terminal', 'desktop'] as const
const BILLINGS = ['metered', 'window'] as const
const MIN = 60_000

type Usage = { tokens?: number; window: number; usd: number; rateLimits: SessionRateLimit[] }

// Stands in for the engine beneath the mod and keeps what it was asked to
// show. `answer` is what the person picks in $.ui.ask (undefined: dismissed).
// `usage` and `model` are live: a test changes them between events.
function world(on: On, opts: {
  surfaces?: readonly RenderSurface[]
  answer?: string
  usage?: Partial<Usage>
  model?: string
  env?: Record<string, string>
  settings?: Record<string, unknown>
  transcript?: string
  git?: { branch?: string; numstat?: string }
  files?: Record<string, string>
  bashOut?: { stdout: string; persistedOutputPath?: string }
  isWriteRefused?: boolean
} = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, opts.env ?? {})
  const usage: Usage = { window: 1_000_000, usd: 0, rateLimits: [], ...opts.usage }
  const shown = {
    clock,
    usage,
    model: opts.model ?? 'claude-sonnet-5-5',
    toasts: [] as string[],
    status: [] as (string | undefined)[],
    logs: [] as string[],
    asks: [] as string[],
    configSets: [] as { key: string; value: unknown }[],
    // What reached core's session.compact: the plugin passed it on.
    coreCompactions: [] as { trigger: string; instructions?: string; agentId?: string }[],
    commandsRun: [] as string[],
    // $.agent.list(), and what reached core's agent.spawn.
    agents: [] as { id: string; description: string; type: string; status: string }[],
    spawned: [] as { subagentType: string; model?: string; prompt: string }[],
    // Prompts that reached core, and what was put back in the prompt box.
    sent: [] as string[],
    fills: [] as string[],
    // Tool calls that reached core, and files the mod wrote.
    reads: [] as string[],
    writes: [] as { path: string; text: string }[],
  }
  on('ui.toast', (_$, e) => { shown.toasts.push(e.text); return { value: undefined } })
  on('ui.status', (_$, e) => { shown.status.push(e.text); return { value: undefined } })
  on('ui.log', (_$, e) => { if (e.to !== 'debug') shown.logs.push(e.text); return { value: undefined } })
  on('session.surfaces', () => ({ value: opts.surfaces ?? [] }))
  on('session.model', () => ({ value: shown.model }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: usage.tokens, window: usage.window }, rateLimits: usage.rateLimits, cost: { usd: usage.usd } },
  }))
  on('settings.read', () => ({ value: opts.settings ?? {} }))
  const file = (path: string) => opts.files?.[path] ?? opts.transcript
  on('fs.stat', (_$, e) => {
    const text = file(e.path)
    return text === undefined ? Promise.reject(new Error('ENOENT')) : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const text = file(e.path)
    return text === undefined ? Promise.reject(new Error('ENOENT')) : { value: text }
  })
  on('fs.write', (_$, e) => {
    if (opts.isWriteRefused) return Promise.reject(new Error('EACCES'))
    shown.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess1' }))
  on('tool.call', { tool: 'Read' }, (_$, e) => { shown.reads.push(e.file_path); return { result: { type: 'text', file: { filePath: e.file_path, content: '', numLines: 0, startLine: 1, totalLines: 0 } } as never } })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: opts.bashOut?.stdout ?? 'ok', stderr: '', interrupted: false, ...(opts.bashOut?.persistedOutputPath === undefined ? {} : { persistedOutputPath: opts.bashOut.persistedOutputPath }) } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/p' }))
  on('agent.list', () => ({ value: shown.agents }))
  on('prompt.submit', (_$, e) => { shown.sent.push(e.text); return { text: e.text } })
  on('prompt.fill', (_$, e) => { shown.fills.push(e.text); return { isFilled: true } })
  on('agent.spawn', (_$, e) => {
    shown.spawned.push({ subagentType: e.subagentType, model: e.model, prompt: e.prompt })
    shown.agents.push({ id: `a${shown.agents.length + 1}`, description: e.description, type: e.subagentType, status: 'running' })
    return { model: e.model ?? e.parentModel, agentId: `a${shown.agents.length}` }
  })
  on('session.messages', () => ({ value: [] }))
  on('process.run', (_$, e) => {
    const out = e.argv.includes('rev-parse') ? opts.git?.branch : e.argv.includes('--numstat') ? opts.git?.numstat : undefined
    return { value: { exitCode: out === undefined ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.compact', (_$, e) => {
    shown.coreCompactions.push({ trigger: e.trigger, instructions: e.instructions, agentId: e.agentId })
    return { messages: [{ role: 'user', text: 'core summary', toolUses: [] }] }
  })
  // Core's /compact raises a manual compaction; a test plays that part with
  // the engine's $ (see `runCompact`).
  on('command.run', { command: 'compact' }, () => { shown.commandsRun.push('compact'); return {} })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = e.questions[0]!.question
    shown.asks.push(question)
    if (opts.answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [question]: opts.answer } } }
  })
  const row = { key: 'ccwarden.billing', label: 'Billing', kind: 'choice', value: 'ask', options: ['ask', 'metered', 'window'], provider: { plugin: 'ccwarden', tier: 'user' }, isLocked: false }
  on('config.list', () => ({ value: [row as unknown as ConfigRow] }))
  on('config.set', (_$, e) => { shown.configSets.push({ key: e.key, value: e.value }); return { value: e.value } })
  return shown
}

type World = ReturnType<typeof world>

const start = (surface: RenderSurface | null) => ({ cwd: '/p', surface, isInteractive: surface !== null })

// The engine's view after a response: what session.measure carries.
function measure(w: World) {
  const { tokens, window, usd, rateLimits } = w.usage
  return { context: { tokens, window }, rateLimits, cost: { usd }, changed: ['cost' as const, 'context' as const] }
}

const turnDone = (model = 'claude-sonnet-5-5') => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' as const,
  usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, model },
})

const fiveHour = (percentUsed: number, resetsAt = new Date(80 * MIN).toISOString()): SessionRateLimit =>
  ({ kind: 'five_hour', percentUsed, resetsAt })

describe('F1 status line', () => {
  for (const surface of SURFACES) {
    test(`metered: model, ctx against the limit, cache countdown, this chat $ (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], usage: { tokens: 140_000, usd: 1.84 } })
      await $.session.start(start(surface))
      expect(w.status.at(-1)).toBe('Sonnet · ctx 140k/300k · cache – · this chat $1.84')

      await $.turn.complete(turnDone())
      await w.clock.advance(2 * MIN) // the minute tick redraws the countdown
      expect(w.status.at(-1)).toBe('Sonnet · ctx 140k/300k · cache ● 3m · this chat $1.84')

      await w.clock.advance(15 * MIN)
      expect(w.status.at(-1)).toBe('Sonnet · ctx 140k/300k · cache ○ cold 12m (rebuild ≈ $0.35) · this chat $1.84')
    })

    test(`window: this chat's share of the 5h window, 1h cache (${surface})`, { options: { billing: 'window' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], model: 'claude-haiku-4-5-20251001', usage: { tokens: 64_000, window: 200_000, rateLimits: [fiveHour(53)] } })
      await $.session.start(start(surface))
      await $.turn.complete(turnDone('claude-haiku-4-5-20251001'))
      w.usage.rateLimits = [fiveHour(62)]
      await $.session.measure(measure(w))
      expect(w.status.at(-1)).toBe('Haiku · ctx 64k/120k · cache ● 1h 0m · this chat 9% of 5h · 5h 62% (resets 1h 20m)')
    })
  }

  test('the limit is the model window when that is smaller', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 150_000, window: 200_000 } })
    await $.session.start(start('terminal'))
    expect(w.status.at(-1)).toContain('ctx 150k/200k')
  })

  test('a subagent turn leaves the main cache clock alone', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 1_000 } })
    await $.session.start(start('terminal'))
    await $.turn.complete({ ...turnDone(), agentId: 'a1' })
    await w.clock.advance(MIN)
    expect(w.status.at(-1)).toContain('cache –')
  })
})

describe('TTL inference', () => {
  const jsonl = (split: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }) =>
    JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { cache_creation: split } } })

  test('observed in the transcript, with one toast when it contradicts billing', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 1_000 }, transcript: jsonl({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }) })
    await $.classic.SessionStart({ source: 'startup', transcript_path: '/t.jsonl' })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(10 * MIN)
    expect(w.status.at(-1)).toContain('cache ● 50m')
    expect(w.toasts).toEqual(['ccwarden: cache writes use a 1h TTL, but billing is set to metered. Check billing in /config.'])

    await $.turn.complete(turnDone()) // re-read after 10 min: no second toast
    expect(w.toasts).toHaveLength(1)
  })

  test('the documented override wins over billing, and explains a 1h write', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, {
      surfaces: ['terminal'], usage: { tokens: 1_000 }, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' },
      transcript: jsonl({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }),
    })
    await $.classic.SessionStart({ source: 'startup', transcript_path: '/t.jsonl' })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(10 * MIN)
    expect(w.status.at(-1)).toContain('cache ● 50m')
    expect(w.toasts).toEqual([])
  })

  test('the promptCacheTtl setting, with no transcript', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 1_000 }, settings: { promptCacheTtl: '1h' } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(10 * MIN)
    expect(w.status.at(-1)).toContain('cache ● 50m')
  })
})

describe('F1b spend alerts under the toast budget (R9)', () => {
  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`a toast per step, at most 3 an hour (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], usage: { rateLimits: [fiveHour(0)] } })
        await $.session.start(start(surface))

        for (const n of [0.2, 1.02, 2.04, 3.06, 4.08]) {
          w.usage.usd = n * 5
          w.usage.rateLimits = [fiveHour(n * 20)]
          await $.session.measure(measure(w))
        }

        expect(w.toasts).toHaveLength(3)
        expect(w.toasts[0]).toContain(billing === 'window' ? '20.4% of your 5-hour window' : '$5.10')
        expect(w.toasts[0]).toContain('(est.)')
        expect(w.status.at(-1)).toContain('⚠')
        expect(w.asks).toEqual([]) // billing is set: no question
      })
    }

    test(`a reload mid-conversation doesn't alert the same step again (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], usage: { usd: 7 } })
      await $.session.start(start(surface))
      w.usage.usd = 7.5
      await $.session.measure(measure(w))
      expect(w.toasts).toEqual([])
    })
  }

  test('sessionAlertRepeat off: the first step only', { options: { billing: 'metered', sessionAlertRepeat: false } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    for (const usd of [5.5, 10.5, 15.5]) {
      w.usage.usd = usd
      await $.session.measure(measure(w))
    }
    expect(w.toasts).toHaveLength(1)
  })

  test('alertTiming turnEnd holds the toast until the turn ends', { options: { billing: 'metered', alertTiming: 'turnEnd' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    w.usage.usd = 5.5
    await $.session.measure(measure(w))
    expect(w.toasts).toEqual([])
    await $.turn.complete(turnDone())
    expect(w.toasts).toHaveLength(1)
  })

  for (const surface of SURFACES) {
    test(`/clear starts the count over and drops a held alert (${surface})`, { options: { billing: 'metered', alertTiming: 'turnEnd' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface] })
      await $.session.start(start(surface))
      await $.turn.complete(turnDone())
      w.usage.usd = 6
      await $.session.measure(measure(w)) // held for the turn's end

      await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
      w.usage.usd = 0
      await w.clock.advance(0)
      expect(w.status.at(-1)).toBe('Sonnet · ctx –/300k · cache – · this chat $0.00')

      await $.turn.complete(turnDone())
      expect(w.toasts).toEqual([]) // the held alert was the old conversation's

      w.usage.usd = 5.5
      await $.session.measure(measure(w))
      await $.turn.complete(turnDone())
      expect(w.toasts).toHaveLength(1)
    })
  }

  test('/clear on window billing measures the share from the clear', { options: { billing: 'window' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { rateLimits: [fiveHour(10)] } })
    await $.session.start(start('terminal'))
    w.usage.rateLimits = [fiveHour(40)]
    await $.session.measure(measure(w))
    expect(w.toasts).toHaveLength(1)

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    w.usage.rateLimits = [fiveHour(45)]
    await $.session.measure(measure(w))
    expect(w.status.at(-1)).toContain('this chat 5% of 5h')
  })
})

describe('first-run billing question', () => {
  for (const surface of SURFACES) {
    test(`asks once and saves the answer (${surface})`, async ($, on) => {
      const w = world(on, { surfaces: [surface], answer: BILLING_OPTIONS[1] })
      await $.session.start(start(surface))
      await w.clock.advance(0)

      expect(w.asks).toEqual([BILLING_QUESTION])
      expect(w.configSets).toEqual([{ key: 'ccwarden.billing', value: 'window' }])

      await $.session.start(start(surface)) // a reload: not asked again this session
      await w.clock.advance(0)
      expect(w.asks).toHaveLength(1)
    })

    test(`a dismissal saves nothing and says how to set it (${surface})`, async ($, on) => {
      const w = world(on, { surfaces: [surface] })
      await $.session.start(start(surface))
      await w.clock.advance(0)

      expect(w.asks).toHaveLength(1)
      expect(w.configSets).toEqual([])
      expect(w.logs.at(-1)).toContain('/config')
    })
  }

  test('headless: nobody to ask', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start(start(null))
    await w.clock.advance(0)
    expect(w.asks).toEqual([])
  })
})

describe('F3 per-model limits and snapshot compaction', () => {
  const msg = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
    ({ role, text, toolUses: [], handle: `h${handles++}`, ...extra })
  let handles = 0
  const history = (): SessionMessage[] => [
    msg('user', 'Fix the login timeout bug'),
    msg('assistant', 'Looking.', { toolUses: [{ tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/p/src/auth.ts' }, text: 'ok' }] }),
    msg('user', '', { toolResults: [{ tool_use_id: 'e1', text: 'ok' }] as never }),
    msg('assistant', 'Edited auth.ts.'),
    msg('user', 'also keep the old cookie name'),
    msg('assistant', 'Running tests.', { toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'npm test' }, text: '1 failing', isError: true }] }),
    msg('user', '', { toolResults: [{ tool_use_id: 'b1', text: '1 failing' }] as never }),
    msg('assistant', 'One test fails.'),
    msg('user', 'fix that test'),
    msg('assistant', 'Fixed.'),
  ]

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`Haiku compacts past 120k with a snapshot, no summary request (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], model: 'claude-haiku-4-5-20251001', usage: { tokens: 125_000, window: 200_000 } })
        await $.session.start(start(surface))
        await $.turn.complete(turnDone('claude-haiku-4-5-20251001'))
        await w.clock.advance(0)

        expect(w.commandsRun).toEqual(['compact'])
        await $.session.compact({ trigger: 'manual', messages: history() }) // what core's /compact raises
        expect(w.coreCompactions).toEqual([]) // answered in core's place
        expect(w.logs).toContain('ccwarden: 125k tokens is past the 120k limit for claude-haiku-4-5-20251001; compacting.')
        expect(w.logs.at(-1)).toMatch(/^ccwarden: snapshot compaction \(manual\): 10 messages → a \d+-character snapshot \+ 2 turn\(s\) kept; no summary request\.$/)
      })
    }
  }

  test('Sonnet keeps going at 250k and compacts past 300k', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 250_000 } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(0)
    expect(w.commandsRun).toEqual([])

    w.usage.tokens = 301_000
    await $.turn.complete(turnDone())
    await w.clock.advance(0)
    expect(w.commandsRun).toEqual(['compact'])
  })

  test('a model switch applies the new limit from the next turn', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 150_000 } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(0)
    expect(w.commandsRun).toEqual([])

    w.model = 'claude-haiku-4-5-20251001'
    await $.turn.complete(turnDone('claude-haiku-4-5-20251001'))
    await w.clock.advance(0)
    expect(w.commandsRun).toEqual(['compact'])
  })

  test('the snapshot: goal, verbatim asks, files with diff stat, branch, last error, then the last turns by handle', { options: { billing: 'metered' } }, async ($, on) => {
    world(on, { surfaces: ['terminal'], usage: { tokens: 10_000 }, git: { branch: 'fix/login', numstat: '12\t3\tsrc/auth.ts\n' } })
    await $.session.start(start('terminal'))
    const messages = history()

    const out = await $.session.compact({ trigger: 'auto', messages })

    expect(out.skip).toBeUndefined()
    const [snap, ...tail] = out.messages ?? []
    expect(snap!.handle).toBeUndefined()
    expect(snap!.text).toContain('[ccwarden snapshot]')
    expect(snap!.text).toContain('## Goal (first request)\nFix the login timeout bug')
    expect(snap!.text).toContain('1. also keep the old cookie name')
    expect(snap!.text).toContain('- src/auth.ts (+12 -3)')
    expect(snap!.text).toContain('## Branch\nfix/login')
    expect(snap!.text).toContain('## Last error\nBash: 1 failing')
    expect(tail.map(m => m.handle)).toEqual(messages.slice(4).map(m => m.handle)) // the last two turns
  })

  test('the goal survives a second compaction', { options: { billing: 'metered' } }, async ($, on) => {
    world(on, { surfaces: ['terminal'], usage: { tokens: 10_000 } })
    await $.session.start(start('terminal'))
    await $.session.compact({ trigger: 'auto', messages: history() })
    const after = [msg('user', 'now the docs'), msg('assistant', 'Done.')]
    const out = await $.session.compact({ trigger: 'auto', messages: after })
    expect(out.messages?.[0]?.text).toContain('## Goal (first request)\nFix the login timeout bug')
  })

  test('precompute is vetoed in snapshot mode', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    const out = await $.session.compact({ trigger: 'precompute', messages: history() })
    expect(out.skip).toContain('snapshot compaction is on')
    expect(w.coreCompactions).toEqual([])
  })

  test('/compact <focus> keeps the engine summary, with the facts added', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    const out = await $.session.compact({ trigger: 'manual', instructions: 'the auth design', messages: history() })
    expect(out.messages?.[0]?.text).toBe('core summary')
    expect(w.coreCompactions).toHaveLength(1)
    expect(w.coreCompactions[0]!.instructions).toMatch(/^the auth design\n\nKeep these facts from the session verbatim/)
    expect(w.coreCompactions[0]!.instructions).toContain('fix that test')
  })

  test('compactMode summary: every compaction is the engine summary, with the facts', { options: { billing: 'metered', compactMode: 'summary' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    await $.session.compact({ trigger: 'auto', messages: history() })
    await $.session.compact({ trigger: 'precompute', messages: history() })
    expect(w.coreCompactions.map(c => c.trigger)).toEqual(['auto', 'precompute'])
    expect(w.coreCompactions[0]!.instructions).toContain('Keep these facts')
    expect(w.coreCompactions[1]!.instructions).toBeUndefined()
  })

  test("a subagent's compaction passes through untouched", { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: history() })
    expect(w.coreCompactions).toEqual([{ trigger: 'auto', instructions: undefined, agentId: 'a1' }])
  })
})

describe('F5 subagent guard', () => {
  const spawn = (subagentType: string, extra: Record<string, unknown> = {}) => ({
    tool_use_id: `t-${subagentType}`, prompt: 'Find where sessions expire.', description: 'find expiry', subagentType,
    provider: { plugin: 'engine', tier: 'core' } as const, parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra,
  })
  const subTurn = (agentId: string, model = 'claude-haiku-4-5-20251001', input = 1_000_000) => ({
    ...turnDone(model), agentId, usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model },
  })

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`Explore runs on Haiku with a report cap; the 4th parallel spawn is denied (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface] })
        await $.session.start(start(surface))

        for (const n of [1, 2, 3]) expect((await $.agent.spawn(spawn('Explore', { tool_use_id: `t${n}` }))).deny).toBeUndefined()
        expect(w.spawned[0]!.model).toBe('haiku')
        expect(w.spawned[0]!.prompt).toMatch(/^Find where sessions expire\.\n\n\[ccwarden\] Keep your final report to at most ~300 words/)
        expect(w.logs).toContain('ccwarden: Explore subagent: model haiku, report capped at ~300 words.')

        const fourth = await $.agent.spawn(spawn('Explore', { tool_use_id: 't4' }))
        expect(fourth.deny).toBe('ccwarden: 3 subagents are already running (maxParallelAgents is 3). Wait for one to finish, or do this step yourself.')
        expect(w.spawned).toHaveLength(3)

        w.agents[0]!.status = 'completed'
        expect((await $.agent.spawn(spawn('Explore', { tool_use_id: 't5' }))).deny).toBeUndefined()
      })
    }
  }

  test('allowlisted types and forks keep their model; the cap is never doubled', { options: { billing: 'metered', subagentAllowlist: 'Plan' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    await $.agent.spawn(spawn('Plan', { model: 'opus' }))
    await $.agent.spawn(spawn('general-purpose', { fork: true }))
    expect(w.spawned.map(s => s.model)).toEqual(['opus', undefined])
    const capped = w.spawned[0]!.prompt
    await $.agent.spawn(spawn('Explore', { prompt: capped }))
    expect(w.spawned[2]!.prompt).toBe(capped)
  })

  test('subagentGuard off: spawns pass untouched', { options: { billing: 'metered', subagentGuard: false, maxParallelAgents: 0 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    expect((await $.agent.spawn(spawn('Explore'))).deny).toBeUndefined()
    expect(w.spawned[0]).toEqual({ subagentType: 'Explore', model: undefined, prompt: 'Find where sessions expire.' })
  })

  for (const surface of SURFACES) {
    test(`per-agent cost in the status, one toast past $1 (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], usage: { usd: 2 } })
      await $.session.start(start(surface))
      await $.agent.spawn(spawn('Explore'))

      await $.turn.complete(subTurn('a1', 'claude-haiku-4-5-20251001', 400_000)) // $0.40
      expect(w.status.at(-1)).toBe('Sonnet · ctx –/300k · cache – · this chat $2.00 · agents 1 running · $0.40')
      expect(w.toasts).toEqual([])

      await $.turn.complete(subTurn('a1', 'claude-haiku-4-5-20251001', 700_000)) // $1.10 in all
      await $.turn.complete(subTurn('a1', 'claude-haiku-4-5-20251001', 100_000))
      expect(w.toasts).toEqual(['⚠ A subagent (a1) has cost $1.10 so far (est.).'])
      expect(w.status.at(-1)).toContain('agents 1 running · $1.20')
      expect(w.status.at(-1)).toContain('cache –') // the main cache clock didn't move
    })
  }
})

describe('F2 cold-cache guard', () => {
  const typed = (text: string, extra: Record<string, unknown> = {}) => ({ text, wait: false, origin: { kind: 'composer' as const }, ...extra })

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`asks over a cold cache; Cancel keeps the prompt, sending again goes through (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], answer: 'Cancel', usage: { tokens: 180_000 } })
        await $.session.start(start(surface))
        await $.turn.complete(turnDone())
        await w.clock.advance(billing === 'window' ? 65 * MIN : 17 * MIN)

        const out = await $.prompt.submit(typed('continue with the refactor'))
        expect(w.asks).toHaveLength(1)
        expect(w.asks[0]).toBe(billing === 'window'
          ? 'ccwarden: the prompt cache went cold 5m ago, so this prompt re-caches ~180k tokens (≈ $0.72 est.). Unrelated work? /clear first is cheaper. Send it anyway?'
          : 'ccwarden: the prompt cache went cold 12m ago, so this prompt re-caches ~180k tokens (≈ $0.45 est.). Unrelated work? /clear first is cheaper. Send it anyway?')
        expect(out.drop).toContain("~180k tokens weren't re-cached")
        expect(w.sent).toEqual([])
        await w.clock.advance(0)
        expect(w.fills).toEqual(['continue with the refactor'])

        await $.prompt.submit(typed('continue with the refactor'))
        expect(w.asks).toHaveLength(1)
        expect(w.sent).toEqual(['continue with the refactor'])
      })
    }
  }

  test('Continue sends it', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Continue', usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(10 * MIN)
    const out = await $.prompt.submit(typed('go'))
    expect(out.drop).toBeUndefined()
    expect(w.sent).toEqual(['go'])
  })

  test('a dismissed question cancels and keeps the prompt', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(10 * MIN)
    expect((await $.prompt.submit(typed('go'))).drop).toBeDefined()
    await w.clock.advance(0)
    expect(w.fills).toEqual(['go'])
  })

  test('no question: warm cache, small context, mid-turn, a plugin prompt, headless, or before any response', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Cancel', usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await $.prompt.submit(typed('first prompt')) // no response yet: cache –
    await $.turn.complete(turnDone())
    await w.clock.advance(2 * MIN)
    await $.prompt.submit(typed('warm'))
    await w.clock.advance(10 * MIN)
    await $.prompt.submit(typed('mid-turn', { turnId: 't1' }))
    await $.prompt.submit(typed('from a plugin', { origin: { kind: 'plugin', name: 'x' } }))
    w.usage.tokens = 20_000
    await $.prompt.submit(typed('small'))
    expect(w.asks).toEqual([])
    expect(w.sent).toEqual(['first prompt', 'warm', 'mid-turn', 'from a plugin', 'small'])
  })
})

describe('F4 junk guard', () => {
  const LONG = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join('\n')
  const SHORT = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
  const BIG = 'x'.repeat(50_000)
  const files = { '/p/big.log': LONG, '/p/small.ts': SHORT, '/p/yarn.lock': LONG }

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`observe (the default): nothing changes, every would-be action is logged (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], files, bashOut: { stdout: BIG }, env: { HOME: '/home/u' } })
        await $.session.start(start(surface))

        expect((await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })).deny).toBeUndefined()
        const bash = await $.tool.call({ tool: 'Bash', command: 'cat big.log' })
        expect((bash.result as { stdout: string }).stdout).toBe(BIG)
        expect(w.reads).toEqual(['/p/big.log'])
        expect(w.writes).toEqual([])

        await $.command.run({ command: 'ccwarden-junk', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
        expect(w.logs.find(l => l.startsWith('ccwarden junk guard (observe): 2 events'))).toBeDefined()
        expect(w.logs.filter(l => / observe (Read 3000 lines|Bash 50000 chars): /.test(l))).toHaveLength(2)
      })
    }

    test(`enforce: a long whole-file Read is denied with a pointer to Grep (${surface})`, { options: { billing: 'metered', junkGuard: 'enforce', junkAllowlist: '**/*.lock' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files })
      await $.session.start(start(surface))

      const denied = await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })
      expect(denied.deny).toBe('ccwarden junk guard: /p/big.log has 3000 lines (more than 2000), so reading it whole would put all of it in the context. Use Grep to find what you need in it, or Read it with offset and limit.')

      await $.tool.call({ tool: 'Read', file_path: '/p/big.log', offset: 1, limit: 100 })
      await $.tool.call({ tool: 'Read', file_path: '/p/small.ts' })
      await $.tool.call({ tool: 'Read', file_path: '/p/yarn.lock' })
      await $.tool.call({ tool: 'Read', file_path: '/p/missing.ts' })
      expect(w.reads).toEqual(['/p/big.log', '/p/small.ts', '/p/yarn.lock', '/p/missing.ts'])
    })

    test(`enforce: long Bash output is cut to head + tail, the full text saved (${surface})`, { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
      const out = 'a'.repeat(30_000) + 'b'.repeat(20_000)
      const w = world(on, { surfaces: [surface], bashOut: { stdout: out }, env: { HOME: '/home/u' } })
      await $.session.start(start(surface))

      const ran = await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu1' })
      const stdout = (ran.result as { stdout: string }).stdout
      expect(w.writes).toEqual([{ path: '/home/u/.claude/ccwarden/outputs/sess1-tu1.txt', text: out }])
      expect(stdout.startsWith('a'.repeat(18_000) + '\n\n[ccwarden junk guard: 20000 characters cut')).toBe(true)
      expect(stdout).toContain('The full output is in /home/u/.claude/ccwarden/outputs/sess1-tu1.txt: use Grep on that file')
      expect(stdout.endsWith('b'.repeat(12_000))).toBe(true)
    })
  }

  test('enforce leaves alone: filtered commands, engine-persisted output, short output, an unsaved file', { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], bashOut: { stdout: BIG }, env: { HOME: '/home/u' }, isWriteRefused: true })
    await $.session.start(start('terminal'))
    for (const command of ['cat big.log | head -50', 'cat big.log']) {
      expect(((await $.tool.call({ tool: 'Bash', command })).result as { stdout: string }).stdout).toBe(BIG)
    }
    expect(w.writes).toEqual([])
  })

  test('engine-persisted output is the engine\'s business', { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], bashOut: { stdout: BIG, persistedOutputPath: '/tmp/x' }, env: { HOME: '/home/u' } })
    await $.session.start(start('terminal'))
    expect(((await $.tool.call({ tool: 'Bash', command: 'cat big.log' })).result as { stdout: string }).stdout).toBe(BIG)
    expect(w.writes).toEqual([])
  })

  test('off: no checks at all', { options: { billing: 'metered', junkGuard: 'off' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], files, bashOut: { stdout: BIG }, env: { HOME: '/home/u' } })
    await $.session.start(start('terminal'))
    expect((await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })).deny).toBeUndefined()
    await $.tool.call({ tool: 'Bash', command: 'cat big.log' })
    await $.command.run({ command: 'ccwarden-junk', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(w.logs.find(l => l.startsWith('ccwarden junk guard (off): 0 events'))).toBeDefined()
  })
})
