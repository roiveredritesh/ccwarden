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
window:   Opus · ctx 111k/300k · cache ● 59m · miss: model switch, re-cached 111k · this chat 4% of 5h · …
window:   Haiku · ctx 64k/120k · cache ● 1h 41m · this chat 9% of 5h · 5h 62% (resets 1h 20m)
```

- **The figure:** in `metered`, this chat's $ is the engine's own per-session total (`session.measure` `cost`, the same as `/usage`). It resets on `/clear`; compaction doesn't reset it.
- **Window share:** the rise in `five_hour` `percentUsed` since the conversation started (a window reset counts from 0). Other sessions on the same account move that window too, so with several running at once it is an upper bound. Until the first `five_hour` reading, the status falls back to $.
- **ctx:** the last response's input tokens against `min(model limit, model window)`.
- **Cache:** warm for the TTL after the main loop's last response (subagent turns don't count). No event carries the TTL, so it is inferred, best source first:
  1. the 5m/1h split of the latest cache write in the transcript, re-read at most every 10 min and only while the file is ≤ 4 MiB (one `$.fs.read`)
  2. `CLAUDE_CODE_PROMPT_CACHE_TTL` or the `promptCacheTtl` setting
  3. the billing default: `window` 1h, `metered` 5m

  A cold cache shows the rebuild cost: context × the TTL's write price. An observed TTL that contradicts the billing setting, with no override to explain it, raises one advisor toast per conversation (§1).
- **Compact hint:** past `compactAt`% of the limit (55; 45 in budget mode) the status adds `/compact at a break`. Status only, no toast; the §3 break-even rule and task detection aren't built, so it is a plain threshold.
- **Cache miss:** a turn's first main-loop request that writes ≥ 20k tokens and more than it reads (its `turn.step` usage) re-cached the conversation. The status adds `miss: <cause>, re-cached 111k` until a turn the cache serves, and the log says the same. The cause, best guess first: `compaction` (one since the last request), `model switch` (each model has its own cache), `expired (idle 1h 5m)` (past the TTL), else `prefix changed (CLAUDE.md, tools, MCP or settings)`. The engine's own `last_miss_cause` (statusline JSON) is not in the plugin API, so this is inferred.

**F1b. Spend alert.** Every `sessionAlertUsd` ($5) in `metered`, or every `sessionAlertPct` (20%) of the 5h window in `window`:

- a 10-second toast, e.g. "⚠ You've spent $5.12 in this conversation. Continuing."
- the status segment turns red
- one advisor suggestion

It never blocks and adds nothing to context.

- **Repeats:** every further step (+$5 / +20%), or only once if `sessionAlertRepeat` is 0.
- **Timing:** `alertTiming` is `immediate` by default, or `turnEnd` to hold the toast until the turn ends.
- **Reset:** the count starts over on a new session or `/clear`, not on compaction.

*(First slice implemented in `mod/`.)*

**F2. Cold-cache guard.** On `prompt.submit`, when the cache has expired and context ≥ `coldMinTokens`, it asks before sending: "this turn re-caches ~N tokens (≈ $X)". The choices are Continue, Handoff or Cancel; the advisor's suggestion is attached. Handoff writes a quick handoff (F7) without a model call, since asking Claude for one would re-cache the whole context. A prompt that asks Claude for a handoff is asked about every time the cache is cold.

- **Asked for:** only prompts the user typed while the session was idle. Not prompts typed mid-turn, prompts from plugins or other sessions, headless runs, or before the first response.
- **Once per cold spell:** sending the same prompt again goes through.
- **Cancel or dismissal:** returns `{ drop }` with the reason, and puts the prompt back with `$.prompt.fill`.
- **The suggestion (as built):** the question names both cheaper routes from §3: same task → `/handoff`, then a new session (re-reads ~3k); unrelated work → `/clear` first. No buttons for them yet.

**F3. Snapshot compaction + per-model limits.**

- **Limits:** `modelLimits` (default Haiku 120K; Sonnet / Opus / Fable 300K), capped at the model's real window. The model is detected from the last turn.
- **Trigger:** on `turn.complete` past the limit, the mod toasts once "type `/compact`" (again only after the context drops back under the limit). It cannot run the compaction itself: `$.command.run({ command: 'compact' })` and `$.session.compact()` both skip the plugin's own `session.compact` hook (Q13, seen live; the engine ran its summary instead). A `/compact` the person types (manual, no focus) is answered with the snapshot.
- **Snapshot compaction:**
  - The mod's `session.compact` hook answers *in core's place*: it returns its own `messages` instead of calling `next`, so **no summary request is made and no summary tokens are spent**. The types state that a hook answer means core made no model request.
  - Those messages are a snapshot plus the last 1–2 turns, kept with their engine `handle`s. The snapshot holds the goal, verbatim recent asks, open todos, files edited with a diff stat, the last error, and the branch.
  - A manual `/compact <focus>` still uses the engine summary, with the snapshot facts added to its instructions.
  - The `precompute` trigger (background pre-summarisation) is vetoed with `{ skip }` while snapshot mode is on, so it spends nothing.
- **Auto-compaction (as built):** the engine re-reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW` live (Q5), so the mod sets it with `$.env.set` to the model's limit (within its real window, kept to 100k–1M) at session start and after every main turn. The engine then compacts at the limit by itself, and that compaction, being the engine's own (not a mod-run one, Q13), reaches the `session.compact` hook and is a snapshot. A value set by hand is overwritten: the per-model limits are `limitHaiku`/`limitOther`. The installer's 300000 covers the start, before the mod runs. Unverified live: that the engine's `auto` trigger reaches the hook (the types say only a plugin's own call skips it).
- **Model-switch warning:** each model has its own cache, so a switch re-reads the whole context uncached. When context exceeds the new model's limit it also compacts, and above the model's real window (more than 200K → Haiku) it must compact first. The toast shows the cost and the cheaper route, e.g. "Switch re-reads 180K on Haiku (≈ $0.23) and then compacts. Cheaper: /handoff → new Haiku session (≈ $0.02)." It shows before the switch if a mod can hook `PreModelSwitch` (Q9), otherwise right after. As built: a log line from `PreModelSwitch`, with the event's `estimated_cache_write_usd`. Live, that hook also fires when the picker is then cancelled ("Kept model"), so the note says "If you switch".
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
- **Rollout:** it ships with `observe` mode, which only logs what it would have done (to `$.store`; `/ccwarden-junk` lists the latest events and the tokens saved, est.). Switch `junkGuard` to `enforce` in `/config` once a week of the log shows no false positives.
- **As built (M1):**
  - A Read is checked only when it reads a whole text file: no offset, limit or pages, and not an image or PDF. Files of at most `readMaxLines` bytes are skipped without being read, and so are files over 4 MiB (what one `$.fs.read` takes).
  - A trimmed output keeps 60% head and 40% tail. The full text goes to `~/.claude/ccwarden/outputs/<session>-<tool_use_id>.txt`.
  - Output is left alone when it is an error, when the engine already persisted it (`persistedOutputPath`), when the command already pipes through `head`/`tail`/`grep`/…, or when the file couldn't be written.
  - **Test runners** (`npm test`, `node --test`, `pytest`, `cargo test`, `claude plugin test`, … by command regex): a run over `bashMaxChars`, passed or failed, keeps each failure line (`fail`, `error`, `expected`, `not ok`, `✗`, …) with the 3 lines after it, plus the last 15 lines, within `bashMaxChars`. The full text is saved as above. A failed run goes back as a plain result that starts "This test run FAILED (exit code N)", because a hook can't shorten an error result.
  - Not built yet: cleanup of old output files.

**F5. Subagent guard** (`agent.spawn` hook).

- **Model:** pins subagents to `subagentModel` (default `haiku`) unless the agent type is in `subagentAllowlist`. Forks always inherit the parent's model, so a fork is warned about when the parent context is large.
- **Report size:** appends a report cap to the subagent's own prompt ("≤ 300 words, findings + paths, no file dumps"). The report lands in the parent context at the parent model's price, so this saves there. The cap goes in the subagent's context, not the parent's, so it doesn't break the parent's cache.
- **Concurrency:** caps how many run at once; past the cap the spawn is denied with a reason.
- **Limits:** applies the per-model limits and snapshot compaction to subagent loops (`session.compact` with `agentId`).
- **Shows:** `agents 2 running · $0.40` in the status, and a toast for any subagent over $1. A subagent's cost is its turns' usage at list price, with cache writes at the 5m rate (subagents get 5m).

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
- **As built (M1, off by default until Q2):**
  - A 15 s timer pings once the cache has ≤ 45 s left, only while all the conditions above hold and no turn is running.
  - The ping costs its usage at list price, and the cap is checked before each one.
  - A ping counts as keeping the cache warm only when it read at least half the context from the cache. Otherwise the cache had lapsed, and there is no retry until the cache is used again.
  - "Saved" is the rebuild cost of each prompt sent while the cache was warm only thanks to a ping.
  - The status shows `keep-warm $spent · saved $saved`.
  - Not built: measuring the user's breaks to recommend a 1h TTL instead (that needs F10's data).

