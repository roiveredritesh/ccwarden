import { describe, expect, mock, test } from 'claude-code/testing'
import type { ConfigRow, On, RenderSurface } from 'claude-code'
import { BILLING_OPTIONS, BILLING_QUESTION } from '../src/billing'

const SURFACES = ['terminal', 'desktop'] as const
const BILLINGS = ['metered', 'window'] as const

// Stands in for the engine beneath the mod and keeps what it was asked to
// show. `answer` is what the person picks in $.ui.ask (undefined: dismissed).
function world(on: On, opts: { surfaces?: readonly RenderSurface[]; answer?: string; usd?: number } = {}) {
  const clock = mock.clock(on)
  const shown = {
    clock,
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
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: opts.usd ?? 0 } } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
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

const start = (surface: RenderSurface) => ({ cwd: '/p', surface, isInteractive: true })
const measured = (usd: number) => ({ context: { window: 200_000 }, rateLimits: [], cost: { usd }, changed: ['cost' as const] })

describe('spend alert (F1b first slice) under the toast budget (R9)', () => {
  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`a toast per $5 step, at most 3 an hour (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const shown = world(on, { surfaces: [surface] })
        await $.session.start(start(surface))

        for (const usd of [1, 5.1, 10.2, 15.3, 20.4]) await $.session.measure(measured(usd))

        expect(shown.toasts).toHaveLength(3)
        expect(shown.toasts[0]).toContain('$5.10')
        expect(shown.toasts[0]).toContain('(est.)')
        expect(shown.status.at(-1)).toBe('this chat $20.40 ⚠')
        expect(shown.asks).toEqual([]) // billing is set: no question
      })
    }

    test(`a reload mid-conversation doesn't alert the same step again (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const shown = world(on, { surfaces: [surface], usd: 7 })
      await $.session.start(start(surface))
      await $.session.measure(measured(7.5))
      expect(shown.toasts).toEqual([])
    })

    test(`/clear starts the count over (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const shown = world(on, { surfaces: [surface] })
      await $.session.start(start(surface))
      await $.session.measure(measured(6))
      await $.session.measure(measured(0.2)) // after /clear: no session.start, the total restarts
      await $.session.measure(measured(5.5))
      expect(shown.toasts).toHaveLength(2)
    })
  }
})

describe('first-run billing question', () => {
  for (const surface of SURFACES) {
    test(`asks once and saves the answer (${surface})`, async ($, on) => {
      const shown = world(on, { surfaces: [surface], answer: BILLING_OPTIONS[1] })
      await $.session.start(start(surface))
      await shown.clock.advance(0)

      expect(shown.asks).toEqual([BILLING_QUESTION])
      expect(shown.configSets).toEqual([{ key: 'ccwarden.billing', value: 'window' }])

      await $.session.start(start(surface)) // a reload: not asked again this session
      await shown.clock.advance(0)
      expect(shown.asks).toHaveLength(1)
    })

    test(`a dismissal saves nothing and says how to set it (${surface})`, async ($, on) => {
      const shown = world(on, { surfaces: [surface] })
      await $.session.start(start(surface))
      await shown.clock.advance(0)

      expect(shown.asks).toHaveLength(1)
      expect(shown.configSets).toEqual([])
      expect(shown.logs.at(-1)).toContain('/config')
    })
  }

  test('headless: nobody to ask', async ($, on) => {
    const shown = world(on, { surfaces: [] })
    await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
    await shown.clock.advance(0)
    expect(shown.asks).toEqual([])
  })
})
