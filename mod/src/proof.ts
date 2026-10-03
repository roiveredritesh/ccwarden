import { fnv1a } from './metrics'
import type { SessionRecord } from './metrics'
import type { Family } from './prices'

// F15: the holdout comparison. $ per user prompt, protected vs holdout
// sessions, within each model family, weighted by the protected sessions'
// family mix; a 90% range by a bootstrap seeded from the session ids, so the
// page shows the same figure until a session is added. Pure.

export const MIN_HOLDOUT = 10
export const MIN_PROTECTED = 30
export const MIN_PROMPTS = 5
const MIN_FAMILY_HOLDOUT = 3
const RESAMPLES = 2_000

export type ProofSession = { record: SessionRecord; estUsd: number }
export type ProofResult =
  | { kind: 'off' }
  | { kind: 'collecting'; holdout: number; protected: number }
  | {
    kind: 'measured'
    /** (1 − protected/holdout) × 100, and its 90% range. */
    lessPct: number
    lowPct: number
    highPct: number
    holdout: number
    protected: number
    families: Family[]
    left: Family[]
    holdoutMedian: number
    protectedMedian: number
    /** The estimate as a share of the protected sessions' spend plus it. */
    estimatePct: number
  }

export function proof(sessions: readonly ProofSession[]): ProofResult {
  const measuring = sessions.filter(s => s.record.measuring)
  if (measuring.length === 0) return { kind: 'off' }
  const eligible = measuring.filter(s => s.record.prompts >= MIN_PROMPTS && s.record.family !== undefined)
    .sort((a, b) => (a.record.session + a.record.part).localeCompare(b.record.session + b.record.part))
  const perPrompt = (s: ProofSession) => s.record.usd / s.record.prompts
  const groups = new Map<Family, { h: number[]; p: number[] }>()
  for (const s of eligible) {
    const g = groups.get(s.record.family!) ?? { h: [], p: [] }
    ;(s.record.holdout ? g.h : g.p).push(perPrompt(s))
    groups.set(s.record.family!, g)
  }
  const kept = [...groups].filter(([, g]) => g.h.length >= MIN_FAMILY_HOLDOUT && g.p.length > 0 && median(g.h) > 0).sort(([a], [b]) => a.localeCompare(b))
  const left = [...groups.keys()].filter(f => !kept.some(([k]) => k === f)).sort()
  const holdout = kept.reduce((n, [, g]) => n + g.h.length, 0)
  const prot = kept.reduce((n, [, g]) => n + g.p.length, 0)
  if (holdout < MIN_HOLDOUT || prot < MIN_PROTECTED) {
    return { kind: 'collecting', holdout: eligible.filter(s => s.record.holdout).length, protected: eligible.filter(s => !s.record.holdout).length }
  }
  const ratio = ratioOf(kept.map(([, g]) => g))
  const random = mulberry32(fnv1a(eligible.map(s => `${s.record.session}#${s.record.part}`).join(',')))
  const draws: number[] = []
  for (let i = 0; i < RESAMPLES; i++) draws.push(ratioOf(kept.map(([, g]) => ({ h: resample(g.h, random), p: resample(g.p, random) }))))
  draws.sort((a, b) => a - b)
  const lo = draws[Math.floor(0.05 * (RESAMPLES - 1))]!
  const hi = draws[Math.ceil(0.95 * (RESAMPLES - 1))]!
  const protectedSessions = eligible.filter(s => !s.record.holdout && kept.some(([f]) => f === s.record.family))
  const spent = protectedSessions.reduce((n, s) => n + s.record.usd, 0)
  const est = protectedSessions.reduce((n, s) => n + s.estUsd, 0)
  return {
    kind: 'measured', lessPct: (1 - ratio) * 100, lowPct: (1 - hi) * 100, highPct: (1 - lo) * 100, holdout, protected: prot,
    families: kept.map(([f]) => f), left,
    holdoutMedian: median(kept.flatMap(([, g]) => g.h)), protectedMedian: median(kept.flatMap(([, g]) => g.p)),
    estimatePct: spent + est > 0 ? (est / (spent + est)) * 100 : 0,
  }
}

/** Σ over families of (protected median / holdout median), weighted by the protected count. */
function ratioOf(groups: readonly { h: number[]; p: number[] }[]): number {
  const total = groups.reduce((n, g) => n + g.p.length, 0)
  return groups.reduce((sum, g) => sum + (g.p.length / total) * (median(g.p) / median(g.h)), 0)
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function resample(xs: readonly number[], random: () => number): number[] {
  return xs.map(() => xs[Math.floor(random() * xs.length)]!)
}

/** A small seeded PRNG (mulberry32): the same seed, the same draws. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const cap = (f: string) => f[0]!.toUpperCase() + f.slice(1)

/** The page's sentence for a result; never a figure the data doesn't hold. */
export function proofClaim(p: ProofResult): string {
  if (p.kind === 'off') return 'Not proven yet: turn on measureHoldout in /config to measure what ccwarden saves.'
  if (p.kind === 'collecting') return `Not proven yet: ${p.holdout} of ${MIN_HOLDOUT} holdout sessions and ${p.protected} of ${MIN_PROTECTED} protected ones.`
  const range = `${Math.round(p.lowPct)}–${Math.round(p.highPct)}%`
  const counts = `${p.holdout} holdout vs ${p.protected} protected; ${p.families.map(cap).join(', ')}`
  const left = p.left.length === 0 ? '' : ` ${p.left.map(cap).join(', ')} left out: fewer than ${MIN_FAMILY_HOLDOUT} holdout sessions.`
  if (p.lowPct > 0) return `Protected sessions cost ${Math.round(p.lessPct)}% less per prompt (90% range ${range}; ${counts}).${left}`
  if (p.highPct < 0) return `Protected sessions cost ${Math.round(-p.lessPct)}% more per prompt (90% range ${Math.round(-p.highPct)}–${Math.round(-p.lowPct)}%; ${counts}).${left}`
  return `No clear difference yet (90% range ${Math.round(p.lowPct)}% to ${Math.round(p.highPct)}%).${left}`
}

/** Whether the per-feature estimates fit what the holdout measured. */
export function selfCheck(p: ProofResult): string | undefined {
  if (p.kind !== 'measured') return undefined
  const est = Math.round(p.estimatePct)
  const range = `${Math.round(p.lowPct)}–${Math.round(p.highPct)}%`
  if (p.estimatePct > p.highPct) return `The estimates look optimistic: they claim ${est}%, the holdout measured ${range}.`
  if (p.estimatePct < p.lowPct) return `The estimates look pessimistic: they claim ${est}%, the holdout measured ${range}.`
  return `The estimates agree with the holdout: they claim ${est}%, the holdout measured ${range}.`
}