### Later (M2+)

**F7. Handoff.**

- **`/handoff quick`** (zero tokens), built from the transcript and git: goal, verbatim asks, files touched + `git diff --stat`, open todos, last error, branch.
- **`/handoff`** (full): the same facts, plus Claude writes the decisions and why, the current state, the exact next step and what to verify first. It is one short turn, cheap while the cache is warm. The advisor offers full while warm, quick when cold.
- **Output:** a fixed template, written to `<handoffDir>/<date>-<topic>.md`.
- **Pickup:** on `session.start` (`startup`), the project's newest handoff, if not offered before, is offered as **[Continue from handoff]**.
- **`handoffOnCompact`:** writes a quick handoff before every compaction, as a safety net.
- **As built (M2):**
  - The full handoff's four sections come from one `$.model.fork`. It is tool-less, reads the cached prefix and adds nothing to the conversation.
  - `/handoff` writes a quick handoff instead, and says why, when:
    - the cache is cold
    - the fork's estimate passes `handoffMaxUsd`
    - the reply isn't the four sections
  - Names are `YYYY-MM-DD-HHMM-<topic>.md` in UTC, so they sort by time on every machine. The topic is the goal's first words.
  - Pickup is offered only on a `startup` session start (from `classic.SessionStart`). Each file is offered once (`$.store`), and once the newest was offered, older ones are never offered (they are stale). **[Continue from handoff]** prefills the prompt box rather than sending anything.

