import { update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import type { CcwardenConversation, CcwardenDashboard } from '../types'
import { dashboardSections, dashboardText, PANE_ID } from '../src/dashboard'
import { analyze, requestsOf, ttlVerdict, weekReport } from '../src/report'
import { hogsOver } from '../src/hogs'
import { backgroundSource, backgroundToast } from '../src/background'
import type { BackgroundSource } from '../src/background'
import { handoffModelLine, startAdvice, switchNote } from '../src/advisor'
import { AGENT_WARN_USD, planSpawn, runningCount } from '../src/agents'
import { avoidedRebuild, PING_PROMPT, pingUsd, pingVerdict, TICK_MS } from '../src/keepwarm'
import { FULL_PROMPT, fullSections, handoffFileName, handoffMarkdown, handoffTopic, newestUnread, pickupPrompt } from '../src/handoff'
import { alertStep, alertText, isAlertDue } from '../src/alerts'
import { BILLING_HEADER, BILLING_OPTIONS, BILLING_QUESTION, billingFrom, billingRow } from '../src/billing'
import { cacheMiss, cacheView, inferTtl, latestWriteTtl, parseTtl, TTL_MS, ttlContradicts } from '../src/cache'
import { COLD_CANCEL, COLD_CONTINUE, COLD_HANDOFF, coldChoice, coldDropReason, coldQuestion, isColdAskDue } from '../src/cold'
import type { Ttl } from '../src/cache'
import { compactWindowFor, limitFor, readConfig } from '../src/config'
import { joinPath } from '../src/paths'
import type { Billing, Config } from '../src/config'
import { familyOf, rebuildUsd } from '../src/prices'
import { appendJunk, isAllowlisted, isAlreadyFiltered, isCheckedRead, readPlan, junkSavedText, junkTokens, outputPath, parseGlobs, readDenyText, isTestCommand, testOutput, trimmedOutput } from '../src/junk'
import type { JunkEvent } from '../src/junk'
import { addSpend, calibrate, costDelta, dayKey, monthKey, monthToDate, projectMonth } from '../src/ledger'
import { budgetConfig, budgetModeText, isBudgetMode, monthAlertText, monthStepsDue } from '../src/budget'
import type { BudgetSwitch } from '../src/budget'
import type { Ledger } from '../src/ledger'
import { estimateTokens, HOG_MIN_TOKENS, hogTarget, tallyHog, topHogs } from '../src/hogs'
import type { HogDays } from '../src/hogs'
import { goalOf, keptTail, lastAnswer, lastError, parseNumstat, planCompaction, snapshotText, summaryInstructions } from '../src/snapshot'
import type { SnapshotFacts } from '../src/snapshot'
import { addProjectDay, claudeDirOf, efficiencyData, fitCache, RECENT_EVENTS, SUMMARY_OUTPUT_TOKENS, isFresh, junkTimesBySession, openerArgv, projectKey, snapshotSaving, summarize } from '../src/efficiency'
import type { Coverage, DayFigures, HostOs, ProjectDays, SessionEvent, SummaryCache, TranscriptSummary } from '../src/efficiency'
import { dashboardHtml } from '../src/htmlDashboard'
import { addEvent, addTurn, addUsage, coldEstimate, emptyFile, METRICS_DIR, newRecord, nextPart, parseFile, pendingOutcome, pinEstimate, putOutcome, resume, serialize, summarizeMetrics, usageUsd } from '../src/metrics'
import type { MetricEvent, MetricsFile, MetricsSummary, Pending, Pin, Usage } from '../src/metrics'
import { fmtTokens, formatStatus } from '../src/status'
import type { Elements } from 'claude-code'
import type { StatusFacts } from '../src/status'
import { bandView } from '../src/band'
import type { BandButton, BandSegment } from '../src/band'
import { heatColumns, heatPixels, rasterCells, textCells, wardenPixels } from '../src/sprite'
import type { Px } from '../src/sprite'
import { WARDEN_SVG } from '../src/wardenSvg'
import { admit, TOASTS_PER_HOUR } from '../src/toasts'
import type { Priority } from '../src/toasts'
import { collectFromMessages, collectFromTranscript, lastResponseTime, parseJsonl } from '../src/transcript'
import type { SessionFacts } from '../src/transcript'
import { fiveHour, trackWindow } from '../src/window'
import { appendTopic, isTopicCandidate, isTopicShift, TOPIC_CLEAR, TOPIC_HANDOFF_CLEAR, TOPIC_SEND, topicChoice, topicDropReason, topicOverlap, topicQuestion } from '../src/topic'
import type { TopicEvent } from '../src/topic'

// The hooks and every $ call live in this file: `claude plugin validate`
// follows $ only into functions declared in the same file, never across an
// import. The logic is in src/, pure and tested there.
//
// So far: F1 (the status line: model, context against the per-model limit,
// cache warm/cold, this conversation's $ or share of the 5h window), F1b
// (spend alerts), F2 (the cold-cache guard), F3 (per-model limits and
// snapshot compaction), F4 (the junk guard), F5 (the subagent guard and
// per-agent cost), F6 (keep-warm, off by default until Q2), F7 (handoffs),
// F8 (the background spend watcher), F9 (model and effort advice), the
// M3 spend ledger and context hogs, F11 month tracking and budget mode,
// F10 the /cw dashboard pane, F13 (the unrelated-prompt hint, off by default), the first-run billing question, the R9 toast budget, and the transcript path
// the session facts are read from.

type $ = EngineInterface

/** What the module tracks between events; a reload starts it over, harmlessly. */
type Runtime = {
  isCompactAdvised: boolean
  isTurnRunning: boolean
  isPinging: boolean
  /** F8: prompts submitted while idle, oldest first, each with what sent it (undefined: the user). */
  queued: { text: string; source?: BackgroundSource }[]
  /** F8: what started the running turn, when the user didn't. */
  turnSource?: BackgroundSource
  /** Budget mode (SPEC §3), as last worked out. */
  isBudget: boolean
  /** F15: this session's metrics file as held in memory (loaded on first use), and whether it changed since the last write. */
  metrics?: MetricsFile
  isMetricsDirty: boolean
  isMetricsWarned: boolean
  /** F15: the session's file exists but couldn't be read, so it is never written over. */
  isMetricsUnread: boolean
  /** F15: makes event refs unique when two events share a millisecond (parallel tool calls). */
  refs: number
  /** F15: the page's recent events per metrics file, read again only when the file changes. */
  recentEvents: Map<string, { mtimeMs: number; size: number; events: MetricEvent[] }>
  /** F3: the compact window ccwarden set, and the one before it, for a holdout to put back (the variable is process-wide). */
  compactWindow?: { set: string; before: string | undefined }
  /** F15: /clear ended the part; the next event starts a new one, or a new file if the id changed. */
  isNewPart: boolean
  /** F15: pinned subagents whose saving adds up with each turn (F5), by agentId. */
  pins: Record<string, Pin>
  /** F15: savings that grow with each main-loop request (F4 kept-out output, F13 dropped context). */
  pending: Pending[]
  /** F15: a topic clear waiting for /clear to land; its saving counts the next conversation (F13). */
  topicCleared?: Pending
  /** F16: the band shows a moving warden (last minute, cold): the frame ticks at 2 fps, else every 5 s for the countdown. */
  isAnimated: boolean
  wardenTicks: number
}

const toastTimes = { plugin: 'ccwarden', key: 'toastTimes' } as const
const heldNote = { plugin: 'ccwarden', key: 'heldNote' } as const
const transcriptPath = { plugin: 'ccwarden', key: 'transcriptPath' } as const
const billingAsked = { plugin: 'ccwarden', key: 'billingAsked' } as const
const conversation = { plugin: 'ccwarden', key: 'conversation' } as const
const budgetModeRef = { plugin: 'ccwarden', key: 'budgetMode' } as const
const dashboardRef = { plugin: 'ccwarden', key: 'dashboard' } as const
const holdoutRef = { plugin: 'ccwarden', key: 'holdout' } as const
const bandRef = { plugin: 'ccwarden', key: 'band' } as const
const frameRef = { plugin: 'ccwarden', key: 'wardenFrame' } as const
const WARDEN_FRAME_MS = 500
const BAND_LABELS: Record<BandButton, string> = { handoff: 'Handoff', clear: 'Clear', send: 'Send anyway', cw: '/cw', ok: 'OK' }
const BAND_HOTKEYS: Record<BandButton, string> = { handoff: 'h', clear: 'c', send: 's', cw: 'w', ok: 'o' }
const WEEK_MS = 7 * 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const WEEK_MAX_FILES = 20

const STATUS_TICK_MS = 60_000 // the cache countdown is shown in whole minutes
const TTL_RECHECK_MS = 10 * 60_000
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024 // what one $.fs.read takes
const JUNK_LOG_KEY = 'junkLog' // $.store: what the junk guard did or would have done
const HANDOFFS_OFFERED_KEY = 'handoffsOffered' // $.store: handoff paths already offered at a start
const HANDOFF_CONTINUE = 'Continue from handoff'
const LEDGER_KEY = 'ledger' // $.store: this machine's est. spend per day (M3)
const HOG_DAYS_KEY = 'hogDays' // $.store: the day's biggest tool results (F10)
const MONTH_ALERTS_KEY = 'monthAlerts' // $.store: the month steps already alerted (F11)
const BUDGET_SWITCH_KEY = 'budgetSwitch' // $.store: /cw budget on|off|auto
const TOPIC_LOG_KEY = 'topicLog' // $.store: each unrelated-prompt hint and its answer, for tuning (F13)
const PROJECT_DAYS_KEY = 'projectDays' // $.store: per project and day, spend and what each guard did (F14)
const SUMMARIES_KEY = 'transcriptSummaries' // $.store: each transcript's summary, parsed once (F14)
const DASHBOARD_OPENED_KEY = 'dashboardOpened' // $.store: /cw open has run on this machine, so the page is kept fresh
const DASHBOARD_TICK_MS = 5 * 60_000
const DASHBOARD_FILE = 'ccwarden/dashboard.html'
const END_MIN_MS = 1_500 // of session end's short bound, needed to rewrite the page
const JUNK_SHOWN = 20 // events /ccwarden-junk lists
const TAIL_SHARE = 0.15 // of the model limit, for the turns kept verbatim
const CHARS_PER_TOKEN = 4
const MIN_MS = 60_000

export const register: Register = (on, options) => {
  const config = readConfig(options)
  const junkAllowlist = parseGlobs(config.junkAllowlist)
  const runtime: Runtime = { isCompactAdvised: false, isTurnRunning: false, isPinging: false, queued: [], isBudget: false, isMetricsDirty: false, isMetricsWarned: false, isMetricsUnread: false, refs: 0, recentEvents: new Map(), isNewPart: false, pins: {}, pending: [], isAnimated: false, wardenTicks: 0 }
  // The config as budget mode has it (stricter junk guard, earlier window alerts).
  const eff = (): Config => (runtime.isBudget ? budgetConfig(config) : config)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // A reload keeps the conversation's state; a new process (startup,
    // resume) starts it from the engine's totals, so old steps don't alert.
    if ((await $.state.get(conversation)).value === undefined) {
      const usage = await $.session.usage()
      const reading = fiveHour(usage.rateLimits)
      await $.state.set(conversation, {
        alerted: alertStep(config, { usd: usage.cost?.usd }),
        // A resumed conversation's earlier spend was counted when it happened.
        ledgerUsd: usage.cost?.usd ?? 0,
        ...(reading === undefined ? {} : { window: trackWindow(undefined, reading) }),
      })
    }
    await $.command.register({ name: 'handoff', description: 'ccwarden: write a handoff note for a fresh session (full while the cache is warm)', argumentHint: '[quick]' })
    await $.command.register({ name: 'cw', description: 'ccwarden: month to date, budget mode, calibration; open: the efficiency dashboard', argumentHint: '[open | spent <amount> | budget on|off|auto]' })
    runtime.isBudget = (await $.state.get(budgetModeRef)).value === true // a reload keeps it, unannounced
    await updateBudgetMode($, config, runtime)
    await $.command.register({ name: 'ccwarden-junk', description: "ccwarden: what the junk guard did (or, in observe mode, would have done)" })
    $.clock.every(STATUS_TICK_MS, () => void refreshStatus($, config))
    // F16: the band's frame. ponytail: one cheap tick always on; it redraws at 2 fps only while the warden moves.
    if (config.warden) {
      $.clock.every(WARDEN_FRAME_MS, () => {
        if (runtime.isAnimated || ++runtime.wardenTicks % 10 === 0) void update($, frameRef, n => (n ?? 0) + 1)
      })
    }
    $.clock.every(DASHBOARD_TICK_MS, () => void refreshEfficiency($, config, runtime, true))
    if (config.keepWarm) $.clock.every(TICK_MS, () => void keepWarmTick($, config, runtime))
    // Detached, so the question never holds up the session's start.
    $.clock.after(0, () => void askBilling($, config))
    await metricsFile($, config, runtime)
    await syncCompactWindow($, config, runtime)
    await refreshStatus($, config)
    return result
  })

  // Fires on startup, resume, /clear and compaction; a /clear starts a new
  // transcript file (and raises no session.start).
  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path !== '') await $.state.set(transcriptPath, e.transcript_path)
    // F7: a fresh start offers the newest handoff not offered before.
    if (e.source === 'startup') {
      $.clock.after(0, () => void offerHandoff($, config).catch((err: unknown) => $.ui.log(`ccwarden: handoff pickup failed: ${String(err)}`, { to: 'debug' })))
      // F9: before the first prompt nothing is cached, so a switch is free.
      if (config.modelAdvisor) {
        $.clock.after(0, async () => {
          const advice = startAdvice(e.model ?? (await $.session.model()))
          if (advice !== undefined) await notify($, 'advisor', advice)
        })
      }
    }
    return next(e)
  })

  // F9: no guard on a switch (Claude Code asks while the cache is warm);
  // only a note when the context is past the new model's limit.
  on('classic.PreModelSwitch', async ($, e, next) => {
    if (config.modelAdvisor) {
      const note = switchNote({ toModel: e.to_model, contextTokens: e.context_tokens, limit: limitFor(e.to_model, config), writeUsd: e.estimated_cache_write_usd })
      if (note !== undefined) $.ui.log(note)
    }
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    await writeHandoff($, config, runtime, e.args.trim() === 'quick' ? 'quick' : 'full')
    return {}
  })

  // /clear ends the conversation: its figures start over, a held alert is
  // dropped, and the window share is measured from here.
  on('session.end', async ($, e, next) => {
    await endMetrics($, runtime, e.reason === 'clear')
    if (e.reason === 'clear') await startOver($, config, runtime)
    if (next.budget.remainingMs >= END_MIN_MS) await refreshEfficiency($, config, runtime, false)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const reading = fiveHour(e.rateLimits)
    let due: string | undefined
    let spent = 0
    const conv = await update($, conversation, prev => {
      const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
      if (reading !== undefined) c.window = trackWindow(c.window, reading)
      if (e.cost !== undefined) {
        spent = costDelta(c.ledgerUsd, e.cost.usd)
        c.ledgerUsd = e.cost.usd
      }
      const figures = { usd: e.cost?.usd, chatPct: c.window?.chatPct }
      const step = alertStep(eff(), figures)
      if (step < c.alerted) c.alerted = step // the conversation started over
      if (isAlertDue(step, c.alerted, config.sessionAlertRepeat)) {
        due = alertText(eff(), figures)
        if (config.alertTiming === 'turnEnd') c.pendingAlert = due
      }
      if (step > c.alerted) c.alerted = step
      return c
    })
    if (due !== undefined && config.alertTiming === 'immediate') await spendAlert($, config, runtime, 'session', due)
    if (spent > 0) {
      await trackMonth($, config, runtime, await recordSpend($, spent))
      await recordProject($, { usd: spent })
    }
    if (spent > 0 || reading !== undefined) await updateBudgetMode($, config, runtime)
    await refreshStatus($, config, conv)
    return result
  })

  // F10: every main-loop tool result big enough to matter, for the dashboard.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined) return ran
    const tokens = estimateTokens(ran.text ?? JSON.stringify(ran.result ?? ''))
    if (tokens >= HOG_MIN_TOKENS) await recordHog($, { tool: String(e.tool), target: hogTarget(e as unknown as Record<string, unknown>), tokens })
    return ran
  })

  // F2: before a typed prompt goes out over a cold cache with a large
  // context, ask. Cancel keeps the prompt: it goes back into the box.
  on('prompt.submit', async ($, e, next) => {
    // F8: a prompt the user didn't type, starting a turn of its own.
    const source = backgroundSource(e.origin)
    if (e.turnId === undefined) runtime.queued = [...runtime.queued, { text: e.text, source }].slice(-20)
    if (source !== undefined) return next(e)
    if (e.origin.kind !== 'composer' || e.turnId !== undefined) return next(e)
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const model = await $.session.model()
    const before = (await $.state.get(conversation)).value ?? { alerted: 0 }
    const { ttl } = inferTtl({ observed: before.observedTtl, override: await ttlOverride($), billing: config.billing })
    const tokens = usage.context.tokens
    // F2: a resumed conversation's state starts without its last response, so
    // the cache's age comes from the transcript (until the first response).
    const seeded = before.lastResponseAt === undefined ? await transcriptLastResponse($) : undefined
    // F6: the prompt keep-warm waits for; and the rebuild a ping avoided, if any.
    const saved = avoidedRebuild({
      now, lastResponseAt: before.lastResponseAt, keepWarmAt: before.keepWarmAt, ttlMs: TTL_MS[ttl],
      rebuildUsd: tokens === undefined ? undefined : rebuildUsd(tokens, model, ttl),
    })
    const conv = await update($, conversation, prev => {
      const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }), lastPromptAt: now }
      if (c.lastResponseAt === undefined && seeded !== undefined) c.lastResponseAt = seeded
      if (saved > 0 && c.keepWarm !== undefined) c.keepWarm = { ...c.keepWarm, savedUsd: c.keepWarm.savedUsd + saved }
      return c
    })
    if (saved > 0) {
      await recordProject($, { keepWarmSavedUsd: saved, keepWarmSavedTokens: tokens ?? 0 })
      await recordEvent($, config, runtime, { at: now, feature: 'keepwarm', action: 'avoided', measured: { tokens: tokens ?? 0 }, est: { tokens: tokens ?? 0, usd: saved, formula: 'rebuild avoided by a ping: context × cache write price', confidence: 'high' } })
      await refreshStatus($, config, conv)
    }

    if ((await $.session.surfaces()).length === 0) return next(e)
    const cache = cacheView(lastCacheUse(conv), ttl, now)
    const isDue = isColdAskDue({ cache, tokens, coldMinTokens: config.coldMinTokens, lastResponseAt: conv.lastResponseAt, askedFor: conv.coldAskedFor, text: e.text })
    if (!isDue || cache.kind !== 'cold' || tokens === undefined) {
      // F13 only where F2 didn't ask: its question already names /clear.
      const reason = config.topicShiftHint ? await topicHint($, config, runtime, e.text, tokens, conv, await isHoldout($, config, runtime)) : undefined
      return reason === undefined ? next(e) : { drop: reason }
    }

    if (await isHoldout($, config, runtime)) {
      await update($, conversation, prev => ({ ...(prev ?? { alerted: 0 }), coldAskedFor: conv.lastResponseAt }))
      await recordEvent($, config, runtime, { at: now, feature: 'cold', action: 'would-ask', would: true, measured: { tokens, rebuildUsd: rebuildUsd(tokens, model, ttl) ?? 0 } })
      return next(e)
    }
    await update($, conversation, prev => ({ ...(prev ?? { alerted: 0 }), coldAskedFor: conv.lastResponseAt }))
    await recordProject($, { coldAsks: 1 })
    const rebuild = rebuildUsd(tokens, model, ttl)
    const ref = `cold-${now}-${++runtime.refs}`
    await recordEvent($, config, runtime, { at: now, feature: 'cold', action: 'asked', ref, measured: { tokens, minutesCold: Math.round(cache.msCold / MIN_MS), rebuildUsd: rebuild ?? 0 } })
    const question = coldQuestion({ msCold: cache.msCold, tokens, rebuildUsd: rebuild })
    const choice = coldChoice(await $.ui.ask(question, { header: 'Cold cache', options: [COLD_CONTINUE, COLD_HANDOFF, COLD_CANCEL] }).catch(() => undefined))
    await recordEvent($, config, runtime, { at: now, feature: 'cold', action: 'outcome', ref, measured: { choice }, est: coldEstimate(choice, tokens, rebuild) })
    if (choice === 'send') return next(e)
    await flushMetrics($, runtime) // no turn follows to write it
    // Quick on a cold cache: no model call, so nothing is re-cached.
    const handoffPath = choice === 'handoff' ? await writeHandoff($, config, runtime, 'quick') : undefined
    // After the drop has settled, so the box isn't cleared over the refill.
    $.clock.after(0, () => void $.prompt.fill({ text: e.text, mode: 'replace' }))
    // The drop reason isn't kept in the conversation; the log line is.
    const reason = coldDropReason(tokens, handoffPath)
    $.ui.log(reason)
    return { drop: reason }
  })

  // F4: a whole-file Read of a long text file, or a Read whose limit asks for
  // more than `readMaxLines` lines, is denied with a pointer to Grep or a
  // ranged Read. Files under `readMaxLines` bytes can't be that long and
  // aren't read; files one $.fs.read can't take are left alone.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (config.junkGuard === 'off' || !isCheckedRead(e) || isAllowlisted(e.file_path, junkAllowlist)) return next(e)
    const mode = (await isHoldout($, config, runtime)) ? 'observe' : config.junkGuard
    const stat = await $.fs.stat(e.file_path).catch(() => undefined)
    if (stat === undefined || stat.kind !== 'file' || stat.size <= eff().readMaxLines || stat.size > MAX_TRANSCRIPT_BYTES) return next(e)
    const text = await $.fs.read(e.file_path).catch(() => undefined)
    if (text === undefined) return next(e)
    const plan = readPlan(e, text)
    if (plan.asked <= eff().readMaxLines) return next(e)
    const event = { at: await $.clock.now(), tool: 'Read' as const, mode, target: e.file_path, size: plan.asked }
    if (mode === 'observe') {
      // What the engine really put in the context, when it says; else the estimate.
      const ran = await next(e)
      const got = ran.deny === undefined && !ran.isError && ran.result?.type === 'text' ? ran.result.file.content.length : undefined
      await recordJunk($, config, runtime, { ...event, savedChars: got ?? plan.estChars })
      return ran
    }
    await recordJunk($, config, runtime, { ...event, savedChars: plan.estChars })
    const reason = readDenyText(e.file_path, plan.asked, eff().readMaxLines, e.limit)
    $.ui.log(reason)
    return { deny: reason }
  })

  // F4: Bash output over `bashMaxChars` is cut to head + tail and the whole
  // of it saved to a file Claude can grep. Output Claude already filtered,
  // errors, and output the engine itself persisted are left alone; so is
  // any output whose full text couldn't be saved.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (config.junkGuard === 'off' || ran.deny !== undefined || isAlreadyFiltered(e.command)) return ran
    const mode = (await isHoldout($, config, runtime)) ? 'observe' : config.junkGuard
    // A test run, passed or failed, keeps only its failure lines and summary.
    // A failed one goes back as a plain result: a hook can't shorten an error.
    if (isTestCommand(e.command)) {
      const failed = ran.isError === true
      const text = failed ? (ran.text ?? '') : [ran.result.stdout, ran.result.stderr].filter(s => s !== '').join('\n')
      if ((!failed && ran.result.persistedOutputPath !== undefined) || text.length <= eff().bashMaxChars) return ran
      await recordJunk($, config, runtime, { at: await $.clock.now(), tool: 'Bash', mode, target: e.command.slice(0, 200), size: text.length, savedChars: text.length - eff().bashMaxChars })
      if (mode === 'observe') return ran
      const path = await saveOutput($, e.tool_use_id, text)
      if (path === undefined) return ran
      $.ui.log(`ccwarden junk guard: test output cut from ${text.length} characters to its failures and summary; the full text is in ${path}.`)
      return { result: { stdout: testOutput(text, eff().bashMaxChars, path, failed), stderr: '', interrupted: false } }
    }
    if (ran.isError) return ran
    const { stdout } = ran.result
    if (ran.result.persistedOutputPath !== undefined || stdout.length <= eff().bashMaxChars) return ran
    await recordJunk($, config, runtime, { at: await $.clock.now(), tool: 'Bash', mode, target: e.command.slice(0, 200), size: stdout.length, savedChars: stdout.length - eff().bashMaxChars })
    if (mode === 'observe') return ran
    const path = await saveOutput($, e.tool_use_id, stdout)
    if (path === undefined) return ran
    $.ui.log(`ccwarden junk guard: Bash output cut from ${stdout.length} to ~${eff().bashMaxChars} characters; the full text is in ${path}.`)
    return { result: { ...ran.result, stdout: trimmedOutput(stdout, eff().bashMaxChars, path) } }
  })

  // F11 and budget mode by hand. (The dashboard pane comes in M3-T3.)
  on('command.run', { command: 'cw' }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)
    const now = await $.clock.now()
    if (verb === 'open') {
      await $.store.set(DASHBOARD_OPENED_KEY, true)
      const path = await writeEfficiency($, config, runtime, true)
      if (path !== undefined) await openInBrowser($, path)
      return {}
    }
    if (verb === 'spent') {
      const real = Number((arg ?? '').replace(/^\$/, ''))
      if (!Number.isFinite(real) || real < 0) {
        $.ui.log('ccwarden: /cw spent <amount>: the real month-to-date from your billing page, e.g. /cw spent 42.50')
        return {}
      }
      await $.store.set(LEDGER_KEY, calibrate((await $.store.get(LEDGER_KEY)) as Ledger | undefined, real, now))
      $.ui.log(`ccwarden: month to date calibrated to $${real.toFixed(2)}; the estimate counts on from there.`)
    } else if (verb === 'budget' && (arg === 'on' || arg === 'off' || arg === 'auto')) {
      await $.store.set(BUDGET_SWITCH_KEY, arg)
      await updateBudgetMode($, config, runtime)
      $.ui.log(budgetModeText(runtime.isBudget, arg === 'auto' ? 'automatic' : 'set by hand'))
    } else if (verb !== undefined && verb !== '') {
      $.ui.log('ccwarden: /cw, /cw open, /cw spent <amount>, /cw budget on|off|auto')
      return {}
    }
    const ledger = (await $.store.get(LEDGER_KEY)) as Ledger | undefined
    const mtd = monthToDate(ledger, now)
    const budget = config.monthlyBudgetUsd > 0 ? ` of your $${config.monthlyBudgetUsd.toFixed(0)} budget` : ''
    $.ui.log(`ccwarden: this month $${mtd.toFixed(2)}${budget} on this machine (est.), ~$${projectMonth(mtd, now).toFixed(0)} at this pace; budget mode ${runtime.isBudget ? 'on' : 'off'}.`)
    await refreshStatus($, config)
    // F10: gather the figures, then open the pane that draws them.
    await $.state.set(dashboardRef, await buildDashboard($, config, runtime))
    if ((await $.session.surfaces()).length > 0) await $.ui.open({ id: PANE_ID, title: 'ccwarden' })
    return {}
  })

  // F10: the /cw pane. It draws what /cw gathered; Refresh gathers again.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = (await $.state.get(dashboardRef)).value
    if (d === undefined) return <Text dimColor>Run /cw to gather the figures.</Text>
    const refresh = async () => { await $.state.set(dashboardRef, await buildDashboard($, config, runtime)) }
    return (
      <Box flexDirection="column" gap={1}>
        {dashboardSections(d).map(section => (
          <Box key={section.title} flexDirection="column">
            <Text bold>{section.title}</Text>
            {section.lines.map(line => <Text wrap="wrap">  {line}</Text>)}
          </Box>
        ))}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="refresh" hotkey="r" onPress={() => void refresh()}>Refresh</Button>
          <Button key="handoff" hotkey="h" onPress={() => void writeHandoff($, config, runtime, 'full')}>Handoff</Button>
          <Button key="budget" hotkey="b" onPress={async () => {
            await $.store.set(BUDGET_SWITCH_KEY, runtime.isBudget ? 'off' : 'on')
            await updateBudgetMode($, config, runtime)
            $.ui.log(budgetModeText(runtime.isBudget, 'set from /cw'))
            await refreshStatus($, config)
            await refresh()
          }}>{runtime.isBudget ? 'Budget mode off' : 'Budget mode on'}</Button>
          <Button key="copy" hotkey="y" onPress={press => void $.ui.copy({ text: dashboardText(d), surface: press.surface })}>Copy report</Button>
        </Box>
      </Box>
    )
  })

  // F16: the band above the prompt (terminal and desktop), in place of the status line.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config.warden || e.props.hasSurvey) return next(e)
    const band = (await $.state.get(bandRef)).value
    if (band === undefined) return next(e)
    const conv = (await $.state.get(conversation)).value ?? { alerted: 0 }
    const note = (await $.state.get(heldNote)).value
    const frame = (await $.state.get(frameRef)).value ?? 0
    const now = await $.clock.now()
    const view = bandView({
      ...(band.facts as StatusFacts),
      now,
      cache: cacheView(band.lastCacheUse, (band.facts as StatusFacts).ttl, now),
      coldMinTokens: config.coldMinTokens,
      isColdAnswered: conv.coldAskedFor !== undefined && conv.coldAskedFor === conv.lastResponseAt,
      ...(conv.bandAlert === undefined ? {} : { spendAlert: conv.bandAlert }),
      ...(conv.bandPromotion === undefined ? {} : { promotion: conv.bandPromotion }),
      ...(note === null || note === undefined ? {} : { heldNote: note.text }),
    }, e.props.bodyColumns)
    const m = view.message
    runtime.isAnimated = m?.isAnimated === true

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const isRaster = e.surface === 'terminal' && 'Raster' in ui
    const pixels = (key: string, px: Px) => (isRaster ? <ui.Raster key={key} {...rasterCells(px)} /> : pixelText(ui, key, px))
    const seg = (s: BandSegment) => <Text key={s.kind} {...tint(s.color)} dimColor={s.isDim} bold={s.isBold} wrap="truncate-end">{s.text}</Text>
    const [model, ...rest] = view.segments
    if (m === undefined) {
      return (
        <Box flexDirection="row" gap={1}>
          {seg(model!)}
          {pixels('heat', heatPixels(view.pct, 12, 2, (band.facts as StatusFacts).compactAt))}
          {rest.flatMap((s, i) => (i === 0 ? [seg(s)] : [<Text key={`dot-${s.kind}`} dimColor>·</Text>, seg(s)]))}
        </Box>
      )
    }
    const face = isRaster
      ? <ui.Raster key="warden" {...rasterCells(wardenPixels(m.mood, frame, 0))} />
      : (
        <Box key="warden" flexDirection="row">
          {'Svg' in ui && <ui.Svg key="warden-svg" source={WARDEN_SVG} alt="Warden" width={59} height={40} />}
          {m.mood === 'cold' && <Text key="flag" bold color={frame % 2 ? '#7a0000' : '#ff2a2a'}>⚑</Text>}
        </Box>
      )
    return (
      <Box flexDirection="row" gap={1}>
        {face}
        {pixels('heat', heatPixels(view.pct, heatColumns(e.props.bodyColumns), 4, (band.facts as StatusFacts).compactAt))}
        <Box flexDirection="column">
          <Text key="said" bold color={m.color} wrap="wrap">{m.text}</Text>
          <Box flexDirection="row" gap={1}>
            <Text key="facts" wrap="truncate-end">{m.facts}</Text>
            {m.buttons.map(b => <Button key={b} hotkey={BAND_HOTKEYS[b]} onPress={() => void pressBand($, config, runtime, m.row, b)}>{BAND_LABELS[b]}</Button>)}
          </Box>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'ccwarden-junk' }, async ($) => {
    const log = ((await $.store.get(JUNK_LOG_KEY)) as JunkEvent[] | undefined) ?? []
    $.ui.log(`ccwarden junk guard (${config.junkGuard}): ${log.length} event${log.length === 1 ? '' : 's'}, ${junkSavedText(config.junkGuard, junkTokens(log))} (est.). Latest ${Math.min(log.length, JUNK_SHOWN)}:`)
    for (const ev of log.slice(-JUNK_SHOWN)) {
      $.ui.log(`  ${new Date(ev.at).toISOString()} ${ev.mode} ${ev.tool} ${ev.tool === 'Read' ? `${ev.size} lines` : `${ev.size} chars`}: ${ev.target}`)
    }
    return {}
  })

  // F5: pin the model, cap the report, cap how many run at once.
  on('agent.spawn', async ($, e, next) => {
    if (!config.subagentGuard) return next(e)
    const plan = planSpawn(e, config, runningCount(await $.agent.list()))
    if (await isHoldout($, config, runtime)) {
      const started = await next(e)
      if ('deny' in plan) await recordEvent($, config, runtime, { feature: 'subagent', action: 'would-deny', would: true, measured: { type: e.subagentType } })
      else if (started.deny === undefined) {
        await recordSpawn($, config, runtime, { type: e.subagentType, agentId: started.agentId, isPinned: plan.model !== undefined, would: true, from: started.model, to: plan.model ?? started.model, confidence: 'high' })
      }
      return started
    }
    if ('deny' in plan) {
      $.ui.log(plan.deny)
      await recordEvent($, config, runtime, { feature: 'subagent', action: 'denied', measured: { type: e.subagentType } })
      return { deny: plan.deny }
    }
    const started = await next({ ...e, prompt: plan.prompt, ...(plan.model === undefined ? {} : { model: plan.model }) })
    if (started.deny === undefined) {
      $.ui.log(`ccwarden: ${e.subagentType} subagent: ${plan.notes.join(', ')}.`)
      await recordSpawn($, config, runtime, {
        type: e.subagentType, agentId: started.agentId, isPinned: plan.model !== undefined, would: false,
        from: e.model ?? e.parentModel, to: started.model, confidence: e.model === undefined ? 'medium' : 'high',
      })
    }
    await refreshStatus($, config)
    return started
  })

  on('turn.start', async ($, e, next) => {
    runtime.isTurnRunning = true
    // F3: before the turn's first request, so a model picked with /model
    // compacts at its own limit from that request on (SPEC §9 Q25).
    await syncCompactWindow($, config, runtime)
    // The turn's prompt, matched by text; a turn no queued prompt matches is the user's.
    const i = runtime.queued.findIndex(q => q.text === e.text)
    runtime.turnSource = i === -1 ? undefined : runtime.queued[i]!.source
    if (i !== -1) runtime.queued = runtime.queued.filter((_, j) => j !== i)
    if (runtime.turnSource === undefined) await editMetrics($, config, runtime, f => ({ ...f, record: { ...f.record, prompts: f.record.prompts + 1 } }))
    return next(e)
  })

  // F1: a turn's first request that re-cached the conversation is named in
  // the status, with its likely cause. Watches the step's usage only; the
  // request and the response pass through unchanged.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId === undefined && r.usage !== null) await countRequest($, config, runtime)
    if (e.agentId !== undefined || e.index !== 0 || r.usage === null) return r
    const usage = r.usage
    const now = await $.clock.now()
    const override = await ttlOverride($)
    let miss: ReturnType<typeof cacheMiss>
    const conv = await update($, conversation, prev => {
      const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
      const { ttl } = inferTtl({ observed: c.observedTtl, override, billing: config.billing })
      miss = cacheMiss({
        read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens, model: usage.model,
        prevModel: c.lastStepModel, lastUseAt: lastCacheUse(c), now, ttl,
        isCompacted: (c.compactions ?? 0) !== (c.compactionsSeen ?? 0),
      })
      c.lastMiss = miss
      c.lastStepModel = usage.model
      c.compactionsSeen = c.compactions ?? 0
      return c
    })
    if (miss !== undefined) $.ui.log(`ccwarden: the cache missed (${miss.cause}); this request re-cached ${fmtTokens(miss.tokens)} tokens.`)
    await refreshStatus($, config, conv)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.usage !== undefined) await addTurnMetrics($, config, runtime, e.usage, e.agentId)
    if (e.agentId === undefined) runtime.isTurnRunning = false
    if (e.agentId !== undefined) {
      // A subagent's turn: its cost, and one toast if it passes AGENT_WARN_USD.
      // Its requests don't touch the main cache.
      const usd = e.usage === undefined ? undefined : usageUsd(e.usage)
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
      if (isWarnDue) await spendAlert($, config, runtime, 'subagent', `⚠ A subagent (${agentId}) has cost $${total.toFixed(2)} so far (est.).`)
      await refreshStatus($, config, conv)
      return result
    }
    const source = runtime.turnSource
    runtime.turnSource = undefined
    if (source !== undefined && config.backgroundWatch && e.usage !== undefined) await watchBackground($, source, usageUsd(e.usage) ?? 0)
    const now = await $.clock.now()
    let pending: string | undefined
    const conv = await update($, conversation, prev => {
      const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
      if (e.usage !== undefined) c.lastResponseAt = now
      pending = c.pendingAlert
      delete c.pendingAlert
      return c
    })
    if (pending !== undefined) await spendAlert($, config, runtime, 'session', pending)
    if (conv.ttlCheckedAt === undefined || now - conv.ttlCheckedAt >= TTL_RECHECK_MS) await observeTtl($, config, now)
    else await refreshStatus($, config, conv)

    // F3: the engine's auto-compaction runs at the model's limit and is a
    // snapshot. Should the context still be past it (one long turn), say so
    // once: the mod can't compact itself, since `$.command.run('compact')` and
    // `$.session.compact` both skip its own session.compact hook (SPEC §9 Q13).
    await syncCompactWindow($, config, runtime)
    const usage = await $.session.usage()
    const model = await $.session.model()
    const limit = await limitOf($, model, config, usage.context.window)
    const tokens = usage.context.tokens ?? 0
    await recordProject($, { turns: 1, peakContext: tokens })
    if (tokens <= limit) runtime.isCompactAdvised = false
    else if (!runtime.isCompactAdvised && (await isHoldout($, config, runtime))) {
      runtime.isCompactAdvised = true
      await recordEvent($, config, runtime, { feature: 'limit', action: 'would-hint', would: true, measured: { tokens, limit } })
    } else if (!runtime.isCompactAdvised) {
      runtime.isCompactAdvised = true
      await recordEvent($, config, runtime, { feature: 'limit', action: 'compact-hint', measured: { tokens, limit } })
      const text = `ccwarden: ${Math.round(tokens / 1000)}k tokens is past the ${Math.round(limit / 1000)}k limit for ${model}. Type /compact: it keeps a snapshot, no summary request.`
      $.ui.log(text)
      await notify($, 'advisor', text)
    }
    await flushMetrics($, runtime)
    return result
  })

  // F3 snapshot compaction: answer in core's place, so no summary request is
  // made. A `/compact <focus>` (or compactMode summary) keeps the engine's
  // summary, with the snapshot facts added to its instructions.
  on('session.compact', async ($, e, next) => {
    const plan = planCompaction(e, config.compactMode)
    if (plan === 'pass') return next(e)
    if (await isHoldout($, config, runtime)) {
      if (plan !== 'skip') {
        const usage = await $.session.usage()
        const saving = snapshotSaving(usage.context.tokens ?? 0, await $.session.model())
        await settleJunk($, config, runtime)
        await recordEvent($, config, runtime, { feature: 'snapshot', action: 'would-answer', would: true, measured: { tokens: usage.context.tokens ?? 0, trigger: e.trigger }, ...(saving === undefined ? {} : { est: { tokens: saving.tokens, usd: saving.usd, formula: `context × read + ${SUMMARY_OUTPUT_TOKENS} × output`, confidence: 'low' as const } }) })
      }
      return next(e)
    }
    if (plan === 'skip') return { skip: 'ccwarden: snapshot compaction is on, so no summary is precomputed.' }

    await update($, conversation, prev => ({
      ...(prev ?? { alerted: 0 }),
      compactions: (prev?.compactions ?? 0) + 1,
      snapshots: (prev?.snapshots ?? 0) + (plan === 'snapshot' ? 1 : 0),
    }))
    await settleJunk($, config, runtime)
    const facts = await snapshotFacts($, e.messages)
    if (config.handoffOnCompact) await writeHandoff($, config, runtime, 'quick', e.messages)
    if (plan === 'summary+facts') {
      const text = snapshotText(facts, { cwd: await $.session.cwd(), keptTurns: 0 })
      await recordEvent($, config, runtime, { feature: 'compact', action: 'summarised', measured: { tokens: (await $.session.usage()).context.tokens ?? 0, trigger: e.trigger } })
      return next({ ...e, instructions: summaryInstructions(e.instructions, text) })
    }

    const usage = await $.session.usage()
    const limit = await limitOf($, await $.session.model(), config, usage.context.window)
    const { tail, turns } = keptTail(e.messages, limit * TAIL_SHARE * CHARS_PER_TOKEN)
    const text = snapshotText(facts, { cwd: await $.session.cwd(), keptTurns: turns })
    const saving = snapshotSaving(usage.context.tokens ?? 0, await $.session.model())
    await recordProject($, { snapshots: 1, ...(saving === undefined ? {} : { snapshotSavedUsd: saving.usd, snapshotSavedTokens: saving.tokens }) })
    if (saving !== undefined) await recordEvent($, config, runtime, { feature: 'snapshot', action: 'answered', measured: { tokens: usage.context.tokens ?? 0, trigger: e.trigger }, est: { tokens: saving.tokens, usd: saving.usd, formula: `context × read + ${SUMMARY_OUTPUT_TOKENS} × output`, confidence: 'low' } })
    $.ui.log(`ccwarden: snapshot compaction (${e.trigger}): ${e.messages.length} messages → a ${text.length}-character snapshot + ${turns} turn(s) kept; no summary request.`)
    return { messages: [{ role: 'user', text, toolUses: [] }, ...tail] }
  })
}

