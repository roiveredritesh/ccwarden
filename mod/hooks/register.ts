import type { Register } from 'claude-code'

// First slice of the mod (spec F1/F1b): this conversation's spend in the
// status line, and a toast each time it crosses another ALERT_STEP_USD.
// The figure is the engine's own per-session total, the one /usage shows.
const ALERT_STEP_USD = 5

export const register: Register = on => {
  // Highest $ step already alerted in this conversation. A reload or /clear
  // re-reads it from the current total, so nothing alerts twice.
  let alerted = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { cost } = await $.session.usage()
    alerted = Math.floor((cost?.usd ?? 0) / ALERT_STEP_USD)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const usd = e.cost?.usd
    if (usd === undefined) return result

    const step = Math.floor(usd / ALERT_STEP_USD)
    if (step < alerted) alerted = step // the conversation started over
    if (step > alerted) {
      alerted = step
      $.ui.toast(`⚠ You've spent $${usd.toFixed(2)} in this conversation. Continuing.`, { timeoutMs: 10_000 })
    }
    $.ui.status(`this chat $${usd.toFixed(2)}${step > 0 ? ' ⚠' : ''}`)
    return result
  })
}
