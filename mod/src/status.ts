import type { SessionRateLimit } from 'claude-code'
import type { CacheView, Ttl } from './cache'
import type { Billing } from './config'
import { familyOf } from './prices'

// The status line (F1), one segment per fact:
//   metered: Sonnet · ctx 140k/300k · cache ● 3m · this chat $1.84
//   metered: Fable · ctx 262k/300k · cache ○ cold 12m (rebuild ≈ $3.30) · this chat $5.12 ⚠
//   window:  Haiku · ctx 64k/120k · cache ● 1h 41m · this chat 9% of 5h · 5h 62% (resets 1h20m)

export type StatusFacts = {
  billing: Billing | undefined
  model: string
  tokens?: number
  limit: number
  cache: CacheView
  ttl: Ttl
  rebuildUsd?: number
  usd?: number
  chatPct?: number
  fiveHour?: SessionRateLimit
  now: number
  isAlerted: boolean
}

export function formatStatus(f: StatusFacts): string {
  const family = familyOf(f.model)
  const parts = [family === undefined ? f.model : family[0]!.toUpperCase() + family.slice(1)]
  parts.push(`ctx ${f.tokens === undefined ? '–' : fmtTokens(f.tokens)}/${fmtTokens(f.limit)}`)
  parts.push(cacheSegment(f))

  const flag = f.isAlerted ? ' ⚠' : ''
  if (f.billing === 'window' && f.fiveHour !== undefined) {
    parts.push(`this chat ${f.chatPct ?? 0}% of 5h${flag}`)
    const resetsIn = f.fiveHour.resetsAt === undefined ? NaN : Date.parse(f.fiveHour.resetsAt) - f.now
    parts.push(`5h ${f.fiveHour.percentUsed}%${Number.isFinite(resetsIn) && resetsIn > 0 ? ` (resets ${fmtDuration(resetsIn)})` : ''}`)
  } else if (f.usd !== undefined) {
    parts.push(`this chat $${f.usd.toFixed(2)}${flag}`)
  }
  return parts.join(' · ')
}

function cacheSegment(f: StatusFacts): string {
  switch (f.cache.kind) {
    case 'none': return 'cache –'
    case 'warm': return `cache ● ${fmtDuration(f.cache.msLeft)}`
    case 'cold': {
      const rebuild = f.rebuildUsd === undefined ? '' : ` (rebuild ≈ $${f.rebuildUsd.toFixed(2)})`
      return `cache ○ cold ${fmtDuration(f.cache.msCold)}${rebuild}`
    }
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

/** Whole minutes, rounded up while counting down: `<1m`, `3m`, `1h 41m`. */
export function fmtDuration(ms: number): string {
  const m = Math.ceil(ms / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
