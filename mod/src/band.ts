import type { Mood } from './sprite'
import { fmtTokens, statusSegments } from './status'
import type { SegmentKind, StatusFacts } from './status'

// F16: the band above the prompt. One row: the status line's segments in colour (a heatmap is drawn after
// the model). Two rows when the warden has something to say: one message at a time, by the priority in
// SPEC F16 §5. Never a warden row in a holdout session: it would change what the user does.

export const GREEN = '#3fb950'
export const AMBER = '#e3b341'
export const RED = '#ff7b72'
const BLUE = '#58a6ff'
const SAY_RED = '#ff5a5a'
const SAY_AMBER = '#ffb000'
export const LAST_MINUTE_MS = 60_000

export type BandFacts = StatusFacts & {
  coldMinTokens: number
  /** F2 asked, or a band button answered, for this cold spell. */
  isColdAnswered: boolean
  spendAlert?: string
  promotion?: string
  heldNote?: string
}
export type BandButton = 'handoff' | 'clear' | 'send' | 'cw' | 'ok'
export type BandSegment = { kind: SegmentKind; text: string; color?: string; isDim: boolean; isBold: boolean }
export type BandMessage = { row: 1 | 2 | 3 | 4 | 5 | 6 | 7; mood: Mood; text: string; color: string; facts: string; buttons: BandButton[]; isAnimated: boolean }
export type BandView = { pct: number; segments: BandSegment[]; message?: BandMessage }

export function bandView(f: BandFacts, bodyColumns: number): BandView {
  const pct = f.tokens === undefined || f.limit <= 0 ? 0 : Math.round((f.tokens / f.limit) * 100)
  const ctx = f.tokens === undefined ? `ctx –/${fmtTokens(f.limit)}` : `ctx ${pct}% ${fmtTokens(f.tokens)}/${fmtTokens(f.limit)}`
  const segments = statusSegments(f)
    .filter(s => !(s.kind === 'fiveHour' && bodyColumns < 90) && !(s.kind === 'chat' && bodyColumns < 70))
    .map(s => colour(s.kind === 'ctx' ? { ...s, text: ctx } : s, f, pct))
  const message = f.isHoldout === true ? undefined : pick(f, pct, ctx)
  return message === undefined ? { pct, segments } : { pct, segments, message }
}

function colour(s: { kind: SegmentKind; text: string }, f: BandFacts, pct: number): BandSegment {
  const plain: BandSegment = { ...s, isDim: false, isBold: false }
  switch (s.kind) {
    case 'model': return { ...plain, color: BLUE, isBold: true }
    case 'ctx': return f.tokens === undefined ? { ...plain, isDim: true } : { ...plain, color: pct < 50 ? GREEN : pct < 80 ? AMBER : RED }
    case 'cache':
      if (f.cache.kind === 'cold') return { ...plain, color: RED }
      if (f.cache.kind === 'warm') return { ...plain, color: f.cache.msLeft <= LAST_MINUTE_MS ? AMBER : GREEN }
      return { ...plain, isDim: true }
    case 'chat':
    case 'fiveHour':
      return plain
    default:
      return { ...plain, isDim: true }
  }
}

/** A toast or log line's text, said by the warden. */
function said(text: string): string {
  return `Warden: ${text.replace(/^(⚠ |ccwarden: )/, '')}`
}

/** `0:48`: the last minute's countdown, whole seconds rounded up. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function pick(f: BandFacts, pct: number, ctx: string): BandMessage | undefined {
  const isBig = f.tokens !== undefined && f.tokens >= f.coldMinTokens
  const isCold = f.cache.kind === 'cold'
  const rebuild = f.rebuildUsd === undefined ? undefined : `$${f.rebuildUsd.toFixed(2)}`
  if (isCold && isBig && !f.isColdAnswered) {
    return {
      row: 1, mood: 'cold', color: SAY_RED, facts: ctx, buttons: ['handoff', 'clear', 'send'], isAnimated: true,
      text: `Warden: The cache is cold. Your next prompt re-reads ${fmtTokens(f.tokens!)} tokens${rebuild === undefined ? '' : ` (≈ ${rebuild})`}.`,
    }
  }
  if (f.spendAlert !== undefined) return { row: 2, mood: 'warm', color: SAY_RED, facts: ctx, buttons: ['cw', 'ok'], isAnimated: false, text: said(f.spendAlert) }
  if (!isCold && pct >= 95) {
    return { row: 3, mood: 'full', color: SAY_RED, facts: ctx, buttons: [], isAnimated: false, text: `Warden: Context is nearly full (${pct}%). Compact now, or ccwarden compacts at the limit.` }
  }
  if (f.cache.kind === 'warm' && f.cache.msLeft <= LAST_MINUTE_MS && isBig) {
    return {
      row: 4, mood: 'lastMinute', color: SAY_AMBER, buttons: [], isAnimated: true,
      facts: rebuild === undefined ? ctx : `${ctx} · rebuild after that ≈ ${rebuild}`,
      text: `Warden: The cache goes cold in ${fmtClock(f.cache.msLeft)}. Send your next prompt before then to keep it warm.`,
    }
  }
  if (!isCold && pct >= 80) return { row: 5, mood: 'full', color: SAY_AMBER, facts: ctx, buttons: [], isAnimated: false, text: `Warden: Context is at ${pct}%. Compact at a break soon.` }
  if (f.promotion !== undefined) return { row: 6, mood: 'warm', color: GREEN, facts: ctx, buttons: ['ok'], isAnimated: false, text: said(f.promotion) }
  if (f.heldNote !== undefined) return { row: 7, mood: 'warm', color: SAY_AMBER, facts: ctx, buttons: ['ok'], isAnimated: false, text: said(f.heldNote) }
  return undefined
}
