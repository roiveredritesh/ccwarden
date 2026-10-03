import { dayKey } from './ledger'
import { slashed } from './paths'
import { familyOf, PRICES } from './prices'
import type { Family } from './prices'
import type { JunkEvent } from './junk'
import { analyze, requestsOf } from './report'
import type { Request } from './report'
import type { TranscriptEntry } from './transcript'
import type { Billing } from './config'
import { hogsOver } from './hogs'
import type { Hog, HogDays } from './hogs'
import type { JunkMode } from './junk'
import type { Ledger } from './ledger'
import type { Feature, FeatureTotals, MetricsSummary } from './metrics'
import { proof } from './proof'
import type { ProofResult } from './proof'


// F14 efficiency dashboard: what ccwarden saved (est.), and a measured
// before/after from the transcripts, for every project on this machine.
// Live figures go to `projectDays` in $.store; each transcript's summary is
// cached in `transcriptSummaries`. Pure: hooks/register.tsx records, reads
// the transcripts and writes the page (drawn by src/htmlDashboard.ts).

export const PROJECT_DAYS_KEEP = 400
/** Where spend and events with no project are filed. */
export const UNATTRIBUTED = 'unattributed'
/** What a summary compaction would have written; shown on the page. */
export const SUMMARY_OUTPUT_TOKENS = 2_000
const DAY_MS = 86_400_000

/** One project's figures for one UTC day, recorded live. A day has only what happened. */
export type DayFigures = {
  usd?: number
  turns?: number
  peakContext?: number
  keepWarmPings?: number
  keepWarmSavedUsd?: number
  keepWarmSavedTokens?: number
  keepWarmSpentUsd?: number
  snapshots?: number
  snapshotSavedUsd?: number
  snapshotSavedTokens?: number
  coldAsks?: number
  topicClears?: number
  handoffs?: number
}

/** `projectDays` in $.store: project (its `projectKey`) → `YYYY-MM-DD` → figures. */
export type ProjectDays = Record<string, Record<string, DayFigures>>

/** The key a project path is filed under: `/`-separated, no trailing slash, a drive letter lower-cased. */
export function projectKey(path: string): string {
  return slashed(path).replace(/\/+$/, '').replace(/^[A-Z]:/, d => d.toLowerCase())
}

/** `pd` with `add` counted into `project`'s `day` (peakContext keeps the max); days more than PROJECT_DAYS_KEEP before `day` dropped. */
export function addProjectDay(pd: ProjectDays | undefined, project: string, day: string, add: DayFigures): ProjectDays {
  const key = projectKey(project)
  const cur: DayFigures = { ...(pd?.[key]?.[day] ?? {}) }
  for (const [k, v] of Object.entries(add) as [keyof DayFigures, number][]) {
    cur[k] = k === 'peakContext' ? Math.max(cur[k] ?? 0, v) : round4((cur[k] ?? 0) + v)
  }
  const cutoff = dayKey(Date.parse(day) - PROJECT_DAYS_KEEP * DAY_MS)
  const next: ProjectDays = {}
  for (const [p, days] of Object.entries({ ...(pd ?? {}), [key]: { ...(pd?.[key] ?? {}), [day]: cur } })) {
    const kept = Object.entries(days).filter(([d]) => d > cutoff)
    if (kept.length > 0) next[p] = Object.fromEntries(kept)
  }
  return next
}

