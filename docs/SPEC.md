# ccwarden: specification

Status: draft 0.4 (pre-alpha), 2026-10. §10 records every gap found in design review and how it was resolved.
**Platform:**

- Claude Code function-hook plugins ("mods"), typed in v2.1.287 and marked *early access*
- Claude Code's documented hooks and status line, for the hooks edition

**Sources:** code.claude.com/docs (prompt-caching, costs, hooks, statusline, model-config) and platform.claude.com/docs (pricing).

## 0. Objective

**Get the same work done for fewer billed tokens, without slowing the user down or degrading answers.** The success measure depends on how the user pays:

| Billing | Success measure |
|---|---|
| **Metered** (every token billed, often with a monthly cap) | $ per completed task; staying under the cap |
| **Window** (Pro / Max / Team: 5-hour and weekly limits) | Work done per 5-hour window; fewer waits for a reset |

**Guardrail:** savings that cause rework don't count. Watch re-reads after compaction, re-run commands and repeated questions.

### Where the money goes

From one real session: Opus 5.5, 100 requests, average context 237K, ≈ $13.60 at list price.

| Category | Share | Levers |
|---|---|---|
| Cache **writes** (new content entering context) | 45% | Junk guard, subagent report caps, TTL choice |
| Cache **reads** (context re-read every request) | 34% | Per-model limits, compaction, `/clear` at task boundaries |
| **Output** (answers, thinking, written files) | 21% | Effort level, model choice, snapshot compaction |

The same session on Sonnet 5.5 is ≈ $9.10, and on Haiku 4.5 ≈ $4.55. **Model choice is the largest single lever**; ccwarden advises on it but never switches models mid-session, because a switch costs a full re-read.

### Expected gain (honest)

- **Automatic features alone** (junk guard, snapshot compaction, subagent guard): about **15–25%**.
- **With the advisor followed** (clear and hand off at task boundaries, cold-cache handling, a cheaper model for routine work): about **35–50%**.

The `/cw` dashboard measures it rather than promising it.

## 1. Billing modes (one setting per machine)

| `billing` | For | Currency | Typical cache TTL |
|---|---|---|---|
| `metered` | Usage-billed plans and API keys | $ for this conversation; month-to-date in the background | 5m (billed usage default) |
| `window` | Pro / Max / Team subscriptions | % of the 5-hour window used by this conversation | 1h within plan usage |

**Setup:**

- **First run:** one question, saved with `$.config.set` into that machine's `~/.claude/settings.json`.
- **Each session:** a sanity check. Signals that contradict the setting (windows present or absent, 5m vs 1h cache writes) raise a toast; the mod never switches silently.
- **No plan field:** the plugin API exposes no plan or account type, so the mode can't be fully automatic.

## 1b. Where it runs

| Surface | Supported | Loading |
|---|---|---|
| Claude Code CLI | ✅ | `claude --plugin-dir <mod>` or `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` `env` |
| Desktop app, **Code** tab (local and SSH sessions) | ✅ | Same `settings.json` `env` entry; Desktop and CLI share `~/.claude/settings.json` |
| VS Code extension | Best effort | `vscode` surface; untested |
| Desktop **Chat** / **Cowork** tabs | ❌ | No hooks or plugin surface there |
| Cloud sessions | ❌ | Desktop-installed plugins don't reach cloud sessions |

**Using several machines with different billing:**

- **Code:** install from one source (this repo, later a marketplace), so one update reaches all machines.
- **`billing` and every other option:** live in each machine's own `~/.claude/settings.json`; nothing is shared.
- **`$.store` history:** per machine. Spend the mod can't see is corrected with `/cw spent <amount>`: other machines, and claude.ai chat or Cowork if they count against the same cap.
- **Handoffs:** default to the project's `.claude/handoffs/`. Point `handoffDir` at a synced folder, or commit the files, to continue a task on another machine.

## 2. Design rules

