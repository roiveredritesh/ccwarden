import { describe, expect, test } from 'claude-code/testing'
import { newRecord } from '../src/metrics'
import type { Family } from '../src/prices'
import { proof, proofClaim, selfCheck } from '../src/proof'
import type { ProofSession } from '../src/proof'

/** A finished session: `perPrompt` $ over 10 prompts. */
function s(id: string, holdout: boolean, perPrompt: number, family: Family = 'sonnet', o: { measuring?: boolean; prompts?: number; estUsd?: number } = {}): ProofSession {
  const r = newRecord({ session: id, project: '/p', now: 0, measuring: o.measuring ?? true })
  const prompts = o.prompts ?? 10
  return { record: { ...r, holdout, family, prompts, usd: perPrompt * prompts }, estUsd: o.estUsd ?? 0 }
}
const many = (n: number, holdout: boolean, base: number, family: Family = 'sonnet', estUsd = 0) =>
  Array.from({ length: n }, (_, i) => s(`${holdout ? 'h' : 'p'}${family}${i}`, holdout, base + (i % 5) * 0.02, family, { estUsd }))

describe('F15 proof', () => {
  test('nothing measured: off', () => {
    expect(proof([s('a', false, 1, 'sonnet', { measuring: false })])).toEqual({ kind: 'off' })
    expect(proofClaim({ kind: 'off' })).toBe('Not proven yet: turn on measureHoldout in /config to measure what ccwarden saves.')
  })

  test('too few: collecting, with the counts; short sessions are not counted', () => {
    const p = proof([...many(5, true, 1), ...many(40, false, 0.75), s('short', true, 1, 'sonnet', { prompts: 4 })])
    expect(p).toEqual({ kind: 'collecting', holdout: 5, protected: 40, left: [] })
    expect(proofClaim(p)).toBe('Not proven yet: 5 of 10 holdout sessions and 40 of 30 protected ones.')
  })

  test('collecting counts only the families it can compare, and names the rest', () => {
    const p = proof([...many(9, true, 1), ...many(2, true, 1, 'opus'), ...many(2, true, 1, 'haiku'), ...many(40, false, 0.75), ...many(5, false, 1, 'opus')])
    expect(p).toEqual({ kind: 'collecting', holdout: 9, protected: 40, left: ['haiku', 'opus'] })
    expect(proofClaim(p)).toBe('Not proven yet: 9 of 10 holdout sessions and 40 of 30 protected ones. Haiku, Opus left out: fewer than 3 holdout sessions.')
  })

  test('protected cheaper: the % less per prompt, a 90% range above 0, the claim', () => {
    const p = proof([...many(12, true, 1), ...many(40, false, 0.75)])
    if (p.kind !== 'measured') throw new Error(p.kind)
    expect(Math.round(p.lessPct)).toBe(23) // medians 0.79 / 1.03
    expect(p.lowPct > 0 && p.lowPct <= p.lessPct && p.lessPct <= p.highPct).toBe(true)
    expect([p.holdout, p.protected, p.families, p.left]).toEqual([12, 40, ['sonnet'], []])
    expect(proofClaim(p)).toMatch(/^Protected sessions cost 23% less per prompt \(90% range \d+–\d+%; 12 holdout vs 40 protected; Sonnet\)\.$/)
  })

  test('the same sessions give the same range every time', () => {
    const input = [...many(12, true, 1), ...many(40, false, 0.75)]
    expect(proof(input)).toEqual(proof([...input].reverse()))
  })

  test('no clear difference, and more expensive, are both said', () => {
    expect(proofClaim(proof([...many(12, true, 1), ...many(40, false, 1)]))).toMatch(/^No clear difference yet \(90% range -?\d+% to -?\d+%\)\.$/)
    expect(proofClaim(proof([...many(12, true, 1), ...many(40, false, 1.3)]))).toMatch(/^Protected sessions cost \d+% more per prompt/)
  })

  test('a family with fewer than 3 holdouts is left out and named; families are weighted by the protected mix', () => {
    const p = proof([...many(12, true, 1), ...many(30, false, 0.75), s('ho1', true, 5, 'opus'), s('ho2', true, 5, 'opus'), ...many(10, false, 1, 'opus')])
    if (p.kind !== 'measured') throw new Error(p.kind)
    expect([p.families, p.left]).toEqual([['sonnet'], ['opus']])
    expect(proofClaim(p)).toContain('Opus left out: fewer than 3 holdout sessions')
  })

  test('self-check: the estimate against the measured range', () => {
    const agree = proof([...many(12, true, 1), ...many(40, false, 0.75, 'sonnet', 2.3)])  // est $2.30 of $7.90 + $2.30 ≈ 23%
    expect(selfCheck(agree)).toMatch(/^The estimates agree with the holdout/)
    const high = proof([...many(12, true, 1), ...many(40, false, 0.75, 'sonnet', 20)])
    expect(selfCheck(high)).toMatch(/^The estimates look optimistic: they claim \d+%, the holdout measured \d+–\d+%\.$/)
    expect(selfCheck({ kind: 'off' })).toBeUndefined()
  })
})