/** What a snapshot saved (est.): the summary request's cached read of the context, and its output. */
export function snapshotSaving(tokens: number, model: string): { usd: number; tokens: number } | undefined {
  const family = familyOf(model)
  if (family === undefined) return undefined
  const p = PRICES[family]
  return { usd: (tokens * p.read + SUMMARY_OUTPUT_TOKENS * p.output) / 1e6, tokens: tokens + SUMMARY_OUTPUT_TOKENS }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

/** One transcript's main-loop usage on one UTC day; `context` sums each request's prompt size. */
export type DayUsage = { requests: number; input: number; read: number; write: number; output: number; usd: number; rebuilds: number; context: number }
/** A junk event's price inputs: the requests that re-read its output, and the model family then. No family: not priced. */
export type JunkPrice = { at: number; requestsAfter: number; family?: Family }
export type TranscriptSummary = { project?: string; days: Record<string, DayUsage>; junk: JunkPrice[] }
/** `transcriptSummaries` in $.store: transcript path → its summary, and the file and junk count it was made from. */
export type SummaryEntry = { mtimeMs: number; size: number; junk: number; summary: TranscriptSummary }
export type SummaryCache = Record<string, SummaryEntry>

/**
 * One transcript by day (requests, tokens, $ at list price, rebuilds,
 * context), its project (the first `cwd`), and for each junk event at
 * `junkAt` (ms) the requests that re-read its output.
 */
export function summarize(entries: readonly TranscriptEntry[], junkAt: readonly number[] = []): TranscriptSummary {
  const cwd = (entries as (TranscriptEntry & { cwd?: unknown })[]).find(e => typeof e.cwd === 'string' && e.cwd !== '')?.cwd as string | undefined
  const requests = requestsOf(entries)
  const days: Record<string, DayUsage> = {}
  const dayOf = (ts: number) => (days[dayKey(ts * 1000)] ??= { requests: 0, input: 0, read: 0, write: 0, output: 0, usd: 0, rebuilds: 0, context: 0 })
  for (const r of requests) {
    const d = dayOf(r.ts)
    d.requests++
    d.input += r.input
    d.read += r.read
    d.write += r.write
    d.output += r.output
    d.context += r.input + r.read + r.write
    d.usd += requestUsd(r)
  }
  for (const rb of analyze(requests).rebuilds) dayOf(rb.at).rebuilds++
  return { ...(cwd === undefined ? {} : { project: projectKey(cwd) }), days, junk: junkAt.map(at => junkPrice(requests, at)) }
}

function requestUsd(r: Request): number {
  const family = r.model === undefined ? undefined : familyOf(r.model)
  if (family === undefined) return 0
  const p = PRICES[family]
  return (r.input * p.input + r.write5m * p.write5m + r.write1h * p.write1h + r.read * p.read + r.output * p.output) / 1e6
}

/** The first request after `atMs` writes the output into the cache; each later one reads it, until a compaction drops it. */
function junkPrice(requests: readonly Request[], atMs: number): JunkPrice {
  const first = requests.findIndex(r => r.ts * 1000 > atMs)
  if (first === -1) return { at: atMs, requestsAfter: 0 }
  const model = requests[first]!.model
  let n = 0
  for (let i = first + 1; i < requests.length && !requests[i]!.afterCompact; i++) n++
  const family = model === undefined ? undefined : familyOf(model)
  return { at: atMs, requestsAfter: n, ...(family === undefined ? {} : { family }) }
}

/** A cached summary still holds: the file and the junk events priced in it are unchanged. */
export function isFresh(entry: SummaryEntry, file: { mtimeMs: number; size: number }, junk: number): boolean {
  return entry.mtimeMs === file.mtimeMs && entry.size === file.size && entry.junk === junk
}

/** Junk event times (ms) per session; events from before F14 have no session and are left out. */
export function junkTimesBySession(log: readonly JunkEvent[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const ev of log) if (ev.session !== undefined) (out[ev.session] ??= []).push(ev.at)
  return out
}

/** A transcript's session id: its file name without `.jsonl` (what `$.session.id()` returns). */
export function sessionOf(path: string): string {
  return (path.split(/[\\/]/).at(-1) ?? '').replace(/\.jsonl$/, '')
}

/** The Claude folder a transcript sits in (`<dir>/projects/<project>/<id>.jsonl`), else undefined. */
export function claudeDirOf(transcript: string | undefined): string | undefined {
  if (transcript === undefined) return undefined
  const parts = transcript.split(/[\\/]/)
  if (parts.length < 4 || parts.at(-3) !== 'projects') return undefined
  return transcript.slice(0, transcript.length - parts.slice(-3).join('/').length - 1)
}

export type HostOs = 'windows' | 'mac' | 'linux'

/** The command that opens `path` in the default browser; argv, no shell (`start`'s first argument is the window title). */
export function openerArgv(os: HostOs, path: string): string[] {
  if (os === 'windows') return ['cmd', '/c', 'start', '', path]
  return [os === 'mac' ? 'open' : 'xdg-open', path]
}

export type Range = '7d' | '30d' | 'install'
export const RANGES: readonly Range[] = ['7d', '30d', 'install']
/** Transcripts found, read (or from the cache), skipped for size, failed, and not read yet (session end parses none). */
export type Coverage = { total: number; read: number; skippedBig: number; failed: number; pending: number }
export type Confidence = 'high' | 'medium' | 'low' | 'count only'
export type SavingRow = { feature: string; did: string; count: number; tokens: number; usd: number; unpriced: number; formula: string; confidence: Confidence; isInTotal: boolean }
export type Measured = { requests: number; usdPerRequest: number; hitPct: number; rebuildsPer100: number; avgContext: number }
export type ProjectRow = { project: string; usd: number; sessions: number; requests: number; hitPct?: number; rebuilds: number; topHog?: Hog; savedUsd: number }
export type View = { savings: SavingRow[]; totalTokens: number; totalUsd: number; before?: Measured; after?: Measured; spend: { day: string; usd: Record<string, number> }[] }
/** One range: its first day, the project table, a view per project (`''`: all of them), and what to do. */
export type RangeData = { from: string; projects: ProjectRow[]; views: Record<string, View>; actions: string[] }
/** `projects`: those used with ccwarden (any activity since install); `hiddenProjects` counts the rest. */
export type EfficiencyData = { at: number; billing?: Billing; installDay?: string; coverage: Coverage; projects: string[]; hiddenProjects: number; ranges: Record<Range, RangeData>; proof: ProofResult }
export type EfficiencyInput = {
  now: number
  billing?: Billing
  junkMode: JunkMode
  ledger?: Ledger
  projectDays?: ProjectDays
  junkLog?: readonly JunkEvent[]
  hogDays?: HogDays
  /** Transcript path → summary. */
  summaries: Record<string, TranscriptSummary>
  coverage: Coverage
  /** Metrics file path → its summary (F15). */
  metrics?: Record<string, MetricsSummary>
}

/** Everything the page shows, for every range and project. */
export function efficiencyData(input: EfficiencyInput): EfficiencyData {
  const install = installDay(input.ledger, input.projectDays)
  const byDay = spendByDay(input)
  const prices = new Map<string, JunkPrice>()
  for (const [path, s] of Object.entries(input.summaries)) for (const j of s.junk) prices.set(`${sessionOf(path)}@${j.at}`, j)
  const all = [...new Set([
    ...Object.keys(input.projectDays ?? {}),
    ...Object.values(input.summaries).map(s => s.project ?? UNATTRIBUTED),
    ...(input.junkLog ?? []).map(ev => ev.project ?? UNATTRIBUTED),
    ...Object.values(input.metrics ?? {}).map(m => m.project ?? UNATTRIBUTED),
    ...Object.values(byDay).flatMap(by => Object.keys(by)),
  ])].sort()
  // ponytail: a project only worked on before install would skew "before"; with no install day there is nothing to compare
  const projects = install === undefined ? all : all.filter(p => isUsedSince(input, byDay, p, install))
  const used = new Set(projects)
  const logStart = metricsStart(input.metrics)
  const ranges = {} as Record<Range, RangeData>
  for (const range of RANGES) {
    const from = range === 'install' ? (install ?? dayKey(input.now)) : dayKey(input.now - (range === '7d' ? 6 : 29) * DAY_MS)
    const views: Record<string, View> = {}
    for (const p of ['', ...projects]) views[p] = viewOf(input, prices, byDay, used, p, from, install, logStart)
    const rows = projects.map(p => projectRow(input, byDay, p, from, views[p]!.totalUsd)).sort((a, b) => b.usd - a.usd || b.requests - a.requests)
    ranges[range] = { from, projects: rows, views, actions: actionsFor(views['']!, input.junkMode, rows) }
  }
  // ponytail: a file's estimate is spread evenly over its /clear parts; per-part estimates if parts ever matter
  const proofSessions = Object.values(input.metrics ?? {})
    .filter(m => used.has(m.project ?? UNATTRIBUTED))
    .flatMap(m => m.records.map(record => ({ record, estUsd: m.estUsd / Math.max(1, m.records.length) })))
  return { at: input.now, ...(input.billing === undefined ? {} : { billing: input.billing }), ...(install === undefined ? {} : { installDay: install }), coverage: input.coverage, projects, hiddenProjects: all.length - projects.length, ranges, proof: proof(proofSessions) }
}

/** Any spend, request, live figure or junk event for `project` on or after `install`. */
function isUsedSince(input: EfficiencyInput, byDay: Record<string, Record<string, number>>, project: string, install: string): boolean {
  const after = (day: string) => day >= install
  return Object.entries(byDay).some(([d, by]) => after(d) && (by[project] ?? 0) > 0)
    || Object.values(input.summaries).some(s => (s.project ?? UNATTRIBUTED) === project && Object.entries(s.days).some(([d, u]) => after(d) && u.requests > 0))
    || Object.keys(input.projectDays?.[project] ?? {}).some(after)
    || (input.junkLog ?? []).some(ev => (ev.project ?? UNATTRIBUTED) === project && after(dayKey(ev.at)))
    || Object.values(input.metrics ?? {}).some(m => (m.project ?? UNATTRIBUTED) === project && Object.keys(m.days).some(after))
}

/** The first day ccwarden recorded anything: the earliest in the ledger or `projectDays`. */
export function installDay(ledger: Ledger | undefined, pd: ProjectDays | undefined): string | undefined {
  const days = [...Object.keys(ledger?.days ?? {}), ...Object.values(pd ?? {}).flatMap(d => Object.keys(d))].sort()
  return days[0]
}

/**
 * Est. $ per day and project: the larger of the transcripts' sum and `projectDays`,
 * plus what the ledger counted that neither did (spend from before F14).
 */
function spendByDay(input: EfficiencyInput): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const s of Object.values(input.summaries)) {
    const p = s.project ?? UNATTRIBUTED
    for (const [day, u] of Object.entries(s.days)) if (u.usd > 0) (out[day] ??= {})[p] = round4((out[day]?.[p] ?? 0) + u.usd)
  }
  // ponytail: max, not sum: both count the same sessions; transcripts miss files over 4 MiB, projectDays starts at F14
  for (const [project, days] of Object.entries(input.projectDays ?? {})) {
    for (const [day, f] of Object.entries(days)) if ((f.usd ?? 0) > 0) (out[day] ??= {})[project] = Math.max(out[day]?.[project] ?? 0, f.usd!)
  }
  for (const [day, usd] of Object.entries(input.ledger?.days ?? {})) {
    const rest = usd - Object.values(out[day] ?? {}).reduce((s, v) => s + v, 0)
    if (rest >= 0.005) (out[day] ??= {})[UNATTRIBUTED] = round4(rest) // ponytail: half a cent of rounding drift isn't a project
  }
  return out
}

