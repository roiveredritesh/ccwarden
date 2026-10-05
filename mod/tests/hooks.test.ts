import { describe, expect, mock, test as engineTest } from 'claude-code/testing'
import type { Engine, TestBody, TestOptions } from 'claude-code/testing'
import type { ConfigRow, On, RenderSurface, SessionMessage, SessionRateLimit } from 'claude-code'
import { BILLING_OPTIONS, BILLING_QUESTION } from '../src/billing'
import { parseFile } from '../src/metrics'

// F16: the warden's band replaces the status line and spend toasts on the terminal and desktop. The tests written
// before it check those, so they run with it off; a test that wants it says `warden: true`.
const test = (name: string, ...rest: readonly [TestBody] | readonly [TestOptions, TestBody]): void => rest.length === 1
  ? engineTest(name, { options: { warden: false } }, rest[0])
  : engineTest(name, { ...rest[0], options: { warden: false, ...rest[0].options } }, rest[1])

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
  bashError?: string
  isWriteRefused?: boolean
  /** Files that exist (stat answers) but can't be read, as under a Windows lock. */
  unreadable?: string[]
  store?: Record<string, unknown>
  mtimes?: Record<string, number>
  sessionId?: string
  /** What `uname -s` prints (the browser opener's OS check); Linux when unset. */
  uname?: string
} = {}) {
  const clock = mock.clock(on)
  // $.store in memory, readable by the test (mock.store's isn't).
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => { store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('store.delete', (_$, e) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  // $.env in memory, so a test reads what the mod set.
  const env = new Map<string, string>(Object.entries(opts.env ?? {}))
  on('env.get', (_$, e) => ({ value: env.get(e.name) }))
  on('env.set', (_$, e) => { if (e.value === undefined) env.delete(e.name); else env.set(e.name, e.value); return { value: undefined } })
  const usage: Usage = { window: 1_000_000, usd: 0, rateLimits: [], ...opts.usage }
  const shown = {
    clock,
    store,
    env,
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
    // Panes opened, text copied.
    opened: [] as string[],
    copied: [] as { text: string; surface?: string }[],
    // Keep-warm forks, and how much of the cache each read.
    forks: [] as string[],
    /** Every $.fs.read path, in order. */
    fsReads: [] as string[],
    forkCacheRead: 180_000,
    // Commands $.process.run was asked to run, and the exit code a browser opener gets.
    runs: [] as string[][],
    openerExit: 0,
    // F15: refuse $.fs.write from now on (a test flips it).
    refuseWrites: false,
    messages: [] as SessionMessage[],
    forkHandoff: '## Decisions and why\nKept the cookie.\n## Current state\nTests green.\n## Next step\nShip it.\n## Verify first\nRun npm test.',
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
  // The engine hands fs hooks a native path (`D:\p\x` on Windows); the fixtures are keyed `/p/x`.
  const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
  // A file the mod wrote reads back, as on a real disk (F15 reads its own metrics files).
  const file = (path: string) => opts.files?.[posix(path)] ?? shown.writes.filter(f => f.path === posix(path)).at(-1)?.text ?? opts.transcript
  on('fs.stat', (_$, e) => {
    const text = file(e.path)
    return text === undefined ? Promise.reject(new Error('ENOENT')) : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    shown.fsReads.push(posix(e.path))
    if (opts.unreadable?.includes(posix(e.path))) return Promise.reject(new Error('EBUSY'))
    const text = file(e.path)
    return text === undefined ? Promise.reject(new Error('ENOENT')) : { value: text }
  })
  on('fs.write', (_$, e) => {
    if (opts.isWriteRefused || shown.refuseWrites) return Promise.reject(new Error('EACCES'))
    shown.writes.push({ path: posix(e.path), text: e.text })
    return { value: undefined }
  })
  on('session.id', () => ({ value: opts.sessionId ?? 'sess1' }))
  on('ui.open', (_$, e) => { shown.opened.push(e.id); return { value: { requestId: e.id } as never } })
  on('ui.copy', (_$, e) => { shown.copied.push({ text: e.text, surface: e.surface }); return { value: { isCopied: true } } })
  on('session.root', () => ({ value: '/p' }))
  on('fs.list', (_$, e) => {
    const dir = `${posix(e.path)}/`
    const paths = [...Object.keys(opts.files ?? {}), ...shown.writes.map(f => f.path)].filter(p => p.startsWith(dir))
    const files = paths.filter(p => !p.slice(dir.length).includes('/'))
    const dirs = [...new Set(paths.map(p => p.slice(dir.length)).filter(rest => rest.includes('/')).map(rest => rest.split('/')[0]!))]
    return { value: [
      ...files.map(p => ({ name: p.slice(dir.length), kind: 'file' as const, size: file(p)?.length ?? 1, mtimeMs: opts.mtimes?.[p] ?? 0, isLink: false })),
      ...dirs.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
    ] }
  })
  on('model.fork', (_$, e) => {
    shown.forks.push(e.prompt)
    return { value: { isAnswered: true, text: e.prompt.startsWith('Write the second half') ? shown.forkHandoff : 'OK', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: shown.forkCacheRead, cache_creation_input_tokens: 10 } } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  // Core's Read: the range asked for, or its default first page of 2000 lines.
  on('tool.call', { tool: 'Read' }, (_$, e) => {
    shown.reads.push(e.file_path)
    const lines = (file(e.file_path) ?? '').split('\n')
    const start = Math.max(0, (e.offset ?? 1) - 1)
    const content = lines.slice(start, start + (e.limit ?? 2_000)).join('\n')
    return { result: { type: 'text', file: { filePath: e.file_path, content, numLines: 0, startLine: start + 1, totalLines: lines.length } } as never }
  })
  on('tool.call', { tool: 'Grep' }, (_$, e) => ({ result: { mode: 'content' } as never, text: (e as unknown as { pattern: string }).pattern === 'big' ? 'x'.repeat(40_000) : 'small' }))
  on('tool.call', { tool: 'Bash' }, () => opts.bashError !== undefined ? { isError: true, result: opts.bashError, text: opts.bashError } : ({ result: { stdout: opts.bashOut?.stdout ?? 'ok', stderr: '', interrupted: false, ...(opts.bashOut?.persistedOutputPath === undefined ? {} : { persistedOutputPath: opts.bashOut.persistedOutputPath }) } }))
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
  on('session.messages', () => ({ value: shown.messages }))
  on('process.run', (_$, e) => {
    shown.runs.push([...e.argv])
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'uname') return done(0, `${opts.uname ?? 'Linux'}\n`)
    if (['cmd', 'open', 'xdg-open'].includes(e.argv[0]!)) return done(shown.openerExit)
    const out = e.argv.includes('rev-parse') ? opts.git?.branch : e.argv.includes('--numstat') ? opts.git?.numstat : undefined
    return done(out === undefined ? 128 : 0, out ?? '')
  })
  on('session.compact', (_$, e) => {
    shown.coreCompactions.push({ trigger: e.trigger, instructions: e.instructions, agentId: e.agentId })
    return { messages: [{ role: 'user', text: 'core summary', toolUses: [] }] }
  })
  // Core's /compact raises a manual compaction; a test plays that part with
  // the engine's $ (see `runCompact`).
  on('command.run', { command: 'compact' }, () => { shown.commandsRun.push('compact'); return {} })
  on('command.run', { command: 'clear' }, () => { shown.commandsRun.push('clear'); return {} })
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
      expect(w.status.at(-1)).toBe('Sonnet · ctx ▓▓▓▓▓░░░░░ 47% 140k/300k · cache – · this chat $1.84')

      await $.turn.complete(turnDone())
      await w.clock.advance(2 * MIN) // the minute tick redraws the countdown
      expect(w.status.at(-1)).toBe('Sonnet · ctx ▓▓▓▓▓░░░░░ 47% 140k/300k · cache ● 3m · this chat $1.84')

      await w.clock.advance(15 * MIN)
      expect(w.status.at(-1)).toBe('Sonnet · ctx ▓▓▓▓▓░░░░░ 47% 140k/300k · cache ○ cold 12m (rebuild ≈ $0.35) · this chat $1.84')
    })

    test(`window: this chat's share of the 5h window, 1h cache (${surface})`, { options: { billing: 'window' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], model: 'claude-haiku-4-5-20251001', usage: { tokens: 64_000, window: 200_000, rateLimits: [fiveHour(53)] } })
      await $.session.start(start(surface))
      await $.turn.complete(turnDone('claude-haiku-4-5-20251001'))
      w.usage.rateLimits = [fiveHour(62)]
      await $.session.measure(measure(w))
      expect(w.status.at(-1)).toBe('Haiku · ctx ▓▓▓▓▓░░░░░ 53% 64k/120k · cache ● 1h 0m · this chat 9% of 5h · 5h 62% (resets 1h 20m)')
    })
  }

  test('the limit is the model window when that is smaller', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 150_000, window: 200_000 } })
    await $.session.start(start('terminal'))
    expect(w.status.at(-1)).toContain('150k/200k')
  })

  test('a re-cached first request names its cause in the status, until the cache serves again', { options: { billing: 'window' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 111_000 } })
    const step = (model: string, read: number, write: number) => ({
      turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const,
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write, model },
    })
    let next = step('claude-sonnet-5-5', 100_000, 1_000)
    on('turn.step', async function* () { return next })
    const run = async () => { const s = $.turn.step({ turnId: 't', index: 0, model: next.usage.model, messageCount: 2 }); for await (const _ of s); return s.result }
    await $.session.start(start('terminal'))
    await run()
    await $.turn.complete(turnDone())
    expect(w.status.at(-1)).not.toContain('miss')

    next = step('claude-opus-5-5', 0, 111_000) // the /model switch
    await run()
    expect(w.status.at(-1)).toContain('miss: model switch, re-cached 111k')
    expect(w.logs).toContain('ccwarden: the cache missed (model switch); this request re-cached 111k tokens.')
    await $.turn.complete(turnDone('claude-opus-5-5'))

    next = step('claude-opus-5-5', 111_000, 500)
    await run()
    expect(w.status.at(-1)).not.toContain('miss')
  })

  test("the engine's auto-compact window follows the model's limit, so the engine compacts there", { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 100_000, window: 1_000_000 }, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' } })
    await $.session.start(start('terminal'))
    expect(w.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBe('300000') // limitOther, over the hand-set value
    expect(w.status.at(-1)).toContain('100k/300k')

    // A /model switch: the next turn's start sets the new model's window, before its first request.
    w.model = 'claude-haiku-4-5-20251001'
    await $.turn.start({ text: 'go on', turnId: 't1' })
    expect(w.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBe('120000')
    w.model = 'claude-opus-5-5'
    await $.turn.complete(turnDone('claude-opus-5-5'))
    expect(w.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBe('300000')
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

  test('observed in the transcript, with one toast when it contradicts billing', { options: { billing: 'metered', modelAdvisor: false } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 1_000 }, transcript: jsonl({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }) })
    await $.classic.SessionStart({ source: 'startup', transcript_path: '/t.jsonl' })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(10 * MIN)
    expect(w.status.at(-1)).toContain('cache ● 50m')
    expect(w.toasts).toEqual(['cache writes use a 1h TTL, but billing is set to metered. Check billing in /config.'])

    await $.turn.complete(turnDone()) // re-read after 10 min: no second toast
    expect(w.toasts).toHaveLength(1)
  })

  test('the documented override wins over billing, and explains a 1h write', { options: { billing: 'metered', modelAdvisor: false } }, async ($, on) => {
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

    test(`the answer takes effect at once: the status switches to the 5h window (${surface})`, async ($, on) => {
      const w = world(on, { surfaces: [surface], answer: BILLING_OPTIONS[1], usage: { tokens: 64_000, window: 200_000, rateLimits: [fiveHour(53)] } })
      await $.session.start(start(surface))
      expect(w.status.at(-1)).toContain('this chat $') // asked, not answered yet: metered format
      await w.clock.advance(0)
      expect(w.status.at(-1)).toContain('% of 5h · 5h 53%')
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
      test(`Haiku past 120k advises /compact, and that /compact is a snapshot, no summary request (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], model: 'claude-haiku-4-5-20251001', usage: { tokens: 125_000, window: 200_000 } })
        await $.session.start(start(surface))
        await $.turn.complete(turnDone('claude-haiku-4-5-20251001'))
        await w.clock.advance(0)

        expect(w.commandsRun).toEqual([]) // a mod-run /compact skips its own hook (Q13), so it only advises
        await $.session.compact({ trigger: 'manual', messages: history() }) // what core's /compact raises
        expect(w.coreCompactions).toEqual([]) // answered in core's place
        expect(w.logs).toContain('ccwarden: 125k tokens is past the 120k limit for claude-haiku-4-5-20251001. Type /compact: it keeps a snapshot, no summary request.')
        expect(w.logs.at(-1)).toMatch(/^ccwarden: snapshot compaction \(manual\): 10 messages → a \d+-character snapshot \+ 2 turn\(s\) kept; no summary request\.$/)
      })
    }
  }

  test('Sonnet keeps going at 250k and is advised past 300k, once', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 250_000 } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(0)
    expect(w.commandsRun).toEqual([])

    w.usage.tokens = 301_000
    await $.turn.complete(turnDone())
    await $.turn.complete(turnDone())
    await w.clock.advance(0)
    expect(w.commandsRun).toEqual([])
    expect(w.logs.filter(l => l.includes('Type /compact'))).toHaveLength(1)
  })

  test('a limit under the engine\'s 100k floor is advised at 100k, where the engine compacts', { options: { billing: 'window', limitOther: 50_000 } }, async ($, on) => {
    const w = world(on, { surfaces: ['desktop'], usage: { tokens: 66_000 } })
    await $.session.start(start('desktop'))
    await $.turn.complete(turnDone())
    await w.clock.advance(0)
    expect(w.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBe('100000')
    expect(w.logs.filter(l => l.includes('Type /compact'))).toEqual([])

    w.usage.tokens = 101_000
    await $.turn.complete(turnDone())
    await w.clock.advance(0)
    expect(w.logs.filter(l => l.includes('Type /compact'))).toHaveLength(1)
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
    expect(w.logs.some(l => l.includes('Type /compact'))).toBe(true)
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
          ? 'ccwarden: the prompt cache went cold 5m ago, so this prompt re-caches ~180k tokens (≈ $0.72 est.). Same task? Handoff writes a note without a model call; a new session re-reads ~3k instead. Unrelated work? /clear first. Send it anyway?'
          : 'ccwarden: the prompt cache went cold 12m ago, so this prompt re-caches ~180k tokens (≈ $0.45 est.). Same task? Handoff writes a note without a model call; a new session re-reads ~3k instead. Unrelated work? /clear first. Send it anyway?')
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

  test('Handoff writes a quick note without a model call and keeps the prompt', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Handoff', usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(10 * MIN)
    const out = await $.prompt.submit(typed('go'))
    expect(w.forks).toEqual([])
    expect(w.sent).toEqual([])
    const path = w.writes.find(f => f.path.includes('/.claude/handoffs/'))?.path
    expect(path).toBeDefined()
    expect(out.drop).toContain(`Handoff written to ${path}`)
    expect(w.logs).toContain(out.drop)
    await w.clock.advance(0)
    expect(w.fills).toEqual(['go'])
  })

  test('a resumed conversation: the first prompt is asked about, its cache age from the transcript', { options: { billing: 'metered' } }, async ($, on) => {
    const NOW = Date.parse('2026-10-02T12:00:00Z')
    const last = { type: 'assistant', timestamp: new Date(NOW - 40 * MIN).toISOString(), message: { content: [] } }
    const w = world(on, { surfaces: ['terminal'], answer: 'Cancel', usage: { tokens: 180_000 }, files: { '/t.jsonl': JSON.stringify(last) } })
    await w.clock.advance(NOW)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t.jsonl' })
    await $.session.start(start('terminal'))
    const out = await $.prompt.submit(typed('continue'))
    expect(w.asks).toHaveLength(1)
    expect(w.asks[0]).toContain('went cold 35m ago')
    expect(out.drop).toBeDefined()
  })

  test('a prompt asking Claude for a handoff is asked about again in the same cold spell', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Cancel', usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(10 * MIN)
    await $.prompt.submit(typed('go'))
    await $.prompt.submit(typed('handoff document bana do'))
    expect(w.asks).toHaveLength(2)
    expect(w.sent).toEqual([])
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
      expect(denied.deny).toBe('ccwarden junk guard: /p/big.log has 3000 lines (more than 2000), so a whole Read would put up to 2000 of them in the context. Use Grep to find what you need in it, or Read it with offset and limit.')

      // A large limit doesn't get round it; a range within readMaxLines, or an offset alone, goes through.
      expect((await $.tool.call({ tool: 'Read', file_path: '/p/big.log', limit: 2_500 })).deny).toContain('this Read asks for 2500 lines of /p/big.log (limit 2500), more than 2000')
      await $.tool.call({ tool: 'Read', file_path: '/p/big.log', offset: 1, limit: 100 })
      await $.tool.call({ tool: 'Read', file_path: '/p/big.log', offset: 2_001, limit: 2_500 })
      await $.tool.call({ tool: 'Read', file_path: '/p/big.log', offset: 100 })
      await $.tool.call({ tool: 'Read', file_path: '/p/small.ts' })
      await $.tool.call({ tool: 'Read', file_path: '/p/yarn.lock' })
      await $.tool.call({ tool: 'Read', file_path: '/p/missing.ts' })
      expect(w.reads).toEqual(['/p/big.log', '/p/big.log', '/p/big.log', '/p/small.ts', '/p/yarn.lock', '/p/missing.ts'])
      // Kept out: what core would have returned (its first 2000 lines; the 2500-line range), not the whole file.
      const firstPage = LONG.split('\n').slice(0, 2_000).join('\n').length
      expect((w.store.get('junkLog') as { savedChars: number }[]).map(ev => ev.savedChars)).toEqual([firstPage, LONG.split('\n').slice(0, 2_500).join('\n').length])
    })

    test(`observe: a long Read's kept-out size is what core returned (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files })
      await $.session.start(start(surface))
      expect((await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })).deny).toBeUndefined()
      expect((w.store.get('junkLog') as { savedChars: number; size: number }[])[0]).toMatchObject({ size: 3_000, savedChars: LONG.split('\n').slice(0, 2_000).join('\n').length })
    })

    test(`enforce: long Bash output is cut to head + tail, the full text saved (${surface})`, { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
      const out = 'a'.repeat(30_000) + 'b'.repeat(20_000)
      const w = world(on, { surfaces: [surface], bashOut: { stdout: out }, env: { HOME: '/home/u' } })
      await $.session.start(start(surface))

      const ran = await $.tool.call({ tool: 'Bash', command: 'cat build.log', tool_use_id: 'tu1' })
      const stdout = (ran.result as { stdout: string }).stdout
      expect(w.writes).toEqual([{ path: '/home/u/.claude/ccwarden/outputs/sess1-tu1.txt', text: out }])
      expect(stdout.startsWith('a'.repeat(18_000) + '\n\n[ccwarden junk guard: 20000 characters cut')).toBe(true)
      expect(stdout).toContain('The full output is in /home/u/.claude/ccwarden/outputs/sess1-tu1.txt: use Grep on that file')
      expect(stdout.endsWith('b'.repeat(12_000))).toBe(true)
    })

    // A long passing run: 2000 "ok" lines, one flaky warning, the summary.
    const passing = Array.from({ length: 2000 }, (_, i) => `ok ${i} - case ${i} passes fine`).join('\n') + '\n# tests 2000\n# pass 2000\n# fail 0'
    test(`enforce: a long test run keeps only its failure lines and summary (${surface})`, { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], bashOut: { stdout: passing }, env: { HOME: '/home/u' } })
      await $.session.start(start(surface))

      const stdout = ((await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu2' })).result as { stdout: string }).stdout
      expect(w.writes).toEqual([{ path: '/home/u/.claude/ccwarden/outputs/sess1-tu2.txt', text: passing }])
      expect(stdout.startsWith('[ccwarden junk guard: Kept the failure lines and the summary')).toBe(true)
      expect(stdout).not.toContain('ok 100 ')
      expect(stdout.endsWith('# fail 0')).toBe(true)
    })

    test(`enforce: a failed test run comes back as a plain result that says it failed (${surface})`, { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
      const failing = 'Exit code 1\n' + passing.replace('ok 1500 - case 1500 passes fine', 'not ok 1500 - case 1500 failed\n  expected: 2\n  received: 3')
      const w = world(on, { surfaces: [surface], bashError: failing, env: { HOME: '/home/u' } })
      await $.session.start(start(surface))

      const ran = await $.tool.call({ tool: 'Bash', command: 'node --test', tool_use_id: 'tu3' })
      const stdout = (ran.result as { stdout: string }).stdout
      expect(ran.isError).toBeUndefined()
      expect(w.writes).toEqual([{ path: '/home/u/.claude/ccwarden/outputs/sess1-tu3.txt', text: failing }])
      expect(stdout.startsWith('[ccwarden junk guard: This test run FAILED (exit code 1).')).toBe(true)
      expect(stdout).toContain('not ok 1500 - case 1500 failed\n  expected: 2\n  received: 3')
      expect(stdout).not.toContain('ok 100 ')
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

describe('F6 keep-warm', () => {
  const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
  // The user prompts, the turn runs and ends; the cache is warm for 5m from here.
  async function exchange($: Engine, text = 'go') {
    await $.prompt.submit(typed(text))
    await $.turn.start({ text, turnId: 't' })
    await $.turn.complete(turnDone())
  }

  for (const surface of SURFACES) {
    test(`pings just before expiry, keeps the cache warm, and counts the rebuild avoided (${surface})`, { options: { billing: 'metered', keepWarm: true } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], answer: 'Cancel', usage: { tokens: 180_000 } })
      await $.session.start(start(surface))
      await exchange($)

      await w.clock.advance(4 * MIN)
      expect(w.forks).toEqual([])
      await w.clock.advance(MIN / 2) // 4m30s: inside the last 45s
      expect(w.forks).toEqual(['Reply with OK.'])
      expect(w.status.at(-1)).toContain('cache ● 5m')
      expect(w.status.at(-1)).toMatch(/keep-warm \$0\.04 · saved \$0\.00/)

      await w.clock.advance(3 * MIN) // 7m30s: cold without the ping
      const out = await $.prompt.submit(typed('next step'))
      expect(out.drop).toBeUndefined() // no cold-cache question: it's warm
      expect(w.asks).toEqual([])
      expect(w.status.at(-1)).toMatch(/saved \$0\.45/)
    })
  }

  test('stops keepWarmMaxMin after the last prompt', { options: { billing: 'metered', keepWarm: true, keepWarmMaxMin: 12 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await exchange($)
    await w.clock.advance(60 * MIN)
    expect(w.forks).toHaveLength(2) // at 4m30s and 9m; the next would be past 12m
    expect(w.status.at(-1)).toContain('cache ○ cold')
  })

  test('stops at the $ cap', { options: { billing: 'metered', keepWarm: true, keepWarmCapUsd: 0.05 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await exchange($)
    await w.clock.advance(60 * MIN)
    expect(w.forks).toHaveLength(1) // ~$0.04 each: a second would pass $0.05
  })

  test('never: off by default, on window billing, detached, mid-turn, or before a prompt', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await exchange($)
    await w.clock.advance(20 * MIN)
    expect(w.forks).toEqual([])
  })

  for (const [name, options, surfaces, midTurn] of [
    ['window billing', { billing: 'window', keepWarm: true }, ['terminal'], false],
    ['no client attached', { billing: 'metered', keepWarm: true }, [], false],
    ['a turn running', { billing: 'metered', keepWarm: true }, ['terminal'], true],
  ] as const) {
    test(`no ping: ${name}`, { options }, async ($, on) => {
      const w = world(on, { surfaces, usage: { tokens: 180_000 } })
      await $.session.start(start(surfaces[0] ?? null))
      await exchange($)
      if (midTurn) await $.turn.start({ text: 'x', turnId: 't2' })
      await w.clock.advance(70 * MIN)
      expect(w.forks).toEqual([])
    })
  }

  test('a resumed session waits for a prompt', { options: { billing: 'metered', keepWarm: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone()) // a response, but no prompt typed in this process
    await w.clock.advance(10 * MIN)
    expect(w.forks).toEqual([])
  })

  test("a fork that read little from the cache found it lapsed: it doesn't count as warm", { options: { billing: 'metered', keepWarm: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 180_000 } })
    w.forkCacheRead = 0
    await $.session.start(start('terminal'))
    await exchange($)
    await w.clock.advance(6 * MIN)
    expect(w.forks).toHaveLength(1)
    expect(w.status.at(-1)).toContain('cache ○ cold')
  })
})

