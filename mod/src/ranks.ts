import type { MetricEvent } from './metrics'

// F16: ranks from lifetime estimated savings (net of what ccwarden spent itself, e.g. keep-warm pings),
// badges from what the guards did. Protected sessions only: a holdout's events are `would` and save
// nothing by design.

export const RANKS = [
  { name: 'Cadet', fromUsd: 0 },
  { name: 'Sergeant', fromUsd: 5 },
  { name: 'Inspector', fromUsd: 20 },
  { name: 'Chief Warden', fromUsd: 50 },
] as const

export type BadgeCounts = { saves: number; coolHead: number; leanTeam: number; cleanReads: number }
export const NO_COUNTS: BadgeCounts = { saves: 0, coolHead: 0, leanTeam: 0, cleanReads: 0 }
export const BADGES: readonly { key: keyof BadgeCounts; name: string; need: number }[] = [
  { key: 'saves', name: 'First save', need: 1 },
  { key: 'coolHead', name: 'Cool head', need: 10 },
  { key: 'leanTeam', name: 'Lean team', need: 25 },
  { key: 'cleanReads', name: 'Clean reads', need: 25 },
]

export type Tally = { savedUsd: number; counts: BadgeCounts }
/** What $.store `warden` holds. */
export type WardenStore = Tally & { rank: number }

export function tally(events: readonly MetricEvent[]): Tally {
  let savedUsd = 0
  const counts = { ...NO_COUNTS }
  for (const e of events) {
    if (e.would === true) continue
    if (e.est !== undefined) {
      savedUsd += e.est.usd
      if (e.est.usd > 0) counts.saves++
    }
    if (e.feature === 'cold' && e.action === 'outcome' && e.measured.choice !== 'send') counts.coolHead++
    if (e.feature === 'subagent' && e.action === 'pinned') counts.leanTeam++
    if (e.feature === 'junk' && e.action === 'kept-out') counts.cleanReads++
  }
  return { savedUsd, counts }
}

export function addTally(a: Tally, b: Tally): Tally {
  return {
    savedUsd: a.savedUsd + b.savedUsd,
    counts: {
      saves: a.counts.saves + b.counts.saves,
      coolHead: a.counts.coolHead + b.counts.coolHead,
      leanTeam: a.counts.leanTeam + b.counts.leanTeam,
      cleanReads: a.counts.cleanReads + b.counts.cleanReads,
    },
  }
}

export function rankOf(savedUsd: number): number {
  return RANKS.reduce((rank, r, i) => (savedUsd >= r.fromUsd ? i : rank), 0)
}

/** `Sergeant · $12.40 saved · $7.60 to Inspector`. */
export function rankLine(savedUsd: number): string {
  const rank = rankOf(savedUsd)
  const next = RANKS[rank + 1]
  return `${RANKS[rank]!.name} · $${savedUsd.toFixed(2)} saved${next === undefined ? '' : ` · $${(next.fromUsd - savedUsd).toFixed(2)} to ${next.name}`}`
}

/** 16 cells: how far from this rank to the next. */
export function rankBar(savedUsd: number): string {
  const rank = rankOf(savedUsd)
  const next = RANKS[rank + 1]
  const share = next === undefined ? 1 : (savedUsd - RANKS[rank]!.fromUsd) / (next.fromUsd - RANKS[rank]!.fromUsd)
  const n = Math.max(0, Math.min(16, Math.round(share * 16)))
  return '█'.repeat(n) + '░'.repeat(16 - n)
}