/** /clear: the conversation's figures start over, a held alert is dropped, and the window share is measured from here. */
async function startOver($: $, config: Config, runtime: Runtime): Promise<void> {
  if (runtime.topicCleared !== undefined) {
    runtime.pending = [...runtime.pending.filter(p => p.ref !== runtime.topicCleared!.ref), runtime.topicCleared]
    runtime.topicCleared = undefined
  }
  const reading = fiveHour((await $.session.usage()).rateLimits)
  await $.state.set(conversation, { alerted: 0, ledgerUsd: 0, ...(reading === undefined ? {} : { window: trackWindow(undefined, reading) }) })
  $.clock.after(0, () => void refreshStatus($, config))
}

/**
 * F13: a typed prompt that shares almost no words with the goal, recent asks
 * and last answer is asked about. Clear runs /clear (queued until idle) and
 * puts the prompt back; that prompt goes through when sent again. Send mutes
 * the hint until the context grows 20%. Returns the drop reason, or undefined
 * to send.
 */
async function topicHint($: $, config: Config, runtime: Runtime, text: string, tokens: number | undefined, conv: CcwardenConversation, isHoldoutSession: boolean): Promise<string | undefined> {
  if (tokens === undefined || !isTopicCandidate({ text, tokens, mutedAt: conv.topicMutedAt, skip: conv.topicSkip })) return undefined
  const facts = await sessionFacts($, (await $.state.get(transcriptPath)).value)
  const history = [goalOf({ goal: conv.goal, asks: facts.asks }) ?? '', ...facts.asks.slice(-5), lastAnswer(await $.session.messages()) ?? '']
  if (!isTopicShift(text, history)) return undefined
  if (isHoldoutSession) {
    await recordEvent($, config, runtime, { feature: 'topic', action: 'would-ask', would: true, measured: { tokens } })
    return undefined
  }
  const answer = await $.ui.ask(topicQuestion(tokens), { header: 'New topic?', options: [TOPIC_SEND, TOPIC_CLEAR, TOPIC_HANDOFF_CLEAR] }).catch(() => undefined)
  const choice = topicChoice(answer)
  await update($, conversation, prev => ({ ...(prev ?? { alerted: 0 }), ...(choice === 'send' ? { topicMutedAt: tokens } : { topicSkip: text.trim() }) }))
  const { overlap, count } = topicOverlap(text, history)
  const log = (await $.store.get(TOPIC_LOG_KEY)) as TopicEvent[] | undefined
  await $.store.set(TOPIC_LOG_KEY, appendTopic(log, { at: await $.clock.now(), overlap, keywords: count, tokens, choice }))
  if (choice === 'send') return undefined
  // Quick: no model call, so the old context isn't re-read just to write it.
  const handoffPath = choice === 'handoff' ? await writeHandoff($, config, runtime, 'quick') : undefined
  const isCleared = choice !== 'keep'
  if (isCleared) {
    await recordProject($, { topicClears: 1 })
    const family = familyOf(await $.session.model())
    const at = await $.clock.now()
    const ref = `topic-${at}-${++runtime.refs}`
    await recordEvent($, config, runtime, { at, feature: 'topic', action: 'cleared', ref, measured: { tokens } })
    if (family !== undefined) runtime.topicCleared = { ref, feature: 'topic', at, tokens, family, requests: 0, would: false }
  }
  // After the drop has settled; /clear itself waits until the session is idle.
  $.clock.after(0, async () => {
    if (isCleared) {
      const ran = await $.command.run({ command: 'clear' }).catch(() => undefined)
      // A plugin's own command skips its own hooks (Q13), so session.end may not reset it.
      if (ran !== undefined) {
        await endMetrics($, runtime, true)
        await startOver($, config, runtime)
      }
      else $.ui.log('ccwarden: /clear could not be run from here; type /clear, then send your prompt.')
    }
    await $.prompt.fill({ text, mode: 'replace' })
  })
  const reason = topicDropReason({ isCleared, handoffPath })
  $.ui.log(reason)
  return reason
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
    c.goal ??= goalOf(facts)
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

/** M3: adds spend to today's line of this machine's ledger; resolves the ledger after. */
async function recordSpend($: $, usd: number): Promise<Ledger> {
  const day = dayKey(await $.clock.now())
  const ledger = addSpend((await $.store.get(LEDGER_KEY)) as Ledger | undefined, day, usd)
  await $.store.set(LEDGER_KEY, ledger)
  return ledger
}

/** F14: adds `add` to today's line for this session's project in `projectDays`. */
async function recordProject($: $, add: DayFigures): Promise<void> {
  const day = dayKey(await $.clock.now())
  const pd = (await $.store.get(PROJECT_DAYS_KEY)) as ProjectDays | undefined
  await $.store.set(PROJECT_DAYS_KEY, addProjectDay(pd, await $.session.root(), day, add))
}

/** F15: this session's metrics file: held, else read back from disk (a reload), else new. A changed id writes the old file first. */
async function metricsFile($: $, config: Config, runtime: Runtime): Promise<MetricsFile> {
  const session = await $.session.id()
  const now = await $.clock.now()
  const held = runtime.metrics
  if (held !== undefined && held.record.session === session) {
    if (runtime.isNewPart) {
      runtime.isNewPart = false
      runtime.metrics = nextPart(held, now)
      runtime.isMetricsDirty = true
    }
    return runtime.metrics!
  }
  if (held !== undefined) await flushMetrics($, runtime) // /clear gave a new id (Q22): that file is done
  runtime.isNewPart = false
  const fresh = newRecord({ session, project: projectKey(await $.session.root()), now, measuring: config.measureHoldout })
  const path = await metricsPath($, session)
  const text = path === undefined ? undefined : await $.fs.read(path).catch(() => undefined)
  const isUnread = text === undefined && path !== undefined && (await $.fs.stat(path).then(() => true, () => false))
  // Another hook loaded the file while this one waited: go on from that one, changes and all.
  if (runtime.metrics?.record.session === session) return runtime.metrics
  runtime.isMetricsUnread = isUnread
  runtime.metrics = text === undefined ? emptyFile(fresh) : resume(text, fresh)
  await $.state.set(holdoutRef, runtime.metrics.record.holdout)
  if (runtime.metrics.record.holdout && text === undefined) $.ui.log('ccwarden: proof mode: this session is a holdout, so guards are off and what they would have done is logged.')
  runtime.isMetricsDirty = true
  return runtime.metrics
}

/** F15: this session runs with the guards off (a holdout); decided once per session id. */
async function isHoldout($: $, config: Config, runtime: Runtime): Promise<boolean> {
  return (await metricsFile($, config, runtime)).record.holdout
}

async function metricsPath($: $, session: string): Promise<string | undefined> {
  const claude = await claudeDir($)
  return claude === undefined ? undefined : joinPath(claude, `${METRICS_DIR}/${session}.jsonl`)
}

/** F15: changes this session's file in memory; the next flush writes it. */
async function editMetrics($: $, config: Config, runtime: Runtime, change: (f: MetricsFile) => MetricsFile): Promise<void> {
  await metricsFile($, config, runtime)
  runtime.metrics = change(runtime.metrics!) // a hook that ran during the wait keeps its change
  runtime.isMetricsDirty = true
}

/** F15: one event, stamped with the time (unless given) and the main model. */
async function recordEvent($: $, config: Config, runtime: Runtime, ev: Omit<MetricEvent, 'v' | 'at' | 'model'> & { at?: number }): Promise<void> {
  const at = ev.at ?? (await $.clock.now())
  const model = await $.session.model()
  await editMetrics($, config, runtime, f => addEvent(f, { ...ev, v: 1, at, model }))
}

/** F15: writes the file if anything changed; a refusal is logged once per session and retried at the next flush. */
async function flushMetrics($: $, runtime: Runtime): Promise<void> {
  let f = runtime.metrics
  if (f === undefined || !runtime.isMetricsDirty) return
  for (const p of runtime.pending) f = putOutcome(f, pendingOutcome(p))
  runtime.metrics = f
  const path = await metricsPath($, f.record.session)
  if (path === undefined) return
  if (runtime.isMetricsUnread) {
    if (!runtime.isMetricsWarned) {
      runtime.isMetricsWarned = true
      $.ui.log(`ccwarden: couldn't read the metrics log at ${path}, so this session's events aren't written, to keep what it holds.`)
    }
    return
  }
  const isWritten = await $.fs.write(path, serialize(f)).then(() => true, () => false)
  if (isWritten && runtime.metrics === f) runtime.isMetricsDirty = false // an event added during the write stays due
  else if (!runtime.isMetricsWarned) {
    runtime.isMetricsWarned = true
    $.ui.log(`ccwarden: couldn't write the metrics log to ${path}; it will retry.`)
  }
}

/** F15: what ccwarden spent itself (a keep-warm ping, a full handoff's fork) in the session's $, so the proof weighs it. */
async function addOwnSpend($: $, config: Config, runtime: Runtime, usd: number): Promise<void> {
  if (usd > 0) await editMetrics($, config, runtime, f => ({ ...f, record: { ...f.record, usd: f.record.usd + usd } }))
}

/** F15: a spend toast (or one held by R9), counted on the page; it saves nothing by itself. */
async function spendAlert($: $, config: Config, runtime: Runtime, kind: 'session' | 'subagent' | 'month', text: string): Promise<void> {
  const shown = await notify($, 'spend', text)
  await recordEvent($, config, runtime, { feature: 'alert', action: 'sent', measured: { kind, shown } })
}

/** F15: a conversation ended: the file is written; after /clear the next event starts a new part. */
async function endMetrics($: $, runtime: Runtime, isClear: boolean): Promise<void> {
  if (runtime.metrics === undefined) return
  runtime.isMetricsDirty = true
  await flushMetrics($, runtime)
  // ponytail: a topic saving with no request yet belongs to the conversation after this /clear, so it waits
  runtime.pending = runtime.pending.filter(p => p.feature === 'topic' && p.requests === 0 && isClear)
  if (isClear) runtime.isNewPart = true
}

/** F15: a compaction drops kept-out output from the context, so its re-reads stop here. */
async function settleJunk($: $, config: Config, runtime: Runtime): Promise<void> {
  const junk = runtime.pending.filter(p => p.feature === 'junk')
  if (junk.length === 0) return
  await editMetrics($, config, runtime, f => junk.reduce((acc, p) => putOutcome(acc, pendingOutcome(p)), f))
  runtime.pending = runtime.pending.filter(p => p.feature !== 'junk')
}

/** F15: a main-loop request, counted in the record. */
async function countRequest($: $, config: Config, runtime: Runtime): Promise<void> {
  for (const p of runtime.pending) p.requests++
  await editMetrics($, config, runtime, f => ({ ...f, record: { ...f.record, requests: f.record.requests + 1 } }))
}

/** F15: a finished turn into the record; a pinned subagent's turn also rewrites its saving. */
async function addTurnMetrics($: $, config: Config, runtime: Runtime, usage: Usage, agentId: string | undefined): Promise<void> {
  const now = await $.clock.now()
  await editMetrics($, config, runtime, f => ({ ...f, record: addTurn(f.record, usage, agentId !== undefined, now) }))
  const pin = agentId === undefined ? undefined : runtime.pins[agentId]
  if (pin === undefined) return
  pin.usage = addUsage(pin.usage, usage)
  const total = pin.usage
  const est = pinEstimate(total, pin.from, pin.to, pin.confidence)
  const tokens = total.input_tokens + total.output_tokens + total.cache_read_input_tokens + total.cache_creation_input_tokens
  await editMetrics($, config, runtime, f => putOutcome(f, {
    v: 1, at: now, feature: 'subagent', action: 'outcome', ref: pin.ref, ...(pin.would ? { would: true as const } : {}),
    measured: { agentId: agentId!, tokens, usd: usageUsd(total) ?? 0 }, ...(est === undefined ? {} : { est }),
  }))
}

/** F15: a started subagent (F5): pinned or only capped; a pin's saving is settled by its turns. */
async function recordSpawn($: $, config: Config, runtime: Runtime, s: { type: string; agentId?: string; isPinned: boolean; would: boolean; from: string; to: string; confidence: 'high' | 'medium' }): Promise<void> {
  const at = await $.clock.now()
  const ref = `subagent-${at}-${s.agentId ?? ''}`
  await recordEvent($, config, runtime, {
    at, feature: 'subagent', action: s.isPinned ? 'pinned' : 'capped', ref, ...(s.would ? { would: true as const } : {}),
    measured: { type: s.type, asked: s.from, ran: s.to },
  })
  if (s.isPinned && s.agentId !== undefined) runtime.pins[s.agentId] = { ref, from: s.from, to: s.to, confidence: s.confidence, would: s.would }
}
/** F11 (metered): a toast at 50%, 80% and 100% of the month budget, each once a month on this machine. */
async function trackMonth($: $, config: Config, runtime: Runtime, ledger: Ledger): Promise<void> {
  if (config.billing === 'window' || config.monthlyBudgetUsd <= 0) return
  const now = await $.clock.now()
  const month = monthKey(now)
  const mtd = monthToDate(ledger, now)
  const record = (await $.store.get(MONTH_ALERTS_KEY)) as { month: string; sent: number[] } | undefined
  const sent = record?.month === month ? record.sent : []
  const due = monthStepsDue(mtd, config.monthlyBudgetUsd, sent)
  if (due.length === 0) return
  await $.store.set(MONTH_ALERTS_KEY, { month, sent: [...sent, ...due] })
  await spendAlert($, config, runtime, 'month', monthAlertText(mtd, config.monthlyBudgetUsd, projectMonth(mtd, now)))
}

/**
 * F10: the dashboard's figures: this session (live figures, plus cache hits
 * and rebuilds from its transcript), guard savings, month to date, hogs, and
 * the last 7 days of this project's transcripts (each one $.fs.read takes).
 */
async function buildDashboard($: $, config: Config, runtime: Runtime): Promise<CcwardenDashboard> {
  const now = await $.clock.now()
  const usage = await $.session.usage()
  const model = await $.session.model()
  const conv = (await $.state.get(conversation)).value ?? { alerted: 0 }
  const month = monthKey(now)

  const path = (await $.state.get(transcriptPath)).value
  const readReport = async (file: string, size?: number) => {
    if (size !== undefined && size > MAX_TRANSCRIPT_BYTES) return undefined
    const text = await $.fs.read(file).catch(() => undefined)
    return text === undefined ? undefined : analyze(requestsOf(parseJsonl(text)))
  }
  const current = path === undefined || path === '' ? undefined : await readReport(path)

  let week: CcwardenDashboard['week']
  if (path !== undefined && path !== '') {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    const dir = path.slice(0, cut)
    const files = (await $.fs.list(dir).catch(() => []))
      .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl') && now - f.mtimeMs <= WEEK_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, WEEK_MAX_FILES)
    const sessions: { id: string; report: NonNullable<Awaited<ReturnType<typeof readReport>>> }[] = []
    for (const f of files) {
      const report = await readReport(`${dir}${path.charAt(cut)}${f.name}`, f.size)
      if (report !== undefined) sessions.push({ id: f.name.replace(/\.jsonl$/, ''), report })
    }
    const w = weekReport(sessions)
    week = { sessions: w.sessions, causes: w.causes, verdict: ttlVerdict(w) }
  }

  const junk = (((await $.store.get(JUNK_LOG_KEY)) as JunkEvent[] | undefined) ?? []).filter(ev => new Date(ev.at).toISOString().startsWith(month))
  const ledger = (await $.store.get(LEDGER_KEY)) as Ledger | undefined
  const mtd = monthToDate(ledger, now)
  return {
    at: now,
    session: {
      model,
      tokens: usage.context.tokens,
      limit: await limitOf($, model, config, usage.context.window),
      usd: usage.cost?.usd,
      hitRatio: current?.hitRatio,
      rebuilds: current?.rebuilds ?? [],
      compactions: conv.compactions ?? 0,
      agentsRunning: runningCount(await $.agent.list()),
      agentsUsd: Object.values(conv.agents?.byId ?? {}).reduce((sum, v) => sum + v, 0),
      backgroundUsd: conv.background?.usd ?? 0,
    },
    savings: {
      junkMode: config.junkGuard,
      junkEvents: junk.length,
      junkTokens: junkTokens(junk),
      keepWarmSpent: conv.keepWarm?.spentUsd ?? 0,
      keepWarmSaved: conv.keepWarm?.savedUsd ?? 0,
      snapshots: conv.snapshots ?? 0,
    },
    month: { mtd, budget: config.monthlyBudgetUsd, projected: projectMonth(mtd, now), isBudget: runtime.isBudget, isMetered: config.billing !== 'window' },
    hogs: { session: conv.hogs ?? [], month: hogsOver((await $.store.get(HOG_DAYS_KEY)) as HogDays | undefined, month) },
    week,
  }
}

/** F14: rewrites the page if /cw open has run on this machine; never throws. `canParse` false reads no transcript anew. */
async function refreshEfficiency($: $, config: Config, runtime: Runtime, canParse: boolean): Promise<void> {
  if ((await $.store.get(DASHBOARD_OPENED_KEY)) !== true) return
  await writeEfficiency($, config, runtime, canParse).catch((err: unknown) => $.ui.log(`ccwarden: dashboard refresh failed: ${String(err)}`, { to: 'debug' }))
}

/** F14: gathers the figures and writes the page; resolves its path, or undefined (logged) when it couldn't. */
async function writeEfficiency($: $, config: Config, runtime: Runtime, canParse: boolean): Promise<string | undefined> {
  const claude = await claudeDir($)
  if (claude === undefined) {
    $.ui.log('ccwarden: no home folder found, so the dashboard has nowhere to go.')
    return undefined
  }
  await flushMetrics($, runtime) // so the page has this session
  const junkLog = ((await $.store.get(JUNK_LOG_KEY)) as JunkEvent[] | undefined) ?? []
  const { summaries, coverage } = await readSummaries($, joinPath(claude, 'projects'), junkLog, canParse)
  const data = efficiencyData({
    now: await $.clock.now(),
    ...(config.billing === undefined ? {} : { billing: config.billing }),
    junkMode: config.junkGuard,
    ledger: (await $.store.get(LEDGER_KEY)) as Ledger | undefined,
    projectDays: (await $.store.get(PROJECT_DAYS_KEY)) as ProjectDays | undefined,
    junkLog,
    hogDays: (await $.store.get(HOG_DAYS_KEY)) as HogDays | undefined,
    summaries,
    coverage,
    metrics: await readMetrics($, joinPath(claude, METRICS_DIR), canParse),
    // ponytail: read at session end too: metrics files are small and capped; skip it there if the end bound proves too short (Q18)
    events: await readRecentEvents($, runtime, joinPath(claude, METRICS_DIR), await $.clock.now()),
    metricsDir: joinPath(claude, METRICS_DIR),
  })
  const path = joinPath(claude, DASHBOARD_FILE)
  const written = await $.fs.write(path, dashboardHtml(data)).then(() => true, () => false)
  if (!written) $.ui.log(`ccwarden: couldn't write the dashboard to ${path}.`)
  return written ? path : undefined
}

/** The Claude folder: the one the transcript is in, else ~/.claude. */
async function claudeDir($: $): Promise<string | undefined> {
  const fromTranscript = claudeDirOf((await $.state.get(transcriptPath)).value)
  if (fromTranscript !== undefined) return fromTranscript
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home === undefined ? undefined : joinPath(home, '.claude')
}

/**
 * F14: every transcript's summary, parsed once and cached in $.store while
 * the file (and the junk events priced in it) is unchanged. Files one
 * $.fs.read can't take are skipped and counted. With `canParse` false a
 * changed file keeps its last summary and a new one waits. A projects
 * folder that lists empty leaves the cache as it was.
 */
async function readSummaries($: $, projectsDir: string, junkLog: readonly JunkEvent[], canParse: boolean): Promise<{ summaries: Record<string, TranscriptSummary>; coverage: Coverage }> {
  const coverage: Coverage = { total: 0, read: 0, skippedBig: 0, failed: 0, pending: 0 }
  const folders = (await $.fs.list(projectsDir).catch(() => [])).filter(f => f.kind === 'dir')
  if (folders.length === 0) return { summaries: {}, coverage }
  const cache = ((await $.store.get(SUMMARIES_KEY)) as SummaryCache | undefined) ?? {}
  const junkAt = junkTimesBySession(junkLog)
  const next: SummaryCache = {}
  for (const folder of folders) {
    const dir = joinPath(projectsDir, folder.name)
    for (const f of await $.fs.list(dir).catch(() => [])) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
      coverage.total++
      if (f.size > MAX_TRANSCRIPT_BYTES) {
        coverage.skippedBig++
        continue
      }
      const path = joinPath(dir, f.name)
      const times = junkAt[f.name.replace(/\.jsonl$/, '')] ?? []
      const cached = cache[path]
      if (cached !== undefined && (!canParse || isFresh(cached, f, times.length))) {
        next[path] = cached
        coverage.read++
        continue
      }
      if (!canParse) {
        coverage.pending++
        continue
      }
      const text = await $.fs.read(path).catch(() => undefined)
      if (text === undefined) {
        coverage.failed++
        continue
      }
      next[path] = { mtimeMs: f.mtimeMs, size: f.size, junk: times.length, summary: summarize(parseJsonl(text), times) }
      coverage.read++
    }
  }
  await $.store.set(SUMMARIES_KEY, fitCache(next, CACHE_MAX_CHARS)) // files gone since are dropped
  return { summaries: Object.fromEntries(Object.entries(next).map(([p, e]) => [p, e.summary])), coverage }
}

