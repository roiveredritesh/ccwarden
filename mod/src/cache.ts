import type { Billing } from './config'
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