function viewOf(input: EfficiencyInput, prices: Map<string, JunkPrice>, byDay: Record<string, Record<string, number>>, used: ReadonlySet<string>, project: string, from: string, install: string | undefined, logStart: string | undefined): View {
  const isIn = (p: string | undefined) => (project === '' ? used.has(p ?? UNATTRIBUTED) : (p ?? UNATTRIBUTED) === project)
  const savings = savingsRows(input, prices, isIn, from, logStart)
  const counted = savings.filter(r => r.isInTotal)
  const days = Object.values(input.summaries).filter(s => isIn(s.project)).flatMap(s => Object.entries(s.days))
  const spend: View['spend'] = []
  for (let t = Date.parse(from); dayKey(t) <= dayKey(input.now); t += DAY_MS) {
    const day = dayKey(t)
    spend.push({ day, usd: Object.fromEntries(Object.entries(byDay[day] ?? {}).filter(([p]) => isIn(p))) })
  }
  return {
    savings,
    totalTokens: counted.reduce((s, r) => s + r.tokens, 0),
    totalUsd: counted.reduce((s, r) => s + r.usd, 0),
    ...(install === undefined ? {} : {
      before: measured(days.filter(([d]) => d < install).map(([, u]) => u)),
      after: measured(days.filter(([d]) => d >= install).map(([, u]) => u)),
    }),
    spend,
  }
}

