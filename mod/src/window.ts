import type { SessionRateLimit } from 'claude-code'

// Window billing (F1): this conversation's share of the 5-hour window, as
// the rise in `five_hour` percentUsed since the conversation started. A
// window that resets (resetsAt moves, or the figure drops) starts counting
// from 0 again. Other sessions on the account move the same window, so the
// share is an upper bound when several run at once.

export type WindowTrack = { chatPct: number; lastPct: number; resetsAt?: string }

export function fiveHour(rateLimits: readonly SessionRateLimit[]): SessionRateLimit | undefined {
  return rateLimits.find(r => r.kind === 'five_hour')
}

/**
 * The track after a new reading. The first reading of a conversation is its
 * baseline: the one at session start, or else the first after a response,
 * whose own share is then missed (rateLimits stay empty until a response).
 */
export function trackWindow(prev: WindowTrack | undefined, reading: SessionRateLimit): WindowTrack {
  if (prev === undefined) return { chatPct: 0, lastPct: reading.percentUsed, resetsAt: reading.resetsAt }
  const isReset = (reading.resetsAt !== undefined && prev.resetsAt !== undefined && reading.resetsAt !== prev.resetsAt) || reading.percentUsed < prev.lastPct
  const delta = isReset ? reading.percentUsed : reading.percentUsed - prev.lastPct
  return { chatPct: round1(prev.chatPct + Math.max(0, delta)), lastPct: reading.percentUsed, resetsAt: reading.resetsAt }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