| # | Rule |
|---|---|
| R1 | Never change the system prompt, tool list or CLAUDE.md layer: no `prompt.compose`, `prompt.context`, `tool.describe` or `skill.prompt` hooks. They invalidate the whole cache. |
| R2 | Nothing enters Claude's context unless a feature that does it is on. |
| R3 | Every feature is a toggle in `userConfig`. |
| R4 | Every block or rewrite tells the user and Claude why; every suggestion shows the cost of each option. |
| R5 | Nothing runs mid-turn (`$.session.compact` rejects mid-turn anyway). |
| R6 | One codebase for the `terminal` and `desktop` surfaces; tests run on both. |
| R7 | No network calls. Model calls only from features that say so (keep-warm, full handoff), within a per-session $ cap. |
| R8 | Dollar figures are labelled "est."; they use list price unless the admin set `modelPricing`. |
| R9 | At most 3 toasts per hour, by priority: spend alert > cold cache > advisor. Everything else goes to the band. |

## 2b. MVP scope

The spec has grown to about 15 features. The risk is that it keeps growing and nothing usable ever ships. So milestone 1 is only the five features with the biggest measured gain (§8). Everything else waits until M1 has been used on real work for a week.

## 3. Advisor

At decision points (`turn.complete`, `prompt.submit`, `session.start`) the advisor picks one recommendation, with buttons.

| State | Recommendation |
|---|---|
| Context under `compactAt`% of the model limit | Continue (silent) |
| Over `compactAt`%, cache warm, same task, more work ahead | **Compact** (snapshot, §4 F3), when the break-even rule holds |
| Task looks done (commit made, todos complete, user said so) | **Clear** (+ quick handoff if work continues later) |
| New prompt looks unrelated and context ≥ 40k | **Clear** (+ quick handoff) |
| Cache cold, large context, same task | **Handoff → new session** (re-read ~3k instead of the whole history) |
| Cache cold, large context, unrelated work | **Clear** |
| Spend or window past budget | Budget mode (earlier suggestions, stricter guards) |

**Advisor UX:**

- **Buttons:** a toast plus a band with **[Compact]** **[Clear + handoff]** **[Handoff → new session]** **[Keep going]**.
- **At most one suggestion per state change,** never mid-turn.
- **"Keep going" mutes that suggestion** until the context grows another 20%.
- **Learning:** every accept or reject is logged to `$.store` to tune the heuristics: task-done detection, unrelated-prompt detection, T estimation.
- **`[Clear + handoff]`** writes a quick handoff, then runs `/clear` if a mod can (Q4); otherwise it tells the user to.

**Budget mode** tightens thresholds: `compactAt` 45%, strict junk guard (`readMaxLines` 800, `bashMaxChars` 12k, test filter on), and alerts at `sessionAlertPct` 15%. It switches on:

- `metered`: month-to-date reaches 80% of `monthlyBudgetUsd`
- `window`: the 5h window reaches `budgetModeAt`%
- or manually with `/cw budget on`

**Break-even rule (compact vs continue), per model.** Let:

- C = the context now; S = the size after compaction
- T = the requests left in the task
- r = the model's cache-read multiplier (0.1; Opus 5.5 0.05; Fable 5.1 0.025)
- p_in, p_out = the model's prices (Appendix A)

Compact when T × (C − S) × r × p_in > the compaction's cost. With snapshot compaction (F3) that cost is only S × 1.25 × p_in, the re-cache of the new short conversation. With an engine summary it also includes C × r × p_in + about 3k × p_out.

Worked numbers for an engine summary (warm cache, S ≈ 15k):

| Model | C | Summary compaction ≈ | Saving per request ≈ | Pays off after ≈ |
|---|---|---|---|---|
| Haiku 4.5 | 100k | $0.04 | $0.009 | 5 requests |
| Sonnet 5.5 | 250k | $0.12 | $0.047 | 3 requests |
| Opus 5.5 | 250k | $0.19 | $0.047 | 4 requests |
| Fable 5.1 | 250k | $0.40 | $0.059 | 7 requests |