const METRICS_SUMMARIES_KEY = 'metricsSummaries' // $.store: each metrics file's summary, parsed once (F15)
// Each summary cache's share of $.store, whose JSON is capped at 4 MiB for all keys: past it the files changed
// longest ago are dropped from the cache (and read again when needed), so the ledger and the rest keep room.
const CACHE_MAX_CHARS = 1_500_000

type MetricsCache = Record<string, { mtimeMs: number; size: number; summary: MetricsSummary }>

/** F15: every metrics file's summary, cached while the file is unchanged; `canParse` false reads no file anew. */
async function readMetrics($: $, dir: string, canParse: boolean): Promise<Record<string, MetricsSummary>> {
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
  const cache = ((await $.store.get(METRICS_SUMMARIES_KEY)) as MetricsCache | undefined) ?? {}
  const next: MetricsCache = {}
  for (const f of files) {
    const path = joinPath(dir, f.name)
    const cached = cache[path]
    if (cached !== undefined && (!canParse || (cached.mtimeMs === f.mtimeMs && cached.size === f.size))) {
      next[path] = cached
      continue
    }
    if (!canParse || f.size > MAX_TRANSCRIPT_BYTES) continue
    const text = await $.fs.read(path).catch(() => undefined)
    if (text !== undefined) next[path] = { mtimeMs: f.mtimeMs, size: f.size, summary: summarizeMetrics(text, f.name.replace(/\.jsonl$/, '')) }
  }
  await $.store.set(METRICS_SUMMARIES_KEY, fitCache(next, CACHE_MAX_CHARS))
  return Object.fromEntries(Object.entries(next).map(([p, e]) => [p, e.summary]))
}

