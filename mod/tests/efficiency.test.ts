import { describe, expect, test } from 'claude-code/testing'
import { addProjectDay, claudeDirOf, efficiencyData, fitCache, installDay, isFresh, junkTimesBySession, openerArgv, projectKey, sessionOf, snapshotSaving, summarize } from '../src/efficiency'
import type { DayUsage, EfficiencyInput, SessionEvent } from '../src/efficiency'
import { requestsOf } from '../src/report'
import { coverageLine, dashboardHtml, escapeHtml, summaryMarkdown } from '../src/htmlDashboard'
import type { MetricsSummary } from '../src/metrics'
import { newRecord } from '../src/metrics'

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

  test('a cache over its budget drops the files changed longest ago; they are read again when needed', () => {
    const entry = (mtimeMs: number) => ({ mtimeMs, size: 1, pad: 'x'.repeat(100) })
    const cache = { '/a': entry(1), '/b': entry(3), '/c': entry(2) }
    const one = JSON.stringify(['/b', entry(3)]).length
    expect(Object.keys(fitCache(cache, 2 + 2 * one))).toEqual(['/b', '/c']) // the braces, then two entries
    expect(fitCache(cache, 10 * one)).toEqual(cache)
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

const AT = Date.parse('2026-10-03T10:00:00Z')
const use = (u: Partial<DayUsage>): DayUsage => ({ requests: 0, input: 0, read: 0, write: 0, output: 0, usd: 0, rebuilds: 0, context: 0, ...u })
const FIXTURE: EfficiencyInput = {
  now: Date.parse('2026-10-03T12:00:00Z'),
  billing: 'metered',
  junkMode: 'observe',
  ledger: { days: { '2026-10-02': 5, '2026-10-03': 2 } },
  projectDays: { '/p': { '2026-10-03': { usd: 2, keepWarmPings: 3, keepWarmSavedUsd: 0.1, keepWarmSavedTokens: 40_000, keepWarmSpentUsd: 0.25, snapshots: 1, snapshotSavedUsd: 0.04, snapshotSavedTokens: 102_000, coldAsks: 2, handoffs: 1 } } },
  junkLog: [
    { at: AT, tool: 'Read', mode: 'enforce', target: '/p/big.log', size: 3_000, savedChars: 40_000, project: '/p', session: 's1' },
    { at: AT + 1_000, tool: 'Bash', mode: 'observe', target: 'cat x', size: 80_000, savedChars: 80_000, project: '/p', session: 's1' },
    { at: AT + 2_000, tool: 'Read', mode: 'enforce', target: '/q/old.log', size: 3_000, savedChars: 4_000 }, // from before F14
  ],
  hogDays: { '2026-10-03': { 'Read\t/p/src/big.ts': 9_000, 'Read\t/elsewhere/x.ts': 20_000, 'Bash\tnpm test': 30_000 } },
  summaries: {
    '/h/.claude/projects/-p/s1.jsonl': {
      project: '/p',
      days: {
        '2026-10-01': use({ requests: 10, read: 50_000, write: 50_000, usd: 1, rebuilds: 2, context: 1_000_000 }),
        '2026-10-03': use({ requests: 10, read: 90_000, write: 10_000, usd: 0.5, context: 1_000_000 }),
      },
      junk: [{ at: AT, requestsAfter: 2, family: 'sonnet' }, { at: AT + 1_000, requestsAfter: 0, family: 'sonnet' }],
    },
  },
  coverage: { total: 2, read: 1, skippedBig: 1, failed: 0, pending: 0 },
}

describe('F14 aggregation and savings', () => {
  const data = efficiencyData(FIXTURE)
  const week = data.ranges['7d']
  const all = week.views['']!
  const row = (feature: string) => all.savings.find(r => r.feature === feature)!

  test('install day: the first day in the ledger or projectDays', () => {
    expect(installDay(FIXTURE.ledger, FIXTURE.projectDays)).toBe('2026-10-02')
    expect(installDay(undefined, undefined)).toBeUndefined()
    expect(data.ranges.install.from).toBe('2026-10-02')
    expect(week.from).toBe('2026-09-27')
  })

  test('junk guard enforce: tokens × (write5m + read × requests after); events from before F14 count their tokens once, no $', () => {
    const r = row('Junk guard')
    expect([r.count, r.unpriced, r.tokens, r.isInTotal, r.confidence]).toEqual([2, 1, 31_000, true, 'medium'])
    expect(r4(r.usd)).toBe(0.029) // 10k × ($2.50 + $0.20 × 2) / 1M
  })

  test('junk guard observe: "would save", not in the total', () => {
    const r = row('Junk guard (observe)')
    expect([r.count, r.tokens, r.isInTotal]).toEqual([1, 20_000, false])
    expect(r4(r.usd)).toBe(0.05)
  })

  test('keep-warm may be negative and is shown so; snapshot priced when it happened; F2 and handoffs count only', () => {
    expect(r4(row('Keep-warm').usd)).toBe(-0.15)
    expect(row('Keep-warm').confidence).toBe('high')
    expect([row('Snapshot compaction').usd, row('Snapshot compaction').confidence]).toEqual([0.04, 'low'])
    expect([row('Cold-cache guard').count, row('Cold-cache guard').isInTotal]).toEqual([2, false])
    expect(row('Handoffs').count).toBe(1)
    expect(r4(all.totalUsd)).toBe(-0.081) // 0.029 − 0.15 + 0.04: observe left out
    expect(all.totalTokens).toBe(173_000)
  })

  test('before and after install, measured from the transcripts', () => {
    expect(all.before).toEqual({ requests: 10, usdPerRequest: 0.1, hitPct: 50, rebuildsPer100: 20, avgContext: 100_000 })
    expect(all.after).toEqual({ requests: 10, usdPerRequest: 0.05, hitPct: 90, rebuildsPer100: 0, avgContext: 100_000 })
  })

  test('projects: spend is the larger of transcripts and projectDays per day, the ledger rest unattributed; the top file hog', () => {
    expect(data.projects).toEqual(['/p', 'unattributed'])
    // /p: 10-01 from the transcript ($1, before projectDays), 10-03 max($0.50 transcript, $2 live).
    expect(week.projects.map(p => [p.project, p.usd, p.sessions, p.requests, p.rebuilds])).toEqual([['unattributed', 5, 0, 0, 0], ['/p', 3, 1, 20, 2]])
    const p = week.projects[1]!
    expect(Math.round(p.hitPct!)).toBe(70)
    expect(p.topHog).toEqual({ tool: 'Read', target: '/p/src/big.ts', tokens: 9_000 })
    expect(r4(p.savedUsd)).toBe(-0.081)
  })

  test('a project view holds only its own events and spend', () => {
    expect(week.views['/p']!.savings.find(r => r.feature === 'Junk guard')!.count).toBe(1)
    expect(week.views.unattributed!.savings.map(r => [r.feature, r.count, r.unpriced])).toEqual([['Junk guard', 1, 1]])
    expect(all.spend.map(d => d.day)).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    expect(all.spend.at(-3)!.usd).toEqual({ '/p': 1 })
    expect(all.spend.at(-2)!.usd).toEqual({ unattributed: 5 })
    expect(all.spend.at(-1)!.usd).toEqual({ '/p': 2 })
    expect(week.views['/p']!.spend.at(-2)!.usd).toEqual({})
  })

  test('what to do: each line names its figure', () => {
    expect(week.actions).toEqual([
      'Junk guard in observe would have saved ~$0.05 (est.): set junkGuard to enforce in /config.',
      'Keep-warm cost ~$0.15 more than it saved (est.): switch keepWarm off in /config.',
    ])
  })

  test('an empty machine: no install day, nothing saved, no NaN', () => {
    const empty = efficiencyData({ now: FIXTURE.now, junkMode: 'observe', summaries: {}, coverage: { total: 0, read: 0, skippedBig: 0, failed: 0, pending: 0 } })
    expect(empty.installDay).toBeUndefined()
    expect(empty.projects).toEqual([])
    expect(empty.ranges['30d'].views['']!).toMatchObject({ savings: [], totalUsd: 0, totalTokens: 0 })
    expect(empty.ranges['30d'].views['']!.before).toBeUndefined()
    expect(empty.ranges['30d'].actions).toEqual([])
  })
})

describe('F14 the page', () => {
  const html = dashboardHtml(efficiencyData(FIXTURE))

  test('self-contained: no URL, one script (ours), refreshes every minute', () => {
    expect(html).not.toMatch(/https?:\/\//)
    expect(html.split('<script').length).toBe(2)
    expect(html).toContain('<meta http-equiv="refresh" content="60">')
  })

  test('a project path is escaped everywhere', () => {
    const evil = '/x/<script>alert(1)</script>&"'
    const page = dashboardHtml(efficiencyData({ ...FIXTURE, projectDays: { [evil]: { '2026-10-03': { usd: 1 } } } }))
    expect(page).not.toContain('<script>alert(1)')
    expect(page).toContain('/x/&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;')
    expect(escapeHtml(`<a href='x'>&`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;')
  })

  test('every saving is labelled est.; observe says "would save"; the coverage line is shown', () => {
    const cells = html.match(/<td class="saved">[^]*?<\/td>/g) ?? []
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) if (!cell.includes('–')) expect(cell).toContain('est.')
    expect(html).toContain('would save')
    expect(html).toContain('saved (est.)')
    expect(html).toContain(escapeHtml(coverageLine(FIXTURE.coverage)))
    expect(coverageLine(FIXTURE.coverage)).toBe('1 of 2 transcripts read; 1 over 4 MiB skipped')
    expect(coverageLine({ total: 5, read: 2, skippedBig: 0, failed: 1, pending: 2 })).toBe('2 of 5 transcripts read; 1 could not be read; 2 not read yet')
  })

  test('window billing labels $ as a list-price equivalent', () => {
    expect(dashboardHtml(efficiencyData({ ...FIXTURE, billing: 'window' }))).toContain('list-price equivalent')
    expect(html).not.toContain('list-price equivalent')
  })

  test('the headline: what was saved, prompt size and cost per request before → after, with better/worse in words', () => {
    expect(html).toContain('Saved by ccwarden (est.)')
    expect(html).toContain('$0.100 → $0.050')
    expect(html).toContain('▼ 50% better')
    expect(html).toContain('▲ 40 pts better') // cache hit 50% → 90%
    expect(html).toContain('▼ 20.0 better') // rebuilds per 100
  })

  test('nothing counted: the card says why, and what observe would have kept out', () => {
    const observeOnly = { ...FIXTURE, projectDays: {}, junkLog: [FIXTURE.junkLog![1]!] }
    const page = dashboardHtml(efficiencyData(observeOnly))
    expect(page).toContain('Nothing counted yet')
    expect(page).toContain('the junk guard would have kept out ~20k tokens (1 times)')
  })

  test('folders with no activity are left out of the project table, and say so', () => {
    const page = dashboardHtml(efficiencyData({ ...FIXTURE, projectDays: { ...FIXTURE.projectDays, '/idle': { '2026-10-03': { turns: 1 } } } }))
    expect(page).not.toContain('<span class="path">/idle</span>')
    expect(page).toContain('1 folder with no activity in this range not shown.')
  })

  test('the proof section: with no holdout data it says how to start one', () => {
    expect(html).toContain('<section class="proof"><h2>Proof (holdout)</h2>')
    expect(html).toContain('Not proven yet: turn on measureHoldout in /config')
  })

  test('an empty machine still renders, with no NaN or Infinity', () => {
    const empty = dashboardHtml(efficiencyData({ now: FIXTURE.now, junkMode: 'observe', summaries: {}, coverage: { total: 0, read: 0, skippedBig: 0, failed: 0, pending: 0 } }))
    expect(empty).toContain('Nothing yet in this range.')
    expect(empty).not.toMatch(/NaN|Infinity/)
  })
})

describe('F14 only projects used with ccwarden', () => {
  // /old has sessions only before install: big contexts that would skew "before".
  const OLD = { project: '/old', days: { '2026-09-30': use({ requests: 10, read: 10_000, usd: 5, context: 5_000_000 }) }, junk: [] }
  const withOld: EfficiencyInput = { ...FIXTURE, summaries: { ...FIXTURE.summaries, '/h/.claude/projects/-old/s9.jsonl': OLD } }
  const data = efficiencyData(withOld)
  const week = data.ranges['7d']

  test('a project with no session since install is left out of the table and the views, and counted', () => {
    expect(data.projects).toEqual(['/p', 'unattributed'])
    expect(week.projects.map(p => p.project)).toEqual(['unattributed', '/p'])
    expect(data.hiddenProjects).toBe(1)
  })

  test('before and after compare the same projects: /old stays out of "before"', () => {
    expect(week.views['']!.before).toEqual({ requests: 10, usdPerRequest: 0.1, hitPct: 50, rebuildsPer100: 20, avgContext: 100_000 })
    expect(week.views['']!.spend.find(d => d.day === '2026-09-30')!.usd).toEqual({})
  })

  test('the page says how many were left out', () => {
    expect(dashboardHtml(data)).toContain('1 project with no session since install not shown.')
  })

  test('with no install day there is nothing to compare, so nothing is left out', () => {
    const noInstall = efficiencyData({ ...withOld, ledger: undefined, projectDays: undefined })
    expect(noInstall.projects).toContain('/old')
    expect(noInstall.hiddenProjects).toBe(0)
  })
})

describe('F15 rows from the metrics log', () => {
  const total = (count: number, tokens: number, usd: number) => ({ count, tokens, usd })
  const none = total(0, 0, 0)
  const SUMMARY: MetricsSummary = {
    session: 's2', project: '/p', records: [], estUsd: 0, wouldUsd: 0, skipped: 0,
    days: { '2026-10-02': {}, '2026-10-03': {
      subagent: { done: total(2, 0, 1.5), would: none },
      cold: { done: total(1, 180_000, 0.45), would: none },
      junk: { done: total(1, 5_000, 0.02), would: total(1, 8_000, 0.03) },
      limit: { done: total(1, 0, 0), would: none },
    } },
  }
  const data = efficiencyData({ ...FIXTURE, metrics: { '/h/.claude/ccwarden/metrics/s2.jsonl': SUMMARY } })
  const all = data.ranges['7d'].views['']!
  const row = (feature: string) => all.savings.find(r => r.feature === feature)

  test('after the first logged day the log replaces junkLog and projectDays for every feature', () => {
    expect(row('Subagent guard')).toMatchObject({ count: 2, usd: 1.5, isInTotal: true, confidence: 'high' })
    expect(row('Cold-cache guard')).toMatchObject({ count: 1, usd: 0.45, isInTotal: true, confidence: 'medium' })
    expect(row('Junk guard')).toMatchObject({ count: 1, tokens: 5_000 }) // 10-03 junkLog events are left to the log
    expect(row('Junk guard (observe)')).toMatchObject({ count: 1, tokens: 8_000, isInTotal: false })
    expect(row('Limit hints')).toMatchObject({ count: 1, confidence: 'count only', isInTotal: false })
    expect(row('Keep-warm')).toBeUndefined() // projectDays' 10-03 keep-warm is left to the log too
  })

  test('on the first logged day junkLog and projectDays keep the features they record, so what ran before the log is not lost', () => {
    const first = efficiencyData({ ...FIXTURE, metrics: { x: { ...SUMMARY, days: { '2026-10-03': SUMMARY.days['2026-10-03']! } } } })
    const r = (feature: string) => first.ranges['7d'].views['']!.savings.find(x => x.feature === feature)
    expect(r('Snapshot compaction')).toMatchObject({ count: 1, usd: 0.04 })
    expect(r('Keep-warm')).toMatchObject({ count: 3 })
    expect(r('Cold-cache guard')).toMatchObject({ count: 2, isInTotal: false }) // projectDays' 2, not the log's 1 on top
    expect(r('Junk guard')).toMatchObject({ count: 2 }) // junkLog's enforce events, not the log's 1 on top
    expect(r('Junk guard (observe)')).toMatchObject({ count: 1 })
    expect(r('Subagent guard')).toMatchObject({ count: 2, usd: 1.5 }) // only the log has these
    expect(r('Limit hints')).toMatchObject({ count: 1 })
  })

  test('spend alerts and summary compactions: count-only rows, never in the total', () => {
    const counted = { ...SUMMARY, days: { ...SUMMARY.days, '2026-10-03': { alert: { done: total(2, 0, 0), would: none }, compact: { done: total(1, 0, 0), would: none } } } }
    const rows = efficiencyData({ ...FIXTURE, metrics: { x: counted } }).ranges['7d'].views['']!.savings
    expect(rows.find(r => r.feature === 'Spend alerts')).toMatchObject({ count: 2, usd: 0, confidence: 'count only', isInTotal: false })
    expect(rows.find(r => r.feature === 'Summary compactions')).toMatchObject({ count: 1, usd: 0, confidence: 'count only', isInTotal: false })
  })

  test('no log: exactly the F14 rows', () => {
    expect(efficiencyData(FIXTURE).ranges['7d'].views['']!.savings.map(r => r.feature)).toEqual(['Junk guard', 'Junk guard (observe)', 'Keep-warm', 'Snapshot compaction', 'Cold-cache guard', 'Handoffs'])
  })

  test('a project with only metrics since install is a used project', () => {
    const only = { ...SUMMARY, project: '/m' }
    expect(efficiencyData({ ...FIXTURE, metrics: { x: only } }).projects).toContain('/m')
  })

  test('the proof is worked out from the log\'s records of used projects', () => {
    const rec = (id: string, holdout: boolean, usd: number) => ({ ...newRecord({ session: id, project: '/p', now: Date.parse('2026-10-03T10:00:00Z'), measuring: true }), holdout, family: 'sonnet' as const, prompts: 10, usd })
    const files = Object.fromEntries([
      ...Array.from({ length: 12 }, (_, i) => rec(`h${i}`, true, 10)),
      ...Array.from({ length: 30 }, (_, i) => rec(`p${i}`, false, 7)),
    ].map(r => [r.session, { session: r.session, project: '/p', records: [r], days: { '2026-10-03': {} }, estUsd: 0, wouldUsd: 0, skipped: 0 }]))
    const p = efficiencyData({ ...FIXTURE, metrics: files }).proof
    expect(p.kind).toBe('measured')
    expect(efficiencyData(FIXTURE).proof).toEqual({ kind: 'off' })
  })
})

describe('F15 the page', () => {
  const DAY = Date.parse('2026-10-03T10:00:00Z')
  const r = { ...newRecord({ session: 's2', project: '/p', now: DAY, measuring: true }), family: 'sonnet' as const, prompts: 8, usd: 4 }
  const SUMMARY = { session: 's2', project: '/p', records: [r], estUsd: 1.5, wouldUsd: 0, skipped: 0, days: { '2026-10-03': { subagent: { done: { count: 2, tokens: 0, usd: 1.5 }, would: { count: 0, tokens: 0, usd: 0 } } } } }
  const evs: SessionEvent[] = [
    { v: 1 as const, at: DAY, feature: 'subagent' as const, action: 'pinned', measured: { type: 'Explore' }, session: 's2' },
    { v: 1 as const, at: DAY + 1, feature: 'subagent' as const, action: 'outcome', measured: {}, est: { tokens: 0, usd: 1.5, formula: 'x', confidence: 'high' as const }, session: 's2' },
  ]
  const data = efficiencyData({ ...FIXTURE, metrics: { m: SUMMARY }, events: evs })
  const html = dashboardHtml(data)

  test('a verdict line per range, with the proof state', () => {
    expect(html).toMatch(/<p class="verdict">7 days: ccwarden saved ~[^<]+est\.\) Not proven yet: 0 of 10 holdout sessions/)
  })

  test('activity per day by feature; sessions; the latest events', () => {
    expect(data.ranges['7d'].views['']!.activity.at(-1)!.counts).toEqual({ subagent: 2 })
    expect(data.sessions[0]).toMatchObject({ session: 's2', project: '/p', prompts: 8, usdPerPrompt: 0.5, estUsd: 1.5, holdout: false })
    expect(data.events.map(e => e.action)).toEqual(['outcome', 'pinned'])
    expect(html).toContain('data-session="s2"')
  })

  test('savings as bars, the table under How it is computed; tooltips instead of <title>', () => {
    expect(html).toContain('<details><summary>How it\'s computed</summary>')
    expect(html).toContain('class="hbar"')
    expect(html).toContain('data-tip=')
    expect(html.split('<title>').length).toBe(2) // only the page's own
  })

  test('copy summary and raw data are embedded, escaped, with one script still', () => {
    expect(html).toContain('<pre id="cw-summary" hidden>')
    expect(html).toContain('<pre id="cw-raw" hidden>')
    expect(html.split('<script').length).toBe(2)
    expect(summaryMarkdown(data)).toMatch(/^## ccwarden report \(2026-10-03\)\n- Saved \(est\., 30 days\): ~/)
    expect(summaryMarkdown(data)).toContain('- Proof: Not proven yet: 0 of 10 holdout sessions')
  })

  test('a $-only saving (a pin) says no "~0 tokens"', () => {
    const only = efficiencyData({ now: FIXTURE.now, junkMode: 'observe', summaries: {}, coverage: { total: 0, read: 0, skippedBig: 0, failed: 0, pending: 0 }, metrics: { m: SUMMARY }, events: evs })
    expect(only.ranges['30d'].views['']!.totalUsd).toBe(1.5)
    expect(summaryMarkdown(only)).toContain('- Saved (est., 30 days): ~$1.50\n')
    const page = dashboardHtml(only)
    expect(page).not.toContain('~0 tokens')
    expect(page).toContain('ccwarden saved ~$1.50 (est.)')
  })
})
