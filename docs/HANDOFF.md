# Handoff: starting the mod (milestone M1)

Written 2026-10-02 at the end of the design session that produced this repo. It is for whoever, human or Claude, picks up the mod work next. Read it top to bottom once; after that, §5 is the task list.

## 1. Where things stand

**M1, M2 and M3 code is complete (M1 T0–T7, M2-T1–T4, M3-T1–T3, 2026-10-02).** M2 added handoffs, the background spend watcher, model/effort advice and the `setup/` installer (§5b). M3 added the spend ledger, context hogs, month tracking with budget mode, and the `/cw` dashboard (§5c).

**M4 started (2026-10-02).** Marketplace packaging is done: `.claude-plugin/marketplace.json` at the repo root lists `./mod`, so `claude plugin marketplace add roiveredritesh/ccwarden` + `claude plugin install ccwarden@ccwarden` installs it (tested from a local directory source in an isolated `CLAUDE_CONFIG_DIR`). `setup.js` skips `CLAUDE_CODE_PLUGIN_DIRS` when `enabledPlugins` has `ccwarden@…`, so the mod never loads twice. Left for M4: F13 (unrelated-prompt hint), off by default.

**First live test done (2026-10-02, window machine, terminal + Desktop).** The run log is `~/.claude/ccwarden-live-test.md` on the maintainer's machine; the answers are in SPEC §9. Fixed from it (PRs #16–#28):