describe('F7 handoff', () => {
  const msg = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })
  const history = [msg('user', 'Fix the login timeout bug'), msg('assistant', 'Done.'), msg('user', 'also keep the old cookie name'), msg('assistant', 'Kept.')]
  const run = (args: string) => ({ command: 'handoff', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
  const START = Date.parse('2026-10-02T07:46:00Z')

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`/handoff while warm: a full note from one fork, nothing added to the conversation (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], usage: { tokens: 50_000 }, git: { branch: 'fix/login' } })
        w.messages = history
        await w.clock.advance(START)
        await $.session.start(start(surface))
        await $.turn.complete(turnDone())

        const out = await $.command.run(run(''))
        expect(out.text).toBeUndefined()
        expect(w.forks).toHaveLength(1)
        expect(w.writes).toHaveLength(1)
        const { path, text } = w.writes[0]!
        expect(path).toBe('/p/.claude/handoffs/2026-10-02-0746-fix-the-login-timeout-bug.md')
        expect(text).toContain('# Handoff: fix the login timeout bug')
        expect(text).toContain('(full); model claude-sonnet-5-5, branch `fix/login`')
        expect(text).toContain('## Goal\nFix the login timeout bug')
        expect(text).toContain('1. also keep the old cookie name')
        expect(text).toContain('## Next step\nShip it.')
        expect(w.logs.at(-1)).toBe(`ccwarden: full handoff written to ${path}.`)
      })
    }
  }

  test('a cold cache gets a quick note and says why; /handoff quick never forks', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 50_000 } })
    w.messages = history
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await $.command.run(run('quick'))
    await w.clock.advance(10 * MIN)
    await $.command.run(run(''))
    expect(w.forks).toEqual([])
    expect(w.writes).toHaveLength(2)
    expect(w.writes[1]!.text).toContain('_(quick handoff: run /handoff while the cache is warm to have this written)_')
    expect(w.logs.at(-1)).toMatch(/quick: the cache is cold, so a full one would re-read the whole conversation\)\.$/)
  })

  test('a fork that answers off-format falls back to quick', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 50_000 } })
    w.forkHandoff = 'Sure! Here is a summary.'
    w.messages = history
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await $.command.run(run(''))
    expect(w.forks).toHaveLength(1)
    expect(w.writes[0]!.text).toContain('(quick: from the transcript and git)')
  })

  for (const surface of SURFACES) {
    test(`a fresh start offers the newest handoff once, never an older one; Continue prefills the prompt (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const files: Record<string, string> = {
        '/p/.claude/handoffs/2026-10-01-0900-old-task.md': '# old',
        '/p/.claude/handoffs/2026-10-02-0746-fix-login.md': '# new',
        '/p/.claude/handoffs/notes.txt': 'not a handoff',
      }
      const w = world(on, { surfaces: [surface], answer: 'Continue from handoff', files })
      await $.classic.SessionStart({ source: 'startup', transcript_path: '/t.jsonl' })
      await $.session.start(start(surface))
      await w.clock.advance(0)
      expect(w.asks).toEqual(['ccwarden: continue from the handoff 2026-10-02-0746-fix-login.md?'])
      expect(w.fills).toEqual(['Continue from the handoff in .claude/handoffs/2026-10-02-0746-fix-login.md: read it first, then verify what it says to verify before the next step.'])

      await $.classic.SessionStart({ source: 'startup', transcript_path: '/t2.jsonl' })
      await w.clock.advance(0)
      expect(w.asks).toHaveLength(1) // the older one is stale: not offered

      files['/p/.claude/handoffs/2026-10-03-0800-next.md'] = '# newer'
      await $.classic.SessionStart({ source: 'resume', transcript_path: '/t3.jsonl' })
      await w.clock.advance(0)
      expect(w.asks).toHaveLength(1) // only a fresh start offers

      await $.classic.SessionStart({ source: 'startup', transcript_path: '/t4.jsonl' })
      await w.clock.advance(0)
      expect(w.asks[1]).toContain('2026-10-03-0800-next.md')
    })
  }

  test('handoffOnCompact writes a quick note before the compaction', { options: { billing: 'metered', handoffOnCompact: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 10_000 } })
    await $.session.start(start('terminal'))
    await $.session.compact({ trigger: 'auto', messages: [{ ...history[0]!, handle: 'h1' }, { ...history[1]!, handle: 'h2' }] })
    expect(w.writes).toHaveLength(1)
    expect(w.writes[0]!.text).toContain('(quick: from the transcript and git)')
    expect(w.forks).toEqual([])
  })
})

