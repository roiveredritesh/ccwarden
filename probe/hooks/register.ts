import type { EngineInterface, Register, SessionMessage } from 'claude-code'

// Dev-only probe for the M1 day-one checks (SPEC §9, HANDOFF §6). It never
// ships: load it beside the mod with `claude --plugin-dir ./mod --plugin-dir
// ./probe` on each machine and run `/cw-probe <check>`.
//
// Findings are shown with $.ui.log (dim, never sent to the model), kept in
// $.store under LOG_KEY across sessions, and written to ~/.claude/
// ccwarden-probe.jsonl by `/cw-probe report`, ready to paste into SPEC §9.
// Nothing here adds to Claude's context, and only `/cw-probe fork` makes a
// model call (Q2 needs one).

type $ = EngineInterface
type Finding = { q: string; at: string; machine?: string; data: unknown }

const LOG_KEY = 'findings'
const FORK_DELAY_MS = 4 * 60_000
// Marker for Q6: a Bash command containing it has its stdout trimmed, so the
// trimmed result goes through the engine's output-schema check.
export const TRIM_MARKER = '# cw-probe-trim'
export const TRIM_KEEP_CHARS = 2_000

const HELP = `/cw-probe <check>
  info          Q1 TTL split, Q7 rateLimits, Q10 policy, Q11 tasks, Q12 spend
  ui            Q8 toast, status line and ui.ask on this surface
  color [off]   Q15 status line with ANSI colours and a bar: do they render?
  env <tokens>  Q5 set CLAUDE_CODE_AUTO_COMPACT_WINDOW live, compare windows
  fork | wait   Q2 fork after 4 min (or don't: the control run), then log the
                next turn's cache read; send a real prompt at ~8 min
  compact       Q3 snapshot-compact now, then log re-read attachments and the
                next turn's usage
  newchat       Q4 run /clear from the mod, then prefill the prompt box
  report        print every finding and write ~/.claude/ccwarden-probe.jsonl
  clear         forget stored findings
Q6: ask Claude to run \`seq 1 100000 ${TRIM_MARKER}\`; Q9: switch /model.`

