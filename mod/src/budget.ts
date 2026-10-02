import type { Billing, Config } from './config'

// F11 month tracking and budget mode (SPEC §3). On metered billing, the
// month-to-date estimate (the M3 ledger, calibrated with /cw spent) is held
// against `monthlyBudgetUsd`: a toast at 50%, 80% and 100%, each once a
// month on this machine, with a projection. Budget mode tightens the guards
// once the month reaches `budgetModeAt`% of the budget (metered) or the 5h
// window reaches `budgetModeAt`% (window), or when switched on by hand.
// Pure: hooks/register.tsx tracks and applies it.

export const MONTH_STEPS = [50, 80, 100] as const

export type BudgetSwitch = 'auto' | 'on' | 'off'

/** The month steps reached and not yet alerted; only the highest of them is worth a toast. */
export function monthStepsDue(mtd: number, budget: number, sent: readonly number[]): number[] {
  if (budget <= 0) return []
  const pct = (mtd / budget) * 100
  return MONTH_STEPS.filter(s => pct >= s && !sent.includes(s))
}

export function monthAlertText(mtd: number, budget: number, projected: number): string {
  const pct = Math.round((mtd / budget) * 100)
  const pace = projected > mtd ? ` At this pace, ~$${projected.toFixed(0)} by month end.` : ''
  return `ccwarden: $${mtd.toFixed(2)} of your $${budget.toFixed(0)} month budget so far (${pct}%, est.).${pace}`
}

export function isBudgetMode(f: {
  manual: BudgetSwitch
  billing: Billing | undefined
  budgetModeAt: number
  /** Month to date and budget, metered. */
  mtd?: number
  budget?: number
  /** The 5h window's percentUsed, window billing. */
  fiveHourPct?: number
}): boolean {
  if (f.manual !== 'auto') return f.manual === 'on'
  if (f.billing === 'window') return f.fiveHourPct !== undefined && f.fiveHourPct >= f.budgetModeAt
  return f.budget !== undefined && f.budget > 0 && f.mtd !== undefined && (f.mtd / f.budget) * 100 >= f.budgetModeAt
}

/** The config in budget mode: earlier compaction advice, a stricter junk guard, earlier window alerts. */
export function budgetConfig(config: Config): Config {
  return {
    ...config,
    compactAt: Math.min(config.compactAt, 45),
    readMaxLines: Math.min(config.readMaxLines, 800),
    bashMaxChars: Math.min(config.bashMaxChars, 12_000),
    sessionAlertPct: Math.min(config.sessionAlertPct, 15),
  }
}

export function budgetModeText(on: boolean, why: string): string {
  return on
    ? `ccwarden: budget mode on (${why}): a stricter junk guard and earlier window alerts. /cw budget off to stop it.`
    : `ccwarden: budget mode off (${why}).`
}
