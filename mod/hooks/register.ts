import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { BILLING_HEADER, BILLING_OPTIONS, BILLING_QUESTION, billingFrom, billingRow } from '../src/billing'
import { readConfig } from '../src/config'
import type { Billing, Config } from '../src/config'
import { admit, TOASTS_PER_HOUR } from '../src/toasts'
import type { Priority } from '../src/toasts'
import { collectFromMessages, collectFromTranscript, parseJsonl } from '../src/transcript'
import type { SessionFacts } from '../src/transcript'

// The hooks and every $ call live in this file: `claude plugin validate`
// follows $ only into functions declared in the same file, never across an
// import. The logic is in src/, pure and tested there.
//
// So far: the first slice of F1/F1b (this conversation's $ in the status
// line, a toast every `sessionAlertUsd`), the first-run billing question,
// the R9 toast budget, and the transcript path the session facts are read
// from.

type $ = EngineInterface

const toastTimes = { plugin: 'ccwarden', key: 'toastTimes' } as const
const heldNote = { plugin: 'ccwarden', key: 'heldNote' } as const
const transcriptPath = { plugin: 'ccwarden', key: 'transcriptPath' } as const
const billingAsked = { plugin: 'ccwarden', key: 'billingAsked' } as const

export const register: Register = (on, options) => {
  const config = readConfig(options)
  // Highest $ step already alerted in this conversation. A reload re-reads it
  // from the current total, so nothing alerts twice.
  let alerted = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { cost } = await $.session.usage()
    alerted = Math.floor((cost?.usd ?? 0) / config.sessionAlertUsd)
    // Detached, so the question never holds up the session's start.
    $.clock.after(0, () => void askBilling($, config))
    return result
  })

  // Fires on startup, resume, /clear and compaction; a /clear starts a new
  // transcript file (and raises no session.start).
  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path !== '') await $.state.set(transcriptPath, e.transcript_path)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const usd = e.cost?.usd
    if (usd === undefined) return result

    const step = Math.floor(usd / config.sessionAlertUsd)
    if (step < alerted) alerted = step // /clear: the conversation started over
    if (step > alerted) {
      alerted = step
      await notify($, 'spend', `⚠ You've spent $${usd.toFixed(2)} in this conversation (est.). Continuing.`)
    }
    $.ui.status(`this chat $${usd.toFixed(2)}${step > 0 ? ' ⚠' : ''}`)
    return result
  })
}

/**
 * Shows `text` as a toast if the hour's budget allows it (R9); otherwise
 * holds it as the band's note. Resolves whether the toast was shown.
 */
async function notify($: $, priority: Priority, text: string, timeoutMs = 10_000): Promise<boolean> {
  const now = await $.clock.now()
  let isShown = false
  await update($, toastTimes, times => {
    const verdict = admit(times ?? [], now, priority)
    isShown = verdict.isShown
    return verdict.times
  })
  if (isShown) {
    $.ui.toast(text, { timeoutMs })
  } else {
    await $.state.set(heldNote, { text, priority, at: now })
    $.ui.log(`ccwarden: toast held (R9, ${TOASTS_PER_HOUR}/hour): ${text}`, { to: 'debug' })
  }
  return isShown
}

/**
 * First run (SPEC §1): asks for `billing` while it is unset, at most once per
 * session; a dismissed question waits for the next session. Resolves the
 * answer, or undefined.
 */
async function askBilling($: $, config: Config): Promise<Billing | undefined> {
  if (config.billing !== undefined) return config.billing
  if ((await $.state.get(billingAsked)).value === true) return undefined
  if ((await $.session.surfaces()).length === 0) return undefined // headless: nobody to ask
  await $.state.set(billingAsked, true)

  const answer = await $.ui.ask(BILLING_QUESTION, { header: BILLING_HEADER, options: BILLING_OPTIONS }).catch(() => undefined)
  const billing = billingFrom(answer)
  if (billing === undefined) {
    $.ui.log('ccwarden: billing not set; costs show as metered until you set it in /config.')
    return undefined
  }

  const row = billingRow(await $.config.list(), $.plugin.name)
  const saved = row === undefined ? { deny: 'no billing row in /config' } : await $.config.set({ key: row.key, value: billing })
  $.ui.log(saved.deny === undefined
    ? `ccwarden: billing set to ${billing} for this machine (change it in /config).`
    : `ccwarden: couldn't save billing (${saved.deny}); set it in /config.`)
  return billing
}

/**
 * The session's facts (asks, edited files, todos), from the transcript when
 * its path is known (`transcriptPath` in $.state), else from the messages.
 */
async function sessionFacts($: $, path: string | undefined): Promise<SessionFacts> {
  if (path !== undefined && path !== '') {
    const text = await $.fs.read(path).catch(() => undefined)
    if (text !== undefined) return collectFromTranscript(parseJsonl(text))
  }
  return collectFromMessages(await $.session.messages())
}