**What the table shows:** a large **warm** context on Opus 5.5 or Fable 5.1 is cheap to carry, because cache reads are cheap. The expensive event is a **cold rebuild**: re-caching 300K costs about $3.75 on Fable 5.1, $1.50 on Opus 5.5 and $0.75 on Sonnet at the 5m write rate. On 300K-limit models, F2 and F6 matter more than early compaction.

## 4. Features

### M1 (MVP)

**F1. Status line: this conversation.** `$.ui.status`.

```
metered:  Sonnet · ctx 140k/300k · cache ● 3m · this chat $1.84
metered:  Fable · ctx 262k/300k · cache ○ cold 12m (rebuild ≈ $3.30) · this chat $5.12 ⚠
window:   Haiku · ctx 64k/120k · cache ● 1h 41m · this chat 9% of 5h · 5h 62% (resets 1h20m)
```

- **The figure:** in `metered`, this chat's $ is the engine's own per-session total (`session.measure` `cost`, the same as `/usage`). It resets on `/clear`; compaction doesn't reset it.

**F1b. Spend alert.** Every `sessionAlertUsd` ($5) in `metered`, or every `sessionAlertPct` (20%) of the 5h window in `window`:

- a 10-second toast, e.g. "⚠ You've spent $5.12 in this conversation. Continuing."
- the status segment turns red
- one advisor suggestion

It never blocks and adds nothing to context.

- **Repeats:** every further step (+$5 / +20%), or only once if `sessionAlertRepeat` is 0.
- **Timing:** `alertTiming` is `immediate` by default, or `turnEnd` to hold the toast until the turn ends.
- **Reset:** the count starts over on a new session or `/clear`, not on compaction.

*(First slice implemented in `mod/`.)*

**F2. Cold-cache guard.** On `prompt.submit`, when the cache has expired and context ≥ `coldMinTokens`, it asks before sending: "this turn re-caches ~N tokens (≈ $X)". The choices are Continue or Cancel; the advisor's suggestion is attached.

**F3. Snapshot compaction + per-model limits.**

- **Limits:** `modelLimits` (default Haiku 120K; Sonnet / Opus / Fable 300K), capped at the model's real window. The model is detected from the last turn.
- **Trigger:** on `turn.complete` past the limit (or on an advisor accept), `$.session.compact()`.
- **Snapshot compaction:**
  - The mod's `session.compact` hook answers *in core's place*: it returns its own `messages` instead of calling `next`, so **no summary request is made and no summary tokens are spent**. The types state that a hook answer means core made no model request.
  - Those messages are a snapshot plus the last 1–2 turns, kept with their engine `handle`s. The snapshot holds the goal, verbatim recent asks, open todos, files edited with a diff stat, the last error, and the branch.
  - A manual `/compact <focus>` still uses the engine summary, with the snapshot facts added to its instructions.
  - The `precompute` trigger (background pre-summarisation) is vetoed with `{ skip }` while snapshot mode is on, so it spends nothing.
- **Safety net:** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set by the installer to the largest limit (300000), for the case where a single long turn outgrows the limit. If the engine re-reads the env live (Q5), the mod also sets it per model with `$.env.set` on each model change.
- **Model-switch warning:** each model has its own cache, so a switch re-reads the whole context uncached. When context exceeds the new model's limit it also compacts, and above the model's real window (more than 200K → Haiku) it must compact first. The toast shows the cost and the cheaper route, e.g. "Switch re-reads 180K on Haiku (≈ $0.23) and then compacts. Cheaper: /handoff → new Haiku session (≈ $0.02)." It shows before the switch if a mod can hook `PreModelSwitch` (Q9), otherwise right after.
- **Done when:**
  - an auto compaction shows no summary request in `/usage`
  - the next turn still knows the goal and recent asks
  - Haiku compacts at the first turn end past 120K, Sonnet past 300K and never below
  - a mid-session model switch applies the new limit from the next turn