**F8. Background spend watcher.** Turns that start without a user prompt raise a toast with their cost and the setting that stops them:

- scheduled tasks and `/loop`
- cross-session messages (`crossSessionInbound: hold`)
- goal check-ins (`CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0`)

**As built (M2):**

- A turn counts when it starts from a `prompt.submit` whose origin isn't the user's own (`composer`, `bridge`, `sdk`, `auto-continuation`). A delivery folded into a running turn doesn't count. Prompts queued while idle are matched to their turn by text, so a background prompt and the user's own, queued together, each go to the right turn.
- Its cost is the turn's usage at list price. Each kind is named once per conversation in an advisor-priority toast (under R9).
- The status line keeps a running `background $X`. The `backgroundWatch` toggle switches it off.
- Goal check-ins have no origin kind of their own in the types, so they fall under the generic "other" text.

**F9. Model / effort advisor.**

- **Model:** routine work → a cheaper model, suggested at session start or through a handoff, never by switching mid-session.
- **Effort:** a lower `/effort` for routine steps. It is cache-safe mid-session on Opus 5.5, Sonnet 5.5 and Fable 5.1 per the docs; on other models, only at session start.
- **As built (M2):**
  - **At a fresh start (`classic.SessionStart` `startup`, before the first prompt, when a switch is free):** one advisor toast gives the cheaper families' price per token as a % of the current one, plus the effort tip where effort is cache-safe. Nothing on Haiku, resume or `/clear`.
  - **Handoffs:** each note carries a "Next session: start on haiku" line.
  - **`classic.PreModelSwitch`:** a dim note when the context is past the new model's limit. It is never a guard, because a guard on `/model` was rejected (HANDOFF §3).
  - **`modelAdvisor`** switches all of it off.

**F10. `/cw` dashboard and context hogs.**

