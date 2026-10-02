import type { CacheView } from './cache'
import { fmtDuration, fmtTokens } from './status'

// F2 cold-cache guard: before a prompt is sent over an expired cache with a
// large context, ask whether to re-cache it all. Asked once per cold spell
// (keyed by the last response's time), so sending again goes through. Pure:
// the prompt.submit hook in hooks/register.tsx asks.

export const COLD_CONTINUE = 'Continue'
export const COLD_CANCEL = 'Cancel'
export const COLD_HANDOFF = 'Handoff'

/**
 * What an answer to the cold question means. Only Continue sends: a
 * dismissal or text typed under "Other" keeps the prompt, so typing
 * /handoff there writes the note instead of re-caching everything.
 */
export function coldChoice(answer: string | undefined): 'send' | 'handoff' | 'keep' {
  const a = (answer ?? '').trim()
  if (a === COLD_CONTINUE) return 'send'
  if (a === COLD_HANDOFF || /^\/handoff\b/i.test(a)) return 'handoff'
  return 'keep'
}

/**
 * A prompt asking Claude for a handoff. Over a cold cache that re-caches
 * everything just to write the note, so it is asked about every time.
 * A slash command (/handoff itself) is not one: it makes no model call cold.
 */
export function isHandoffAsk(text: string): boolean {
  return !text.trimStart().startsWith('/') && /\bhand-?offs?\b/i.test(text)
}

export function isColdAskDue(f: {
  cache: CacheView
  tokens: number | undefined
  coldMinTokens: number
  lastResponseAt: number | undefined
  askedFor: number | undefined
  text?: string
}): boolean {
  const isFirst = f.lastResponseAt !== f.askedFor || isHandoffAsk(f.text ?? '')
  return f.cache.kind === 'cold' && (f.tokens ?? 0) >= f.coldMinTokens && isFirst
}

export function coldQuestion(f: { msCold: number; tokens: number; rebuildUsd?: number }): string {
  const cost = f.rebuildUsd === undefined ? '' : ` (≈ $${f.rebuildUsd.toFixed(2)} est.)`
  return (
    `ccwarden: the prompt cache went cold ${fmtDuration(f.msCold)} ago, so this prompt re-caches ~${fmtTokens(f.tokens)} tokens${cost}. ` +
    'Same task? Handoff writes a note without a model call; a new session re-reads ~3k instead. Unrelated work? /clear first. Send it anyway?'
  )
}

export function coldDropReason(tokens: number, handoffPath?: string): string {
  const not = `ccwarden: not sent, so ~${fmtTokens(tokens)} tokens weren't re-cached. Your prompt is back in the box.`
  if (handoffPath !== undefined) return `${not} Handoff written to ${handoffPath}: start a new session and it offers to continue from it.`
  return `${not} Same task: /handoff, then a new session. Unrelated work: /clear first. Or send it again to go ahead.`
}
