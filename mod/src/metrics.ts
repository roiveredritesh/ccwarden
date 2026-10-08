import { dayKey } from './ledger'
import { familyOf, PRICES } from './prices'
import type { Family } from './prices'

// F15: the metrics log. Every intervention is one event in the session's own
// file (<claude dir>/ccwarden/metrics/<session id>.jsonl); the file's last
// lines are the session's records (one per /clear part). One file per
// session because $.fs has no append: a shared file would need
// read-modify-write, and sessions would lose each other's events. Pure:
// hooks/register.tsx holds the file and writes it; the page reads it.

export const METRICS_V = 1
export const METRICS_DIR = 'ccwarden/metrics'
/** Past this a session adds no events (its record still updates), so a write never passes 4 MiB. */
export const MAX_FILE_CHARS = 3_500_000
const HOLDOUT_SHARE = 10
const RECORD_ROOM = 4_000 // the records' lines, kept free under MAX_FILE_CHARS

export type Feature = 'subagent' | 'cold' | 'topic' | 'junk' | 'snapshot' | 'keepwarm' | 'limit' | 'handoff' | 'alert' | 'compact'
export type Confidence = 'high' | 'medium' | 'low' | 'count only'
export type Estimate = { tokens: number; usd: number; formula: string; confidence: Confidence }
export type MetricEvent = {
  v: 1
  at: number
  feature: Feature
  action: string
  /** The main model when it happened. */
  model?: string
  /** Links an `outcome` to the event it settles. */
  ref?: string
  /** What a guard would have done: a holdout session, or the junk guard in observe. */
  would?: true
  /** Read from the engine; never estimated. */
  measured: Record<string, string | number | boolean>
  /** The saving; absent on an event whose `outcome` carries it. */
  est?: Estimate
}
export type TokenTotals = { input: number; read: number; write: number; output: number }
export type SessionRecord = {
  v: 1
  record: 'session'
  session: string
  /** 2, 3… when /clear kept the session id. */
  part: number
  project: string
  startedAt: number
  lastAt: number
  /** measureHoldout was on when this part started; `holdout` is only ever true with it. */
  measuring: boolean
  holdout: boolean
  /** The main loop's family with the most turns. */
  family?: Family
  familyTurns: Partial<Record<Family, number>>
  prompts: number
  requests: number
  tokens: TokenTotals
  usd: number
  subagentUsd: number
  events: number
  truncated: boolean
}
/** A session's file as the module holds it; `chars` is the events' share of the text. */
export type MetricsFile = { events: MetricEvent[]; done: SessionRecord[]; record: SessionRecord; chars: number }
export type Usage = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
/** F5: a pinned subagent whose saving adds up with each of its turns. `from` is what it would have run on, `to` what it ran on. */
export type Pin = { ref: string; from: string; to: string; confidence: Confidence; would: boolean; usage?: Usage }

/** FNV-1a (32-bit) over UTF-16 code units; session ids are ASCII, so these are their UTF-8 bytes. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** 1 in 10 sessions, by id alone: anyone can check which were holdouts, and a reload never changes it. */
export function isHoldoutId(sessionId: string): boolean {
  return fnv1a(sessionId) % HOLDOUT_SHARE === 0
}

export function newRecord(f: { session: string; project: string; now: number; measuring: boolean; part?: number }): SessionRecord {
  return {
    v: 1, record: 'session', session: f.session, part: f.part ?? 1, project: f.project, startedAt: f.now, lastAt: f.now,
    measuring: f.measuring, holdout: f.measuring && isHoldoutId(f.session), familyTurns: {},
    prompts: 0, requests: 0, tokens: { input: 0, read: 0, write: 0, output: 0 }, usd: 0, subagentUsd: 0, events: 0, truncated: false,
  }
}

export function emptyFile(record: SessionRecord): MetricsFile {
  return { events: [], done: [], record, chars: 0 }
}

/** List price, cache writes at the 5m rate (as F5's turnUsd); undefined for an unknown model. */
export function usageUsd(u: Usage, family = familyOf(u.model)): number | undefined {
  if (family === undefined) return undefined
  const p = PRICES[family]
  return (u.input_tokens * p.input + u.cache_read_input_tokens * p.read + u.cache_creation_input_tokens * p.write5m + u.output_tokens * p.output) / 1e6
}

