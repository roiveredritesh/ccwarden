import type { Billing } from './config'
import { fmtDuration } from './status'
import type { TranscriptEntry } from './transcript'

// The prompt cache's TTL and whether it is still warm (F1). No event carries
// the TTL, so it is inferred, best source first:
//   1. observed: the 5m/1h split of the latest cache write in the transcript
//   2. override: CLAUDE_CODE_PROMPT_CACHE_TTL, or the `promptCacheTtl` setting
//   3. billing: a subscription within plan usage gets 1h, billed usage 5m
// The cache stays warm for the TTL after the main loop's last request.

export type Ttl = '5m' | '1h'
export type TtlSource = 'observed' | 'override' | 'billing'

export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

export function parseTtl(value: unknown): Ttl | undefined {
  return value === '5m' || value === '1h' ? value : undefined
}

export function inferTtl(input: { observed?: Ttl; override?: Ttl; billing: Billing | undefined }): { ttl: Ttl; source: TtlSource } {
  if (input.observed !== undefined) return { ttl: input.observed, source: 'observed' }
  if (input.override !== undefined) return { ttl: input.override, source: 'override' }
  return { ttl: input.billing === 'window' ? '1h' : '5m', source: 'billing' }
}

/** The TTL of the latest main-loop cache write in the transcript, or undefined if none wrote. */
export function latestWriteTtl(entries: readonly TranscriptEntry[]): Ttl | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type !== 'assistant' || entry.isSidechain) continue
    const split = entry.message?.usage?.cache_creation
    const w5m = split?.ephemeral_5m_input_tokens ?? 0
    const w1h = split?.ephemeral_1h_input_tokens ?? 0
    if (w5m + w1h > 0) return w1h > w5m ? '1h' : '5m'
  }
  return undefined
}

/**
 * The billing setting and the observed TTL disagree: 1h writes on a metered
 * machine, or 5m writes on a window one (extra usage, or an override). Not
 * when an override explains it.
 */
export function ttlContradicts(billing: Billing | undefined, observed: Ttl, override: Ttl | undefined): boolean {
  if (billing === undefined || override === observed) return false
  return (billing === 'metered' && observed === '1h') || (billing === 'window' && observed === '5m')
}

export type CacheView = { kind: 'none' } | { kind: 'warm'; msLeft: number } | { kind: 'cold'; msCold: number }

/** Warm or cold now, from the last main-loop response; `none` before the first. */
export function cacheView(lastResponseAt: number | undefined, ttl: Ttl, now: number): CacheView {
  if (lastResponseAt === undefined) return { kind: 'none' }
  const left = lastResponseAt + TTL_MS[ttl] - now
  return left > 0 ? { kind: 'warm', msLeft: left } : { kind: 'cold', msCold: -left }
}

/** A first request that writes at least this much (and more than it reads) re-cached the conversation. */
export const MISS_MIN_TOKENS = 20_000

export type CacheMiss = { cause: string; tokens: number }

/**
 * A turn's first request re-cached the conversation, and the likely why (as
 * cache-guard's report.js reads it): a compaction since the last request, a
 * model switch (each model has its own cache), the TTL running out, else the
 * prefix changed (CLAUDE.md, tools, MCP servers or settings). Undefined when
 * the cache served it, or there was no earlier request to miss.
 */
export function cacheMiss(f: {
  read: number
  write: number
  model: string
  prevModel?: string
  lastUseAt?: number
  now: number
  ttl: Ttl
  isCompacted: boolean
}): CacheMiss | undefined {
  if (f.lastUseAt === undefined || f.write < MISS_MIN_TOKENS || f.write <= f.read) return undefined
  const gap = f.now - f.lastUseAt
  const cause = f.isCompacted ? 'compaction'
    : f.prevModel !== undefined && f.prevModel !== f.model ? 'model switch'
    : gap > TTL_MS[f.ttl] ? `expired (idle ${fmtDuration(gap)})`
    : 'prefix changed (CLAUDE.md, tools, MCP or settings)'
  return { cause, tokens: f.write }
}
