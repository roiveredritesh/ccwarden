import { describe, expect, test } from 'claude-code/testing'
import { addProjectDay, projectKey, snapshotSaving } from '../src/efficiency'
import { requestsOf } from '../src/report'

// Floating sums compared to 4 decimals (the kit has no toBeCloseTo).
const r4 = (n: number) => Math.round(n * 1e4) / 1e4

describe('F14 projectDays', () => {
  test('a project path files under one key: slashes, no trailing slash, drive letter lower-cased', () => {
    expect(projectKey('D:\\work\\app\\')).toBe('d:/work/app')
    expect(projectKey('d:/work/app')).toBe('d:/work/app')
    expect(projectKey('/home/u/app/')).toBe('/home/u/app')
  })

  test('sums per project and day, keeps the peak context, drops days over 400 old', () => {
    let pd = addProjectDay(undefined, 'D:\\work\\app\\', '2026-10-01', { usd: 1.5, turns: 1, peakContext: 50_000 })
    pd = addProjectDay(pd, 'd:/work/app', '2026-10-01', { usd: 0.25, turns: 1, peakContext: 20_000 })
    expect(pd).toEqual({ 'd:/work/app': { '2026-10-01': { usd: 1.75, turns: 2, peakContext: 50_000 } } })
    // 2027-11-10 is 405 days on: the old day goes, and the project with it.
    pd = addProjectDay(pd, '/other', '2027-11-10', { handoffs: 1 })
    expect(pd).toEqual({ '/other': { '2027-11-10': { handoffs: 1 } } })
  })

  test('a snapshot saves the summary request: context read from the cache plus its output', () => {
    const s = snapshotSaving(100_000, 'claude-sonnet-5-5')!
    expect(r4(s.usd)).toBe(0.04) // (100k × \$0.20 + 2k × \$10) / 1M
    expect(s.tokens).toBe(102_000)
    expect(snapshotSaving(100_000, 'some-other-model')).toBeUndefined()
  })

  test('requestsOf counts output tokens', () => {
    const entry = { type: 'assistant', timestamp: '2026-10-01T10:00:00Z', message: { id: 'a', model: 'm', usage: { input_tokens: 1, output_tokens: 700 } } }
    expect(requestsOf([entry] as never)[0]!.output).toBe(700)
  })
})