/** Two usages summed, under the later one's model. */
export function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (a === undefined) return { ...b }
  return {
    model: b.model,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  }
}

/** A finished turn into the record: tokens and $, a subagent's $ also into subagentUsd, a main turn's family counted. */
export function addTurn(r: SessionRecord, u: Usage, isSubagent: boolean, now: number): SessionRecord {
  const usd = usageUsd(u) ?? 0
  const family = familyOf(u.model)
  const familyTurns = { ...r.familyTurns }
  if (!isSubagent && family !== undefined) familyTurns[family] = (familyTurns[family] ?? 0) + 1
  const top = (Object.entries(familyTurns) as [Family, number][]).sort((a, b) => b[1] - a[1])[0]?.[0]
  return {
    ...r, lastAt: now, familyTurns, ...(top === undefined ? {} : { family: top }),
    tokens: {
      input: r.tokens.input + u.input_tokens, read: r.tokens.read + u.cache_read_input_tokens,
      write: r.tokens.write + u.cache_creation_input_tokens, output: r.tokens.output + u.output_tokens,
    },
    usd: r.usd + usd,
    subagentUsd: r.subagentUsd + (isSubagent ? usd : 0),
  }
}

/** Adds an event, unless the file is full; then the record says so and nothing more is added. */
export function addEvent(f: MetricsFile, ev: MetricEvent): MetricsFile {
  if (f.record.truncated) return f
  const size = JSON.stringify(ev).length + 1
  if (f.chars + size + RECORD_ROOM * (f.done.length + 1) > MAX_FILE_CHARS) return { ...f, record: { ...f.record, truncated: true } }
  return { ...f, events: [...f.events, ev], record: { ...f.record, events: f.record.events + 1 }, chars: f.chars + size }
}

/** The outcome for `ev.ref` replaced if held, else added: a saving that grows is rewritten, not repeated. */
export function putOutcome(f: MetricsFile, ev: MetricEvent): MetricsFile {
  const i = f.events.findIndex(e => e.action === 'outcome' && e.ref === ev.ref)
  if (i === -1) return addEvent(f, ev)
  const events = [...f.events]
  events[i] = ev
  return { ...f, events, chars: f.chars - JSON.stringify(f.events[i]).length + JSON.stringify(ev).length }
}

export function serialize(f: MetricsFile): string {
  return `${[...f.events, ...f.done, f.record].map(x => JSON.stringify(x)).join('\n')}\n`
}

/** A file's events and records (the last line per part wins); lines that aren't JSON or carry another `v` are skipped and counted. */
export function parseFile(text: string): { events: MetricEvent[]; records: SessionRecord[]; skipped: number } {
  const events: MetricEvent[] = []
  const parts = new Map<number, SessionRecord>()
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let x: unknown
    try {
      x = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    const o = x as { v?: unknown; record?: unknown } | null
    if (o === null || typeof o !== 'object' || o.v !== METRICS_V) {
      skipped++
      continue
    }
    if (o.record === 'session') parts.set((x as SessionRecord).part, x as SessionRecord)
    else events.push(x as MetricEvent)
  }
  return { events, records: [...parts.values()].sort((a, b) => a.part - b.part), skipped }
}

/** The file back from disk after a reload: the newest part goes on, earlier parts are kept as they were. */
export function resume(text: string, fallback: SessionRecord): MetricsFile {
  const { events, records } = parseFile(text)
  return {
    events,
    done: records.slice(0, -1),
    record: records.at(-1) ?? fallback,
    chars: events.reduce((s, e) => s + JSON.stringify(e).length + 1, 0),
  }
}

/** /clear kept the session id: this part is done and the next starts now, with the same holdout choice. */
export function nextPart(f: MetricsFile, now: number): MetricsFile {
  const r = f.record
  return { ...f, done: [...f.done, r], record: newRecord({ session: r.session, project: r.project, now, measuring: r.measuring, part: r.part + 1 }) }
}