- **Hogs:** every tool result is recorded with its estimated tokens. The top hogs per session and per month feed the dashboard and tune the F4 thresholds. *(As built, M3-T1: main-loop results of ≥ 2k est. tokens (characters / 4); the session's top 20 in `$.state`, a per-day tally in `$.store`, 31 days.)*
- **Pane:**
  - this session: context, cache hits, rebuilds with their cause, compactions, subagents
  - guard savings
  - month-to-date
  - the 7-day transcript report (`hooks-edition/report.js` logic)
- **Buttons:** [Handoff] [Budget mode] [Copy report].
- **As built (M3-T3):**
  - `/cw` gathers the figures into `$.state` and opens the pane `ccwarden-cw`. Gathering is heavy (it reads transcripts), so it happens once per `/cw` or **Refresh**, never per redraw.
  - **This session:** model, ctx/limit and $ (est.); cache hits and rebuilds with their cause from its transcript; compactions; subagents; background spend.
  - **Guard savings:** this month's junk-guard events and est. tokens; snapshot compactions; keep-warm spent and saved.
  - **Month to date:** with the budget, the projection and budget mode.
  - **Hogs:** the top 3 this session and this month.
  - **Last 7 days:** the newest 20 transcripts of this project (each ≤ 4 MiB): per-session hits and rebuilds, tokens re-cached by cause, and the TTL verdict (`report.js` logic, ported to `src/report.ts`).
  - **Buttons, all on terminal and desktop:** Refresh, Handoff, Budget mode on/off, and Copy report (the whole dashboard as text, via `$.ui.copy`).

**F11. Month tracking** (`metered`).

- **Total:** the month-to-date estimate, calibrated with `/cw spent <amount>`. *(As built, M3-T1: a per-UTC-day ledger in `$.store` from each conversation's engine total; resumes and reloads start from their current total, so nothing is counted twice.)*
- **Toasts:** at 50%, 80% and 100% of `monthlyBudgetUsd`, with a projection ("at this pace $118 by month end"). The total is not in the status line, which stays per conversation.
- **As built (M3-T2):**
  - Each step toasts once a month on this machine (`$.store`), at spend priority. When one jump crosses several steps, only one toast is shown.
  - `monthlyBudgetUsd` 0 means off. Window billing never gets month toasts.
  - `/cw spent <amount>` records the real figure. The estimate counts on from it until the month ends.
  - `/cw` (for now) logs month to date, the projection and the budget mode.
  - **Budget mode** is on with `/cw budget on|off|auto` (auto by default), or automatically at `budgetModeAt`% of the month budget or the 5h window. It tightens `readMaxLines` (800), `bashMaxChars` (12k), `sessionAlertPct` (15) and `compactAt` (45), and never loosens a stricter setting.
  - Budget mode shows in the status line and is announced once when it switches on by itself. The test-runner filter is always on with the junk guard; budget mode's lower `bashMaxChars` makes it cut sooner. Turning prompt suggestions off is not built.

**F12. Setup profile (installer).** It writes and explains each setting:

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
- the subagent model setting
- a `# Compact instructions` template for the project CLAUDE.md
- prompt suggestions off in budget mode (each is a small extra request)
- a reminder to disable unused MCP servers
- `promptCacheTtl: "1h"`, only when F6/F7 data says it pays off

**As built (M2):** `setup/setup.js`, a plain Node script outside the mod. A plugin can't load itself, and only a script can set `CLAUDE_CODE_PLUGIN_DIRS`.

- **By default** it sets the documented `CLAUDE_CODE_PLUGIN_DIRS` (the mod, appended to any other dirs) and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (300000), each with its reason.
- **With `--project <dir>`** it appends a `# Compact instructions` template to that project's CLAUDE.md.
- It lists the configured MCP servers (`~/.claude.json`, the project's `.mcp.json`) with the reminder.
- **Opt-in, and unverified in the docs (§9 Q14):** `--subagent-model` (`CLAUDE_CODE_SUBAGENT_MODEL`), `--cache-ttl` (`promptCacheTtl`) and `--no-prompt-suggestions` (`promptSuggestionEnabled`).
- It writes a timestamped backup and records what each change replaced (`~/.claude/ccwarden/setup.json`), so `--uninstall` restores it and leaves later hand edits alone. `--dry-run` prints the plan only.
- The 1h-TTL recommendation from measured breaks waits for F10's data.
**F13. Unrelated-prompt hint.** It compares a new prompt's keywords with the session goal and recent asks, with zero model tokens, and suggests `/clear` when overlap is near zero. Off until tuned from the advisor's accept/reject log.

**As built (M4):** `topicShiftHint`, off by default.

- **Asked for:** the same prompts F2 asks about (typed while idle, interactive), when F2 didn't ask: its cold question already names `/clear`. The context must be ≥ 40k tokens and the prompt must have ≥ 2 keywords and not be a slash command.
- **Keywords:** lowercased alphanumeric words of 3+ characters, minus English and Hinglish filler, cut to 6 characters (a crude stem). The history is the goal, the last 5 asks and Claude's last answer. A shift is ≤ 20% of the prompt's keywords seen there.
- **The question:** Send, Clear or Handoff + clear. Clear drops the prompt, runs `/clear` with `$.command.run` (queued until the session is idle), resets the conversation's figures itself (a plugin's own command may skip its own `session.end` hook, as `/compact` did in Q13), and puts the prompt back with `$.prompt.fill`. Handoff + clear writes a quick handoff first. A dismissal keeps the prompt in the box.
- **Mute:** Send mutes the hint until the context grows 20%. Any other answer puts the prompt back, and only that prompt goes through when sent again; the next unrelated one is still asked about.
- **Learning:** each answer goes to `$.store` `topicLog` (overlap, keyword count, tokens, choice; last 200). Turn it on by default once that log shows few Sends.
- **Unverified live:** that a mod-run `/clear` clears (Q4), and that the refill lands after it.

**F14. Efficiency dashboard (browser).** A page that answers two questions about ccwarden itself: what did it save (an estimate per feature, with the method next to each number), and is that real (a measured before/after from the transcripts). It covers every project on the machine, with a per-project filter. Measured figures never share a total with estimates. `/cw` stays as it is.

**As built (M4):**

- **Opening:** `/cw open` writes `<claude dir>/ccwarden/dashboard.html` and opens it. The Claude folder comes from the transcript path, else `~/.claude`. The opener is `cmd /c start "" <path>` on Windows (`OS=Windows_NT`), `open` when `uname -s` is Darwin, `xdg-open` otherwise, all as argv with no shell. If the opener fails, the path is logged. Any other `/cw` argument behaves as before, and the usage line gains `open`.
- **Keeping it fresh:** once `/cw open` has run on the machine (`dashboardOpened`), the file is rewritten every 5 minutes and at session end; users who never open it pay nothing. The page has `<meta http-equiv="refresh" content="60">`. Concurrent sessions may each rewrite it; the last write wins and every write holds the full picture. Session end parses no transcript (it rebuilds from cached summaries) and skips the rewrite when less than 1.5 s of its bound is left.
- **The page** is one self-contained file: inline CSS, SVG charts, and a few lines of JS for the range (7 days, 30 days, since install) and project filters. No URL is loaded, and every path and text is escaped. Five sections and a coverage line:
  1. **Est. savings:** the total and one row per feature: what it did, how many times, what it saved, the formula, a confidence label.
  2. **Reality check (measured):** before vs after the install day: cost per request, cache hit %, rebuilds per 100 requests, average context. A trend, not a saving.
  3. **Projects:** spend, sessions, requests, cache hit %, rebuilds, top context hog and est. saved. A click filters sections 1, 2 and 4. The top hog is the biggest *file* hog under the project's path (`hogDays` has no project; Bash and Grep hogs aren't attributed).
  4. **Spend over time:** daily spend stacked by project, with the install day marked.
  5. **What to do:** up to three lines, each naming its figure.
  - **Coverage line:** for example "92 of 102 transcripts read; 10 over 4 MiB skipped". Transcripts over 4 MiB (the `$.fs.read` limit) are left out before and after alike, so the longest sessions are not in the measured figures.
  - In window billing, $ is labelled a list-price equivalent. Install day is the first day in `ledger.days` or `projectDays`.
- **Data:** live figures go to `projectDays`; each transcript's summary is parsed once and cached in `transcriptSummaries` (keyed by path, invalidated by mtime, size and junk-event count, pruned when the file is gone). Spend from before F14, with no project, shows as "unattributed". A projects folder that cannot be listed leaves the cache as it was.
- **Savings formulas (est.):** prices from `src/prices.ts` for the model family at the time.

  | Feature | Formula | Confidence |
  |---|---|---|
  | Junk guard, `enforce` | `tokens × (write5m + read × requestsAfter)`, where `requestsAfter` runs to the session's end or its next compaction | medium |
  | Junk guard, `observe` | same, shown as "would save", **not in the total** | medium |
  | Keep-warm | `keepWarmSavedUsd − keepWarmSpentUsd`; may be negative and is shown so | high |
  | Snapshot compaction | `context × read + SUMMARY_OUTPUT_TOKENS × output`, with `SUMMARY_OUTPUT_TOKENS = 2000`, priced when the snapshot happens | low |
  | F2 cold guard, F13 Clear, handoff | count only, no $ (the saving depends on what the user did next) | none |

  `requestsAfter` is counted from the transcript, not from turns: a junk event's `session` (`$.session.id()`, the transcript's file name) finds its transcript, and the summary counts the main-loop API requests after the event up to the next compaction. An event with no session (from before F14), or none of whose requests follow, is counted but not priced.