function savingsRows(input: EfficiencyInput, prices: Map<string, JunkPrice>, isIn: (p: string | undefined) => boolean, from: string, logStart: string | undefined): SavingRow[] {
  // ponytail: from the log's first day it replaces junkLog and projectDays outright; both stay for the days before it
  const isBeforeLog = (day: string) => logStart === undefined || day < logStart
  const rows: SavingRow[] = []
  for (const mode of ['enforce', 'observe'] as const) {
    const events = (input.junkLog ?? []).filter(ev => ev.mode === mode && isIn(ev.project) && dayKey(ev.at) >= from && isBeforeLog(dayKey(ev.at)))
    if (events.length === 0) continue
    const row: SavingRow = {
      feature: mode === 'enforce' ? 'Junk guard' : 'Junk guard (observe)',
      did: mode === 'enforce' ? 'oversized output kept out of the context' : 'oversized output it would have kept out',
      count: events.length, tokens: 0, usd: 0, unpriced: 0,
      formula: 'tokens × (write5m + read × requests after, to the session end or next compaction)',
      confidence: 'medium', isInTotal: mode === 'enforce',
    }
    for (const ev of events) {
      const price = ev.session === undefined ? undefined : prices.get(`${ev.session}@${ev.at}`)
      const tokens = ev.savedChars / 4
      if (price?.family === undefined) {
        row.unpriced++
        row.tokens += tokens // kept out of at least the next request; its re-reads are unknown
        continue
      }
      const p = PRICES[price.family]
      row.tokens += tokens * (1 + price.requestsAfter)
      row.usd += (tokens * (p.write5m + p.read * price.requestsAfter)) / 1e6
    }
    rows.push(row)
  }
  const f: DayFigures = {}
  for (const [p, days] of Object.entries(input.projectDays ?? {})) {
    if (!isIn(p)) continue
    for (const [day, x] of Object.entries(days)) {
      if (day < from || !isBeforeLog(day)) continue
      for (const [k, v] of Object.entries(x) as [keyof DayFigures, number][]) f[k] = (f[k] ?? 0) + v
    }
  }
  if ((f.keepWarmPings ?? 0) > 0) {
    rows.push({ feature: 'Keep-warm', did: 'pings that kept the cache warm', count: f.keepWarmPings!, tokens: f.keepWarmSavedTokens ?? 0, usd: (f.keepWarmSavedUsd ?? 0) - (f.keepWarmSpentUsd ?? 0), unpriced: 0, formula: 'rebuilds avoided − pings spent', confidence: 'high', isInTotal: true })
  }
  if ((f.snapshots ?? 0) > 0) {
    rows.push({ feature: 'Snapshot compaction', did: 'compactions with no summary request', count: f.snapshots!, tokens: f.snapshotSavedTokens ?? 0, usd: f.snapshotSavedUsd ?? 0, unpriced: 0, formula: `context × read + ${SUMMARY_OUTPUT_TOKENS} × output`, confidence: 'low', isInTotal: true })
  }
  const counts = [['coldAsks', 'Cold-cache guard', 'asked before a send over a cold cache'], ['topicClears', 'Unrelated-prompt hint', 'cleared for a new topic'], ['handoffs', 'Handoffs', 'notes written']] as const
  for (const [key, feature, did] of counts) {
    if ((f[key] ?? 0) > 0) rows.push({ feature, did, count: f[key]!, tokens: 0, usd: 0, unpriced: 0, formula: 'count only', confidence: 'count only', isInTotal: false })
  }
  for (const m of Object.values(input.metrics ?? {})) {
    if (!isIn(m.project)) continue
    for (const [day, features] of Object.entries(m.days)) {
      if (day < from) continue
      for (const [feature, t] of Object.entries(features) as [Feature, { done: FeatureTotals; would: FeatureTotals }][]) {
        if (t.done.count > 0 || t.done.usd !== 0) addLogged(rows, feature, false, t.done)
        if (t.would.count > 0 || t.would.usd !== 0) addLogged(rows, feature, true, t.would)
      }
    }
  }
  return rows
}