/** F15: the last 30 days' events from the metrics files, newest first, at most RECENT_EVENTS. */
async function readRecentEvents($: $, runtime: Runtime, dir: string, now: number): Promise<SessionEvent[]> {
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl') && now - f.mtimeMs <= 30 * DAY_MS && f.size <= MAX_TRANSCRIPT_BYTES)
  const out: SessionEvent[] = []
  const held = new Map<string, { mtimeMs: number; size: number; events: MetricEvent[] }>()
  for (const f of files) {
    const path = joinPath(dir, f.name)
    const cached = runtime.recentEvents.get(path)
    let events = cached?.mtimeMs === f.mtimeMs && cached.size === f.size ? cached.events : undefined
    if (events === undefined) {
      const text = await $.fs.read(path).catch(() => undefined)
      if (text === undefined) continue
      events = parseFile(text).events
    }
    held.set(path, { mtimeMs: f.mtimeMs, size: f.size, events })
    const session = f.name.replace(/\.jsonl$/, '')
    for (const e of events) if (now - e.at <= 30 * DAY_MS) out.push({ ...e, session })
  }
  runtime.recentEvents = held // files gone or past 30 days are dropped
  return out.sort((a, b) => b.at - a.at).slice(0, RECENT_EVENTS)
}

/** F14: opens the page in the default browser; when that fails, says where it is. */
async function openInBrowser($: $, path: string): Promise<void> {
  let os: HostOs = 'linux'
  if ((await $.env.get('OS')) === 'Windows_NT') os = 'windows'
  else if ((await $.process.run(['uname', '-s'], { timeoutMs: 5_000 }).catch(() => undefined))?.stdout.trim() === 'Darwin') os = 'mac'
  const ran = await $.process.run(openerArgv(os, path), { timeoutMs: 10_000 }).catch(() => undefined)
  $.ui.log(ran?.exitCode === 0 ? `ccwarden: dashboard opened in your browser (${path}).` : `ccwarden: dashboard written to ${path}; open it in a browser.`)
}

