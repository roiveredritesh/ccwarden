import { describe, expect, test } from 'claude-code/testing'
import { addEvent, addTurn, addUsage, coldEstimate, emptyFile, fnv1a, isHoldoutId, junkEstimate, MAX_FILE_CHARS, newRecord, nextPart, parseFile, pendingOutcome, pinEstimate, putOutcome, resume, serialize, summarizeMetrics, topicEstimate, usageUsd } from '../src/metrics'
import type { MetricEvent, Usage } from '../src/metrics'

const r4 = (n: number) => Math.round(n * 1e4) / 1e4
const u = (model: string, x: Partial<Usage> = {}): Usage => ({ model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...x })
const ev = (x: Partial<MetricEvent> = {}): MetricEvent => ({ v: 1, at: 1, feature: 'handoff', action: 'written', measured: {}, ...x })
const rec = () => newRecord({ session: 'sess1', project: '/p', now: 100, measuring: false })

describe('F15 holdout choice', () => {
  test('FNV-1a 32-bit, and 1 in 10 ids are holdouts', () => {
    expect(fnv1a('sess1')).toBe(3256376694)
    expect(isHoldoutId('sess5')).toBe(true)
    expect(isHoldoutId('sess1')).toBe(false)
    let n = 0
    for (let i = 0; i < 10_000; i++) if (isHoldoutId(`id-${i}`)) n++
    expect(n > 900 && n < 1100).toBe(true)
  })

  test('a record is a holdout only when measuring', () => {
    expect(newRecord({ session: 'sess5', project: '/p', now: 1, measuring: true }).holdout).toBe(true)
    expect(newRecord({ session: 'sess5', project: '/p', now: 1, measuring: false }).holdout).toBe(false)
    expect(newRecord({ session: 'sess1', project: '/p', now: 1, measuring: true }).holdout).toBe(false)
  })
})