export const register: Register = on => {
  // Module state is fine for a probe: a reload only drops an armed check.
  let transcriptPath: string | undefined
  let lastTurnEndedAt: number | undefined
  let watchNextTurn: string | undefined // which check logs the next turn
  let snapshotArmed = false
  let watchAppendsUntil = 0 // clock ms; attachment rows logged until then
  let clearArmed = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'cw-probe',
      description: 'ccwarden day-one checks (dev only)',
      argumentHint: 'info|ui|color|env|fork|wait|compact|newchat|report|clear',
    })
    return result
  })

  // Q4: a /clear ends the session (reason `clear`) and starts no new
  // session.start; the module keeps running, so the flag survives it.
  on('session.end', async ($, e, next) => {
    if (clearArmed && e.reason === 'clear') {
      clearArmed = false
      await record($, 'Q4', { clearedByMod: true })
      $.clock.after(500, async () => {
        const filled = await $.prompt.fill({ text: 'cw-probe Q4: prefilled after /clear' })
        await record($, 'Q4', { prefill: filled.isFilled, refusal: filled.refusal ?? null })
      })
    }
    return next(e)
  })

  // Stop carries the transcript path (Q1) and in-flight background work (Q11).
  on('classic.Stop', async ($, e, next) => {
    transcriptPath = e.transcript_path
    if ((e.background_tasks?.length ?? 0) > 0) {
      await record($, 'Q11', { background_tasks: e.background_tasks })
    }
    return next(e)
  })

  // Q9: a mod sees the switch before it happens, with the re-cache cost.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const { from_model, to_model, source, context_tokens, prompt_cache_warm, cache_ttl, estimated_cache_write_usd } = e
    await record($, 'Q9', { from_model, to_model, source, context_tokens, prompt_cache_warm, cache_ttl, estimated_cache_write_usd })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const now = await $.clock.now()
    if (watchNextTurn !== undefined && e.usage !== undefined) {
      await record($, watchNextTurn, {
        nextTurnUsage: e.usage,
        idleBeforeMs: lastTurnEndedAt === undefined ? undefined : now - e.durationMs - lastTurnEndedAt,
      })
      watchNextTurn = undefined
    }
    lastTurnEndedAt = now
    return result
  })

  // Q3: which rows the engine injects right after a snapshot compaction
  // (re-read files show up as attachments).
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (watchAppendsUntil > 0 && e.message.type !== 'assistant' && (await $.clock.now()) < watchAppendsUntil) {
      await record($, 'Q3', { door: e.door, type: e.message.type, name: e.message.name })
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || !snapshotArmed || e.agentId !== undefined) return next(e)
    snapshotArmed = false
    const messages = snapshot(e.messages)
    watchAppendsUntil = (await $.clock.now()) + 10 * 60_000
    watchNextTurn = 'Q3'
    await record($, 'Q3', { answered: 'snapshot', before: e.messages.length, after: messages.length })
    return { messages }
  })

  // Q6: trim marked Bash output and hand the engine our own result.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.command.includes(TRIM_MARKER) || ran.deny !== undefined || ran.isError) return ran
    const { stdout } = ran.result
    if (stdout.length <= TRIM_KEEP_CHARS) return ran
    await record($, 'Q6', { trimmedFrom: stdout.length, to: TRIM_KEEP_CHARS })
    return { result: { ...ran.result, stdout: `${stdout.slice(0, TRIM_KEEP_CHARS)}\n[cw-probe: trimmed ${stdout.length - TRIM_KEEP_CHARS} chars]` } }
  })

  on('command.run', { command: 'cw-probe' }, async ($, e) => {
    const [check = 'info', arg] = e.args.trim().split(/\s+/)
    switch (check) {
      case 'info': await info($, transcriptPath); break
      case 'ui': await ui($); break
      case 'color': await color($, arg); break
      case 'env': await env($, arg); break
      case 'fork':
      case 'wait':
        watchNextTurn = `Q2-${check}`
        $.clock.after(FORK_DELAY_MS, async () => {
          if (check === 'fork') {
            const reply = await $.model.fork({ prompt: 'Reply with OK.' })
            await record($, 'Q2-fork', reply)
          }
          $.ui.toast(`cw-probe: send a real prompt in ~4 min (Q2 ${check})`, { timeoutMs: 30_000 })
        })
        $.ui.log(`cw-probe: Q2 ${check} armed; wait for the toast`)
        break
      case 'compact':
        snapshotArmed = true
        // Detached: compaction runs between turns, not inside this command.
        // Through `/compact`: a plugin's own $.session.compact skips its own
        // session.compact hook, so the snapshot would never be answered.
        $.clock.after(0, async () => {
          const ran = await $.command.run({ command: 'compact' }).catch((err: unknown) => ({ error: String(err) }))
          if ('error' in ran) await record($, 'Q3', { skipped: ran.error })
        })
        break
      case 'newchat':
        clearArmed = true
        $.clock.after(0, async () => {
          const ran = await $.command.run({ command: 'clear' }).catch((err: unknown) => ({ error: String(err) }))
          if ('error' in ran) await record($, 'Q4', { clearedByMod: false, error: ran.error })
        })
        break
      case 'report': await report($); break
      case 'clear': await $.store.delete(LOG_KEY); $.ui.log('cw-probe: findings cleared'); break
      default: $.ui.log(HELP)
    }
    return {}
  })
}

async function record($: $, q: string, data: unknown): Promise<void> {
  const finding: Finding = { q, at: new Date(await $.clock.now()).toISOString(), data }
  const all = ((await $.store.get(LOG_KEY)) as Finding[] | undefined) ?? []
  await $.store.set(LOG_KEY, [...all, finding])
  $.ui.log(`cw-probe ${q}: ${JSON.stringify(data)}`)
}

async function info($: $, transcriptPath: string | undefined): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const breakdown = usage.context.breakdown
  await record($, 'info', {
    version: (await $.session.version()).version,
    model: await $.session.model(),
    surfaces: await $.session.surfaces(),
    context: { tokens: usage.context.tokens, window: usage.context.window, percent: usage.context.percent, compactWindow: breakdown?.rawMaxTokens },
  })
  await record($, 'Q7', { rateLimits: usage.rateLimits })
  await record($, 'Q12', { cost: usage.cost, spendLimit: usage.rateLimits.find(r => r.kind === 'spend_limit') ?? null })
  const policy = await $.settings.read({ source: 'policy' })
  await record($, 'Q10', {
    loaded: true,
    policyKeys: Object.keys(policy),
    plugins: pick(policy, ['enabledPlugins', 'strictKnownMarketplaces', 'extraKnownMarketplaces', 'allowManagedHooksOnly', 'disableAllHooks']),
  })
  await record($, 'Q11', { agents: await $.agent.list() })
  await record($, 'Q1', transcriptPath === undefined ? { note: 'send one prompt first (Stop gives the transcript path)' } : await ttlSplit($, transcriptPath))
}