/** Budget mode (SPEC §3): by hand, or past budgetModeAt% of the month budget or 5h window; says when it switches on by itself. */
async function updateBudgetMode($: $, config: Config, runtime: Runtime): Promise<void> {
  const manual = ((await $.store.get(BUDGET_SWITCH_KEY)) as BudgetSwitch | undefined) ?? 'auto'
  const now = await $.clock.now()
  const mtd = monthToDate((await $.store.get(LEDGER_KEY)) as Ledger | undefined, now)
  const fiveHourPct = fiveHour((await $.session.usage()).rateLimits)?.percentUsed
  const on = isBudgetMode({ manual, billing: config.billing, budgetModeAt: config.budgetModeAt, mtd, budget: config.monthlyBudgetUsd, fiveHourPct })
  if (on && !runtime.isBudget && manual === 'auto') {
    const why = config.billing === 'window' ? `the 5h window is at ${fiveHourPct ?? 0}%` : `the month is at ${Math.round((mtd / config.monthlyBudgetUsd) * 100)}% of its budget`
    await notify($, 'spend', budgetModeText(true, why)) // spend-driven, like the alerts that lead to it
  }
  runtime.isBudget = on
  await $.state.set(budgetModeRef, on)
}

/** F10: a big tool result, into the conversation's top list and today's tally. */
async function recordHog($: $, hog: { tool: string; target: string; tokens: number }): Promise<void> {
  await update($, conversation, prev => ({ ...(prev ?? { alerted: 0 }), hogs: topHogs(prev?.hogs, hog) }))
  const day = dayKey(await $.clock.now())
  await $.store.set(HOG_DAYS_KEY, tallyHog((await $.store.get(HOG_DAYS_KEY)) as HogDays | undefined, day, hog))
}