/** The first UTC day the metrics log has anything for; undefined with no log. */
function metricsStart(metrics: Record<string, MetricsSummary> | undefined): string | undefined {
  return Object.values(metrics ?? {}).flatMap(m => Object.keys(m.days)).sort()[0]
}

/** Each logged feature's row: its name, what it did, formula and confidence; would-have totals go to `would` (not in the total). */
const LOGGED: Record<Feature, { feature: string; did: string; formula: string; confidence: Confidence; would: string; wouldDid: string }> = {
  subagent: { feature: 'Subagent guard', did: 'subagents pinned to a cheaper model', formula: 'subagent tokens × (price asked − price ran)', confidence: 'high', would: 'Subagent guard (holdout)', wouldDid: 'subagents it would have pinned' },
  cold: { feature: 'Cold-cache guard', did: 'asked before a send over a cold cache', formula: 'context × cache write price, when the prompt was not sent', confidence: 'medium', would: 'Cold-cache guard (holdout)', wouldDid: 'sends over a cold cache it would have asked about' },
  topic: { feature: 'Unrelated-prompt hint', did: 'cleared for a new topic', formula: 'dropped context × read × requests in the next conversation', confidence: 'medium', would: 'Unrelated-prompt hint (holdout)', wouldDid: 'new topics it would have asked about' },
  junk: { feature: 'Junk guard', did: 'oversized output kept out of the context', formula: 'tokens × (write5m + read × requests after, to the session end or next compaction)', confidence: 'medium', would: 'Junk guard (observe)', wouldDid: 'oversized output it would have kept out' },
  snapshot: { feature: 'Snapshot compaction', did: 'compactions with no summary request', formula: `context × read + ${SUMMARY_OUTPUT_TOKENS} × output`, confidence: 'low', would: 'Snapshot compaction (holdout)', wouldDid: 'compactions it would have answered' },
  keepwarm: { feature: 'Keep-warm', did: 'pings that kept the cache warm', formula: 'rebuilds avoided − pings spent', confidence: 'high', would: 'Keep-warm (holdout)', wouldDid: 'pings it would have sent' },
  limit: { feature: 'Limit hints', did: '/compact hints past the model limit', formula: 'count only', confidence: 'count only', would: 'Limit hints (holdout)', wouldDid: 'hints it would have shown' },
  handoff: { feature: 'Handoffs', did: 'notes written', formula: 'count only', confidence: 'count only', would: 'Handoffs (holdout)', wouldDid: 'notes' },
}

