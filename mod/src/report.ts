import type { TranscriptEntry } from './transcript'

// The transcript cache report (F10), ported from hooks-edition/report.js:
// per session, the hit ratio, cache writes by TTL and every rebuild with its
// likely cause; over the sessions, the tokens re-cached by cause and a rough
// verdict on the 1h TTL. Pure: the dashboard in hooks/register.tsx reads the
// transcripts and calls it.

const WRITE_5M = 1.25
const WRITE_1H = 2.0
const READ = 0.1
const MIN_PREFIX = 10_000 // rebuilds of tiny prefixes aren't worth naming

type UsageEntry = TranscriptEntry & {
  uuid?: string
  timestamp?: string
  subtype?: string
  message?: TranscriptEntry['message'] & {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
    }
  }
}

export type Request = { ts: number; model?: string; input: number; output: number; read: number; write: number; write5m: number; write1h: number; afterCompact: boolean }
export type Rebuild = { at: number; tokens: number; cause: string }
export type SessionReport = {
  requests: number
  input: number
  read: number
  write5m: number
  write1h: number
  /** Cache reads over all input; undefined with no input. */
  hitRatio?: number
  rebuilds: Rebuild[]
  /** Base-input-token equivalents a 1h TTL would have saved on idle gaps of 5–60 min. */
  gapSavings: number
  lastTs: number
}

/** One record per API response of the main conversation, in order (the JSONL repeats a response per block). */
export function requestsOf(entries: readonly TranscriptEntry[]): Request[] {
  const seen = new Set<string>()
  const out: Request[] = []
  let compactedSince = false
  for (const raw of entries) {
    const e = raw as UsageEntry
    if ((e.type === 'system' && e.subtype === 'compact_boundary') || (e.type === 'user' && e.isCompactSummary)) {
      compactedSince = true
      continue
    }
    const u = e.message?.usage
    if (e.type !== 'assistant' || e.isSidechain || u === undefined) continue
    const id = e.message?.id ?? e.uuid ?? ''
    if (id !== '' && seen.has(id)) continue
    seen.add(id)
    const ts = Date.parse(e.timestamp ?? '') / 1000
    if (Number.isNaN(ts)) continue
    const write = u.cache_creation_input_tokens ?? 0
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    out.push({
      ts,
      model: e.message?.model,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      read: u.cache_read_input_tokens ?? 0,
      write,
      write1h,
      write5m: u.cache_creation?.ephemeral_5m_input_tokens ?? write - write1h,
      afterCompact: compactedSince,
    })
    compactedSince = false
  }
  return out
}

export function analyze(requests: readonly Request[]): SessionReport {
  const s: SessionReport = { requests: requests.length, input: 0, read: 0, write5m: 0, write1h: 0, rebuilds: [], gapSavings: 0, lastTs: 0 }
  let is1h = false
  requests.forEach((r, i) => {
    s.input += r.input
    s.read += r.read
    s.write5m += r.write5m
    s.write1h += r.write1h
    if (r.write1h > 0) is1h = true
    if (i === 0) return
    const prev = requests[i - 1]!
    const prefix = prev.input + prev.read + prev.write
    const gap = r.ts - prev.ts
    // An idle gap a 5m cache wouldn't survive but a 1h one would.
    if (gap > 300 && gap <= 3600 && prefix >= MIN_PREFIX) s.gapSavings += prefix * (WRITE_5M - READ)
    if (prefix < MIN_PREFIX || r.read >= prefix * 0.5) return
    let cause = 'prefix changed'
    if (r.afterCompact) cause = 'compaction'
    else if (prev.model !== undefined && r.model !== undefined && prev.model !== r.model) cause = 'model switch'
    else if (gap > (is1h ? 3600 : 300)) cause = `expired (idle ${Math.round(gap / 60)}m)`
    s.rebuilds.push({ at: r.ts, tokens: r.write + r.input, cause })
  })
  const total = s.input + s.read + s.write5m + s.write1h
  s.hitRatio = total > 0 ? s.read / total : undefined
  s.lastTs = requests.at(-1)?.ts ?? 0
  return s
}

export type WeekReport = {
  sessions: { id: string; lastTs: number; requests: number; hitRatio?: number; rebuilds: number }[]
  /** Tokens re-cached, by cause (`expired` for every idle gap). */
  causes: Record<string, number>
  /** Base-input-token equivalents: the 1h write premium, and what 1h would have saved on gaps. */
  premium: number
  gapSavings: number
}

export function weekReport(sessions: readonly { id: string; report: SessionReport }[]): WeekReport {
  const causes: Record<string, number> = {}
  let writes = 0
  let gapSavings = 0
  for (const { report } of sessions) {
    for (const r of report.rebuilds) {
      const key = r.cause.startsWith('expired') ? 'expired' : r.cause
      causes[key] = (causes[key] ?? 0) + r.tokens
    }
    writes += report.write5m + report.write1h
    gapSavings += report.gapSavings
  }
  return {
    sessions: sessions
      .filter(s => s.report.requests > 0)
      .map(s => ({ id: s.id, lastTs: s.report.lastTs, requests: s.report.requests, hitRatio: s.report.hitRatio, rebuilds: s.report.rebuilds.length }))
      .sort((a, b) => b.lastTs - a.lastTs),
    causes,
    premium: writes * (WRITE_1H - WRITE_5M),
    gapSavings,
  }
}

/** The 1h-TTL verdict for how this machine works (metered). */
export function ttlVerdict(w: WeekReport): string {
  if (w.premium === 0 && w.gapSavings === 0) return 'not enough data yet'
  return w.gapSavings > w.premium
    ? '1h would pay off for how you work (node setup/setup.js --cache-ttl 1h)'
    : '5m is cheaper for how you work (keep the default)'
}
