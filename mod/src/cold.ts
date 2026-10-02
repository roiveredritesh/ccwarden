import type { CacheView } from './cache'
import { fmtDuration, fmtTokens } from './status'

// F2 cold-cache guard: before a prompt is sent over an expired cache with a
// large context, ask whether to re-cache it all. Asked once per cold spell
// (keyed by the last response's time), so sending again goes through. Pure:
// the prompt.submit hook in hooks/register.ts asks.

export const COLD_CONTINUE = 'Continue'
export const COLD_CANCEL = 'Cancel'

export function isColdAskDue(f: {
  cache: CacheView
  tokens: number | undefined
  coldMinTokens: number
  lastResponseAt: number | undefined
  askedFor: number | undefined
}): boolean {
  return f.cache.kind === 'cold' && (f.tokens ?? 0) >= f.coldMinTokens && f.lastResponseAt !== f.askedFor
}

export function coldQuestion(f: { msCold: number; tokens: number; rebuildUsd?: number }): string {
  const cost = f.rebuildUsd === undefined ? '' : ` (≈ $${f.rebuildUsd.toFixed(2)} est.)`
  return (
    `ccwarden: the prompt cache went cold ${fmtDuration(f.msCold)} ago, so this prompt re-caches ~${fmtTokens(f.tokens)} tokens${cost}. ` +
    'Unrelated work? /clear first is cheaper. Send it anyway?'
  )
}

export function coldDropReason(tokens: number): string {
  return `ccwarden: not sent, so ~${fmtTokens(tokens)} tokens weren't re-cached. Your prompt is back in the box; /clear first for unrelated work, or send it again to go ahead.`
}
