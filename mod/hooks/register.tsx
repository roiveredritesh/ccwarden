import { update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import type { CcwardenConversation, CcwardenDashboard } from '../types'
import { dashboardSections, dashboardText, PANE_ID } from '../src/dashboard'
import { analyze, requestsOf, ttlVerdict, weekReport } from '../src/report'
import { hogsOver } from '../src/hogs'
import { backgroundSource, backgroundToast } from '../src/background'
import type { BackgroundSource } from '../src/background'
import { handoffModelLine, startAdvice, switchNote } from '../src/advisor'
import { AGENT_WARN_USD, planSpawn, runningCount, turnUsd } from '../src/agents'
import { avoidedRebuild, PING_PROMPT, pingUsd, pingVerdict, TICK_MS } from '../src/keepwarm'
import { FULL_PROMPT, fullSections, handoffFileName, handoffMarkdown, handoffTopic, newestUnread, pickupPrompt } from '../src/handoff'
import { alertStep, alertText, isAlertDue } from '../src/alerts'
import { BILLING_HEADER, BILLING_OPTIONS, BILLING_QUESTION, billingFrom, billingRow } from '../src/billing'
import { cacheView, inferTtl, latestWriteTtl, parseTtl, TTL_MS, ttlContradicts } from '../src/cache'
import { COLD_CANCEL, COLD_CONTINUE, coldDropReason, coldQuestion, isColdAskDue } from '../src/cold'
import type { Ttl } from '../src/cache'
import { limitFor, readConfig } from '../src/config'
import { joinPath } from '../src/paths'
import type { Billing, Config } from '../src/config'
import { rebuildUsd } from '../src/prices'
import { appendJunk, isAllowlisted, isAlreadyFiltered, isWholeTextRead, countLines, outputPath, parseGlobs, readDenyText, trimmedOutput } from '../src/junk'
import type { JunkEvent } from '../src/junk'
import { addSpend, calibrate, costDelta, dayKey, monthKey, monthToDate, projectMonth } from '../src/ledger'
import { budgetConfig, budgetModeText, isBudgetMode, monthAlertText, monthStepsDue } from '../src/budget'
import type { BudgetSwitch } from '../src/budget'
import type { Ledger } from '../src/ledger'
import { estimateTokens, HOG_MIN_TOKENS, hogTarget, tallyHog, topHogs } from '../src/hogs'
import type { HogDays } from '../src/hogs'
import { goalOf, keptTail, lastAnswer, lastError, parseNumstat, planCompaction, snapshotText, summaryInstructions } from '../src/snapshot'
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
// snapshot compaction), F4 (the junk guard), F5 (the subagent guard and
// per-agent cost), F6 (keep-warm, off by default until Q2), F7 (handoffs),
// F8 (the background spend watcher), F9 (model and effort advice), the
// M3 spend ledger and context hogs, F11 month tracking and budget mode,
// F10 the /cw dashboard pane, the first-run billing question, the R9 toast budget, and the transcript path
// the session facts are read from.

type $ = EngineInterface

/** What the module tracks between events; a reload starts it over, harmlessly. */
type Runtime = {
  isCompacting: boolean
  isTurnRunning: boolean
  isPinging: boolean
  /** F8: prompts submitted while idle, oldest first, each with what sent it (undefined: the user). */
  queued: { text: string; source?: BackgroundSource }[]
  /** F8: what started the running turn, when the user didn't. */
  turnSource?: BackgroundSource
  /** Budget mode (SPEC §3), as last worked out. */
  isBudget: boolean
}

const toastTimes = { plugin: 'ccwarden', key: 'toastTimes' } as const
const heldNote = { plugin: 'ccwarden', key: 'heldNote' } as const
const transcriptPath = { plugin: 'ccwarden', key: 'transcriptPath' } as const
const billingAsked = { plugin: 'ccwarden', key: 'billingAsked' } as const
const conversation = { plugin: 'ccwarden', key: 'conversation' } as const
const budgetModeRef = { plugin: 'ccwarden', key: 'budgetMode' } as const
const dashboardRef = { plugin: 'ccwarden', key: 'dashboard' } as const
const WEEK_MS = 7 * 24 * 60 * 60_000
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
const JUNK_SHOWN = 20 // events /ccwarden-junk lists
const TAIL_SHARE = 0.15 // of the model limit, for the turns kept verbatim
const CHARS_PER_TOKEN = 4

export const register: Register = (on, options) => {
  const config = readConfig(options)
  const junkAllowlist = parseGlobs(config.junkAllowlist)
  const runtime: Runtime = { isCompacting: false, isTurnRunning: false, isPinging: false, queued: [], isBudget: false }
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
    await $.command.register({ name: 'cw', description: 'ccwarden: month to date, budget mode, calibration', argumentHint: '[spent <amount> | budget on|off|auto]' })
    runtime.isBudget = (await $.state.get(budgetModeRef)).value === true // a reload keeps it, unannounced
    await updateBudgetMode($, config, runtime)
    await $.command.register({ name: 'ccwarden-junk', description: "ccwarden: what the junk guard did (or, in observe mode, would have done)" })
    $.clock.every(STATUS_TICK_MS, () => void refreshStatus($, config))
    if (config.keepWarm) $.clock.every(TICK_MS, () => void keepWarmTick($, config, runtime))
    // Detached, so the question never holds up the session's start.
    $.clock.after(0, () => void askBilling($, config))
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
      const note = switchNote({ toModel: e.to_model, contextTokens: e.context_tokens, limit: limitFor(e.to_model, config) })
      if (note !== undefined) $.ui.log(note)
    }
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    await writeHandoff($, config, e.args.trim() === 'quick' ? 'quick' : 'full')
    return {}
  })

  // /clear ends the conversation: its figures start over, a held alert is
  // dropped, and the window share is measured from here.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const reading = fiveHour((await $.session.usage()).rateLimits)
      await $.state.set(conversation, { alerted: 0, ledgerUsd: 0, ...(reading === undefined ? {} : { window: trackWindow(undefined, reading) }) })
      $.clock.after(0, () => void refreshStatus($, config))
    }
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
    if (due !== undefined && config.alertTiming === 'immediate') await notify($, 'spend', due)
    if (spent > 0) await trackMonth($, config, await recordSpend($, spent))
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
    // F6: the prompt keep-warm waits for; and the rebuild a ping avoided, if any.
    const saved = avoidedRebuild({
      now, lastResponseAt: before.lastResponseAt, keepWarmAt: before.keepWarmAt, ttlMs: TTL_MS[ttl],
      rebuildUsd: tokens === undefined ? undefined : rebuildUsd(tokens, model, ttl),
    })
    const conv = await update($, conversation, prev => {
      const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }), lastPromptAt: now }
      if (saved > 0 && c.keepWarm !== undefined) c.keepWarm = { ...c.keepWarm, savedUsd: c.keepWarm.savedUsd + saved }
      return c
    })
    if (saved > 0) await refreshStatus($, config, conv)

    if ((await $.session.surfaces()).length === 0) return next(e)
    const cache = cacheView(lastCacheUse(conv), ttl, now)
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

  // F4: a whole-file Read of a long text file is denied with a pointer to
  // Grep or a ranged Read. Files under `readMaxLines` bytes can't be that
  // long and aren't read; files one $.fs.read can't take are left alone.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (config.junkGuard === 'off' || !isWholeTextRead(e) || isAllowlisted(e.file_path, junkAllowlist)) return next(e)
    const stat = await $.fs.stat(e.file_path).catch(() => undefined)
    if (stat === undefined || stat.kind !== 'file' || stat.size <= eff().readMaxLines || stat.size > MAX_TRANSCRIPT_BYTES) return next(e)
    const text = await $.fs.read(e.file_path).catch(() => undefined)
    const lines = text === undefined ? 0 : countLines(text)
    if (lines <= eff().readMaxLines) return next(e)
    await recordJunk($, { at: await $.clock.now(), tool: 'Read', mode: config.junkGuard, target: e.file_path, size: lines, savedChars: stat.size })
    if (config.junkGuard === 'observe') return next(e)
    const reason = readDenyText(e.file_path, lines, eff().readMaxLines)
    $.ui.log(reason)
    return { deny: reason }
  })

  // F4: Bash output over `bashMaxChars` is cut to head + tail and the whole
  // of it saved to a file Claude can grep. Output Claude already filtered,
  // errors, and output the engine itself persisted are left alone; so is
  // any output whose full text couldn't be saved.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (config.junkGuard === 'off' || ran.deny !== undefined || ran.isError || isAlreadyFiltered(e.command)) return ran
    const { stdout } = ran.result
    if (ran.result.persistedOutputPath !== undefined || stdout.length <= eff().bashMaxChars) return ran
    await recordJunk($, { at: await $.clock.now(), tool: 'Bash', mode: config.junkGuard, target: e.command.slice(0, 200), size: stdout.length, savedChars: stdout.length - eff().bashMaxChars })
    if (config.junkGuard === 'observe') return ran
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (home === undefined) return ran
    const path = outputPath(home, await $.session.id(), e.tool_use_id)
    const saved = await $.fs.write(path, stdout).then(() => true, () => false)
    if (!saved) return ran
    $.ui.log(`ccwarden junk guard: Bash output cut from ${stdout.length} to ~${eff().bashMaxChars} characters; the full text is in ${path}.`)
    return { result: { ...ran.result, stdout: trimmedOutput(stdout, eff().bashMaxChars, path) } }
  })

  // F11 and budget mode by hand. (The dashboard pane comes in M3-T3.)
  on('command.run', { command: 'cw' }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)
    const now = await $.clock.now()
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
      $.ui.log('ccwarden: /cw, /cw spent <amount>, /cw budget on|off|auto')
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
          <Button key="compact" hotkey="c" onPress={() => void $.command.run({ command: 'compact' })}>Compact</Button>
          <Button key="handoff" hotkey="h" onPress={() => void writeHandoff($, config, 'full')}>Handoff</Button>
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

  on('command.run', { command: 'ccwarden-junk' }, async ($) => {
    const log = ((await $.store.get(JUNK_LOG_KEY)) as JunkEvent[] | undefined) ?? []
    const saved = log.reduce((sum, ev) => sum + ev.savedChars, 0)
    $.ui.log(`ccwarden junk guard (${config.junkGuard}): ${log.length} event${log.length === 1 ? '' : 's'}, ~${Math.round(saved / 4 / 1000)}k tokens ${config.junkGuard === 'enforce' ? 'kept out' : 'would be kept out'} of context (est.). Latest ${Math.min(log.length, JUNK_SHOWN)}:`)
    for (const ev of log.slice(-JUNK_SHOWN)) {
      $.ui.log(`  ${new Date(ev.at).toISOString()} ${ev.mode} ${ev.tool} ${ev.tool === 'Read' ? `${ev.size} lines` : `${ev.size} chars`}: ${ev.target}`)
    }
    return {}
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

  on('turn.start', async ($, e, next) => {
    runtime.isTurnRunning = true
    // The turn's prompt, matched by text; a turn no queued prompt matches is the user's.
    const i = runtime.queued.findIndex(q => q.text === e.text)
    runtime.turnSource = i === -1 ? undefined : runtime.queued[i]!.source
    if (i !== -1) runtime.queued = runtime.queued.filter((_, j) => j !== i)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) runtime.isTurnRunning = false
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
    const source = runtime.turnSource
    runtime.turnSource = undefined
    if (source !== undefined && config.backgroundWatch && e.usage !== undefined) await watchBackground($, source, turnUsd(e.usage) ?? 0)
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
    if (tokens > limit && !runtime.isCompacting) {
      runtime.isCompacting = true
      $.ui.log(`ccwarden: ${Math.round(tokens / 1000)}k tokens is past the ${Math.round(limit / 1000)}k limit for ${model}; compacting.`)
      $.clock.after(0, async () => {
        const ran = await $.command.run({ command: 'compact' }).catch((err: unknown) => ({ error: String(err) }))
        runtime.isCompacting = false
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

    await update($, conversation, prev => ({
      ...(prev ?? { alerted: 0 }),
      compactions: (prev?.compactions ?? 0) + 1,
      snapshots: (prev?.snapshots ?? 0) + (plan === 'snapshot' ? 1 : 0),
    }))
    const facts = await snapshotFacts($, e.messages)
    if (config.handoffOnCompact) await writeHandoff($, config, 'quick', e.messages)
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

/** F11 (metered): a toast at 50%, 80% and 100% of the month budget, each once a month on this machine. */
async function trackMonth($: $, config: Config, ledger: Ledger): Promise<void> {
  if (config.billing === 'window' || config.monthlyBudgetUsd <= 0) return
  const now = await $.clock.now()
  const month = monthKey(now)
  const mtd = monthToDate(ledger, now)
  const record = (await $.store.get(MONTH_ALERTS_KEY)) as { month: string; sent: number[] } | undefined
  const sent = record?.month === month ? record.sent : []
  const due = monthStepsDue(mtd, config.monthlyBudgetUsd, sent)
  if (due.length === 0) return
  await $.store.set(MONTH_ALERTS_KEY, { month, sent: [...sent, ...due] })
  await notify($, 'spend', monthAlertText(mtd, config.monthlyBudgetUsd, projectMonth(mtd, now)))
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
      limit: Math.min(limitFor(model, config), usage.context.window),
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
      junkTokens: Math.round(junk.reduce((sum, ev) => sum + ev.savedChars, 0) / 4),
      keepWarmSpent: conv.keepWarm?.spentUsd ?? 0,
      keepWarmSaved: conv.keepWarm?.savedUsd ?? 0,
      snapshots: conv.snapshots ?? 0,
    },
    month: { mtd, budget: config.monthlyBudgetUsd, projected: projectMonth(mtd, now), isBudget: runtime.isBudget, isMetered: config.billing !== 'window' },
    hogs: { session: conv.hogs ?? [], month: hogsOver((await $.store.get(HOG_DAYS_KEY)) as HogDays | undefined, month) },
    week,
  }
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
async function writeHandoff($: $, config: Config, mode: 'quick' | 'full', known?: readonly SessionMessage[]): Promise<string | undefined> {
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
async function recordJunk($: $, event: JunkEvent): Promise<void> {
  await $.store.set(JUNK_LOG_KEY, appendJunk((await $.store.get(JUNK_LOG_KEY)) as JunkEvent[] | undefined, event))
  $.ui.log(`ccwarden junk guard (${event.mode}): ${event.tool} ${event.target}`, { to: 'debug' })
}

/** Redraws the status line from the engine's figures and the conversation's state. */
async function refreshStatus($: $, config: Config, known?: CcwardenConversation): Promise<void> {
  const conv = known ?? (await $.state.get(conversation)).value ?? { alerted: 0 }
  const usage = await $.session.usage()
  const model = await $.session.model()
  const now = await $.clock.now()
  const { ttl } = inferTtl({ observed: conv.observedTtl, override: await ttlOverride($), billing: config.billing })
  const cache = cacheView(lastCacheUse(conv), ttl, now)
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
    keepWarm: conv.keepWarm,
    isBudget: (await $.state.get(budgetModeRef)).value === true,
    backgroundUsd: conv.background?.usd,
    agents: {
      running: runningCount(await $.agent.list()),
      usd: Object.values(conv.agents?.byId ?? {}).reduce((sum, v) => sum + v, 0),
    },
  }))
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
  const spent = turnUsd({ ...reply.usage, model }) ?? 0
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
  // `config` is the load-time snapshot every hook closes over: use the answer now, not at the next load.
  config.billing = billing
  await refreshStatus($, config)
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