- the billing format, `/ccwarden-junk` wording, Windows paths (#17–#19)
- the limit follows `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (#20); the handoff Goal skips ccwarden's own pasted output (#21)
- **Q13 is no:** a mod-run `/compact` skips the mod's own hook, so the pane's Compact button is gone (#22). **Q5 is yes**, so the mod now sets the engine's auto-compact window to the model's limit and the engine's own compaction is answered with the snapshot (#27)
- Q6's first run was inconclusive (the engine had already capped and persisted the output); the probe now uses a 19k output (#23)
- new in F1: a cache miss names its likely cause (#25); a `/compact at a break` hint past `compactAt` (55, 45 in budget mode); F2 names the handoff route (#26). The switch note says "if you switch" (#28: PreModelSwitch also fires for a cancelled picker)

**Still open, all live:**

1. Check #27 live: `limitOther` 100000 in `/config`, work past it, and look for `ccwarden: snapshot compaction (auto)` in the log (not the engine summary).
2. Check #25 live: switch model, send a prompt, look for `miss: model switch` in the status.
3. Q6 retry with `seq 1 4000 # cw-probe-trim`; Q2 on the metered machine; `/cw` vs `/usage` back to back (the first compare was 21% low, timing-confounded).
4. Desktop UI polish: wait for the maintainer's list of what looks wrong.
5. Use the mod for a week, then `junkGuard` → `enforce` if `/ccwarden-junk` shows no false positives, and `keepWarm` on if Q2 passed.

Not built: the full §3 advisor (break-even rule, task-done / unrelated-prompt detection, its buttons), and cleanup of F4's output files (the plugin API has no file delete).

| Piece | State |
|---|---|
| `hooks-edition/` | Done: status line, cold-cache prompt guard, post-compaction restore, transcript cache report, settings-merging installer. 16 node tests pass. CI runs on Linux and macOS (Windows path handling in the tests isn't portable yet). |
| `mod/` | T1 foundation done: `userConfig` (SPEC §5), the `$.state` contract, the first-run billing question, the R9 toast budget and the ported transcript helpers. T2 done: F1 status line (model, ctx against the per-model limit, cache warm/cold with time left and rebuild cost, this chat's $ or share of the 5h window) and F1b alerts (`sessionAlertUsd`/`Pct`/`Repeat`, `alertTiming`, reset on `/clear`). T3 done: per-model limits and snapshot compaction. T4 done: the subagent guard. T5 done: the cold-cache guard. T6 done: the junk guard (ships in `observe`). T7 done: keep-warm (ships off until Q2). It validates, type-checks, and passes 107 tests on terminal and desktop × metered and window; CI runs them. **It has not run in a live session yet.** |
| `probe/` | T0 day-one probe (dev only, never shipped): `/cw-probe <check>` runs the live checks for SPEC §9. Validates, type-checks, and passes 8 tests on terminal and desktop. **Not yet run on the maintainer's machines.** |
| `docs/SPEC.md` | The product spec (draft 0.3): objective, billing modes, design rules, advisor, features F1–F11, milestones, open questions. §9 now records what the types answer. |

## 2. Who it's for (maintainer setup)

The maintainer uses Claude Code on **two machines with different billing**:

- **A `metered` machine:** usage-billed, every prompt costs money, with a hard monthly cap.
- **A `window` machine:** a Pro/Team subscription with 5-hour and weekly limits.

Both run the CLI and the Desktop Code tab. Routine work and **all subagents run on Haiku**. The maintainer's preferred context limits:

- **Haiku:** 120K
- **Sonnet, Opus, Fable:** 300K

The mod must work on both machines from one codebase; the per-machine `billing` setting (SPEC §1) changes the currency shown.

## 3. Decisions already made (don't reopen without new evidence)

| Topic | Decision | Why |
|---|---|---|
| Status line | Shows **this conversation's** spend ($, or % of the 5h window), not month totals | What the user can act on right now |
| Spend alert | Toast every $5 (metered) or 20% of the 5h window (window); never blocks | Awareness without interrupting work |
| Compaction | **Snapshot compaction**: the mod answers `session.compact` itself, so no summary tokens are spent. A manual `/compact <focus>` still uses the engine summary. | Summaries are output tokens (5x input); the snapshot costs nothing |
| Limits | Per model family (Haiku 120K, others 300K), enforced by the mod at turn end, plus the engine window (300K) as a safety net | The engine has only one global window |
| Junk guard | Deny with a pointer to `Grep` / ranged `Read`; trimmed Bash output saved to a file Claude can grep. Ships in `observe` mode first. | Redirecting to Grep avoids retries |
| Subagents | Pinned to Haiku via `agent.spawn`, report capped (~300 words), parallel cap | The report lands in the parent's context at the parent model's price |
| Cache TTL | Metered: 5m TTL + **keep-warm for the active session only** (≤ 30 min after the last prompt, client attached, $ cap); a 1h TTL is recommended only when the user's break pattern makes it cheaper. Window: 1h already, no keep-warm. | 1h makes every write 2x instead of 1.25x |
| Model switches | Never automatic; advise at session start or via handoff | A switch re-reads the whole context uncached |
| Baseline | No measurement-only phase; the maintainer tracks spend personally | |
| Scope | M1 = F1–F6 only (SPEC §2b, §8) | Ship something used, then grow |

Every gap raised in design review (G1–G12) and how it was resolved is in **SPEC §10**. Read it before proposing changes.

### Rejected ideas (don't rebuild these)

| Idea | Why it was rejected |
|---|---|
| Deleting local "dynamic cache" files on `/clear` | The prompt cache lives on Anthropic's servers; local files do nothing, and `/clear` already starts clean |
| Detecting `/clear` with `UserPromptSubmit` | Built-in slash commands don't fire it; use SessionStart `clear` / SessionEnd `clear` |
| Reading token usage in `PreToolUse` and printing `{"action":"compact"}` | The hook input has no usage fields, and no hook output triggers compaction (a mod can: `$.session.compact`) |
| Setting `ENABLE_PROMPT_CACHING_1H` on subscriptions | They already get 1h within plan usage; the documented override is `CLAUDE_CODE_PROMPT_CACHE_TTL` / `promptCacheTtl` |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` alone for "compact at 60%" | It only applies when a compaction window below the model limit is set; use `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100000–1000000) or the mod's per-model limits |
| A guard for `/model` and effort switches | Claude Code already asks while the cache is warm |
| Blocking on spend | Alerts never block (maintainer's choice) |

## 4. Verified facts to build on

### Docs (code.claude.com, platform.claude.com)

- **TTL:**
  - A subscription within plan usage gets 1h for the main conversation; billed usage and API keys get 5m.
  - `CLAUDE_CODE_PROMPT_CACHE_TTL` / the `promptCacheTtl` setting override it.
  - Subagents get 5m.
- **Effort is cache-safe on some models:** changing effort mid-session keeps the cache on Opus 5.5, Sonnet 5.5 and Fable 5.1 (API key or subscription). Model switches, fast mode, MCP/tool changes and plugin MCP changes invalidate it.
- **Cache-read multipliers:** 0.1x; **Opus 5.5 0.05x; Fable 5.1 0.025x**. No long-context premium on 4.6+ models. Prices are in SPEC Appendix A.
- **Compaction:**
  - It re-injects CLAUDE.md, memory, the plan, invoked skills, and re-reads up to 5 recent files.
  - `/clear` costs nothing.
  - `# Compact instructions` in CLAUDE.md steers the engine's summary.
- **`/usage`:** the Session block is the per-session cost (list price unless `modelPricing` is set); it resets on `/clear`.
- **Hooks:** built-in slash commands don't fire `UserPromptSubmit`. SessionStart sources: startup, resume, clear, compact, fork.

### Plugin API (types, v2.1.287; re-check against `mod/.claude-plugin/types/` after loading)

- **Events:**
  - `/clear` raises `session.end` with `reason: 'clear'` and **no `session.start` after it**. The module keeps running, so anything reset per conversation must reset on that `session.end` (or when `cost` drops in `session.measure`, as the first slice does).
  - Classic settings-hook events are hookable as `classic.<Event>`, e.g. `classic.PreModelSwitch` (it can deny or ask, with the re-cache cost) and `classic.Stop` (`background_tasks`, `transcript_path`).
  - `session.start`, `session.measure` (with `changed: ('context'|'rateLimits'|'cost')[]`), `session.compact`, `session.attach`/`detach`, `session.end`
  - `turn.start`, `turn.complete`, `prompt.submit`, `tool.call`, `agent.spawn`, `ui.render`, `command.run`
- **`$.session.usage()`:**
  - `{ startedAt, context: { tokens?, window, percent?, breakdown? }, rateLimits: { kind, percentUsed, resetsAt? }[], cost?: { usd } }`
  - `percent` is `tokens` over `window`, and `window` is the **model's** context window (the status line's `used_percentage`). An earlier note here said it was the compaction window; the types say otherwise. The compaction window is `breakdown.rawMaxTokens` (with `autocompactSource`). `breakdown: "summary"` is local and free, and includes `model`.
- **`$.session.compact({ instructions })`:** rejects mid-turn.
- **`session.compact` hook:**
  - Input: `{ trigger: 'manual'|'auto'|'plugin'|'precompute', agentId?, instructions?, messages }`.
  - **Returning `{ messages }` without calling `next` answers in core's place, and core makes no model request** (`usage` is absent).
  - A message kept with its `handle` stands as the engine has it; one without is built from `role`, `text` and tool blocks.
  - `{ skip }` vetoes.
- **`agent.spawn` hook:**
  - Rewrite `model` (alias like `haiku`), `prompt`, `description`, `background`; `{ deny }` refuses the spawn.
  - Forks ignore `model`.
  - `$.agent.list()` gives `{ id, type, status, parentId? }`.
- **`tool.call` hook:**
  - `{ deny }` refuses the call, and the model sees the text.
  - `await next(e)` then return a modified `{ result }`; core validates it against the tool's output schema.
- **`$.model.fork({ prompt })`:** re-sends the main thread's last request (same model, system, tools, messages) with `prompt` appended, so "the API serves that prefix from its cache". This is the keep-warm mechanism. Its own tail is never cached.
- **UI:**
  - `$.ui.status(text|undefined)`: one per plugin
  - `$.ui.toast(text, { timeoutMs })`
  - `$.ui.ask(question, options)`
  - `$.ui.open` + a `ui.render` hook for panes
  - an `AbovePrompt` band
- **State:**
  - `$.state` (session, needs a `types/index.d.ts` contract)
  - `$.store` (cross-session)
  - `$.config.set` (the plugin's `userConfig` fields)
  - `$.settings.read()` is **read-only**
  - `$.env.set(literal, value)` sets the process env (whether the engine re-reads it live is unverified)
- **Loading:**
  - `claude --plugin-dir <dir>`
  - or `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` `env`; the Desktop app uses this
  - hot reload in interactive sessions

## 5. M1 task list (do in order)

Each task: a branch, tests on `['terminal', 'desktop']` × `['metered', 'window']`, `claude plugin validate` clean, PR.

**T0. Day-one checks** (§6). **Q10 comes first.** Some features depend on the answers: F6 needs Q2, F3 needs Q3, F4 needs Q6.

- *Status 2026-10-02:* the type-level answers are in SPEC §9. Q9, Q11 and Q12 are answered there, and Q4 and Q6 look likely. `probe/` is the runbook for the rest; see `probe/README.md`. What remains is for the maintainer: run it on the `metered` and `window` machines, terminal and Desktop, and paste `~/.claude/ccwarden-probe.jsonl` back into SPEC §9.
- T1 can start in parallel. It doesn't depend on any open answer.

**T1. Foundation.** *Done 2026-10-02.* Notes for what follows:

- `src/` is pure, and every hook and `$` call is in `hooks/register.tsx` (see the §7 gotcha).
- `sessionFacts($, path)` is in `register.tsx`, ready for T3. It takes the path from `$.state` `transcriptPath`, which `classic.SessionStart` keeps current.
- A toast that R9 holds back is kept in `$.state` `heldNote` for the band (T2+).
- Not yet live-checked: whether `$.config.set` on `<plugin>.billing` writes `~/.claude/settings.json` for a `--plugin-dir` plugin (the row's key is looked up, not assumed), and how `$.ui.ask` looks in Desktop (Q8).


- **Layout:** `mod/src/` modules, `mod/types/index.d.ts` (the `$.state` contract), and `userConfig` in `plugin.json` (SPEC §5).
- **First-run `billing` question:** `$.ui.ask`, saved with `$.config.set`.
- **Toast budget:** a helper that enforces R9 (max 3/hour, priority).
- **Port the transcript helpers** from `hooks-edition/lib.js`: verbatim asks (incl. `queued_command` attachments), edited files, TodoWrite todos. Read the transcript with `$.fs`, or better `$.session.messages()` where it suffices.

**T2. F1 + F1b, finished.** *Done 2026-10-02* (code and tests). Still to do live:

- Check the status figures against `/usage` on both machines.
- Check that the observed TTL matches Q1.

Known limits:

- The window share is an upper bound when several sessions share the 5h window.
- On a brand-new process, the first turn's share is missed, because `rateLimits` is empty until a response arrives.
- TTL observation is skipped for transcripts over 4 MiB. The override and billing sources then decide.


- Model and per-model limit in the status line.
- Cache warm/cold and time left. TTL is inferred from the 5m/1h split of the last turn's cache writes.
- Window mode: this conversation's share of the 5h window (the `rateLimits` five_hour delta since session start).
- `sessionAlertUsd/Pct/Repeat` from config.
- Done when the figures match `/usage`, and `/clear` resets the count with no stale alert.

**T3. F3, snapshot compaction + per-model limits.** *Done 2026-10-02* (code and tests). Notes:

- Past the limit F3 only toasts "type /compact": a mod-run `/compact` (`$.command.run`) or `$.session.compact` skips the mod's own `session.compact` hook, so it got the engine summary (SPEC §9 Q13, live test). Only a typed `/compact` is a snapshot. The pane's Compact button was removed for the same reason.
- The snapshot is a user message: the goal (kept in `$.state` across compactions), the last 5 asks verbatim, open todos, edited files with `git diff --numstat HEAD`, the branch, and the last error. It is followed by the last 2 turns by handle (1 if they don't fit 15% of the limit; with none, the last answer goes in the snapshot).
- A snapshot followed by a kept user prompt makes two user messages in a row; that the engine accepts this is part of Q3.
- Compaction of subagent loops (`agentId`) passes through untouched, for T4.


- At `turn.complete` past the model limit: `$.session.compact()`.
- The `session.compact` hook builds the snapshot message plus the last 1–2 turns (with handles) and returns `{ messages }`.
- `precompute` → `{ skip }` in snapshot mode.
- Manual `/compact <focus>`: call `next` with the instructions plus snapshot facts.
- The installer/README sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000`.
- Done when:
  - `/usage` shows no summary request on an auto compaction
  - the next turn still knows the goal and recent asks
  - Haiku compacts past 120K, Sonnet past 300K

**T4. F5, subagent guard.** *Done 2026-10-02* (code and tests). Notes:

- The `agent.spawn` hook pins `subagentModel` unless the type is in `subagentAllowlist` (forks keep the parent's model). It appends the report cap to the subagent's own prompt, once, and denies a spawn once `maxParallelAgents` are `running` per `$.agent.list()`.
- Each spawn writes one dim transcript line saying what changed. `subagentGuard: false` turns all of it off.
- A subagent's cost comes from its `turn.complete` usage. A toast fires once per agent over $1.
- Not done yet: per-model limits and snapshot compaction inside subagent loops. Their `session.compact` passes through, and a mod can't trigger a subagent's compaction.
- Unverified live: that an Explore report really stays ≤ ~300 words. It's an instruction, not a hard limit.


- `agent.spawn`: `model: haiku` unless allowlisted; append the report cap to `prompt`; deny past `maxParallelAgents`.
- Per-agent cost in the status.
- Done when a spawned Explore runs on Haiku, its report is ≤ ~300 words, and the 4th parallel spawn is denied with a reason.

**T5. F2, cold-cache guard.** *Done 2026-10-02* (code and tests). Notes:

- A prompt the user types while idle, over a cold cache with a context ≥ `coldMinTokens`, gets one `$.ui.ask`. It names the cold time, the tokens and the re-cache cost (est.), and suggests `/clear`.
- Cancel or a dismissal drops the prompt with a reason and refills the box via `$.prompt.fill`. Sending again in the same cold spell goes through.
- A third choice, Handoff (or `/handoff` typed under Other), writes a quick handoff with no model call, so the cold cache isn't rebuilt just to write the note. Before this, asking Claude for the note re-cached everything anyway. The prompt is kept as with Cancel.
- Guard: a prompt that asks Claude for a handoff (`isHandoffAsk`: mentions "handoff"/"hand-off", not a slash command) is asked about every time over a cold cache, not just once per cold spell.
- Unverified live: that the refill lands after the drop clears the box (Q4-adjacent), and how `ui.ask` looks in Desktop (Q8).


- On `prompt.submit` with a cold cache and large context: `$.ui.ask` with the re-cache cost, Continue or Cancel.
- Done when Cancel keeps the prompt text (Q4-adjacent: verify).

**T6. F4, junk guard, `observe` first.** *Done 2026-10-02* (code and tests). Notes:

- What is built and what is left out is in SPEC F4 "As built". `/ccwarden-junk` shows the observe log.
- The switch to `enforce` is the maintainer's, after a week of use: `/config` → `junkGuard`.
- Unverified live: Q6, whether a trimmed Bash `{ result }` passes the engine's output-schema check (`stdout` stays a string, so it should). The same goes for a failed test run, which the filter turns into a plain `{ result }` that says it failed.


- `tool.call` on Read/Bash as in SPEC.
- In `observe` mode it only logs to `$.store`.
- Switch to `enforce` after a week with no false positives.

**T7. F6, keep-warm** (only if Q2 passes). *Built 2026-10-02, shipped **off*** (`keepWarm` defaults to false). Once `/cw-probe wait` vs `/cw-probe fork` on the metered machine shows the fork keeps the main cache warm (Q2), turn it on in `/config`. SPEC F6 "As built" has the details.


- `$.clock.every` ~270 s; `$.model.fork({ prompt: "Reply with OK." })`.
- All SPEC F6 conditions; a per-session $ cap; spent and saved shown in the status.

## 5b. M2 task list (do in order; SPEC §8: F7, F8, F9, F12)

Same rules as M1: a branch and a PR per task, tests on `['terminal', 'desktop']` × `['metered', 'window']`, `claude plugin validate` clean.

**M2-T1. F7, handoff.** *Done 2026-10-02.* `/handoff` (full while warm, else quick) and `/handoff quick`, the pickup offer on a fresh start, and `handoffOnCompact`. SPEC F7 "As built" has the details. Unverified live: the fork's reply quality, and whether `$.prompt.fill` lands when it runs at startup.

**M2-T2. F8, background spend watcher.** *Done 2026-10-02* (SPEC F8 "As built"). A turn that starts without the user's prompt gets a toast with its cost and the setting that stops it. Such turns are scheduled tasks, `/loop`, peer messages and channel deliveries. The `prompt.submit` origin says which.

**M2-T3. F9, model/effort advisor.** *Done 2026-10-02* (SPEC F9 "As built"). At session start, before the first prompt (when a switch is free), suggest a cheaper model for routine work. A lower `/effort` is cache-safe on Opus 5.5, Sonnet 5.5 and Fable 5.1. No guard on `/model` (rejected in §3). The handoff note names the suggested model.

**M2-T4. F12, setup profile.** *Done 2026-10-02* (`setup/setup.js`, SPEC F12 "As built"; CI runs its tests). A Node installer outside the mod, so it can also set `CLAUDE_CODE_PLUGIN_DIRS`. It writes and explains each setting, with `--dry-run`, a backup and `--uninstall`. Only settings that are documented, or present in the pinned binary and listed in SPEC §9.

## 5c. M3 task list (SPEC §8: F10, F11; exit check: dashboard within 10% of `/usage`)

**M3-T1. Spend ledger and context hogs** (the data both features read). *Done 2026-10-02.*

- **Ledger:** this machine's est. spend per UTC day goes into `$.store` `ledger`. It grows from each conversation's engine total, counting the rise since the last reading, or the new total after `/clear`. A resumed or reloaded conversation starts from its current total, so nothing is counted twice. It keeps 62 days.
- **Hogs:** every main-loop tool result of ≥ 2k est. tokens is recorded, in the conversation's top 20 (`$.state`) and in a per-day tally (`$.store` `hogDays`, the top 100 a day, 31 days).
- **Known gap:** two sessions on one machine writing at the same moment can lose one update, because `$.store` has no compare-and-set. The error is small.

**M3-T2. F11 month tracking and budget mode.** *Done 2026-10-02* (SPEC F11 "As built").

- `monthlyBudgetUsd`. `/cw spent <amount>` calibrates against the real figure.
- Toasts at 50/80/100% with a projection.
- Budget mode at `budgetModeAt`% of the month budget (metered) or of the 5h window (window), or `/cw budget on|off`. It tightens `compactAt`, the junk guard thresholds and `sessionAlertPct` (SPEC §3).

**M3-T3. F10 `/cw` dashboard.** *Done 2026-10-02* (SPEC F10 "As built"). Still to do live: M3's exit check, the dashboard within 10% of `/usage`.

- A pane with: this session (context, cache hits, rebuilds and their cause, compactions, subagents), guard savings, month-to-date, top hogs, and the 7-day transcript report (`report.js` logic, ported).
- Buttons: [Compact] [Handoff] [Budget mode] [Copy report].

## 6. Day-one checks (fill in the answers in SPEC §9)

`probe/` runs each check below; its README maps each one to a `/cw-probe` command.

| # | Question | How to check |
|---|---|---|
| Q1 | Default TTL on the metered machine | After a few turns, the transcript's `usage.cache_creation` split (`ephemeral_5m` vs `ephemeral_1h`), or the `prompt_cache.ttl` the status line gets |
| Q2 | Does `$.model.fork` refresh the main cache? | Fork at t=4 min; send a real prompt at t=8 min: is `cache_read` high, with no rebuild? Compare with no fork |
| Q3 | Snapshot compaction: does core still re-read files? What does the next turn cost? | Answer `session.compact` with `{ messages }`; watch the transcript and `/usage` |
| Q4 | Can a mod trigger `/clear`, or prefill the prompt? | Search the types for clear / prompt-box APIs (`$.prompt…`) |
| Q5 | Is the env re-read live after `$.env.set("CLAUDE_CODE_AUTO_COMPACT_WINDOW", …)`? | Set a low value mid-session and see whether auto-compaction honours it |
| Q6 | Does a trimmed Bash `{ result }` pass the schema? | Return a trimmed result from `tool.call` and watch for a refusal line |
| Q7 | Are `rateLimits` available on Team? | `$.session.usage()` on the window machine |
| Q8 | Does Desktop render toasts, status and `ui.ask`? | Load the mod in the Desktop Code tab via `CLAUDE_CODE_PLUGIN_DIRS` |
| Q9 | Can a mod hook `PreModelSwitch` (warn before a switch)? | Search the types for `classic` events or model-switch events, and try one |
| Q10 | Do managed settings on the metered machine allow the mod? | **Do this first:** load `mod/` (the first slice is a hello mod) with `claude --plugin-dir ./mod`; the status should show `this chat $…` |
| Q11 | How does a mod see running background tasks? | Search the types (`$.agent.list()` statuses, task APIs) |
| Q12 | Is the real month-to-date spend readable locally? | Check `/usage` and the plugin API; if not, F11 stays an estimate |

## 7. Gotchas learned the hard way

- **`$` can't cross an import.** `claude plugin validate` follows `$` only into functions declared in the same file. So every `$` call lives in `hooks/register.tsx`, and `src/` is pure logic, which also makes it easy to test.
- **A `$.state` reference is a `const` used only as a `$.state` argument.** Reading one in a helper function that nothing calls yet failed validation ("what it holds at the call could not be listed"). Pass the value in instead.
- **`userConfig`:** every field needs a `description`, and a field with `options` needs a `default` among them (or `required: true`). Values are string, number, boolean or string list only.
- **Tests:** `test(name, { options }, body)` sets `userConfig`. Ops the mod calls (`session.usage`, `session.surfaces`, `config.list`, `ui.toast`, …) need a test hook that answers `{ value }`. `$.state` works in tests without one. `$.ui.ask` is answered through `tool.call` `AskUserQuestion` (`{ result: { questions, answers } }`, or `{ deny }` for a dismissal). See `world()` in `mod/tests/hooks.test.ts`.
- **CI:** `npm install -g @anthropic-ai/claude-code@<version>` runs `plugin validate` and `plugin test` with no login.
- **The test kit's `expect` has no `toBeCloseTo`.** Round instead. A mod that calls `$.env.get` needs an `env.get` answer in its tests; `mock.env` answers only `get`, so `world()` keeps `$.env` in a map that also answers `env.set`. `fs.read`, `fs.stat`, `settings.read` and `session.model` are answered with `{ value }` like other ops.
- **A plugin's own `$.session.compact()` skips that plugin's `session.compact` hook** (the "calling one" is the whole plugin, even from a timer), and so does a `$.command.run({ command: 'compact' })` (Q13, live: it ran the engine summary). Only a `/compact` the person types, or the engine's own auto-compaction, reaches the hook; to compact at a limit, set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (re-read live, Q5). In tests, a test hook's `$` can't call `$.session.compact` (it isn't in its scanned calls), so the test body plays core with the engine's `$`.
- **`$.fs.read` rejects files over 4 MiB.** Long transcripts exceed that, so anything read from the transcript must have another source to fall back on.

- **`claude plugin test` doesn't validate a `tool.call` answer against the tool's output schema.** A malformed Bash result passes in a test, so schema questions (Q6) need a live session.
- **In tests, the engine's `$` has only event nouns.** There's no `$.store` to read back, and `ui.log`, `ui.status` and `command.register` need a test-level hook beneath, or the plugin's call fails with "no implementation". See `world()` in `probe/hooks/probe.test.ts`.
- **The plugin API is early access:** pin and document the minimum Claude Code version; re-run `validate` after every update.
- **The transcript JSONL format is undocumented.** Assistant lines repeat per content block (dedupe by `message.id`). Mid-turn user messages are `attachment.type: "queued_command"`. Compaction leaves a `compact_boundary` system entry. Prefer `$.session.messages()` when it gives what you need.
- **No compaction mid-turn:** `$.session.compact` rejects while a turn runs, so a long agentic turn can pass the per-model limit; the engine window is the safety net.
- **Dollar figures are list price** unless the admin set `modelPricing`; label them "est.".
- **Desktop doesn't document a custom status line;** the mod's `$.ui.status` is the way there.
- **`$.ui.status` draws ANSI escapes raw** (Q15, terminal): plain text and Unicode bars only, no colour.
- **`classic.PreModelSwitch` fires before the picker is confirmed,** also for a switch then cancelled. Say "if you switch".
- **Bash output over 30k chars is capped and persisted by the engine** before `tool.call` hooks see it (`persistedOutputPath`); the model gets the engine's file preview, not a hook's trimmed `stdout`.
- **`git add mod` / `git add probe` picks up the engine-written `tsconfig.json`;** both are in `.gitignore` now. Add files by name.
- **Coexisting with ccstatusline:** the mod doesn't own `statusLine`, so it works next to it.

## 8. Hooks edition: known issues (maintenance backlog)

- **`prompt-guard.js` gets cache expiry from the hooks-edition `statusline.js`.** With another status line (e.g. ccstatusline) the cold-cache warning goes quiet. Fix: derive expiry from the transcript (last response time + TTL from the 5m/1h cache-write split), and add `install.js --no-statusline`.
- **Unverified in a live session:**
  - whether the settings `env` reaches the status-line process (a `config.json` fallback exists)
  - whether the `UserPromptSubmit` `systemMessage` is displayed
  - whether `report.js`'s compaction marker is right (`compact_boundary` is also what ccstatusline counts)
- **Windows:** hook commands are quoted absolute paths; the tests assume POSIX paths (CI excludes Windows).

## 9. Where to look

- `docs/SPEC.md`: features, config, milestones
- `hooks-edition/lib.js`: transcript parsing to port
- `hooks-edition/report.js`: rebuild-cause logic (dedupe, gap and model-switch detection) for the future dashboard
- `mod/hooks/register.tsx`: every hook and `$` call (the logic is in `mod/src/`)