- **Unverified live:** see §9 Q15–Q19.

**Out of scope (v1):** $ estimates for F2, F13 and handoff; reading transcripts over 4 MiB; a live server, or publishing anywhere off the machine; a config option for the refresh interval.

## 5. Configuration (`userConfig`)

| Key | Default | Feature |
|---|---|---|
| `billing` | `ask`: asked on the next session start, then `metered` or `window` | §1 |
| `sessionAlertUsd` / `sessionAlertPct` / `sessionAlertRepeat` | 5 / 20 / same step | F1b |
| `coldMinTokens` | 50000 | F2 |
| `limitHaiku` / `limitOther` | 120000 / 300000 (Sonnet, Opus, Fable) | F3 |
| `compactMode` | `snapshot` (`summary` for manual `/compact <focus>`) | F3 |
| `compactAt` | 55 (% of the model limit) | §3 |
| `junkGuard` | `observe` → `enforce` | F4 |
| `readMaxLines` / `bashMaxChars` / `junkAllowlist` | 2000 / 30000 / `""` (comma-separated globs) | F4 |
| `subagentGuard` / `subagentModel` / `subagentAllowlist` / `maxParallelAgents` | on / haiku / `""` (comma-separated types) / 3 | F5 |
| `keepWarm` / `keepWarmMaxMin` / `keepWarmCapUsd` | **off** until Q2 is confirmed, then on for metered / 30 / 0.50 | F6 |
| `monthlyBudgetUsd` | unset | F11 |
| `budgetModeAt` | 80 (% of month budget or 5h window) | §3 budget mode |
| `alertTiming` | `immediate` | F1b |
| `handoffDir` / `handoffOnCompact` / `handoffMaxUsd` | `.claude/handoffs` / off / 0.50 | F7 |
| `topicShiftHint` | off (until tuned from `topicLog`) | F13 |

