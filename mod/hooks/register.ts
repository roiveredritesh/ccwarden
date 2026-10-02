import { update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import type { CcwardenConversation } from '../types'
import { AGENT_WARN_USD, planSpawn, runningCount, turnUsd } from '../src/agents'
import { alertStep, alertText, isAlertDue } from '../src/alerts'
import { BILLING_HEADER, BILLING_OPTIONS, BILLING_QUESTION, billingFrom, billingRow } from '../src/billing'
import { cacheView, inferTtl, latestWriteTtl, parseTtl, ttlContradicts } from '../src/cache'
import { COLD_CANCEL, COLD_CONTINUE, coldDropReason, coldQuestion, isColdAskDue } from '../src/cold'
import type { Ttl } from '../src/cache'
import { limitFor, readConfig } from '../src/config'
import type { Billing, Config } from '../src/config'
import { rebuildUsd } from '../src/prices'
import { keptTail, lastAnswer, lastError, parseNumstat, planCompaction, snapshotText, summaryInstructions } from '../src/snapshot'
import type { SnapshotFacts } from '../src/snapshot'
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
// (spend alerts), F2 (the cold-cache guard), F3 (per-model limits and
// snapshot compaction), F5 (the subagent guard and per-agent cost), the first-run billing question, the R9 toast budget, and the transcript path
// the session facts are read from.

type $ = EngineInterface

const toastTimes = { plugin: 'ccwarden', key: 'toastTimes' } as const
const heldNote = { plugin: 'ccwarden', key: 'heldNote' } as const
const transcriptPath = { plugin: 'ccwarden', key: 'transcriptPath' } as const
const billingAsked = { plugin: 'ccwarden', key: 'billingAsked' } as const
const conversation = { plugin: 'ccwarden', key: 'conversation' } as const

const STATUS_TICK_MS = 60_000 // the cache countdown is shown in whole minutes
const TTL_RECHECK_MS = 10 * 60_000
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024 // what one $.fs.read takes
const TAIL_SHARE = 0.15 // of the model limit, for the turns kept verbatim
const CHARS_PER_TOKEN = 4

export const register: Register = (on, options) => {
  const config = readConfig(options)
  // One limit compaction at a time; a reload forgets it, which is harmless.
  let isCompacting = false

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

  // F2: before a typed prompt goes out over a cold cache with a large
  // context, ask. Cancel keeps the prompt: it goes back into the box.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' || e.turnId !== undefined) return next(e)
    if ((await $.session.surfaces()).length === 0) return next(e)
    const conv = (await $.state.get(conversation)).value ?? { alerted: 0 }
    const usage = await $.session.usage()
    const model = await $.session.model()
    const { ttl } = inferTtl({ observed: conv.observedTtl, override: await ttlOverride($), billing: config.billing })
    const cache = cacheView(conv.lastResponseAt, ttl, await $.clock.now())
    const tokens = usage.context.tokens
    const isDue = isColdAskDue({ cache, tokens, coldMinTokens: config.coldMinTokens, lastResponseAt: conv.lastResponseAt, askedFor: conv.coldAskedFor })
    if (!isDue || cache.kind !== 'cold' || tokens === undefined) return next(e)

    await update($, conversation, prev => ({ ...(prev ?? { alerted: 0 }), coldAskedFor: conv.lastResponseAt }))
    const question = coldQuestion({ msCold: cache.msCold, tokens, rebuildUsd: rebuildUsd(tokens, model, ttl) })
    const answer = await $.ui.ask(question, { header: 'Cold cache', options: [COLD_CONTINUE, COLD_CANCEL] }).catch(() => COLD_CANCEL)
    if (answer !== COLD_CANCEL) return next(e)
    // After the drop has settled, so the box isn't cleared over the refill.
    $.clock.after(0, () => void $.prompt.fill({ text: e.text, mode: 'replace' }))
    return { drop: coldDropReason(tokens) }
  })

  // F5: pin the model, cap the report, cap how many run at once.
  on('agent.spawn', async ($, e, next) => {
    if (!config.subagentGuard) return next(e)
    const plan = planSpawn(e, config, runningCount(await $.agent.list()))
    if ('deny' in plan) {
      $.ui.log(plan.deny)
      return { deny: plan.deny }
    }
    const started = await next({ ...e, prompt: plan.prompt, ...(plan.model === undefined ? {} : { model: plan.model }) })
    if (started.deny === undefined) $.ui.log(`ccwarden: ${e.subagentType} subagent: ${plan.notes.join(', ')}.`)
    await refreshStatus($, config)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      // A subagent's turn: its cost, and one toast if it passes AGENT_WARN_USD.
      // Its requests don't touch the main cache.
      const usd = e.usage === undefined ? undefined : turnUsd(e.usage)
      if (usd === undefined) return result
      const agentId = e.agentId
      let total = 0
      let isWarnDue = false
      const conv = await update($, conversation, prev => {
        const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
        const agents = { byId: { ...(c.agents?.byId ?? {}) }, warned: [...(c.agents?.warned ?? [])] }
        total = (agents.byId[agentId] ?? 0) + usd
        agents.byId[agentId] = total
        if (total > AGENT_WARN_USD && !agents.warned.includes(agentId)) {
          agents.warned.push(agentId)
          isWarnDue = true
        }
        c.agents = agents
        return c
      })
      if (isWarnDue) await notify($, 'spend', `⚠ A subagent (${agentId}) has cost $${total.toFixed(2)} so far (est.).`)
      await refreshStatus($, config, conv)
      return result
    }
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

    // F3: past the model's limit, compact once the turn is over (the engine
    // refuses mid-turn). Through `/compact`, not $.session.compact: a plugin's
    // own call skips its own session.compact hook, so it would get the engine
    // summary. The engine's own window stays the safety net.
    const usage = await $.session.usage()
    const model = await $.session.model()
    const limit = Math.min(limitFor(model, config), usage.context.window)
    const tokens = usage.context.tokens ?? 0
    if (tokens > limit && !isCompacting) {
      isCompacting = true
      $.ui.log(`ccwarden: ${Math.round(tokens / 1000)}k tokens is past the ${Math.round(limit / 1000)}k limit for ${model}; compacting.`)
      $.clock.after(0, async () => {
        const ran = await $.command.run({ command: 'compact' }).catch((err: unknown) => ({ error: String(err) }))
        isCompacting = false
        if ('error' in ran) $.ui.log(`ccwarden: compaction didn't run: ${ran.error}`)
        await refreshStatus($, config)
      })
    }
    return result
  })

  // F3 snapshot compaction: answer in core's place, so no summary request is
  // made. A `/compact <focus>` (or compactMode summary) keeps the engine's
  // summary, with the snapshot facts added to its instructions.
  on('session.compact', async ($, e, next) => {
    const plan = planCompaction(e, config.compactMode)
    if (plan === 'pass') return next(e)
    if (plan === 'skip') return { skip: 'ccwarden: snapshot compaction is on, so no summary is precomputed.' }

    const facts = await snapshotFacts($, e.messages)
    if (plan === 'summary+facts') {
      const text = snapshotText(facts, { cwd: await $.session.cwd(), keptTurns: 0 })
      return next({ ...e, instructions: summaryInstructions(e.instructions, text) })
    }

    const usage = await $.session.usage()
    const limit = Math.min(limitFor(await $.session.model(), config), usage.context.window)
    const { tail, turns } = keptTail(e.messages, limit * TAIL_SHARE * CHARS_PER_TOKEN)
    const text = snapshotText(facts, { cwd: await $.session.cwd(), keptTurns: turns })
    $.ui.log(`ccwarden: snapshot compaction (${e.trigger}): ${e.messages.length} messages → a ${text.length}-character snapshot + ${turns} turn(s) kept; no summary request.`)
    return { messages: [{ role: 'user', text, toolUses: [] }, ...tail] }
  })
}