**F4. Junk guard.**

- **Reads:** a `Read` with no limit on a file over `readMaxLines` is denied with "use `Grep` for what you need, or `Read` with offset/limit".
- **Bash output:** output over `bashMaxChars` is cut to head + tail, the full text is saved to a file, and Claude is told "`Grep` this file" (no re-run needed).
- **Test runners:** filtered to failures only.
- **Allowlist:** path globs to exempt; commands Claude already pipes through `head`/`tail`/`grep` are left alone.
- **Rollout:** it ships with `observe` mode, which only logs what it would have done.

**F5. Subagent guard** (`agent.spawn` hook).

- **Model:** pins subagents to `subagentModel` (default `haiku`) unless the agent type is in `subagentAllowlist`. Forks always inherit the parent's model, so a fork is warned about when the parent context is large.
- **Report size:** appends a report cap to the subagent's own prompt ("≤ 300 words, findings + paths, no file dumps"). The report lands in the parent context at the parent model's price, so this saves there. The cap goes in the subagent's context, not the parent's, so it doesn't break the parent's cache.
- **Concurrency:** caps how many run at once; past the cap the spawn is denied with a reason.
- **Limits:** applies the per-model limits and snapshot compaction to subagent loops (`session.compact` with `agentId`).
- **Shows:** `agents: 2 running · $0.40` in the status, and a toast for any subagent over $1.

**F6. Keep-warm, active session only** (experimental, `metered`).

- **What:** a minimal request every ~4.5 min that reads and refreshes the cached prefix: `$.model.fork({ prompt: "Reply with OK." })`. It re-sends the main thread's last request, so the API serves the prefix from its cache; its own tail is never cached.
- **When it runs, all of these must hold:**
  - a client is attached (`session.attach`/`detach`)
  - the last user prompt was within `keepWarmMaxMin` (30 min)
  - the cache is warm
  - the rebuild cost exceeds the ping cost
- **When it stops:** `/clear`, session end, detach, or the time limit. It never runs for a resumed session until the user sends a prompt.
- **Cap:** a per-session $ cap. It reports what it spent and what it saved.
- **Example:** Sonnet, 150K context: a ping ≈ $0.03 vs a rebuild ≈ $0.38. On Fable 5.1 the gap is far wider.
- **Instead of a 1h TTL:** on usage-billed plans, 5m TTL + keep-warm usually beats a 1h TTL, because 1h makes every write 2x instead of 1.25x. The mod measures the user's breaks and recommends a 1h TTL (written by the installer as `promptCacheTtl`) only when it would be cheaper.
- **Not on `window` plans:** they already get a 1h TTL.

### Later (M2+)

**F7. Handoff.**

- **`/handoff quick`** (zero tokens), built from the transcript and git: goal, verbatim asks, files touched + `git diff --stat`, open todos, last error, branch.
- **`/handoff`** (full): the same facts, plus Claude writes the decisions and why, the current state, the exact next step and what to verify first. It is one short turn, cheap while the cache is warm. The advisor offers full while warm, quick when cold.
- **Output:** a fixed template, written to `<handoffDir>/<date>-<topic>.md`.
- **Pickup:** on `session.start` (`startup`), the newest unread handoff for the project is offered as **[Continue from handoff]**.
- **`handoffOnCompact`:** writes a quick handoff before every compaction, as a safety net.

**F8. Background spend watcher.** Turns that start without a user prompt raise a toast with their cost and the setting that stops them:

- scheduled tasks and `/loop`
- cross-session messages (`crossSessionInbound: hold`)
- goal check-ins (`CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0`)

**F9. Model / effort advisor.**

- **Model:** routine work → a cheaper model, suggested at session start or through a handoff, never by switching mid-session.
- **Effort:** a lower `/effort` for routine steps. It is cache-safe mid-session on Opus 5.5, Sonnet 5.5 and Fable 5.1 per the docs; on other models, only at session start.