describe('F8 background spend watcher', () => {
  const sent = (origin: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ text: 'tick', wait: false, origin: origin as never, ...extra })
  const bgTurn = { ...turnDone(), usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' } } // $0.20

  async function backgroundTurn($: Engine, origin: Record<string, unknown>) {
    await $.prompt.submit(sent(origin))
    await $.turn.start({ text: 'tick', turnId: 'b' })
    await $.turn.complete(bgTurn)
  }

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`each kind is named once with its cost and how to stop it; the total stays in the status (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface] })
        await $.session.start(start(surface))

        await backgroundTurn($, { kind: 'scheduled-trigger' })
        await w.clock.advance(61 * MIN) // past R9's hour, so only the once-per-kind rule holds a repeat back
        await backgroundTurn($, { kind: 'scheduled-trigger' })
        expect(w.toasts).toEqual(['a turn started by a scheduled task or /loop cost ~$0.20 (est.). To stop these, delete the scheduled tasks or loops you no longer need.'])
        expect(w.status.at(-1)).toContain('background $0.40')
      })
    }
  }

  test("the user's own turns don't count: typed, from a phone, or the SDK host's", { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    for (const kind of ['composer', 'bridge', 'sdk']) await backgroundTurn($, { kind })
    expect(w.toasts).toEqual([])
    expect(w.status.at(-1)).not.toContain('background')
  })

  test("a delivery folded into the user's running turn isn't a turn of its own", { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    await $.prompt.submit({ text: 'mine', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'mine', turnId: 't' })
    await $.prompt.submit(sent({ kind: 'peer' }, { turnId: 't' }))
    await $.turn.complete(bgTurn)
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } }) // the next turn is the user's
    await $.turn.start({ text: 'next', turnId: 't2' })
    await $.turn.complete(bgTurn)
    expect(w.toasts).toEqual([])
  })

  test('queued prompts are told apart: a background one and the user\'s, each to its own turn', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    await $.prompt.submit(sent({ kind: 'scheduled-trigger' }))
    await $.prompt.submit({ text: 'mine', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'tick', turnId: 'b' })
    await $.turn.complete(bgTurn)
    await $.turn.start({ text: 'mine', turnId: 'm' })
    await $.turn.complete(bgTurn)
    expect(w.toasts).toHaveLength(1)
    expect(w.status.at(-1)).toContain('background $0.20')
  })

  test('backgroundWatch off: nothing', { options: { billing: 'metered', backgroundWatch: false } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    await backgroundTurn($, { kind: 'peer' })
    expect(w.toasts).toEqual([])
  })
})

describe('F9 model and effort advice', () => {
  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`a fresh start on Opus suggests cheaper models while a switch is free (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], model: 'claude-opus-5-5' })
        await $.classic.SessionStart({ source: 'startup', transcript_path: '/t.jsonl', model: 'claude-opus-5-5' })
        await w.clock.advance(0)
        expect(w.toasts).toEqual(['Routine work? Per token, Sonnet 50%, Haiku 25% of Opus. Switching now (/model haiku) is free: nothing is cached before the first prompt. For routine steps later, a lower /effort keeps the cache on this model.'])
      })
    }
  }

  test('not on a resume or after /clear, not on Haiku, not when off', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], model: 'claude-opus-5-5' })
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t.jsonl', model: 'claude-opus-5-5' })
    await $.classic.SessionStart({ source: 'clear', transcript_path: '/t.jsonl', model: 'claude-opus-5-5' })
    await $.classic.SessionStart({ source: 'startup', transcript_path: '/t.jsonl', model: 'claude-haiku-4-5-20251001' })
    await w.clock.advance(0)
    expect(w.toasts).toEqual([])
  })

  test('modelAdvisor off', { options: { billing: 'metered', modelAdvisor: false } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], model: 'claude-opus-5-5' })
    await $.classic.SessionStart({ source: 'startup', transcript_path: '/t.jsonl', model: 'claude-opus-5-5' })
    await w.clock.advance(0)
    expect(w.toasts).toEqual([])
  })

  test('a switch past the new model\'s limit is noted, never blocked', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    const sw = (to_model: string, context_tokens: number) => $.classic.PreModelSwitch({
      from_model: 'claude-sonnet-5-5', to_model, requested_model: null, source: 'command', context_tokens,
      prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0.2, pricing: 'catalog',
    })
    on('classic.PreModelSwitch', () => ({}))
    const out = await sw('claude-haiku-4-5-20251001', 180_000)
    expect(out.permissionDecision).toBeUndefined()
    expect(w.logs).toEqual(["ccwarden: 180k tokens is past claude-haiku-4-5-20251001's 120k limit. If you switch, it re-reads it all (≈ $0.20 est.) and then compacts. Cheaper: /handoff, then start a new session on that model."])
    await sw('claude-opus-5-5', 180_000)
    expect(w.logs).toHaveLength(1)
  })

  test('a handoff names the cheaper model for the next session', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], model: 'claude-opus-5-5' })
    w.messages = [{ role: 'user', text: 'Ship it', toolUses: [] }]
    await $.session.start(start('terminal'))
    await $.command.run({ command: 'handoff', args: 'quick', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(w.writes[0]!.text).toContain('_Next session: for routine steps, start on haiku (`/model haiku`) before the first prompt; a switch then costs nothing._')
  })
})

