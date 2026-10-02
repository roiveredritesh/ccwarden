import type { Config } from './config'

// F1b: a spend alert at every `sessionAlertUsd` (metered) or
// `sessionAlertPct` of the 5h window (window); only the first with
// `sessionAlertRepeat` off. It never blocks and adds nothing to context.

/** The step the conversation has reached, in the billing's unit. */
export function alertStep(config: Config, figures: { usd?: number; chatPct?: number }): number {
  if (config.billing === 'window') {
    return figures.chatPct === undefined ? 0 : Math.floor(figures.chatPct / config.sessionAlertPct)
  }
  return figures.usd === undefined ? 0 : Math.floor(figures.usd / config.sessionAlertUsd)
}

/** Whether reaching `step` alerts, given the highest step already alerted. */
export function isAlertDue(step: number, alerted: number, repeat: boolean): boolean {
  return step > alerted && (repeat || alerted === 0)
}

export function alertText(config: Config, figures: { usd?: number; chatPct?: number }): string {
  return config.billing === 'window'
    ? `⚠ This conversation has used ${figures.chatPct ?? 0}% of your 5-hour window (est.). Continuing.`
    : `⚠ You've spent $${(figures.usd ?? 0).toFixed(2)} in this conversation (est.). Continuing.`
}