**F10. `/cw` dashboard and context hogs.**

- **Hogs:** every tool result is recorded with its estimated tokens. The top hogs per session and per month feed the dashboard and tune the F4 thresholds.
- **Pane:**
  - this session: context, cache hits, rebuilds with their cause, compactions, subagents
  - guard savings
  - month-to-date
  - the 7-day transcript report (`hooks-edition/report.js` logic)
- **Buttons:** [Compact] [Handoff] [Budget mode] [Copy report].

**F11. Month tracking** (`metered`).

- **Total:** the month-to-date estimate, calibrated with `/cw spent <amount>`.
- **Toasts:** at 50%, 80% and 100% of `monthlyBudgetUsd`, with a projection ("at this pace $118 by month end"). The total is not in the status line, which stays per conversation.

**F12. Setup profile (installer).** It writes and explains each setting:

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
- the subagent model setting
- a `# Compact instructions` template for the project CLAUDE.md
- prompt suggestions off in budget mode (each is a small extra request)
- a reminder to disable unused MCP servers
- `promptCacheTtl: "1h"`, only when F6/F7 data says it pays off

**F13. Unrelated-prompt hint.** It compares a new prompt's keywords with the session goal and recent asks, with zero model tokens, and suggests `/clear` when overlap is near zero. Off until tuned from the advisor's accept/reject log.

## 5. Configuration (`userConfig`)

| Key | Default | Feature |
|---|---|---|
| `billing` | asked on first run | §1 |
| `sessionAlertUsd` / `sessionAlertPct` / `sessionAlertRepeat` | 5 / 20 / same step | F1b |
| `coldMinTokens` | 50000 | F2 |
| `modelLimits` | haiku 120000 · sonnet/opus/fable 300000 | F3 |
| `compactMode` | `snapshot` (`summary` for manual `/compact <focus>`) | F3 |
| `compactAt` | 55 (% of the model limit) | §3 |
| `junkGuard` | `observe` → `enforce` | F4 |
| `readMaxLines` / `bashMaxChars` | 2000 / 30000 | F4 |
| `subagentModel` / `subagentAllowlist` / `maxParallelAgents` | haiku / [] / 3 | F5 |
| `keepWarm` / `keepWarmMaxMin` / `keepWarmCapUsd` | on (metered) / 30 / 0.50 | F6 |
| `monthlyBudgetUsd` | unset | F11 |
| `budgetModeAt` | 80 (% of month budget or 5h window) | §3 budget mode |
| `alertTiming` | `immediate` | F1b |
| `handoffDir` / `handoffOnCompact` | `.claude/handoffs` / off | F7 |
| `topicShiftHint` | off | F13 |

## 6. State

- **`$.state`** (session): cache expiry, alert steps, guard counters.
- **`$.store`** (machine): daily totals, hog history (30 days).
- **Files:** trimmed outputs and handoffs only.

## 7. Layout

```
hooks-edition/   v0.1, documented hooks + status line (works today)
mod/             the plugin: .claude-plugin/plugin.json, hooks/hooks.json, hooks/register.ts, src/…
probe/           dev-only day-one probe for §9 (never shipped)
docs/            this spec
```

## 8. Milestones

| Milestone | Scope | Exit check |
|---|---|---|
| **M1** | F1, F1b, F2, F3, F4 (observe → enforce), F5, F6 (after Q2) | `claude plugin validate` clean; tests on terminal + desktop × both billing modes; a week of real use on a metered and a window machine |
| **M2** | F7, F8, F9, F12 | Handoff round trip loses nothing needed |
| **M3** | F10, F11 | Dashboard within 10% of `/usage` |
| **M4** | F13, marketplace packaging | One-command install |

## 9. Open questions (verify in M1 week one)

