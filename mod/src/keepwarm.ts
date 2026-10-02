import type { Billing } from './config'
import { familyOf, PRICES } from './prices'

// F6 keep-warm (metered, experimental): just before the active session's
// cache expires, one tiny tool-less fork of the main thread's last request
// ($.model.fork) reads the cached prefix, which should refresh its TTL (Q2,
// unverified: the feature is off by default until it is). It runs only while
// every condition below holds, within a per-session $ cap, and reports what
// it spent and what it saved. Pure: the timer in hooks/register.tsx pings.

export const PING_PROMPT = 'Reply with OK.'
/** Ping when the cache has at most this long left. */
export const PING_LEAD_MS = 45_000
/** How often the timer checks. */
export const TICK_MS = 15_000

export type PingFacts = {
  keepWarm: boolean
  billing: Billing | undefined
  /** A client draws the session (a terminal or the Desktop app). */
  isAttached: boolean
  isTurnRunning: boolean
  now: number
  /** When the user last typed a prompt; undefined for a resumed session until they do. */
  lastPromptAt?: number
  /** The cache's expiry, from the last response or ping. */
  expiresAt?: number
  maxMin: number
  spentUsd: number
  capUsd: number
  tokens?: number
  model: string
}

/** Whether to ping now, or why not (shown nowhere; for tests and the debug log). */
export function pingVerdict(f: PingFacts): { isDue: true } | { isDue: false; why: string } {
  if (!f.keepWarm || f.billing !== 'metered') return { isDue: false, why: 'off' }
  if (!f.isAttached) return { isDue: false, why: 'no client attached' }
  if (f.isTurnRunning) return { isDue: false, why: 'a turn is running' }
  if (f.lastPromptAt === undefined || f.now - f.lastPromptAt > f.maxMin * 60_000) return { isDue: false, why: 'no prompt within keepWarmMaxMin' }
  if (f.expiresAt === undefined || f.expiresAt <= f.now) return { isDue: false, why: 'cache already cold' }
  if (f.expiresAt - f.now > PING_LEAD_MS) return { isDue: false, why: 'not yet' }
  const tokens = f.tokens ?? 0
  const ping = pingUsd(tokens, f.model)
  const rebuild = rebuildAt5m(tokens, f.model)
  if (ping === undefined || rebuild === undefined || rebuild <= ping) return { isDue: false, why: "a rebuild wouldn't cost more" }
  if (f.spentUsd + ping > f.capUsd) return { isDue: false, why: 'keepWarmCapUsd reached' }
  return { isDue: true }
}

/** A ping's expected cost: the prefix read from the cache, plus a few output tokens. */
export function pingUsd(tokens: number, model: string): number | undefined {
  const family = familyOf(model)
  if (family === undefined) return undefined
  return (tokens * PRICES[family].read + 20 * PRICES[family].output) / 1e6
}

function rebuildAt5m(tokens: number, model: string): number | undefined {
  const family = familyOf(model)
  return family === undefined ? undefined : (tokens * PRICES[family].write5m) / 1e6
}

/**
 * A prompt sent while the cache is warm only thanks to a ping: the rebuild
 * it avoided, else 0. `lastResponseAt + ttl` is when it would have gone cold.
 */
export function avoidedRebuild(f: { now: number; lastResponseAt?: number; keepWarmAt?: number; ttlMs: number; rebuildUsd?: number }): number {
  if (f.lastResponseAt === undefined || f.keepWarmAt === undefined || f.rebuildUsd === undefined) return 0
  const wouldBeCold = f.now >= f.lastResponseAt + f.ttlMs
  const isWarm = f.now < f.keepWarmAt + f.ttlMs
  return wouldBeCold && isWarm ? f.rebuildUsd : 0
}
