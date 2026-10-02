import { describe, expect, mock, test } from 'claude-code/testing'
import type { ConfigRow, On, RenderSurface, SessionRateLimit } from 'claude-code'
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
} = {}) {
  const clock = mock.clock(on)
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
  on('fs.stat', () => (opts.transcript === undefined ? Promise.reject(new Error('ENOENT')) : { value: { kind: 'file', size: opts.transcript.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => (opts.transcript === undefined ? Promise.reject(new Error('ENOENT')) : { value: opts.transcript }))
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