M1 declares only the M1 keys above in `plugin.json`. `monthlyBudgetUsd`, `handoffDir`/`handoffOnCompact` and `topicShiftHint` are added with their features. A `userConfig` value is a string, number, boolean or string list, so limits are one field per family, not a map. A field with `options` needs a `default` among them, which is why `billing` has `ask`.

## 6. State

- **`$.state`** (session): cache expiry, alert steps, guard counters.
- **`$.store`** (machine): daily totals, hog history (30 days).
  - `projectDays` (F14): per project (`projectKey`: `/`-separated, drive letter lower-cased) and UTC day: `usd`, `turns`, `peakContext`, `keepWarmPings`, `keepWarmSavedUsd`, `keepWarmSavedTokens`, `keepWarmSpentUsd`, `snapshots`, `snapshotSavedUsd`, `snapshotSavedTokens`, `coldAsks`, `topicClears`, `handoffs`. Days older than 400 are dropped.
  - `transcriptSummaries` (F14): transcript path → `{ mtimeMs, size, junk, summary }`; entries for gone files are dropped on each build.
  - `dashboardOpened` (F14): `true` once `/cw open` has run.
  - `junkLog` events (F14): optional `project` and `session`. Older events lack them.
- **Files:** trimmed outputs and handoffs, and the F14 page (`<claude dir>/ccwarden/dashboard.html`).

