import { familyOf, PRICES } from './prices'
import type { Family } from './prices'

// F9 model/effort advisor. Model choice is the largest lever (SPEC §0), but a
// switch mid-session re-reads the whole context uncached, so the mod never
// switches and advises only where it is free: at a fresh start, before the
// first prompt (nothing cached yet), and in a handoff for the next session.
// Effort is cache-safe mid-session on Opus 5.5, Sonnet 5.5 and Fable 5.1
// (docs). Pure: the hooks in hooks/register.tsx show it.

const CHEAPER: Partial<Record<Family, Family[]>> = {
  fable: ['opus', 'sonnet', 'haiku'],
  opus: ['sonnet', 'haiku'],
  sonnet: ['haiku'],
}

/** Opus 5.5, Sonnet 5.5 and Fable 5.1 keep the cache when effort changes mid-session. */
export function isEffortCacheSafe(model: string): boolean {
  return /(opus|sonnet)-5-5|fable-5-1/i.test(model)
}

/** The start-of-session advice: cheaper models for routine work, and effort if it's cache-safe. */
export function startAdvice(model: string): string | undefined {
  const family = familyOf(model)
  if (family === undefined) return undefined
  const cheaper = CHEAPER[family]
  const parts: string[] = []
  if (cheaper !== undefined) {
    const pct = (f: Family) => `${name(f)} ${Math.round((PRICES[f].input / PRICES[family].input) * 100)}%`
    parts.push(
      `Routine work? Per token, ${cheaper.map(pct).join(', ')} of ${name(family)}. ` +
        `Switching now (/model ${cheaper.at(-1)}) is free: nothing is cached before the first prompt.`,
    )
  }
  if (isEffortCacheSafe(model)) parts.push('For routine steps later, a lower /effort keeps the cache on this model.')
  return parts.length === 0 ? undefined : `ccwarden: ${parts.join(' ')}`
}

/** A line for the handoff: start the next session on a cheaper model for routine steps. */
export function handoffModelLine(model: string): string | undefined {
  const cheaper = CHEAPER[familyOf(model) ?? 'haiku']
  return cheaper === undefined
    ? undefined
    : `Next session: for routine steps, start on ${cheaper.at(-1)} (\`/model ${cheaper.at(-1)}\`) before the first prompt; a switch then costs nothing.`
}

/**
 * Before a model switch: when the context is past the new model's limit,
 * say it will be compacted at the next turn end, and the cheaper route.
 */
/** Said before the switch is confirmed (PreModelSwitch also fires for a picker that is then cancelled), so it says "if". */
export function switchNote(f: { toModel: string; contextTokens: number; limit: number; writeUsd?: number }): string | undefined {
  if (f.contextTokens <= f.limit) return undefined
  const cost = f.writeUsd === undefined ? '' : ` (≈ $${f.writeUsd.toFixed(2)} est.)`
  return (
    `ccwarden: ${Math.round(f.contextTokens / 1000)}k tokens is past ${f.toModel}'s ${Math.round(f.limit / 1000)}k limit. ` +
    `If you switch, it re-reads it all${cost} and then compacts. Cheaper: /handoff, then start a new session on that model.`
  )
}

function name(f: Family): string {
  return `${f[0]!.toUpperCase()}${f.slice(1)}`
}
