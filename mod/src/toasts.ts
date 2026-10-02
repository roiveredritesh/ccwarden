import type { CcwardenNote } from '../types'

// R9: at most 3 toasts per hour, by priority (spend alert > cold cache >
// advisor). Each priority may only use the hour's slots up to its own
// ceiling, so a chatty advisor can never use up the room a spend alert needs.
// A toast that doesn't fit is held for the band. Pure: `notify` in
// hooks/register.tsx applies it (the validator follows $ only within a file).

export type Priority = CcwardenNote['priority']

export const TOASTS_PER_HOUR = 3
const HOUR_MS = 60 * 60_000
const CEILING: Record<Priority, number> = { spend: 3, cold: 2, advisor: 1 }

/** Whether a toast of `priority` fits now, given the hour's toast times. */
export function admit(times: readonly number[], now: number, priority: Priority): { isShown: boolean; times: number[] } {
  const recent = times.filter(t => now - t < HOUR_MS)
  const isShown = recent.length < Math.min(CEILING[priority], TOASTS_PER_HOUR)
  return { isShown, times: isShown ? [...recent, now] : recent }
}