/** F8: adds a background turn's cost; names its kind in a toast once per conversation. */
async function watchBackground($: $, source: BackgroundSource, usd: number): Promise<void> {
  let isFirst = false
  await update($, conversation, prev => {
    const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
    const bg = { usd: (c.background?.usd ?? 0) + usd, toasted: [...(c.background?.toasted ?? [])] }
    if (!bg.toasted.includes(source.kind)) {
      bg.toasted.push(source.kind)
      isFirst = true
    }
    c.background = bg
    return c
  })
  $.ui.log(`ccwarden: background turn (${source.label}) ~$${usd.toFixed(3)}`, { to: 'debug' })
  if (isFirst) await notify($, 'advisor', backgroundToast(source, usd))
}

/**
 * F7: writes a handoff note and says where. `full` asks one fork of the
 * main thread for the decisions, state, next step and checks; it falls back
 * to quick when the cache is cold (the fork would re-read everything), the
 * estimate passes handoffMaxUsd, or the reply isn't the four sections.
 */
async function writeHandoff($: $, config: Config, runtime: Runtime, mode: 'quick' | 'full', known?: readonly SessionMessage[]): Promise<string | undefined> {
  const messages = known ?? (await $.session.messages())
  const facts = await snapshotFacts($, messages)
  const model = await $.session.model()
  const now = await $.clock.now()
  let full: string | undefined
  let why = ''
  if (mode === 'full') {
    const conv = (await $.state.get(conversation)).value ?? { alerted: 0 }
    const { ttl } = inferTtl({ observed: conv.observedTtl, override: await ttlOverride($), billing: config.billing })
    const isWarm = cacheView(lastCacheUse(conv), ttl, now).kind === 'warm'
    const estimate = pingUsd((await $.session.usage()).context.tokens ?? 0, model) ?? 0
    if (!isWarm) why = 'the cache is cold, so a full one would re-read the whole conversation'
    else if (estimate > config.handoffMaxUsd) why = `a full one would cost ~$${estimate.toFixed(2)} (handoffMaxUsd is $${config.handoffMaxUsd})`
    else {
      const reply = await $.model.fork({ prompt: FULL_PROMPT }).catch(() => undefined)
      if (reply !== undefined && 'usage' in reply) await addOwnSpend($, config, runtime, usageUsd({ ...reply.usage, model }) ?? 0)
      full = reply?.isAnswered === true ? fullSections(reply.text) : undefined
      if (full === undefined) why = "the fork didn't return the four sections"
    }
  }
  const root = await $.session.root()
  const dir = /^([\\/]|[A-Za-z]:)/.test(config.handoffDir) ? config.handoffDir : joinPath(root, config.handoffDir)
  const path = joinPath(dir, handoffFileName(now, handoffTopic(goalOf(facts))))
  const modelLine = config.modelAdvisor ? handoffModelLine(model) : undefined
  const text = handoffMarkdown({ ...facts, model, writtenAt: now }, { cwd: root, full, modelLine })
  const written = await $.fs.write(path, text).then(() => true, () => false)
  $.ui.log(!written
    ? `ccwarden: couldn't write the handoff to ${path}.`
    : `ccwarden: ${full === undefined ? 'quick' : 'full'} handoff written to ${path}${why === '' ? '' : ` (quick: ${why})`}.`)
  if (written) await recordProject($, { handoffs: 1 })
  if (written) await recordEvent($, config, runtime, { feature: 'handoff', action: 'written', measured: { route: full === undefined ? 'quick' : 'full' } })
  return written ? path : undefined
}