describe('F15 session record', () => {
  test('a main turn adds tokens, $ and its family; a subagent turn adds $ to subagentUsd only', () => {
    let r = addTurn(rec(), u('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 }), false, 200)
    expect(r.tokens).toEqual({ input: 1_000_000, read: 0, write: 0, output: 100_000 })
    expect(r4(r.usd)).toBe(3) // $2 + 100k × $10
    expect([r.family, r.familyTurns, r.lastAt]).toEqual(['sonnet', { sonnet: 1 }, 200])
    r = addTurn(r, u('claude-haiku-4-5-20251001', { input_tokens: 1_000_000 }), true, 300)
    expect([r4(r.usd), r4(r.subagentUsd), r.familyTurns]).toEqual([4, 1, { sonnet: 1 }])
  })

  test('usage adds up; an unknown model has no price', () => {
    expect(addUsage(u('a', { input_tokens: 1 }), u('b', { input_tokens: 2, output_tokens: 3 }))).toEqual(u('b', { input_tokens: 3, output_tokens: 3 }))
    expect(addUsage(undefined, u('b', { input_tokens: 2 }))).toEqual(u('b', { input_tokens: 2 }))
    expect(usageUsd(u('mystery', { input_tokens: 5 }))).toBeUndefined()
  })
})

describe('F15 file', () => {
  test('events, earlier parts and the current record, one JSON line each; read back the same', () => {
    let f = addEvent(emptyFile(rec()), ev({ at: 5 }))
    f = nextPart(f, 500)
    f = addEvent(f, ev({ at: 6 }))
    const back = parseFile(serialize(f))
    expect(back.events.map(e => e.at)).toEqual([5, 6])
    expect(back.records.map(r => [r.part, r.events, r.startedAt])).toEqual([[1, 1, 100], [2, 1, 500]])
    expect(back.skipped).toBe(0)
  })

  test('lines that are not JSON or carry another version are skipped and counted', () => {
    const back = parseFile(`${JSON.stringify(ev())}\nnot json\n${JSON.stringify({ ...ev(), v: 2 })}\n\n`)
    expect([back.events.length, back.skipped]).toEqual([1, 2])
  })

  test('a reload goes on from the newest part and keeps the earlier ones', () => {
    const text = serialize(addEvent(nextPart(addEvent(emptyFile(rec()), ev()), 500), ev()))
    const f = resume(text, newRecord({ session: 'sess1', project: '/p', now: 900, measuring: false }))
    expect([f.events.length, f.done.map(r => r.part), f.record.part, f.record.startedAt]).toEqual([2, [1], 2, 500])
    expect(resume('', rec()).record.startedAt).toBe(100) // nothing on disk: the fallback
  })

  test('an outcome is replaced by ref, not added again', () => {
    let f = putOutcome(emptyFile(rec()), ev({ action: 'outcome', ref: 'a', measured: { n: 1 } }))
    f = putOutcome(f, ev({ action: 'outcome', ref: 'a', measured: { n: 2 } }))
    expect(f.events.map(e => e.measured.n)).toEqual([2])
    expect(f.record.events).toBe(1)
  })

  test('past MAX_FILE_CHARS no event is added and the record says so', () => {
    const f = addEvent(emptyFile(rec()), ev({ measured: { x: 'a'.repeat(MAX_FILE_CHARS) } }))
    expect([f.events.length, f.record.truncated]).toEqual([0, true])
    expect(addEvent(f, ev()).events.length).toBe(0)
  })
})

describe('F15 estimates', () => {
  test('a pin: the subagent tokens at the model it would have run on, less what they cost', () => {
    const e = pinEstimate(u('haiku', { input_tokens: 1_000_000, output_tokens: 10_000 }), 'opus', 'haiku', 'high')!
    expect(r4(e.usd)).toBe(3.15) // (4 − 1) + 10k × (20 − 5) / 1M
    expect(e).toMatchObject({ tokens: 0, confidence: 'high', formula: 'subagent tokens × (price opus − price haiku)' })
    expect(pinEstimate(u('haiku'), 'claude-haiku-4-5-20251001', 'haiku', 'high')).toBeUndefined()
    expect(pinEstimate(u('haiku'), 'mystery', 'haiku', 'high')).toBeUndefined()
  })

  test('a cold ask saves the rebuild when the prompt was not sent', () => {
    expect(coldEstimate('keep', 180_000, 0.45)).toMatchObject({ tokens: 180_000, usd: 0.45, confidence: 'medium' })
    expect(coldEstimate('handoff', 180_000, 0.45).usd).toBe(0.45)
    expect(coldEstimate('send', 180_000, 0.45)).toMatchObject({ tokens: 0, usd: 0 })
  })
})

describe('F15 pending savings', () => {
  test('kept-out output: written once, re-read by each later request; a dropped context: not re-read', () => {
    expect(junkEstimate(10_000, 'sonnet', 2)).toMatchObject({ tokens: 30_000, confidence: 'medium' })
    expect(r4(junkEstimate(10_000, 'sonnet', 2).usd)).toBe(0.029)
    expect(topicEstimate(100_000, 'opus', 3)).toMatchObject({ tokens: 300_000 })
    expect(r4(topicEstimate(100_000, 'opus', 3).usd)).toBe(0.06)
  })

  test('the outcome: junk counts the requests after the first, topic all of them; would carried over', () => {
    const junk = pendingOutcome({ ref: 'j', feature: 'junk', at: 7, tokens: 10_000, family: 'sonnet', requests: 3, would: true })
    expect(junk).toMatchObject({ at: 7, feature: 'junk', action: 'outcome', ref: 'j', would: true, measured: { requestsAfter: 2 } })
    expect(junk.est!.tokens).toBe(30_000)
    const topic = pendingOutcome({ ref: 't', feature: 'topic', at: 8, tokens: 100_000, family: 'opus', requests: 3, would: false })
    expect([topic.would, topic.measured.requestsAfter, topic.est!.tokens]).toEqual([undefined, 3, 300_000])
  })
})

describe('F15 file summary', () => {
  const DAY = Date.parse('2026-10-03T10:00:00Z')
  test('per day and feature: originals count, estimates add, would apart; the records and project', () => {
    const f0 = emptyFile(newRecord({ session: 's', project: '/p', now: DAY, measuring: true }))
    let f = addEvent(f0, ev({ at: DAY, feature: 'cold', action: 'asked', ref: 'c' }))
    f = addEvent(f, ev({ at: DAY, feature: 'cold', action: 'outcome', ref: 'c', est: { tokens: 9, usd: 0.5, formula: 'x', confidence: 'medium' } }))
    f = addEvent(f, ev({ at: DAY, feature: 'junk', action: 'would-keep-out', would: true, est: { tokens: 4, usd: 0.1, formula: 'x', confidence: 'medium' } }))
    const s = summarizeMetrics(serialize(f), 's')
    expect(s.days['2026-10-03']!.cold).toEqual({ done: { count: 1, tokens: 9, usd: 0.5 }, would: { count: 0, tokens: 0, usd: 0 } })
    expect(s.days['2026-10-03']!.junk!.would).toEqual({ count: 1, tokens: 4, usd: 0.1 })
    expect([s.project, s.records.length, s.estUsd, s.wouldUsd, s.skipped]).toEqual(['/p', 1, 0.5, 0.1, 0])
  })
})