/** Adds a logged feature's totals to its row, making the row if the range has none yet. */
function addLogged(rows: SavingRow[], feature: Feature, isWould: boolean, t: { count: number; tokens: number; usd: number }): void {
  const d = LOGGED[feature]
  const name = isWould ? d.would : d.feature
  const isCounted = !isWould && d.confidence !== 'count only'
  let row = rows.find(r => r.feature === name)
  if (row === undefined) {
    row = { feature: name, did: isWould ? d.wouldDid : d.did, count: 0, tokens: 0, usd: 0, unpriced: 0, formula: d.formula, confidence: d.confidence, isInTotal: isCounted }
    rows.push(row)
  }
  row.count += t.count
  row.tokens += t.tokens
  row.usd += t.usd
  if (isCounted) [row.isInTotal, row.confidence, row.formula] = [true, d.confidence, d.formula]
}

function measured(days: readonly DayUsage[]): Measured | undefined {
  const t = sumUsage(days)
  if (t.requests === 0) return undefined
  const all = t.input + t.read + t.write
  return { requests: t.requests, usdPerRequest: t.usd / t.requests, hitPct: all > 0 ? (t.read / all) * 100 : 0, rebuildsPer100: (t.rebuilds / t.requests) * 100, avgContext: t.context / t.requests }
}