## 7. Layout

```
hooks-edition/   v0.1, documented hooks + status line (works today)
mod/             the plugin: .claude-plugin/plugin.json, hooks/hooks.json, hooks/register.tsx (all hooks and $ calls),
                 src/ (pure logic), types/index.d.ts ($.state contract), tests/
probe/           dev-only day-one probe for §9 (never shipped)
docs/            this spec
```

## 8. Milestones

| Milestone | Scope | Exit check |
|---|---|---|
| **M1** | F1, F1b, F2, F3, F4 (observe → enforce), F5, F6 (after Q2) | `claude plugin validate` clean; tests on terminal + desktop × both billing modes; a week of real use on a metered and a window machine |
| **M2** | F7, F8, F9, F12 | Handoff round trip loses nothing needed |
| **M3** | F10, F11 | Dashboard within 10% of `/usage` |
| **M4** | F13, F14, marketplace packaging | One-command install |

## 9. Open questions (verify in M1 week one)

T0 status, 2026-10-02. The "Types" column is what the v2.1.287 plugin API declarations state; they count as documented behaviour under rule 6. Each "Live" cell is still open until the maintainer runs `probe/` (see `probe/README.md`) on the `metered` and `window` machines.

| # | Question | Types (v2.1.287) | Live |
|---|---|---|---|
| 1 | **Default TTL on usage-billed plans:** what is the 5m/1h split of cache writes? | No `$` call returns the split. It is in the transcript (`message.usage.cache_creation.ephemeral_5m/1h_input_tokens`; the Agent tool result carries it too). `classic.PreModelSwitch` gets `cache_ttl: '5m'\|'1h'`, and `classic.SessionStart` (resume/fork) gets `prompt_cache_likely_expired` plus `estimated_cache_write_usd`. | open: `/cw-probe info` |
| 2 | **Keep-warm refresh:** does the ping refresh the main conversation's cached prefix? | `$.model.fork` re-sends "the main thread's last request (its model, system prompt, tools, messages)… so the API serves that prefix from its cache". The prefix is "billed afresh once the entry lapsed or after `/model`". `usage.cache_read_input_tokens` shows how much the cache served. Whether the fork extends the main entry's TTL is not stated. | open: `/cw-probe wait` vs `/cw-probe fork` |
| 3 | **Post-compaction re-reads:** after a hook answers `session.compact`, does core still re-read recent files? | Answering `{ messages }` without `next` means core makes no summary request (`usage` absent). Re-reads after a hook's answer are not stated. | open: `/cw-probe compact` |
| 4 | **`/clear` from a mod:** can a mod trigger it, or only tell the user? | **Likely yes.** `$.command.run({ command })` "runs a slash command as if the person typed `/command args`", and `$.command.list()` includes built-ins. `$.prompt.fill({ text, mode })` prefills the prompt box (`isFilled: false` under a dialog or headless). `/clear` raises `session.end` with `reason: 'clear'` and **no `session.start` after it**. | open: `/cw-probe newchat` |
| 5 | **Live env re-read:** does the engine re-read `CLAUDE_CODE_AUTO_COMPACT_WINDOW` after `$.env.set`? | `$.env.set` sets the variable "for this process and everything it starts after". Nothing says the engine re-reads it. `usage({ breakdown: 'summary' }).context.breakdown.rawMaxTokens` exposes the compaction window, so the effect is measurable. | **Yes** (live: 1000000 → 150000 right after `$.env.set`). F3 now sets it per model. |
| 6 | **Bash trim schema:** does a trimmed Bash result pass the tool's output schema? | **Likely yes.** Bash's result is `{ stdout: string, stderr: string, interrupted: boolean, … }`, so a shorter `stdout` keeps the shape. "Core validates a hook's answer against the tool's output schema." `claude plugin test` does **not** run that check: a malformed result passed in a test. | open: first live run (`seq 1 100000`) was inconclusive, not a fail: the hook saw only 30000 chars of stdout (the engine caps it) and the model got the engine's own persisted-file preview. Retry with `seq 1 4000 # cw-probe-trim` (about 19k chars). F4 already leaves a result with `persistedOutputPath` alone. |
| 7 | **Rate-limit windows:** are `rateLimits` available to mods on Team? | `rateLimits` is "empty off a subscription or before the first reading". Kinds are `five_hour`, `seven_day`, and a gateway's `spend_limit`. | open: `/cw-probe info` on `window` |
| 8 | **Desktop rendering:** do `$.ui.ask`, toasts and status look right in the Desktop Code tab? | All three are surface-independent `$` calls. `ui.ask` rejects when dismissed or in `-p`. | open: `/cw-probe ui` in Desktop |
| 9 | **`PreModelSwitch` from a mod:** can a mod hook it, to warn before a switch rather than after? | **Yes.** `on('classic.PreModelSwitch')` gets `from_model`, `to_model`, `source`, `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd` and `pricing`. It can answer `permissionDecision: 'allow'\|'deny'\|'ask'` with a reason. `classic.PostModelSwitch` exists too. A test passes (`probe/hooks/probe.test.ts`). | confirm once: `/model` |
| 10 | **Plugins allowed on managed machines:** do managed settings allow loading the mod? Hooks run there, but plugins can be restricted separately. | Not answerable from the types. `$.settings.read({ source: 'policy' })` shows the managed settings. | open: load `mod/` + `probe/` |
| 11 | **Background tasks:** how does a mod see running background tasks (the advisor's "never mid-work")? | **Answered.** `classic.Stop` and `classic.SubagentStop` carry `background_tasks` (shell, subagent, monitor, workflow: `id`, `type`, `status`, `description`, `command?`) and the scheduled crons that will wake the session. `$.agent.list()` gives subagents with `status` (`running`, `completed`, `failed`, `killed`, …). | confirm once |
| 12 | **Real spend:** is the org's real month-to-date spend readable locally? If yes, it replaces the F11 estimate. | **No $ figure.** `usage().cost.usd` is this session's total only. The one account-level reading is a gateway's `spend_limit` rate-limit kind, which gives `percentUsed` and no dollars. F11 stays an estimate. | confirm: `/cw-probe info` on `metered` |
| 13 | **Mod-run `/compact`:** does `$.command.run({ command: 'compact' })` reach the mod's own `session.compact` hook? | **No** (live test: the `/cw` Compact button ran the engine's own summary compaction, no snapshot log). A plugin's own `$.session.compact` skips its hook too. A `/compact` the person types does reach it. | closed: F3 only advises `/compact`; the pane's Compact button is removed |
| 14 | **Setting names not in the docs read for this spec:** `CLAUDE_CODE_SUBAGENT_MODEL`, `promptSuggestionEnabled`, `crossSessionInbound`, `CLAUDE_CODE_GOAL_CHECKIN_MINUTES`. | All four are strings in the 2.1.287 binary. The setup offers the first two only as opt-in flags, and F8's texts name the last two. | open: check code.claude.com/docs (settings, model-config) |
| 15 | **`/cw open` opener (F14):** does it open the page on Windows (`cmd /c start "" <path>` via argv), macOS (`open`) and Linux (`xdg-open`)? | Argv with no shell; the tests cover the argv per OS and the logged-path fallback. | open: live check per OS (the interactive `claude --plugin-dir ./mod` run of the build plan was not done) |
| 16 | **Page refresh (F14):** does a `file://` page with `<meta http-equiv="refresh" content="60">` reload and keep its `#hash` in Chrome, Edge and Safari? | Browser behaviour, not in the plugin API. | open |
| 17 | **`$.process.run` on Desktop (F14):** is it available in the Desktop Code tab? | The types say "CLI only". If not, the path is logged instead of opened. | open |
| 18 | **`session.end` bound (F14):** how long is it in practice; does the page rewrite fit or is it always skipped? | `next.budget.remainingMs` at `session.end` is what is left of one short bound; the rewrite needs 1.5 s. | open |
| 19 | **`OS=Windows_NT` (F14):** is it visible through `$.env.get` on Windows? | `$.env.get` reads the process environment. | open: if not, the Windows opener is never chosen |

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
- **Where prices live:** `mod/src/prices.ts`, versioned with the mod. A hooks module imports code files only, so prices aren't kept as JSON.