describe('M3 spend ledger and context hogs', () => {
  const DAY = Date.parse('2026-10-02T10:00:00Z')
  const ledgerDays = (w: World) => (w.store.get('ledger') as { days: Record<string, number> } | undefined)?.days ?? {}

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`each day's spend counts once: a resume, a reload and a /clear (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], usage: { usd: 2 } }) // a resumed conversation that already spent $2
        await w.clock.advance(DAY)
        await $.session.start(start(surface))
        w.usage.usd = 2.5
        await $.session.measure(measure(w))
        await $.session.start(start(surface)) // a reload keeps the count
        w.usage.usd = 3
        await $.session.measure(measure(w))
        await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
        w.usage.usd = 0.25 // the new conversation's own total
        await $.session.measure(measure(w))
        expect(ledgerDays(w)).toEqual({ '2026-10-02': 1.25 })
      })
    }
  }

  test('spend lands on the day it happened', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await w.clock.advance(Date.parse('2026-10-02T23:59:00Z'))
    await $.session.start(start('terminal'))
    w.usage.usd = 1
    await $.session.measure(measure(w))
    await w.clock.advance(2 * MIN)
    w.usage.usd = 1.5
    await $.session.measure(measure(w))
    expect(ledgerDays(w)).toEqual({ '2026-10-02': 1, '2026-10-03': 0.5 })
  })

  test('big main-loop tool results are tallied as hogs; small ones and subagents\' are not', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await w.clock.advance(DAY)
    await $.session.start(start('terminal'))
    await $.tool.call({ tool: 'Grep', pattern: 'big' } as never)
    await $.tool.call({ tool: 'Grep', pattern: 'big' } as never)
    await $.tool.call({ tool: 'Grep', pattern: 'small' } as never)
    await $.tool.call({ tool: 'Grep', pattern: 'big', agentId: 'a1' } as never)
    expect(w.store.get('hogDays')).toEqual({ '2026-10-02': { 'Grep\tbig': 20_000 } })
  })
})

describe('F11 month tracking and budget mode', () => {
  const OCT = Date.parse('2026-10-11T00:00:00Z') // 10 days into a 31-day month
  const seeded = (usd: number) => ({ ledger: { days: { '2026-10-05': usd } } })
  const cw = (args: string) => ({ command: 'cw', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

  for (const surface of SURFACES) {
    test(`toasts at 50% and 80% of the month budget, once each, with a projection; budget mode follows (${surface})`, { options: { billing: 'metered', monthlyBudgetUsd: 100, sessionAlertUsd: 1000 } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], store: seeded(45) })
      await w.clock.advance(OCT)
      await $.session.start(start(surface))
      w.usage.usd = 6
      await $.session.measure(measure(w))
      expect(w.toasts).toEqual(['$51.00 of your $100 month budget so far (51%, est.). At this pace, ~$158 by month end.'])
      w.usage.usd = 7
      await $.session.measure(measure(w))
      expect(w.toasts).toHaveLength(1)
      expect(w.status.at(-1)).not.toContain('budget mode')

      w.usage.usd = 37
      await $.session.measure(measure(w))
      expect(w.toasts.slice(1)).toEqual([
        '$82.00 of your $100 month budget so far (82%, est.). At this pace, ~$254 by month end.',
        'budget mode on (the month is at 82% of its budget): a stricter junk guard and earlier window alerts. /cw budget off to stop it.',
      ])
      expect(w.status.at(-1)).toContain('budget mode')

      await $.session.start(start(surface)) // a reload: budget mode stays, unannounced
      expect(w.toasts).toHaveLength(3)
    })
  }

  test('no month toasts without a budget, or on window billing', { options: { billing: 'window', monthlyBudgetUsd: 100 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], store: seeded(90) })
    await w.clock.advance(OCT)
    await $.session.start(start('terminal'))
    w.usage.usd = 20
    await $.session.measure(measure(w))
    expect(w.toasts).toEqual([])
  })

  test('/cw spent calibrates the month; /cw reports it', { options: { billing: 'metered', monthlyBudgetUsd: 200 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], store: seeded(10) })
    await w.clock.advance(OCT)
    await $.session.start(start('terminal'))
    await $.command.run(cw('spent $60'))
    w.usage.usd = 5
    await $.session.measure(measure(w))
    await $.command.run(cw(''))
    expect(w.logs.at(-1)).toBe('ccwarden: this month $65.00 of your $200 budget on this machine (est.), ~$202 at this pace; budget mode off.')
    await $.command.run(cw('spent lots'))
    expect(w.logs.at(-1)).toContain('/cw spent <amount>')
  })

  for (const surface of SURFACES) {
    test(`/cw budget on tightens the junk guard (800 lines) (${surface})`, { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
      const file = Array.from({ length: 1_000 }, (_, i) => `line ${i}`).join('\n')
      const w = world(on, { surfaces: [surface], files: { '/p/mid.ts': file } })
      await $.session.start(start(surface))
      expect((await $.tool.call({ tool: 'Read', file_path: '/p/mid.ts' })).deny).toBeUndefined()
      await $.command.run(cw('budget on'))
      expect(w.logs).toContain('ccwarden: budget mode on (set by hand): a stricter junk guard and earlier window alerts. /cw budget off to stop it.')
      expect((await $.tool.call({ tool: 'Read', file_path: '/p/mid.ts' })).deny).toContain('more than 800')
      expect(w.status.at(-1)).toContain('budget mode')
      await $.command.run(cw('budget off'))
      expect((await $.tool.call({ tool: 'Read', file_path: '/p/mid.ts' })).deny).toBeUndefined()
    })
  }

  test('window billing: budget mode once the 5h window passes budgetModeAt', { options: { billing: 'window' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { rateLimits: [fiveHour(70)] } })
    await $.session.start(start('terminal'))
    w.usage.rateLimits = [fiveHour(81)]
    await $.session.measure(measure(w))
    expect(w.toasts.at(-1)).toBe('budget mode on (the 5h window is at 81%): a stricter junk guard and earlier window alerts. /cw budget off to stop it.')
  })
})

describe('F10 /cw dashboard', () => {
  const NOW = Date.parse('2026-10-11T12:00:00Z')
  const cw = (args = '') => ({ command: 'cw', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
  const paneProps = { title: 'ccwarden', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
  const row = (id: string, minute: number, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: 'assistant', timestamp: new Date(NOW - 60 * MIN + minute * MIN).toISOString(),
    message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } }, ...extra,
  })
  // The current session: a warm stretch, then a 20-minute idle gap that lapsed the 5m cache.
  const current = [
    row('a', 0, { cache_creation_input_tokens: 50_000, cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 0 } }),
    row('b', 2, { cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1_000 }),
    row('c', 22, { cache_creation_input_tokens: 51_000 }),
  ].join('\n')
  const files = { '/proj/s1.jsonl': current, '/proj/old.jsonl': row('z', 0, { cache_read_input_tokens: 5 }) }
  const mtimes = { '/proj/s1.jsonl': NOW, '/proj/old.jsonl': NOW - 10 * 24 * 60 * MIN }

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`/cw gathers the figures and opens a pane that draws them (${surface}, ${billing})`, { options: { billing, monthlyBudgetUsd: 100 } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], files, mtimes, usage: { tokens: 51_000, usd: 1.5 }, store: { ledger: { days: { '2026-10-05': 20 } } } })
        await w.clock.advance(NOW)
        await $.classic.SessionStart({ source: 'resume', transcript_path: '/proj/s1.jsonl' })
        await $.session.start(start(surface))
        await $.command.run(cw())
        expect(w.opened).toEqual(['ccwarden-cw'])

        const pane = await $.ui.mount({ plugin: 'ccwarden', surface, component: 'Pane', props: paneProps, requestId: 'ccwarden-cw' })
        const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
        expect(texts).toContain('This session')
        expect(texts.some(t => t.includes('Sonnet') || t.includes('claude-sonnet-5-5'))).toBe(true)
        expect(texts.some(t => /cache hits \d+% · 1 rebuild: \d\d:\d\d 51k expired \(idle 20m\)/.test(t))).toBe(true)
        expect(texts.some(t => t.includes('$20.00 of $100'))).toBe(true)
        expect(texts.some(t => t.startsWith('Last 7 days (1 session in this project)'))).toBe(true)
        expect(texts.some(t => t.includes('re-cached: expired 51k'))).toBe(true)

        await pane.press({ key: 'copy' })
        expect(w.copied).toHaveLength(1)
        expect(w.copied[0]!.text).toMatch(/^ccwarden report, 2026-10-11 12:00 UTC\n\nThis session\n/)
        expect(w.copied[0]!.surface).toBe(surface)
      })
    }
  }

  test('the pane buttons: budget mode toggles, handoff writes a note', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 1_000 } })
    w.messages = [{ role: 'user', text: 'Ship it', toolUses: [] }]
    await $.session.start(start('terminal'))
    await $.command.run(cw())
    const pane = await $.ui.mount({ plugin: 'ccwarden', surface: 'terminal', component: 'Pane', props: paneProps, requestId: 'ccwarden-cw' })
    await pane.press({ key: 'budget' })
    expect(w.logs).toContain('ccwarden: budget mode on (set from /cw): a stricter junk guard and earlier window alerts. /cw budget off to stop it.')
    expect(w.status.at(-1)).toContain('budget mode')
    expect((await pane.find({ key: 'budget' }))?.text).toBe('Budget mode off')
    await pane.press({ key: 'handoff' })
    expect(w.writes.some(f => f.path.includes('/.claude/handoffs/'))).toBe(true)
  })

  test('before /cw has run, the pane says how to fill it', { options: { billing: 'metered' } }, async ($, on) => {
    world(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))
    const pane = await $.ui.mount({ plugin: 'ccwarden', surface: 'desktop', component: 'Pane', props: paneProps, requestId: 'ccwarden-cw' })
    expect((await pane.find({ type: 'Text' }))?.text).toBe('Run /cw to gather the figures.')
  })
})

describe('F13 unrelated-prompt hint', () => {
  const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
  const history: SessionMessage[] = [
    { role: 'user', text: 'fix the snapshot compaction for the haiku limit', toolUses: [] },
    { role: 'assistant', text: 'Done: compaction now writes a snapshot at the haiku limit.', toolUses: [] },
  ]
  const UNRELATED = 'write a python scraper for weather forecast data'
  const warm = async ($: Engine, w: World, surface: RenderSurface) => {
    w.messages.push(...history)
    await $.session.start(start(surface))
    await $.turn.complete(turnDone())
    await w.clock.advance(MIN)
  }

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`Clear runs /clear and puts the prompt back (${surface}, ${billing})`, { options: { billing, topicShiftHint: true } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], answer: 'Clear', usage: { tokens: 180_000 } })
        await warm($, w, surface)
        const out = await $.prompt.submit(typed(UNRELATED))
        expect(w.asks).toHaveLength(1)
        expect(w.asks[0]).toContain('every turn here re-reads ~180k tokens. New work? Clear starts fresh and puts your prompt back in the box. Send it here anyway?')
        expect(out.drop).toBe('ccwarden: not sent; clearing the conversation, then your prompt goes back in the box.')
        expect(w.sent).toEqual([])
        await w.clock.advance(0)
        expect(w.commandsRun).toEqual(['clear'])
        expect(w.fills).toEqual([UNRELATED])
        expect((w.store.get('topicLog') as { choice: string; keywords: number }[]).map(ev => [ev.choice, ev.keywords])).toEqual([['clear', 6]])
      })
    }
  }

  test('Handoff + clear writes a quick note first', { options: { billing: 'metered', topicShiftHint: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Handoff + clear', usage: { tokens: 180_000 } })
    await warm($, w, 'terminal')
    const out = await $.prompt.submit(typed(UNRELATED))
    expect(w.forks).toEqual([])
    const path = w.writes.find(f => f.path.includes('/.claude/handoffs/'))?.path
    expect(path).toBeDefined()
    expect(out.drop).toContain(`Handoff written to ${path}`)
    await w.clock.advance(0)
    expect(w.commandsRun).toEqual(['clear'])
  })

  test('Send goes ahead and mutes the hint until the context grows 20%', { options: { billing: 'metered', topicShiftHint: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Send', usage: { tokens: 180_000 } })
    await warm($, w, 'terminal')
    await $.prompt.submit(typed(UNRELATED))
    await $.prompt.submit(typed('deploy kubernetes cluster on azure today'))
    expect(w.asks).toHaveLength(1)
    w.usage.tokens = 220_000
    await $.prompt.submit(typed('deploy kubernetes cluster on azure today'))
    expect(w.asks).toHaveLength(2)
    expect(w.sent).toHaveLength(3)
  })

  test('a dismissal keeps the prompt; sending it again goes through', { options: { billing: 'metered', topicShiftHint: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 180_000 } })
    await warm($, w, 'terminal')
    const out = await $.prompt.submit(typed(UNRELATED))
    expect(out.drop).toContain('Type /clear first')
    await w.clock.advance(0)
    expect(w.commandsRun).toEqual([])
    expect(w.fills).toEqual([UNRELATED])
    await $.prompt.submit(typed(UNRELATED))
    expect(w.sent).toEqual([UNRELATED])
    // Only that prompt went through: the next unrelated one is asked about.
    await $.prompt.submit(typed('deploy kubernetes cluster on azure today'))
    expect(w.asks).toHaveLength(2)
  })

  test('not asked: related, short, under 40k, or a slash command', { options: { billing: 'metered', topicShiftHint: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Clear', usage: { tokens: 180_000 } })
    await warm($, w, 'terminal')
    await $.prompt.submit(typed('now make the snapshot keep todos for sonnet too'))
    await $.prompt.submit(typed('ok ship it'))
    await $.prompt.submit(typed('the haiku limit?'))
    await $.prompt.submit(typed('/handoff quick please now'))
    w.usage.tokens = 30_000
    await $.prompt.submit(typed(UNRELATED))
    expect(w.asks).toEqual([])
    expect(w.sent).toHaveLength(5)
  })

  test('off by default', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Clear', usage: { tokens: 180_000 } })
    await warm($, w, 'terminal')
    await $.prompt.submit(typed(UNRELATED))
    expect(w.asks).toEqual([])
    expect(w.sent).toEqual([UNRELATED])
  })
})

describe('F14 efficiency dashboard: live figures', () => {
  const DAY = Date.parse('2026-10-03T10:00:00Z')
  const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
  const today = (w: World) => (w.store.get('projectDays') as Record<string, Record<string, Record<string, number>>> | undefined)?.['/p']?.['2026-10-03']

  for (const surface of SURFACES) {
    test(`spend goes to projectDays under the project, and to the ledger as before (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], usage: { tokens: 30_000 } })
      await w.clock.advance(DAY)
      await $.session.start(start(surface))
      w.usage.usd = 1.5
      await $.session.measure(measure(w))
      await $.turn.complete(turnDone())
      expect((w.store.get('ledger') as { days: Record<string, number> }).days).toEqual({ '2026-10-03': 1.5 })
      expect(today(w)).toEqual({ usd: 1.5, turns: 1, peakContext: 30_000 })
    })

    test(`a cold-cache ask and a handoff are counted (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], answer: 'Cancel', usage: { tokens: 180_000 } })
      await w.clock.advance(DAY)
      await $.session.start(start(surface))
      await $.turn.complete(turnDone())
      await w.clock.advance(17 * MIN)
      await $.prompt.submit(typed('continue with the refactor'))
      await $.command.run({ command: 'handoff', args: 'quick', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
      expect(today(w)).toMatchObject({ coldAsks: 1, handoffs: 1 })
    })
  }

  test('a snapshot compaction records what a summary would have cost', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 100_000 } })
    await w.clock.advance(DAY)
    await $.session.start(start('terminal'))
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'Ship it', toolUses: [] }] })
    expect(today(w)).toMatchObject({ snapshots: 1, snapshotSavedTokens: 102_000 })
    expect(Math.round(today(w)!.snapshotSavedUsd! * 1e4) / 1e4).toBe(0.04)
  })

  test('junk events carry the project and the session', { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
    const LONG = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join('\n')
    const w = world(on, { surfaces: ['terminal'], files: { '/p/big.log': LONG } })
    await $.session.start(start('terminal'))
    await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })
    expect((w.store.get('junkLog') as Record<string, unknown>[])[0]).toMatchObject({ tool: 'Read', project: '/p', session: 'sess1' })
  })
})

describe('F14 efficiency dashboard: /cw open', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z')
  const TRANSCRIPT = '/home/u/.claude/projects/-p/sess1.jsonl'
  const PAGE = '/home/u/.claude/ccwarden/dashboard.html'
  const cw = (args = '') => ({ command: 'cw', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
  const line = JSON.stringify({ type: 'assistant', cwd: '/p', timestamp: new Date(NOW - 60 * MIN).toISOString(), message: { id: 'a', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 1_000 } } })
  const files = { [TRANSCRIPT]: line, '/home/u/.claude/projects/-q/big.jsonl': 'x' }
  const pages = (w: World) => w.writes.filter(f => f.path === PAGE)
  async function begin($: Engine, w: World, surface: RenderSurface) {
    await w.clock.advance(NOW)
    await $.classic.SessionStart({ source: 'resume', transcript_path: TRANSCRIPT })
    await $.session.start(start(surface))
  }

  for (const surface of SURFACES) {
    test(`writes the page next to the transcripts and opens it, Windows (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files, env: { OS: 'Windows_NT' } })
      await begin($, w, surface)
      await $.command.run(cw('open'))
      expect(pages(w)).toHaveLength(1)
      expect(pages(w)[0]!.text).toContain('<b>p</b><span class="path">/p</span>')
      expect(pages(w)[0]!.text).toContain('2 of 2 transcripts read')
      expect(w.runs.at(-1)).toEqual(['cmd', '/c', 'start', '', PAGE])
      expect(w.logs).toContain(`ccwarden: dashboard opened in your browser (${PAGE}).`)
      expect(w.opened).toEqual([]) // /cw open doesn't open the pane
      expect(Object.keys(w.store.get('transcriptSummaries') as object)).toEqual([TRANSCRIPT, '/home/u/.claude/projects/-q/big.jsonl'])
    })

    test(`macOS opens with open; a failing opener logs the path (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files, uname: 'Darwin' })
      await begin($, w, surface)
      w.openerExit = 1
      await $.command.run(cw('open'))
      expect(w.runs.at(-1)).toEqual(['open', PAGE])
      expect(w.logs).toContain(`ccwarden: dashboard written to ${PAGE}; open it in a browser.`)
    })

    test(`the timer and session end rewrite it only after /cw open has run once (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files })
      await begin($, w, surface)
      await w.clock.advance(11 * MIN)
      await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
      expect(pages(w)).toHaveLength(0)

      await $.command.run(cw('open'))
      await w.clock.advance(5 * MIN)
      expect(pages(w)).toHaveLength(2)
      await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
      expect(pages(w)).toHaveLength(3)
    })

    test(`plain /cw, /cw spent and /cw budget are unchanged after /cw open (${surface})`, { options: { billing: 'metered', monthlyBudgetUsd: 100 } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files, store: { ledger: { days: { '2026-10-02': 20 } } } })
      await begin($, w, surface)
      await $.command.run(cw('open'))
      await $.command.run(cw())
      expect(w.logs).toContain('ccwarden: this month $20.00 of your $100 budget on this machine (est.), ~$248 at this pace; budget mode off.')
      expect(w.opened).toEqual(['ccwarden-cw'])
      await $.command.run(cw('spent 30'))
      expect(w.logs).toContain('ccwarden: month to date calibrated to $30.00; the estimate counts on from there.')
      await $.command.run(cw('nonsense'))
      expect(w.logs.at(-1)).toBe('ccwarden: /cw, /cw open, /cw spent <amount>, /cw budget on|off|auto')
    })
  }

  test('no transcripts folder: the page still writes and the summary cache is kept', { options: { billing: 'metered' } }, async ($, on) => {
    const cached = { '/old/a.jsonl': { mtimeMs: 1, size: 1, junk: 0, summary: { days: {}, junk: [] } } }
    const w = world(on, { surfaces: ['terminal'], env: { HOME: '/home/u' }, store: { transcriptSummaries: cached } })
    w.messages = []
    await w.clock.advance(NOW)
    await $.session.start(start('terminal'))
    await $.command.run(cw('open'))
    expect(pages(w)).toHaveLength(1)
    expect(pages(w)[0]!.text).toContain('0 of 0 transcripts read')
    expect(w.store.get('transcriptSummaries')).toEqual(cached)
  })
})

