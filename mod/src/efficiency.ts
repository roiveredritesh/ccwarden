import { dayKey } from './ledger'
import { slashed } from './paths'
import { familyOf, PRICES } from './prices'

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