T0 status, 2026-10-02. The "Types" column is what the v2.1.287 plugin API declarations state; they count as documented behaviour under rule 6. Each "Live" cell is still open until the maintainer runs `probe/` (see `probe/README.md`) on the `metered` and `window` machines.

| # | Question | Types (v2.1.287) | Live |
|---|---|---|---|
| 1 | **Default TTL on usage-billed plans:** what is the 5m/1h split of cache writes? | No `$` call returns the split. It is in the transcript (`message.usage.cache_creation.ephemeral_5m/1h_input_tokens`; the Agent tool result carries it too). `classic.PreModelSwitch` gets `cache_ttl: '5m'\|'1h'`, and `classic.SessionStart` (resume/fork) gets `prompt_cache_likely_expired` plus `estimated_cache_write_usd`. | open: `/cw-probe info` |
| 2 | **Keep-warm refresh:** does the ping refresh the main conversation's cached prefix? | `$.model.fork` re-sends "the main thread's last request (its model, system prompt, tools, messages)… so the API serves that prefix from its cache". The prefix is "billed afresh once the entry lapsed or after `/model`". `usage.cache_read_input_tokens` shows how much the cache served. Whether the fork extends the main entry's TTL is not stated. | open: `/cw-probe wait` vs `/cw-probe fork` |
| 3 | **Post-compaction re-reads:** after a hook answers `session.compact`, does core still re-read recent files? | Answering `{ messages }` without `next` means core makes no summary request (`usage` absent). Re-reads after a hook's answer are not stated. | open: `/cw-probe compact` |
| 4 | **`/clear` from a mod:** can a mod trigger it, or only tell the user? | **Likely yes.** `$.command.run({ command })` "runs a slash command as if the person typed `/command args`", and `$.command.list()` includes built-ins. `$.prompt.fill({ text, mode })` prefills the prompt box (`isFilled: false` under a dialog or headless). `/clear` raises `session.end` with `reason: 'clear'` and **no `session.start` after it**. | open: `/cw-probe newchat` |
| 5 | **Live env re-read:** does the engine re-read `CLAUDE_CODE_AUTO_COMPACT_WINDOW` after `$.env.set`? | `$.env.set` sets the variable "for this process and everything it starts after". Nothing says the engine re-reads it. `usage({ breakdown: 'summary' }).context.breakdown.rawMaxTokens` exposes the compaction window, so the effect is measurable. | open: `/cw-probe env 150000` |
| 6 | **Bash trim schema:** does a trimmed Bash result pass the tool's output schema? | **Likely yes.** Bash's result is `{ stdout: string, stderr: string, interrupted: boolean, … }`, so a shorter `stdout` keeps the shape. "Core validates a hook's answer against the tool's output schema." `claude plugin test` does **not** run that check: a malformed result passed in a test. | open: `seq 1 100000 # cw-probe-trim` |
| 7 | **Rate-limit windows:** are `rateLimits` available to mods on Team? | `rateLimits` is "empty off a subscription or before the first reading". Kinds are `five_hour`, `seven_day`, and a gateway's `spend_limit`. | open: `/cw-probe info` on `window` |
| 8 | **Desktop rendering:** do `$.ui.ask`, toasts and status look right in the Desktop Code tab? | All three are surface-independent `$` calls. `ui.ask` rejects when dismissed or in `-p`. | open: `/cw-probe ui` in Desktop |
| 9 | **`PreModelSwitch` from a mod:** can a mod hook it, to warn before a switch rather than after? | **Yes.** `on('classic.PreModelSwitch')` gets `from_model`, `to_model`, `source`, `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd` and `pricing`. It can answer `permissionDecision: 'allow'\|'deny'\|'ask'` with a reason. `classic.PostModelSwitch` exists too. A test passes (`probe/hooks/probe.test.ts`). | confirm once: `/model` |
| 10 | **Plugins allowed on managed machines:** do managed settings allow loading the mod? Hooks run there, but plugins can be restricted separately. | Not answerable from the types. `$.settings.read({ source: 'policy' })` shows the managed settings. | open: load `mod/` + `probe/` |
| 11 | **Background tasks:** how does a mod see running background tasks (the advisor's "never mid-work")? | **Answered.** `classic.Stop` and `classic.SubagentStop` carry `background_tasks` (shell, subagent, monitor, workflow: `id`, `type`, `status`, `description`, `command?`) and the scheduled crons that will wake the session. `$.agent.list()` gives subagents with `status` (`running`, `completed`, `failed`, `killed`, …). | confirm once |
| 12 | **Real spend:** is the org's real month-to-date spend readable locally? If yes, it replaces the F11 estimate. | **No $ figure.** `usage().cost.usd` is this session's total only. The one account-level reading is a gateway's `spend_limit` rate-limit kind, which gives `percentUsed` and no dollars. F11 stays an estimate. | confirm: `/cw-probe info` on `metered` |

## 10. Gaps found in design review, and resolutions

| # | Gap | Resolution |
|---|---|---|
| G1 | No measured baseline to prove savings | Accepted: the maintainer tracks spend personally and old sessions exist. The `/cw` dashboard (F10) measures from M1 on. |
| G2 | Model choice and effort (the largest levers) not covered | Routine work and all subagents run on **Haiku** (F5 pins it). F9 advises on model at session start and on effort mid-session, where cache-safe. |
| G3 | Managed machines might block plugins | Hooks (e.g. graphify) already run on the maintainer's managed machine. A day-one hello-mod check confirms plugins too (Q10); the hooks edition is the fallback. |
| G4 | Aggressive compaction has hidden costs: summary output tokens, file re-reads, lost detail | **Snapshot compaction** (F3): the mod answers `session.compact` itself, so no summary is generated, and keeps the last turns verbatim. Q3 checks the re-reads. |
| G5 | The junk guard might cause retries (many small reads, re-runs) | Deny messages point to `Grep` / ranged `Read`; full Bash output is saved to a file Claude greps. Ships in `observe` mode first. |
| G6 | Alert fatigue | R9: max 3 toasts/hour by priority; the rest goes to the band; "Keep going" mutes a suggestion. |
| G7 | The cache goes cold while idle; old sessions spend in the background | Keep-warm only for the **active, attached** session, ≤ 30 min, with a $ cap (F6). The background spend watcher (F8) exposes idle turns. A 1h TTL is set by the installer only when cheaper than keep-warm. |
| G8 | The monthly figure is an estimate (list price; other surfaces unseen) | Accepted risk: labelled "est.", calibrated with `/cw spent`, per-conversation figures stay exact. |
| G9 | Subagent spend is invisible and their reports bloat the parent context | F5: pin to Haiku, cap the report, cap parallelism, apply limits and snapshot compaction to subagent loops, per-agent cost in the status. |
| G10 | Heuristics (task done, unrelated prompt, turns left) unvalidated | Covered by tests plus the advisor's accept/reject log; F13 stays off until tuned. |
| G11 | Scope creep: about 15 features for a first release | M1 limited to F1–F6 (§2b, §8); everything else waits for real-use data. |
| G12 | Known platform limits | No compaction mid-turn (engine window as safety net); `rateLimits` on Team unknown (Q7); Desktop rendering unverified (Q8); plugin API is early access (pin the version). |

## Appendix A. List prices (per million tokens, platform.claude.com, 2026-10)

| Model | Input | 5m write | 1h write | Cache read | Output |
|---|---|---|---|---|---|
| Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |
| Sonnet 5.5 / 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Opus 5.5 | $4 | $5 | $8 | $0.20 (0.05x) | $20 |
| Fable 5.1 | $10 | $12.50 | $20 | $0.25 (0.025x) | $50 |

- **No long-context premium:** Claude 4.6+ bills a 900K request at the same per-token rate as a 9K one.
- **Where prices live:** `mod/config/prices.json`, versioned with the mod.
