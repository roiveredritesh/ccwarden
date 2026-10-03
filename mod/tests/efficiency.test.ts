import { describe, expect, test } from 'claude-code/testing'
import { addProjectDay, claudeDirOf, isFresh, junkTimesBySession, openerArgv, projectKey, sessionOf, snapshotSaving, summarize } from '../src/efficiency'
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
    expect(r4(s.usd)).toBe(0.04) // (100k × $0.20 + 2k × $10) / 1M
    expect(s.tokens).toBe(102_000)
    expect(snapshotSaving(100_000, 'some-other-model')).toBeUndefined()
  })

  test('requestsOf counts output tokens', () => {
    const entry = { type: 'assistant', timestamp: '2026-10-01T10:00:00Z', message: { id: 'a', model: 'm', usage: { input_tokens: 1, output_tokens: 700 } } }
    expect(requestsOf([entry] as never)[0]!.output).toBe(700)
  })
})

describe('F14 transcript summaries', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z')
  const row = (id: string, min: number, u: Record<string, number>) => ({
    type: 'assistant', cwd: 'D:\\p\\', timestamp: new Date(T0 + min * 60_000).toISOString(),
    message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u } },
  })
  const entries = [
    row('a', 0, { cache_creation_input_tokens: 40_000, output_tokens: 1_000 }),
    row('b', 1, { cache_read_input_tokens: 40_000, cache_creation_input_tokens: 10_000 }), // writes the junk result
    row('c', 2, { cache_read_input_tokens: 50_000 }),
    row('d', 3, { cache_read_input_tokens: 50_000 }),
    { type: 'system', subtype: 'compact_boundary' },
    row('e', 4, { cache_creation_input_tokens: 15_000 }),
  ]

  test('by day: requests, tokens, $ at list price, rebuilds, context; the project from cwd', () => {
    const s = summarize(entries as never)
    const day = s.days['2026-10-01']!
    expect(s.project).toBe('d:/p')
    expect({ ...day, usd: 0 }).toEqual({ requests: 5, input: 0, read: 140_000, write: 65_000, output: 1_000, usd: 0, rebuilds: 1, context: 205_000 })
    expect(r4(day.usd)).toBe(0.2005) // 65k × $2.50 + 140k × $0.20 + 1k × $10, per million
    expect(s.junk).toEqual([])
  })

  test('a junk event: the requests that re-read it, up to the next compaction', () => {
    const s = summarize(entries as never, [T0 + 30_000, T0 + 10 * 60_000])
    // b writes it, c and d read it, e comes after a compaction.
    expect(s.junk[0]).toEqual({ at: T0 + 30_000, requestsAfter: 2, family: 'sonnet' })
    // Nothing after it: counted, never priced.
    expect(s.junk[1]).toEqual({ at: T0 + 10 * 60_000, requestsAfter: 0 })
  })

  test('the cache: fresh only while mtime, size and the junk count all match', () => {
    const entry = { mtimeMs: 5, size: 100, junk: 1, summary: { days: {}, junk: [] } }
    expect(isFresh(entry, { mtimeMs: 5, size: 100 }, 1)).toBe(true)
    expect(isFresh(entry, { mtimeMs: 6, size: 100 }, 1)).toBe(false)
    expect(isFresh(entry, { mtimeMs: 5, size: 101 }, 1)).toBe(false)
    expect(isFresh(entry, { mtimeMs: 5, size: 100 }, 2)).toBe(false)
  })

  test('junk times by session; events from before F14 have none', () => {
    const ev = (at: number, session?: string) => ({ at, tool: 'Read' as const, mode: 'enforce' as const, target: 'x', size: 1, savedChars: 4, ...(session === undefined ? {} : { session }) })
    expect(junkTimesBySession([ev(1, 's1'), ev(2), ev(3, 's1'), ev(4, 's2')])).toEqual({ s1: [1, 3], s2: [4] })
    expect(sessionOf('C:\\Users\\u\\.claude\\projects\\C--p\\abc.jsonl')).toBe('abc')
  })

  test('the Claude folder from a transcript path, either separator', () => {
    expect(claudeDirOf('/home/u/.claude/projects/-p/s1.jsonl')).toBe('/home/u/.claude')
    expect(claudeDirOf('C:\\Users\\u\\.claude\\projects\\C--p\\s1.jsonl')).toBe('C:\\Users\\u\\.claude')
    expect(claudeDirOf('/tmp/s1.jsonl')).toBeUndefined()
    expect(claudeDirOf(undefined)).toBeUndefined()
  })

  test('the opener per OS, argv with no shell', () => {
    expect(openerArgv('windows', 'C:\\u\\d.html')).toEqual(['cmd', '/c', 'start', '', 'C:\\u\\d.html'])
    expect(openerArgv('mac', '/u/d.html')).toEqual(['open', '/u/d.html'])
    expect(openerArgv('linux', '/u/d.html')).toEqual(['xdg-open', '/u/d.html'])
  })
})