describe('F15 metrics log', () => {
  const METRICS = '/home/u/.claude/ccwarden/metrics/sess1.jsonl'
  const HOME = { HOME: '/home/u' }
  const metricsOf = (w: World, path = METRICS) => {
    const f = w.writes.filter(x => x.path === path).at(-1)
    return f === undefined ? undefined : parseFile(f.text)
  }
  const spawn = (subagentType: string, extra: Record<string, unknown> = {}) => ({
    tool_use_id: `t-${subagentType}`, prompt: 'Find where sessions expire.', description: 'find expiry', subagentType,
    provider: { plugin: 'engine', tier: 'core' } as const, parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra,
  })
  const subTurn = (agentId: string, model = 'claude-haiku-4-5-20251001', input = 1_000_000) => ({
    ...turnDone(model), agentId, usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model },
  })
  const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`a pinned subagent: the pin, then its measured saving; the session record (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], env: HOME })
        await $.session.start(start(surface))
        const s = await $.agent.spawn(spawn('Explore', { model: 'opus' }))
        await $.turn.complete(subTurn(s.agentId!))
        await $.turn.complete(turnDone())
        const m = metricsOf(w)!
        const pinned = m.events.find(e => e.action === 'pinned')!
        expect(pinned).toMatchObject({ feature: 'subagent', measured: { type: 'Explore', asked: 'opus', ran: 'haiku' } })
        expect(pinned.est).toBeUndefined()
        const out = m.events.find(e => e.action === 'outcome' && e.ref === pinned.ref)!
        expect(out.est).toMatchObject({ usd: 3, confidence: 'high', formula: 'subagent tokens × (price opus − price haiku)' })
        expect(m.records[0]).toMatchObject({ session: 'sess1', project: '/p', part: 1, measuring: false, holdout: false, family: 'sonnet' })
        expect(m.records[0]!.subagentUsd).toBe(1)
      })
    }
  }

  test('no model named: the parent model is assumed, at medium confidence; a denied spawn is counted', { options: { billing: 'metered', maxParallelAgents: 1 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    const s = await $.agent.spawn(spawn('Explore'))
    await $.agent.spawn(spawn('Explore', { tool_use_id: 't2' }))
    await $.turn.complete(subTurn(s.agentId!))
    await $.turn.complete(turnDone())
    const m = metricsOf(w)!
    expect(m.events.find(e => e.action === 'pinned')!.measured.asked).toBe('claude-opus-5-5')
    expect(m.events.find(e => e.action === 'outcome')!.est!.confidence).toBe('medium')
    expect(m.events.filter(e => e.action === 'denied')).toHaveLength(1)
  })

  for (const surface of SURFACES) {
    test(`a spend alert and a summary compaction are logged, count only (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], env: HOME })
      await $.session.start(start(surface))
      w.usage.usd = 5.5
      await $.session.measure(measure(w))
      await $.session.compact({ trigger: 'manual', instructions: 'the auth design', messages: [{ role: 'user', text: 'Fix the login bug', toolUses: [] }] })
      await $.turn.complete(turnDone())
      const m = metricsOf(w)!
      expect(m.events.find(e => e.feature === 'alert')).toMatchObject({ action: 'sent', measured: { kind: 'session', shown: true } })
      expect(m.events.find(e => e.feature === 'compact')).toMatchObject({ action: 'summarised', measured: { trigger: 'manual' } })
      expect(m.events.filter(e => e.feature === 'alert' || e.feature === 'compact').map(e => e.est)).toEqual([undefined, undefined])
    })
  }

  test('a cold-cache ask: the ask, and the rebuild saved when the prompt was kept back', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Cancel', usage: { tokens: 180_000 }, env: HOME })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(17 * MIN)
    await $.prompt.submit(typed('continue with the refactor'))
    const m = metricsOf(w)!
    const asked = m.events.find(e => e.feature === 'cold' && e.action === 'asked')!
    expect(asked.measured).toMatchObject({ tokens: 180_000, minutesCold: 12 })
    const est = m.events.find(e => e.action === 'outcome' && e.ref === asked.ref)!.est!
    expect([est.tokens, Math.round(est.usd * 1e4) / 1e4]).toEqual([180_000, 0.45])
  })

  test('prompts and requests are counted; session end writes the file', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' } }
    })
    await $.session.start(start('terminal'))
    await $.turn.start({ text: 'hi', turnId: 't' })
    for (const index of [0, 1]) { const s = $.turn.step({ turnId: 't', index, model: 'claude-sonnet-5-5', messageCount: 2 }); for await (const _ of s); }
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
    expect(metricsOf(w)!.records[0]).toMatchObject({ prompts: 1, requests: 2 })
  })

  test('a file that exists but cannot be read is never overwritten', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME, files: { [METRICS]: 'earlier events\n' }, unreadable: [METRICS] })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
    expect(w.writes.filter(f => f.path === METRICS)).toEqual([])
    expect(w.logs.filter(l => l.includes("couldn't read the metrics log"))).toHaveLength(1)
  })

  test('parallel tool calls in the same millisecond each keep their event and saving', { options: { billing: 'metered' } }, async ($, on) => {
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
    const w = world(on, { surfaces: ['terminal'], env: HOME, files: { '/p/a.log': long, '/p/b.log': long } })
    await $.session.start(start('terminal'))
    await Promise.all(['/p/a.log', '/p/b.log'].map(file_path => $.tool.call({ tool: 'Read', file_path })))
    await $.turn.complete(turnDone())
    const m = metricsOf(w)!
    const kept = m.events.filter(e => e.action === 'would-keep-out')
    expect(kept.map(e => e.measured.target).sort()).toEqual(['/p/a.log', '/p/b.log'])
    expect(new Set(kept.map(e => e.ref)).size).toBe(2)
    expect(m.events.filter(e => e.feature === 'junk' && e.action === 'outcome')).toHaveLength(2)
  })

  test('a reload reads the file back and goes on from it', { options: { billing: 'metered' } }, async ($, on) => {
    const before = `${JSON.stringify({ v: 1, at: 1, feature: 'handoff', action: 'written', measured: {} })}\n${JSON.stringify({ v: 1, record: 'session', session: 'sess1', part: 1, project: '/p', startedAt: 1, lastAt: 1, measuring: false, holdout: false, familyTurns: {}, prompts: 3, requests: 4, tokens: { input: 0, read: 0, write: 0, output: 0 }, usd: 0, subagentUsd: 0, events: 1, truncated: false })}\n`
    const w = world(on, { surfaces: ['terminal'], env: HOME, files: { [METRICS]: before } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    const m = metricsOf(w)!
    expect(m.events[0]!.feature).toBe('handoff')
    expect(m.records[0]).toMatchObject({ prompts: 3, requests: 4, startedAt: 1, family: 'sonnet' })
  })

  test('/clear with the same id starts part 2', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await $.session.end({ reason: 'clear', sessionId: 'sess1', resume: { id: 'sess1' } })
    await $.turn.complete(turnDone())
    expect(metricsOf(w)!.records.map(r => r.part)).toEqual([1, 2])
  })

  test('a refused write is logged once and retried at the next flush', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    w.refuseWrites = true
    await $.turn.complete(turnDone())
    await $.turn.complete(turnDone())
    expect(w.logs.filter(l => l.startsWith("ccwarden: couldn't write the metrics log"))).toHaveLength(1)
    w.refuseWrites = false
    await $.turn.complete(turnDone())
    expect(metricsOf(w)!.records[0]!.familyTurns).toEqual({ sonnet: 3 })
  })

  test('with no Claude folder nothing is written', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    expect(w.writes).toEqual([])
  })

  const run = async ($: Engine) => { const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 2 }); for await (const _ of s); }
  const stepAnswer = () => ({ turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' } })

  test('a holdout compaction ends the re-reads a junk would-saving counts', { options: { billing: 'metered', measureHoldout: true } }, async ($, on) => {
    const LONG = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join('\n')
    const w = world(on, { surfaces: ['terminal'], env: HOME, sessionId: 'sess5', files: { '/p/big.log': LONG } })
    on('turn.step', async function* () { return stepAnswer() })
    await $.session.start(start('terminal'))
    await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })
    await run($) // writes the output: not a re-read
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'Ship it', toolUses: [] }] })
    await run($)
    await run($)
    await $.turn.complete(turnDone())
    const m = metricsOf(w, '/home/u/.claude/ccwarden/metrics/sess5.jsonl')!
    const kept = m.events.find(e => e.action === 'would-keep-out')!
    expect(m.events.find(e => e.action === 'outcome' && e.ref === kept.ref)!.measured.requestsAfter).toBe(0)
  })

  test('a holdout after /clear gets back the compact window it had before ccwarden set one', { options: { billing: 'metered', measureHoldout: true } }, async ($, on) => {
    const opts: Parameters<typeof world>[1] = { surfaces: ['terminal'], env: { ...HOME, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' }, sessionId: 'sess1' }
    const w = world(on, opts)
    await $.session.start(start('terminal'))
    expect(w.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).not.toBe('900000') // a protected session: ccwarden's window
    await $.session.end({ reason: 'clear', sessionId: 'sess1', resume: { id: 'sess1' } })
    opts.sessionId = 'sess5' // the new conversation is a holdout
    await $.turn.complete(turnDone())
    expect(w.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBe('900000')
  })

  test('a keep-warm ping is in the record\'s $: ccwarden\'s own spend counts against it', { options: { billing: 'metered', keepWarm: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME, usage: { tokens: 180_000 } })
    await $.session.start(start('terminal'))
    await $.prompt.submit(typed('go'))
    await $.turn.start({ text: 'go', turnId: 't' })
    await $.turn.complete(turnDone())
    const before = metricsOf(w)!.records[0]!.usd
    await w.clock.advance(4.5 * MIN)
    expect(w.forks).toEqual(['Reply with OK.'])
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
    const m = metricsOf(w)!
    const ping = m.events.find(e => e.action === 'ping')!
    expect(Math.round(m.records[0]!.usd * 1e9)).toBe(Math.round((before - ping.est!.usd) * 1e9))
  })

  test('the page refresh reads an unchanged metrics file once', { options: { billing: 'metered' } }, async ($, on) => {
    const OLD = '/home/u/.claude/ccwarden/metrics/old.jsonl'
    const w = world(on, { surfaces: ['terminal'], env: HOME, files: { [OLD]: `${JSON.stringify({ v: 1, at: 1, feature: 'handoff', action: 'written', measured: {} })}\n` } })
    await $.session.start(start('terminal'))
    await $.command.run({ command: 'cw', args: 'open', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    await w.clock.advance(10 * MIN) // two refreshes
    expect(w.fsReads.filter(p => p === OLD)).toHaveLength(2) // once for its summary, once for its events
  })

  test('junk kept out: the event, then its saving from the requests after, settled at session end', { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
    const LONG = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join('\n')
    const w = world(on, { surfaces: ['terminal'], env: HOME, files: { '/p/big.log': LONG } })
    on('turn.step', async function* () { return stepAnswer() })
    await $.session.start(start('terminal'))
    await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })
    for (let i = 0; i < 3; i++) await run($)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
    const m = metricsOf(w)!
    const kept = m.events.find(e => e.feature === 'junk' && e.action === 'kept-out')!
    expect(kept.measured).toMatchObject({ tool: 'Read', chars: LONG.split('\n').slice(0, 2_000).join('\n').length }) // core's first page, not the whole file
    expect(m.events.find(e => e.action === 'outcome' && e.ref === kept.ref)!.measured.requestsAfter).toBe(2)
  })

  test('a snapshot, a limit hint and a handoff each leave an event', { options: { billing: 'metered', limitOther: 100_000 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME, usage: { tokens: 120_000 } })
    await $.session.start(start('terminal'))
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'Ship it', toolUses: [] }] })
    await $.command.run({ command: 'handoff', args: 'quick', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    await $.turn.complete(turnDone())
    const m = metricsOf(w)!
    expect(m.events.find(e => e.feature === 'snapshot')!.est).toMatchObject({ tokens: 122_000, confidence: 'low' })
    expect(m.events.find(e => e.feature === 'handoff')!.measured.route).toBe('quick')
    expect(m.events.find(e => e.feature === 'limit')!.measured).toMatchObject({ tokens: 120_000, limit: 100_000 })
  })

  test("a topic clear's saving counts the next conversation's requests", { options: { billing: 'metered', topicShiftHint: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Clear', usage: { tokens: 90_000 }, env: HOME })
    on('turn.step', async function* () { return stepAnswer() })
    w.messages.push({ role: 'user', text: 'fix the snapshot compaction for the haiku limit', toolUses: [] }, { role: 'assistant', text: 'Done: compaction now writes a snapshot at the haiku limit.', toolUses: [] })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(MIN)
    await $.prompt.submit(typed('write a python scraper for weather forecast data'))
    await w.clock.advance(0) // /clear runs once the drop has settled
    await run($)
    await run($)
    await $.turn.complete(turnDone())
    const m = metricsOf(w)!
    const cleared = m.events.find(e => e.feature === 'topic' && e.action === 'cleared')!
    expect(cleared.measured.tokens).toBe(90_000)
    expect(m.events.find(e => e.action === 'outcome' && e.ref === cleared.ref)!.measured.requestsAfter).toBe(2)
  })

  test('/cw open puts the logged savings on the page', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    const s = await $.agent.spawn(spawn('Explore', { model: 'opus' }))
    await $.turn.complete(subTurn(s.agentId!))
    await $.turn.complete(turnDone())
    await $.command.run({ command: 'cw', args: 'open', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    const page = w.writes.filter(f => f.path === '/home/u/.claude/ccwarden/dashboard.html').at(-1)!.text
    expect(page).toContain('Subagent guard')
    expect(page).toContain('data-session="sess1"') // the sessions table and the event log
    expect(page).toContain('<tr data-feature="subagent" data-session="sess1">')
    expect(page).toContain('Raw files: <code>/home/u/.claude/ccwarden/metrics</code>')
    expect(Object.keys(w.store.get('metricsSummaries') as object)).toEqual([METRICS])
  })

  const METRICS5 = '/home/u/.claude/ccwarden/metrics/sess5.jsonl'
  for (const surface of SURFACES) {
    test(`a holdout session: nothing pinned, asked, denied or compacted by ccwarden; would-have events; status says holdout (${surface})`, { options: { billing: 'metered', measureHoldout: true, junkGuard: 'enforce' } }, async ($, on) => {
      const LONG = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join('\n')
      const w = world(on, { surfaces: [surface], env: HOME, sessionId: 'sess5', answer: 'Cancel', usage: { tokens: 180_000 }, files: { '/p/big.log': LONG } })
      await $.session.start(start(surface))
      expect(w.status.at(-1)).toContain('holdout')
      expect(w.logs).toContain('ccwarden: proof mode: this session is a holdout, so guards are off and what they would have done is logged.')
      expect(w.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBeUndefined()

      const s = await $.agent.spawn(spawn('Explore', { model: 'opus' }))
      expect(w.spawned[0]!.model).toBe('opus')
      expect(w.spawned[0]!.prompt).toBe('Find where sessions expire.')
      await $.turn.complete(subTurn(s.agentId!, 'claude-opus-5-5'))

      await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })
      expect(w.reads).toContain('/p/big.log')

      await $.turn.complete(turnDone())
      await w.clock.advance(17 * MIN)
      await $.prompt.submit(typed('continue with the refactor'))
      expect(w.asks).toEqual([])
      expect(w.sent).toContain('continue with the refactor')

      await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'Ship it', toolUses: [] }] })
      expect(w.coreCompactions).toHaveLength(1)

      await $.turn.complete(turnDone())
      const m = metricsOf(w, METRICS5)!
      expect(m.records[0]).toMatchObject({ measuring: true, holdout: true })
      const pin = m.events.find(e => e.feature === 'subagent' && e.action === 'pinned')!
      expect(pin.would).toBe(true)
      expect(m.events.find(e => e.action === 'outcome' && e.ref === pin.ref)!.est!.usd).toBe(3) // opus 1M input − haiku
      for (const f of ['subagent', 'junk', 'cold', 'snapshot']) expect(m.events.some(e => e.would === true && e.feature === f)).toBe(true)
    })
  }

  test('measuring, but not a holdout id: guards on, the record says measuring', { options: { billing: 'metered', measureHoldout: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    await $.agent.spawn(spawn('Explore'))
    await $.turn.complete(turnDone())
    expect(w.spawned[0]!.model).toBe('haiku')
    expect(w.status.at(-1)).not.toContain('holdout')
    expect(metricsOf(w)!.records[0]).toMatchObject({ measuring: true, holdout: false })
  })

  test('a holdout id with measureHoldout off is protected', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME, sessionId: 'sess5' })
    await $.session.start(start('terminal'))
    await $.agent.spawn(spawn('Explore'))
    expect(w.spawned[0]!.model).toBe('haiku')
  })
})
