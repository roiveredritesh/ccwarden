import { dayKey } from './ledger'
import { slashed } from './paths'
import { familyOf, PRICES } from './prices'
import type { JunkEvent } from './junk'
import { analyze, requestsOf } from './report'
import type { Request } from './report'
import type { TranscriptEntry } from './transcript'


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

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}
