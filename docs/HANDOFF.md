# Handoff: starting the mod (milestone M1)

Written 2026-10-02 at the end of the design session that produced this repo. It is for whoever, human or Claude, picks up the mod work next. Read it top to bottom once; after that, §5 is the task list.

## 1. Where things stand

| Piece | State |
|---|---|
| `hooks-edition/` | Done: status line, cold-cache prompt guard, post-compaction restore, transcript cache report, settings-merging installer. 16 node tests pass. CI runs on Linux and macOS (Windows path handling in the tests isn't portable yet). |
| `mod/` | First slice only, in `hooks/register.ts`: this conversation's $ in the status line, and a toast every $5. It passes `claude plugin validate` and type-checks against the v2.1.287 API. **It has not run in a live session yet.** |
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

**T1. Foundation.**

- **Layout:** `mod/src/` modules, `mod/types/index.d.ts` (the `$.state` contract), and `userConfig` in `plugin.json` (SPEC §5).
- **First-run `billing` question:** `$.ui.ask`, saved with `$.config.set`.
- **Toast budget:** a helper that enforces R9 (max 3/hour, priority).
- **Port the transcript helpers** from `hooks-edition/lib.js`: verbatim asks (incl. `queued_command` attachments), edited files, TodoWrite todos. Read the transcript with `$.fs`, or better `$.session.messages()` where it suffices.

**T2. F1 + F1b, finished.**

- Model and per-model limit in the status line.
- Cache warm/cold and time left. TTL is inferred from the 5m/1h split of the last turn's cache writes.
- Window mode: this conversation's share of the 5h window (the `rateLimits` five_hour delta since session start).
- `sessionAlertUsd/Pct/Repeat` from config.
- Done when the figures match `/usage`, and `/clear` resets the count with no stale alert.

**T3. F3, snapshot compaction + per-model limits.**

- At `turn.complete` past the model limit: `$.session.compact()`.
- The `session.compact` hook builds the snapshot message plus the last 1–2 turns (with handles) and returns `{ messages }`.
- `precompute` → `{ skip }` in snapshot mode.
- Manual `/compact <focus>`: call `next` with the instructions plus snapshot facts.
- The installer/README sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000`.
- Done when:
  - `/usage` shows no summary request on an auto compaction
  - the next turn still knows the goal and recent asks
  - Haiku compacts past 120K, Sonnet past 300K

**T4. F5, subagent guard.**

- `agent.spawn`: `model: haiku` unless allowlisted; append the report cap to `prompt`; deny past `maxParallelAgents`.
- Per-agent cost in the status.
- Done when a spawned Explore runs on Haiku, its report is ≤ ~300 words, and the 4th parallel spawn is denied with a reason.

**T5. F2, cold-cache guard.**

- On `prompt.submit` with a cold cache and large context: `$.ui.ask` with the re-cache cost, Continue or Cancel.
- Done when Cancel keeps the prompt text (Q4-adjacent: verify).

**T6. F4, junk guard, `observe` first.**

- `tool.call` on Read/Bash as in SPEC.
- In `observe` mode it only logs to `$.store`.
- Switch to `enforce` after a week with no false positives.

**T7. F6, keep-warm** (only if Q2 passes).

- `$.clock.every` ~270 s; `$.model.fork({ prompt: "Reply with OK." })`.
- All SPEC F6 conditions; a per-session $ cap; spent and saved shown in the status.

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

- **`claude plugin test` doesn't validate a `tool.call` answer against the tool's output schema.** A malformed Bash result passes in a test, so schema questions (Q6) need a live session.
- **In tests, the engine's `$` has only event nouns.** There's no `$.store` to read back, and `ui.log`, `ui.status` and `command.register` need a test-level hook beneath, or the plugin's call fails with "no implementation". See `world()` in `probe/hooks/probe.test.ts`.
- **The plugin API is early access:** pin and document the minimum Claude Code version; re-run `validate` after every update.
- **The transcript JSONL format is undocumented.** Assistant lines repeat per content block (dedupe by `message.id`). Mid-turn user messages are `attachment.type: "queued_command"`. Compaction leaves a `compact_boundary` system entry. Prefer `$.session.messages()` when it gives what you need.
- **No compaction mid-turn:** `$.session.compact` rejects while a turn runs, so a long agentic turn can pass the per-model limit; the engine window is the safety net.
- **Dollar figures are list price** unless the admin set `modelPricing`; label them "est.".
- **Desktop doesn't document a custom status line;** the mod's `$.ui.status` is the way there.
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
- `mod/hooks/register.ts`: the first slice; extend from here