/** F7 pickup: offers the newest handoff in the project not offered before, once. */
async function offerHandoff($: $, config: Config): Promise<void> {
  if ((await $.session.surfaces()).length === 0) return
  const root = await $.session.root()
  const dir = /^([\\/]|[A-Za-z]:)/.test(config.handoffDir) ? config.handoffDir : joinPath(root, config.handoffDir)
  const entries = await $.fs.list(dir).catch(() => [])
  const offered = ((await $.store.get(HANDOFFS_OFFERED_KEY)) as string[] | undefined) ?? []
  const dirPrefix = joinPath(dir, '')
  const name = newestUnread(entries.filter(f => f.kind === 'file').map(f => f.name), offered.filter(p => p.startsWith(dirPrefix)).map(p => p.slice(dirPrefix.length)))
  if (name === undefined) return
  const path = joinPath(dir, name)
  await $.store.set(HANDOFFS_OFFERED_KEY, [...offered, path].slice(-200))
  const answer = await $.ui.ask(`ccwarden: continue from the handoff ${name}?`, { header: 'Handoff', options: [HANDOFF_CONTINUE, 'Not now'] }).catch(() => undefined)
  if (answer !== HANDOFF_CONTINUE) return
  const rootPrefix = joinPath(root, '')
  const rel = path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path
  await $.prompt.fill({ text: pickupPrompt(rel), mode: 'replace' })
}

/** Adds one junk-guard event to the log in $.store (machine-wide, kept for review before `enforce`). */
async function recordJunk($: $, config: Config, runtime: Runtime, event: JunkEvent): Promise<void> {
  const tagged: JunkEvent = { ...event, project: projectKey(await $.session.root()), session: await $.session.id() }
  await $.store.set(JUNK_LOG_KEY, appendJunk((await $.store.get(JUNK_LOG_KEY)) as JunkEvent[] | undefined, tagged))
  const family = familyOf(await $.session.model())
  const ref = `junk-${event.at}-${++runtime.refs}`
  const would = event.mode === 'observe'
  await recordEvent($, config, runtime, {
    at: event.at, feature: 'junk', action: would ? 'would-keep-out' : 'kept-out', ref, ...(would ? { would: true as const } : {}),
    measured: { tool: event.tool, target: event.target.slice(0, 200), size: event.size, chars: event.savedChars },
  })
  if (family !== undefined) runtime.pending.push({ ref, feature: 'junk', at: event.at, tokens: event.savedChars / CHARS_PER_TOKEN, family, requests: 0, would })
  $.ui.log(`ccwarden junk guard (${event.mode}): ${event.tool} ${event.target}`, { to: 'debug' })
}