function sumUsage(days: readonly DayUsage[]): DayUsage {
  const t: DayUsage = { requests: 0, input: 0, read: 0, write: 0, output: 0, usd: 0, rebuilds: 0, context: 0 }
  for (const d of days) for (const k of Object.keys(t) as (keyof DayUsage)[]) t[k] += d[k]
  return t
}

function projectRow(input: EfficiencyInput, byDay: Record<string, Record<string, number>>, project: string, from: string, savedUsd: number): ProjectRow {
  const sessions = Object.values(input.summaries)
    .filter(s => (s.project ?? UNATTRIBUTED) === project)
    .map(s => Object.entries(s.days).filter(([d]) => d >= from).map(([, u]) => u))
    .filter(days => days.some(u => u.requests > 0))
  const t = sumUsage(sessions.flat())
  const all = t.input + t.read + t.write
  // ponytail: hogDays has no project, so only file hogs under its path count; Bash and Grep hogs aren't attributed
  const root = `${project.toLowerCase()}/`
  const hogs = hogsOver(Object.fromEntries(Object.entries(input.hogDays ?? {}).filter(([d]) => d >= from)), '', 100)
  const topHog = hogs.find(h => slashed(h.target).toLowerCase().startsWith(root))
  return {
    project,
    usd: round4(Object.entries(byDay).filter(([d]) => d >= from).reduce((s, [, by]) => s + (by[project] ?? 0), 0)),
    sessions: sessions.length,
    requests: t.requests,
    ...(all > 0 ? { hitPct: (t.read / all) * 100 } : {}),
    rebuilds: t.rebuilds,
    ...(topHog === undefined ? {} : { topHog }),
    savedUsd,
  }
}

/** Up to three things to change, each naming the figure behind it. */
function actionsFor(all: View, junkMode: JunkMode, rows: readonly ProjectRow[]): string[] {
  const out: string[] = []
  const observe = all.savings.find(r => r.feature === 'Junk guard (observe)')
  if (junkMode === 'observe' && observe !== undefined && observe.usd >= 0.01) out.push(`Junk guard in observe would have saved ~$${observe.usd.toFixed(2)} (est.): set junkGuard to enforce in /config.`)
  const kw = all.savings.find(r => r.feature === 'Keep-warm')
  if (kw !== undefined && kw.usd < 0) out.push(`Keep-warm cost ~$${(-kw.usd).toFixed(2)} more than it saved (est.): switch keepWarm off in /config.`)
  if (all.before !== undefined && all.after !== undefined && all.after.hitPct < all.before.hitPct - 5) {
    out.push(`Cache hits fell from ${Math.round(all.before.hitPct)}% to ${Math.round(all.after.hitPct)}% since install: /cw names this session's rebuild causes.`)
  } else if (all.after !== undefined && all.after.rebuildsPer100 > 10) {
    out.push(`${Math.round(all.after.rebuildsPer100)} rebuilds per 100 requests since install: idle gaps past the cache TTL are the usual cause; /cw names them.`)
  }
  const low = rows.find(r => r.hitPct !== undefined && r.hitPct < 60 && r.requests >= 20)
  if (low !== undefined) out.push(`${low.project} had ${Math.round(low.hitPct!)}% cache hits over ${low.requests} requests: its prompt prefix changed or went cold often.`)
  return out.slice(0, 3)
}