/**
 * The facts a snapshot carries: asks, files and todos from the transcript
 * (else the messages compacted), the goal kept across compactions, and git's
 * branch and diff stat.
 */
async function snapshotFacts($: $, messages: readonly SessionMessage[]): Promise<SnapshotFacts> {
  const path = (await $.state.get(transcriptPath)).value
  let facts = await sessionFacts($, path)
  if (facts.asks.length === 0) facts = collectFromMessages(messages)
  const conv = await update($, conversation, prev => {
    const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
    c.goal ??= facts.asks[0]
    return c
  })
  const git = async (argv: string[]) => {
    const ran = await $.process.run(['git', ...argv], { timeoutMs: 5_000 }).catch(() => undefined)
    return ran?.exitCode === 0 ? ran.stdout.trim() : undefined
  }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const numstat = await git(['diff', '--numstat', 'HEAD'])
  return {
    goal: conv.goal,
    asks: facts.asks,
    todos: facts.todos,
    files: facts.files,
    diff: parseNumstat(numstat ?? ''),
    branch: branch === undefined || branch === '' ? undefined : branch,
    lastError: lastError(messages),
    lastAnswer: lastAnswer(messages),
  }
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
    agents: {
      running: runningCount(await $.agent.list()),
      usd: Object.values(conv.agents?.byId ?? {}).reduce((sum, v) => sum + v, 0),
    },
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