/** Saves a tool's full output under the home folder for Claude to grep; undefined when it couldn't. */
async function saveOutput($: $, toolUseId: string, text: string): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (home === undefined) return undefined
  const path = outputPath(home, await $.session.id(), toolUseId)
  return $.fs.write(path, text).then(() => path, () => undefined)
}

/** Redraws the status line from the engine's figures and the conversation's state. */
async function refreshStatus($: $, config: Config, known?: CcwardenConversation): Promise<void> {
  const conv = known ?? (await $.state.get(conversation)).value ?? { alerted: 0 }
  const usage = await $.session.usage()
  const model = await $.session.model()
  const now = await $.clock.now()
  const { ttl } = inferTtl({ observed: conv.observedTtl, override: await ttlOverride($), billing: config.billing })
  const lastUse = lastCacheUse(conv)
  const cache = cacheView(lastUse, ttl, now)
  const tokens = usage.context.tokens
  const isBudget = (await $.state.get(budgetModeRef)).value === true
  const facts: StatusFacts = {
    billing: config.billing,
    model,
    tokens,
    limit: await limitOf($, model, config, usage.context.window),
    compactAt: (isBudget ? budgetConfig(config) : config).compactAt,
    cache,
    ttl,
    // The band's last-minute row shows the rebuild before the cache goes cold; the status line only once cold.
    rebuildUsd: tokens !== undefined ? rebuildUsd(tokens, model, ttl) : undefined,
    usd: usage.cost?.usd,
    chatPct: conv.window?.chatPct,
    fiveHour: fiveHour(usage.rateLimits),
    now,
    isAlerted: conv.alerted > 0,
    keepWarm: conv.keepWarm,
    miss: conv.lastMiss,
    isBudget,
    isHoldout: (await $.state.get(holdoutRef)).value === true,
    backgroundUsd: conv.background?.usd,
    agents: {
      running: runningCount(await $.agent.list()),
      usd: Object.values(conv.agents?.byId ?? {}).reduce((sum, v) => sum + v, 0),
    },
  }
  // F16: the band draws these where it can; the status line stays everywhere else.
  if (await isBandDrawn($, config)) await $.state.set(bandRef, lastUse === undefined ? { facts } : { facts, lastCacheUse: lastUse })
  else $.ui.status(formatStatus(facts))
}

/** F16: AbovePrompt is raised on the terminal and desktop only; elsewhere (-p, VS Code, mobile) the status line stays. */
async function isBandDrawn($: $, config: Config): Promise<boolean> {
  return config.warden && (await $.session.surfaces()).some(s => s === 'terminal' || s === 'desktop')
}

/** F16: a band button. The cold row's three answer the spell, so F2 doesn't ask about it again. */
async function pressBand($: $, config: Config, runtime: Runtime, row: number, b: BandButton): Promise<void> {
  if (row === 1) {
    await update($, conversation, prev => {
      const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
      if (c.lastResponseAt !== undefined) c.coldAskedFor = c.lastResponseAt
      return c
    })
    if (b === 'handoff') await writeHandoff($, config, runtime, 'quick') // no model call over a cold cache
    if (b === 'clear') await $.command.run({ command: 'clear' })
    return
  }
  if (b === 'cw') {
    await $.state.set(dashboardRef, await buildDashboard($, config, runtime))
    await $.ui.open({ id: PANE_ID, title: 'ccwarden' })
  }
  if (row === 7) {
    await $.state.set(heldNote, null)
    return
  }
  await update($, conversation, prev => {
    const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
    if (row === 2) delete c.bandAlert
    if (row === 6) delete c.bandPromotion
    return c
  })
}

const tint = (color: string | undefined) => (color === undefined ? {} : { color })

/** F16: pixels as coloured ▀ text, where there is no Raster (desktop): Text redraws there, a changed Svg doesn't (Q27). */
function pixelText(ui: { Box: Elements['desktop']['Box']; Text: Elements['desktop']['Text'] }, key: string, px: Px) {
  const { Box, Text } = ui
  return (
    <Box key={key} flexDirection="column">
      {textCells(px).map((row, r) => (
        <Text key={`${key}-${r}`}>
          {row.map((cell, c) => <Text key={`${key}-${r}-${c}`} {...tint(cell.color)} {...(cell.backgroundColor === undefined ? {} : { backgroundColor: cell.backgroundColor })}>{cell.char}</Text>)}
        </Text>
      ))}
    </Box>
  )
}

/**
 * F3: the engine's auto-compact window follows the model's limit. The engine
 * re-reads the variable live (SPEC §9 Q5), so it compacts at the limit, and
 * that compaction (the engine's own, unlike a mod-run /compact: Q13) reaches
 * the session.compact hook and is a snapshot. Overrides a value set by hand:
 * the per-model limits are limitHaiku/limitOther.
 */
async function syncCompactWindow($: $, config: Config, runtime: Runtime): Promise<void> {
  const usage = await $.session.usage()
  const target = String(compactWindowFor(limitFor(await $.session.model(), config), usage.context.window))
  const current = await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  if (await isHoldout($, config, runtime)) {
    // A protected conversation before /clear set it in this process. ponytail: after a reload the old value is
    // unknown, so a window that matches ccwarden's own is unset (the engine's default) rather than kept.
    const own = runtime.compactWindow
    if (own !== undefined && current === own.set) await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', own.before)
    else if (own === undefined && current === target) await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined)
    runtime.compactWindow = undefined
    return
  }
  if (current === target) return
  runtime.compactWindow = { set: target, before: runtime.compactWindow === undefined ? current : runtime.compactWindow.before }
  await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', target)
  $.ui.log(`ccwarden: auto-compact window set to ${target} tokens for ${await $.session.model()}.`, { to: 'debug' })
}

/**
 * The limit the mod measures a conversation against: its per-model limit, the
 * model window, and the compact window the user sets with
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW (Q5: the engine re-reads it live), so the
 * status never says 300k while the engine compacts at 150k. The per-model
 * limit takes the variable's 100k floor, as syncCompactWindow does, so a 50k
 * limit doesn't say "type /compact" at 50k while the engine waits for 100k.
 */
async function limitOf($: $, model: string, config: Config, window: number): Promise<number> {
  const compactWindow = Number(await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'))
  return Math.min(compactWindowFor(limitFor(model, config), window), window, compactWindow > 0 ? compactWindow : Infinity)
}

/** The cache's last use: the main loop's last response, or a later keep-warm ping. */
function lastCacheUse(conv: CcwardenConversation): number | undefined {
  if (conv.lastResponseAt === undefined) return conv.keepWarmAt
  return Math.max(conv.lastResponseAt, conv.keepWarmAt ?? 0)
}

/**
 * F6: just before the cache expires, while every condition holds, one fork
 * of the main thread's last request reads the cached prefix. A fork that
 * read (almost) nothing from the cache found it lapsed: it isn't counted as
 * keeping it warm.
 */
async function keepWarmTick($: $, config: Config, runtime: Runtime): Promise<void> {
  if (runtime.isPinging) return
  if (await isHoldout($, config, runtime)) return
  const conv = (await $.state.get(conversation)).value ?? { alerted: 0 }
  const now = await $.clock.now()
  const usage = await $.session.usage()
  const model = await $.session.model()
  const { ttl } = inferTtl({ observed: conv.observedTtl, override: await ttlOverride($), billing: config.billing })
  const lastUse = lastCacheUse(conv)
  if (lastUse !== undefined && conv.keepWarmMissedFor === lastUse) return // this cache already lapsed
  const verdict = pingVerdict({
    keepWarm: config.keepWarm, billing: config.billing,
    isAttached: (await $.session.surfaces()).length > 0, isTurnRunning: runtime.isTurnRunning,
    now, lastPromptAt: conv.lastPromptAt, expiresAt: lastUse === undefined ? undefined : lastUse + TTL_MS[ttl],
    maxMin: config.keepWarmMaxMin, spentUsd: conv.keepWarm?.spentUsd ?? 0, capUsd: config.keepWarmCapUsd,
    tokens: usage.context.tokens, model,
  })
  if (!verdict.isDue) return

  runtime.isPinging = true
  const reply = await $.model.fork({ prompt: PING_PROMPT }).catch(() => undefined)
  runtime.isPinging = false
  if (reply === undefined || !('usage' in reply)) return
  const spent = usageUsd({ ...reply.usage, model }) ?? 0
  const didRead = reply.usage.cache_read_input_tokens >= (usage.context.tokens ?? 0) * 0.5
  const at = await $.clock.now()
  const after = await update($, conversation, prev => {
    const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
    const kw = c.keepWarm ?? { pings: 0, spentUsd: 0, savedUsd: 0 }
    c.keepWarm = { ...kw, pings: kw.pings + 1, spentUsd: kw.spentUsd + spent }
    if (didRead) c.keepWarmAt = at
    else c.keepWarmMissedFor = lastUse
    return c
  })
  await recordProject($, { keepWarmPings: 1, keepWarmSpentUsd: spent })
  await addOwnSpend($, config, runtime, spent)
  await recordEvent($, config, runtime, { at, feature: 'keepwarm', action: 'ping', measured: { read: reply.usage.cache_read_input_tokens, didRead }, est: { tokens: 0, usd: -spent, formula: 'ping cost', confidence: 'high' } })
  $.ui.log(`ccwarden keep-warm: ping read ${reply.usage.cache_read_input_tokens} cached tokens for ~$${spent.toFixed(3)}${didRead ? '' : ' (the cache had lapsed)'}.`, { to: 'debug' })
  await refreshStatus($, config, after)
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
    // A toast is already shown under the plugin's name, so drop our own prefix.
    $.ui.toast(text.replace(/^ccwarden: /, ''), { timeoutMs })
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
  // `config` is the load-time snapshot every hook closes over: use the answer now, not at the next load.
  config.billing = billing
  await refreshStatus($, config)
  return billing
}

/** When the transcript's last main-thread response was written, if the transcript is known and readable. */
async function transcriptLastResponse($: $): Promise<number | undefined> {
  const path = (await $.state.get(transcriptPath)).value
  if (path === undefined || path === '') return undefined
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.size > MAX_TRANSCRIPT_BYTES) return undefined
  const text = await $.fs.read(path).catch(() => undefined)
  return text === undefined ? undefined : lastResponseTime(parseJsonl(text))
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
