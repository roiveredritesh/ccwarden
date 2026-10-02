import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { CcwardenConversation } from '../types'
import { alertStep, alertText, isAlertDue } from '../src/alerts'
import { BILLING_HEADER, BILLING_OPTIONS, BILLING_QUESTION, billingFrom, billingRow } from '../src/billing'
import { cacheView, inferTtl, latestWriteTtl, parseTtl, ttlContradicts } from '../src/cache'
import type { Ttl } from '../src/cache'
import { limitFor, readConfig } from '../src/config'
import type { Billing, Config } from '../src/config'
import { rebuildUsd } from '../src/prices'
import { formatStatus } from '../src/status'
import { admit, TOASTS_PER_HOUR } from '../src/toasts'
import type { Priority } from '../src/toasts'
import { collectFromMessages, collectFromTranscript, parseJsonl } from '../src/transcript'
import type { SessionFacts } from '../src/transcript'
import { fiveHour, trackWindow } from '../src/window'

// The hooks and every $ call live in this file: `claude plugin validate`
// follows $ only into functions declared in the same file, never across an
// import. The logic is in src/, pure and tested there.
//
// So far: F1 (the status line: model, context against the per-model limit,
// cache warm/cold, this conversation's $ or share of the 5h window), F1b
// (spend alerts), the first-run billing question, the R9 toast budget, and
// the transcript path the session facts are read from.

type $ = EngineInterface

const toastTimes = { plugin: 'ccwarden', key: 'toastTimes' } as const
const heldNote = { plugin: 'ccwarden', key: 'heldNote' } as const
const transcriptPath = { plugin: 'ccwarden', key: 'transcriptPath' } as const
const billingAsked = { plugin: 'ccwarden', key: 'billingAsked' } as const
const conversation = { plugin: 'ccwarden', key: 'conversation' } as const

const STATUS_TICK_MS = 60_000 // the cache countdown is shown in whole minutes
const TTL_RECHECK_MS = 10 * 60_000
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024 // what one $.fs.read takes

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // A reload keeps the conversation's state; a new process (startup,
    // resume) starts it from the engine's totals, so old steps don't alert.
    if ((await $.state.get(conversation)).value === undefined) {
      const usage = await $.session.usage()
      const reading = fiveHour(usage.rateLimits)
      await $.state.set(conversation, {
        alerted: alertStep(config, { usd: usage.cost?.usd }),
        ...(reading === undefined ? {} : { window: trackWindow(undefined, reading) }),
      })
    }
    $.clock.every(STATUS_TICK_MS, () => void refreshStatus($, config))
    // Detached, so the question never holds up the session's start.
    $.clock.after(0, () => void askBilling($, config))
    await refreshStatus($, config)
    return result
  })

  // Fires on startup, resume, /clear and compaction; a /clear starts a new
  // transcript file (and raises no session.start).
  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path !== '') await $.state.set(transcriptPath, e.transcript_path)
    return next(e)
  })

  // /clear ends the conversation: its figures start over, a held alert is
  // dropped, and the window share is measured from here.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const reading = fiveHour((await $.session.usage()).rateLimits)
      await $.state.set(conversation, { alerted: 0, ...(reading === undefined ? {} : { window: trackWindow(undefined, reading) }) })
      $.clock.after(0, () => void refreshStatus($, config))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const reading = fiveHour(e.rateLimits)
    let due: string | undefined
    const conv = await update($, conversation, prev => {
      const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
      if (reading !== undefined) c.window = trackWindow(c.window, reading)
      const figures = { usd: e.cost?.usd, chatPct: c.window?.chatPct }
      const step = alertStep(config, figures)
      if (step < c.alerted) c.alerted = step // the conversation started over
      if (isAlertDue(step, c.alerted, config.sessionAlertRepeat)) {
        due = alertText(config, figures)
        if (config.alertTiming === 'turnEnd') c.pendingAlert = due
      }
      if (step > c.alerted) c.alerted = step
      return c
    })
    if (due !== undefined && config.alertTiming === 'immediate') await notify($, 'spend', due)
    await refreshStatus($, config, conv)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result // a subagent's requests don't touch the main cache
    const now = await $.clock.now()
    let pending: string | undefined
    const conv = await update($, conversation, prev => {
      const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
      if (e.usage !== undefined) c.lastResponseAt = now
      pending = c.pendingAlert
      delete c.pendingAlert
      return c
    })
    if (pending !== undefined) await notify($, 'spend', pending)
    if (conv.ttlCheckedAt === undefined || now - conv.ttlCheckedAt >= TTL_RECHECK_MS) await observeTtl($, config, now)
    else await refreshStatus($, config, conv)
    return result
  })
}

/** Redraws the status line from the engine's figures and the conversation's state. */
async function refreshStatus($: $, config: Config, known?: CcwardenConversation): Promise<void> {
  const conv = known ?? (await $.state.get(conversation)).value ?? { alerted: 0 }
  const usage = await $.session.usage()
  const model = await $.session.model()
  const now = await $.clock.now()
  const { ttl } = inferTtl({ observed: conv.observedTtl, override: await ttlOverride($), billing: config.billing })
  const cache = cacheView(conv.lastResponseAt, ttl, now)
  const tokens = usage.context.tokens
  $.ui.status(formatStatus({
    billing: config.billing,
    model,
    tokens,
    limit: Math.min(limitFor(model, config), usage.context.window),
    cache,
    ttl,
    rebuildUsd: cache.kind === 'cold' && tokens !== undefined ? rebuildUsd(tokens, model, ttl) : undefined,
    usd: usage.cost?.usd,
    chatPct: conv.window?.chatPct,
    fiveHour: fiveHour(usage.rateLimits),
    now,
    isAlerted: conv.alerted > 0,
  }))
}

/** The documented TTL override: CLAUDE_CODE_PROMPT_CACHE_TTL, else the `promptCacheTtl` setting. */
async function ttlOverride($: $): Promise<Ttl | undefined> {
  return parseTtl(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')) ?? parseTtl((await $.settings.read()).promptCacheTtl)
}

/**
 * Reads the TTL of the latest cache write from the transcript (best effort:
 * skipped past what one read takes), records it, and says once per
 * conversation when it contradicts the billing setting (SPEC §1).
 */
async function observeTtl($: $, config: Config, now: number): Promise<void> {
  const path = (await $.state.get(transcriptPath)).value
  let observed: Ttl | undefined
  if (path !== undefined && path !== '') {
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat !== undefined && stat.size <= MAX_TRANSCRIPT_BYTES) {
      const text = await $.fs.read(path).catch(() => undefined)
      if (text !== undefined) observed = latestWriteTtl(parseJsonl(text))
    }
  }
  const override = await ttlOverride($)
  let isWarnDue = false
  const conv = await update($, conversation, prev => {
    const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }), ttlCheckedAt: now }
    if (observed !== undefined) c.observedTtl = observed
    if (observed !== undefined && !c.ttlWarned && ttlContradicts(config.billing, observed, override)) {
      c.ttlWarned = true
      isWarnDue = true
    }
    return c
  })
  if (isWarnDue) {
    await notify($, 'advisor', `ccwarden: cache writes use a ${observed} TTL, but billing is set to ${config.billing}. Check billing in /config.`)
  }
  await refreshStatus($, config, conv)
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