// Q1: the 5m/1h split of cache writes over the transcript's assistant rows,
// deduped by message id (the JSONL repeats them per content block).
async function ttlSplit($: $, path: string): Promise<unknown> {
  const text = await $.fs.read(path)
  const seen = new Set<string>()
  let w5m = 0
  let w1h = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"cache_creation"')) continue
    try {
      const row = JSON.parse(line) as { message?: { id?: string; usage?: { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } } } }
      const id = row.message?.id
      const split = row.message?.usage?.cache_creation
      if (id === undefined || split === undefined || seen.has(id)) continue
      seen.add(id)
      w5m += split.ephemeral_5m_input_tokens ?? 0
      w1h += split.ephemeral_1h_input_tokens ?? 0
    } catch { /* a partial line */ }
  }
  return { responses: seen.size, write5m: w5m, write1h: w1h, ttl: w1h > w5m ? '1h' : w5m > 0 ? '5m' : 'unknown' }
}

// Q15: the types give `$.ui.status` a plain string and say nothing of ANSI. Show
// green, yellow and red bars with escape codes; the user answers what rendered.
async function color($: $, arg: string | undefined): Promise<void> {
  if (arg === 'off') { $.ui.status(undefined); return }
  const bar = (pct: number) => '▓'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
  const paint = (code: number, text: string) => `[${code}m${text}[0m`
  $.ui.status(`${paint(32, `ctx ${bar(30)} 30%`)} │ ${paint(33, `ctx ${bar(70)} 70%`)} │ ${paint(31, `ctx ${bar(90)} 90%`)} │ ${paint(2, 'dim')}`)
  const answer = await $.ui.ask('cw-probe Q15: how does the status line look?', ['Colours + bars', 'Bars only, no colour', 'Raw escape codes (garbage)', 'Nothing shown'])
    .catch((err: unknown) => `ask failed: ${String(err)}`)
  $.ui.status(undefined) // leave no second status line behind
  await record($, 'Q15', { surfaces: await $.session.surfaces(), answer })
}

async function ui($: $): Promise<void> {
  const surfaces = await $.session.surfaces()
  $.ui.toast('cw-probe: toast test (Q8)', { timeoutMs: 10_000 })
  $.ui.status('cw-probe: status test (Q8)')
  const answer = await $.ui.ask('cw-probe Q8: did the toast and the status line show?', ['Both', 'Toast only', 'Status only', 'Neither'])
    .catch((err: unknown) => `ask failed: ${String(err)}`)
  $.ui.status(undefined) // leave no second status line behind
  await record($, 'Q8', { surfaces, answer })
}

async function env($: $, arg: string | undefined): Promise<void> {
  const tokens = Number(arg)
  if (!Number.isInteger(tokens) || tokens < 100_000 || tokens > 1_000_000) {
    $.ui.log('cw-probe: /cw-probe env <tokens>, 100000 to 1000000 (the documented range)')
    return
  }
  const window = async () => (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.rawMaxTokens
  const before = await window()
  const previous = await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', String(tokens))
  await record($, 'Q5', { previous: previous ?? null, set: tokens, compactWindowBefore: before, compactWindowAfter: await window() })
}

async function report($: $): Promise<void> {
  const all = ((await $.store.get(LOG_KEY)) as Finding[] | undefined) ?? []
  const home = await $.env.get('HOME')
  if (home !== undefined) {
    await $.fs.write(`${home}/.claude/ccwarden-probe.jsonl`, all.map(f => JSON.stringify(f)).join('\n') + '\n')
  }
  $.ui.log(`cw-probe: ${all.length} findings${home === undefined ? '' : ` → ${home}/.claude/ccwarden-probe.jsonl`}`)
  for (const f of all) $.ui.log(`${f.at} ${f.q}: ${JSON.stringify(f.data)}`)
}

// The snapshot F3 will build, reduced to what Q3 needs: one note in place of
// the summary, then the last real user prompt onward, kept by handle.
export function snapshot(messages: readonly SessionMessage[]): SessionMessage[] {
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && (m.toolResults?.length ?? 0) === 0 && m.text !== '') { start = i; break }
  }
  const note: SessionMessage = {
    role: 'user',
    text: `[cw-probe snapshot] ${start} earlier messages were dropped without a summary (day-one check Q3).`,
    toolUses: [],
  }
  return [note, ...messages.slice(start)]
}

function pick(obj: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]))
}
