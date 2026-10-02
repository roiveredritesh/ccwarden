// M3 spend ledger: what this machine spent per day (est., list price), kept
// in $.store for month tracking (F11) and the dashboard (F10). It grows from
// each conversation's engine total (session.measure `cost`): the rise since
// the last reading, the new total after a /clear. A resumed or reloaded
// session starts from its current total, so nothing is counted twice. Days
// are UTC dates. Pure: hooks/register.tsx reads and writes the store.

export type Ledger = {
  /** `YYYY-MM-DD` → est. $ spent that day on this machine. */
  days: Record<string, number>
  /** `/cw spent <amount>` for a month: the real total then, and the ledger's at that moment. */
  calibration?: { month: string; realUsd: number; ledgerUsd: number }
}

export const LEDGER_DAYS = 62

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7)
}

/** What a reading adds: the rise since the last one, or all of it when the total started over. */
export function costDelta(previous: number | undefined, usd: number): number {
  if (previous === undefined || usd < previous) return Math.max(0, usd)
  return usd - previous
}

/** The ledger with `usd` added to `day`, days older than LEDGER_DAYS dropped. */
export function addSpend(ledger: Ledger | undefined, day: string, usd: number): Ledger {
  const days = { ...(ledger?.days ?? {}) }
  if (usd > 0) days[day] = round4((days[day] ?? 0) + usd)
  const keep = Object.keys(days).sort().slice(-LEDGER_DAYS)
  return { ...(ledger ?? {}), days: Object.fromEntries(keep.map(k => [k, days[k]!])) }
}

/** The ledger's own total for a month. */
export function ledgerMonth(ledger: Ledger | undefined, month: string): number {
  return Object.entries(ledger?.days ?? {}).filter(([d]) => d.startsWith(month)).reduce((sum, [, v]) => sum + v, 0)
}

/**
 * Month-to-date (est.): the ledger's total, or after a `/cw spent` this
 * month, the real figure then plus what the ledger counted since.
 */
export function monthToDate(ledger: Ledger | undefined, now: number): number {
  const month = monthKey(now)
  const counted = ledgerMonth(ledger, month)
  const cal = ledger?.calibration
  return cal !== undefined && cal.month === month ? cal.realUsd + Math.max(0, counted - cal.ledgerUsd) : counted
}

/** `/cw spent <amount>`: record the real month-to-date against the ledger's. */
export function calibrate(ledger: Ledger | undefined, realUsd: number, now: number): Ledger {
  const month = monthKey(now)
  return { days: { ...(ledger?.days ?? {}) }, calibration: { month, realUsd, ledgerUsd: ledgerMonth(ledger, month) } }
}

/** At this month's pace so far, its total by the end (UTC days). */
export function projectMonth(mtd: number, now: number): number {
  const d = new Date(now)
  const daysIn = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  const elapsed = (d.getUTCDate() - 1) + (d.getUTCHours() * 60 + d.getUTCMinutes()) / 1440
  return elapsed < 0.5 ? mtd : (mtd / elapsed) * daysIn
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}