/** F5: the subagent's tokens priced at `from` less at `to`; undefined when the families match or one is unknown. */
export function pinEstimate(u: Usage, from: string, to: string, confidence: Confidence): Estimate | undefined {
  const a = familyOf(from)
  const b = familyOf(to)
  if (a === undefined || b === undefined || a === b) return undefined
  return { tokens: 0, usd: usageUsd(u, a)! - usageUsd(u, b)!, formula: `subagent tokens × (price ${a} − price ${b})`, confidence }
}

/** F2: not sending over a cold cache saves its rebuild (context × cache write price). */
export function coldEstimate(choice: 'send' | 'handoff' | 'keep', tokens: number, rebuildUsd: number | undefined): Estimate {
  const isAvoided = choice !== 'send'
  return { tokens: isAvoided ? tokens : 0, usd: isAvoided ? (rebuildUsd ?? 0) : 0, formula: 'context × cache write price, when the prompt was not sent', confidence: 'medium' }
}

/** F4 kept-out output, F13 a dropped context: savings that grow with each later main-loop request. */
export type Pending = { ref: string; feature: 'junk' | 'topic'; at: number; tokens: number; family: Family; requests: number; would: boolean }

/** F4: the output is written once, then re-read by each later request, up to the next compaction (F14's formula). */
export function junkEstimate(tokens: number, family: Family, requestsAfter: number): Estimate {
  const p = PRICES[family]
  return { tokens: tokens * (1 + requestsAfter), usd: (tokens * (p.write5m + p.read * requestsAfter)) / 1e6, formula: 'tokens × (write5m + read × requests after, to the next compaction)', confidence: 'medium' }
}

/** F13: a context dropped by /clear is not re-read by the next conversation's requests. */
export function topicEstimate(dropped: number, family: Family, requests: number): Estimate {
  return { tokens: dropped * requests, usd: (dropped * PRICES[family].read * requests) / 1e6, formula: 'dropped context × read × requests in the next conversation', confidence: 'medium' }
}

/** A pending saving as its outcome event; junk's first request only writes the output, so it isn't a re-read. */
export function pendingOutcome(p: Pending): MetricEvent {
  const after = p.feature === 'junk' ? Math.max(0, p.requests - 1) : p.requests
  const est = p.feature === 'junk' ? junkEstimate(p.tokens, p.family, after) : topicEstimate(p.tokens, p.family, after)
  return { v: 1, at: p.at, feature: p.feature, action: 'outcome', ref: p.ref, ...(p.would ? { would: true as const } : {}), measured: { requestsAfter: after }, est }
}

export type FeatureTotals = { count: number; tokens: number; usd: number }
export type DayFeatures = Partial<Record<Feature, { done: FeatureTotals; would: FeatureTotals }>>
/** One file, summarised for the page and cached in $.store (`metricsSummaries`). */
export type MetricsSummary = { session: string; project?: string; records: SessionRecord[]; days: Record<string, DayFeatures>; estUsd: number; wouldUsd: number; skipped: number }

/** Per UTC day and feature: each event but an outcome counts once; an estimate adds wherever it is; would-have events apart. */
export function summarizeMetrics(text: string, session: string): MetricsSummary {
  const { events, records, skipped } = parseFile(text)
  const days: Record<string, DayFeatures> = {}
  const zero = (): FeatureTotals => ({ count: 0, tokens: 0, usd: 0 })
  let estUsd = 0
  let wouldUsd = 0
  for (const e of events) {
    const slot = ((days[dayKey(e.at)] ??= {})[e.feature] ??= { done: zero(), would: zero() })
    const t = e.would ? slot.would : slot.done
    if (e.action !== 'outcome' && !e.action.startsWith('loop-')) t.count++ // a loop warning or stop isn't a compaction
    if (e.est === undefined) continue
    t.tokens += e.est.tokens
    t.usd += e.est.usd
    if (e.would) wouldUsd += e.est.usd
    else estUsd += e.est.usd
  }
  return { session, ...(records[0] === undefined ? {} : { project: records[0].project }), records, days, estUsd, wouldUsd, skipped }
}
