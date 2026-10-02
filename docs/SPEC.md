# ccwarden: specification

Status: draft 0.3 (pre-alpha), 2026-10.
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

**Break-even rule (compact vs continue), per model.** Let:

- C = the context now; S = the size after compaction
- T = the requests left in the task
- r = the model's cache-read multiplier (0.1; Opus 5.5 0.05; Fable 5.1 0.025)
- p_in, p_out = the model's prices (Appendix A)

Compact when T × (C − S) × r × p_in > the compaction's cost. With snapshot compaction (F3) that cost is only S × 1.25 × p_in, the re-cache of the new short conversation. With an engine summary it also includes C × r × p_in + about 3k × p_out.

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

It never blocks and adds nothing to context. *(First slice implemented in `mod/`.)*

**F2. Cold-cache guard.** On `prompt.submit`, when the cache has expired and context ≥ `coldMinTokens`, it asks before sending: "this turn re-caches ~N tokens (≈ $X)". The choices are Continue or Cancel; the advisor's suggestion is attached.

**F3. Snapshot compaction + per-model limits.**

- **Limits:** `modelLimits` (default Haiku 120K; Sonnet / Opus / Fable 300K), capped at the model's real window. The model is detected from the last turn.
- **Trigger:** on `turn.complete` past the limit (or on an advisor accept), `$.session.compact()`.
- **Snapshot compaction:**
  - The mod's `session.compact` hook answers *in core's place*: it returns its own `messages` instead of calling `next`, so **no summary request is made and no summary tokens are spent**. The types state that a hook answer means core made no model request.
  - Those messages are a snapshot plus the last 1–2 turns, kept with their engine `handle`s. The snapshot holds the goal, verbatim recent asks, open todos, files edited with a diff stat, the last error, and the branch.
  - A manual `/compact <focus>` still uses the engine summary, with the snapshot facts added to its instructions.
  - The `precompute` trigger (background pre-summarisation) is vetoed with `{ skip }` while snapshot mode is on, so it spends nothing.
- **Safety net:** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set by the installer to the largest limit (300000), for the case where a single long turn outgrows the limit.

**F4. Junk guard.**

- **Reads:** a `Read` with no limit on a file over `readMaxLines` is denied with "use `Grep` for what you need, or `Read` with offset/limit".
- **Bash output:** output over `bashMaxChars` is cut to head + tail, the full text is saved to a file, and Claude is told "`Grep` this file" (no re-run needed).
- **Test runners:** filtered to failures only.
- **Allowlist:** path globs to exempt.
- **Rollout:** it ships with `observe` mode, which only logs what it would have done.

**F5. Subagent guard** (`agent.spawn` hook).

- **Model:** pins subagents to `subagentModel` (default `haiku`) unless the agent type is in `subagentAllowlist`. Forks always inherit the parent's model, so a fork is warned about when the parent context is large.
- **Report size:** appends a report cap to the subagent's own prompt ("≤ 300 words, findings + paths, no file dumps"). The report lands in the parent context at the parent model's price, so this saves there. The cap goes in the subagent's context, not the parent's, so it doesn't break the parent's cache.
- **Concurrency:** caps how many run at once; past the cap the spawn is denied with a reason.
- **Limits:** applies the per-model limits and snapshot compaction to subagent loops (`session.compact` with `agentId`).
- **Shows:** `agents: 2 running · $0.40` in the status, and a toast for any subagent over $1.

**F6. Keep-warm, active session only** (experimental, `metered`).

- **What:** a minimal request every ~4.5 min that reads and refreshes the cached prefix.
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

- **F7. Handoff:**
  - `/handoff quick` (zero tokens: the snapshot as a file)
  - `/handoff` (Claude adds decisions and next steps, one short turn)
  - pickup: `[Continue from handoff]` on the next session start
- **F8. Background spend watcher:** turns that start without a user prompt (scheduled tasks, cross-session messages, goal check-ins) raise a toast with their cost and the setting that stops them.
- **F9. Model / effort advisor:**
  - routine work → a cheaper model at session start
  - `/effort` changes mid-session; cache-safe on Opus 5.5, Sonnet 5.5 and Fable 5.1 per the docs
- **F10. `/cw` dashboard:** this session and month, rebuilds and their causes, context hogs, guard savings.
- **F11. Month projection** for `metered`, calibrated with `/cw spent <amount>`.

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

## 6. State

- **`$.state`** (session): cache expiry, alert steps, guard counters.
- **`$.store`** (machine): daily totals, hog history (30 days).
- **Files:** trimmed outputs and handoffs only.

## 7. Layout

```
hooks-edition/   v0.1, documented hooks + status line (works today)
mod/             the plugin: .claude-plugin/plugin.json, hooks/hooks.json, hooks/register.ts, src/…
docs/            this spec
```

## 8. Milestones

| Milestone | Scope | Exit check |
|---|---|---|
| **M1** | F1, F1b, F2, F3, F4 (observe → enforce), F5, F6 (after Q2) | `claude plugin validate` clean; tests on terminal + desktop × both billing modes; a week of real use on a metered and a window machine |
| **M2** | F7, F8, F9 | Handoff round trip loses nothing needed |
| **M3** | F10, F11 | Dashboard within 10% of `/usage` |
| **M4** | Marketplace packaging | One-command install |

## 9. Open questions (verify in M1 week one)

1. **Default TTL on usage-billed plans:** read the 5m/1h split of cache writes.
2. **Keep-warm refresh:** does the ping actually refresh the main conversation's cached prefix? Same model, tools and system prompt are required.
3. **Post-compaction re-reads:** after a hook answers `session.compact`, does core still re-read recent files?
4. **`/clear` from a mod:** can a mod trigger it, or only tell the user?
5. **Live env re-read:** does the engine re-read `CLAUDE_CODE_AUTO_COMPACT_WINDOW` after `$.env.set`?
6. **Bash trim schema:** does a trimmed Bash result pass the tool's output schema?
7. **Rate-limit windows:** are `rateLimits` available to mods on Team?
8. **Desktop rendering:** do `$.ui.ask`, toasts and status look right in the Desktop Code tab?

## Appendix A. List prices (per million tokens, platform.claude.com, 2026-10)

| Model | Input | 5m write | 1h write | Cache read | Output |
|---|---|---|---|---|---|
| Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |
| Sonnet 5.5 / 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Opus 5.5 | $4 | $5 | $8 | $0.20 (0.05x) | $20 |
| Fable 5.1 | $10 | $12.50 | $20 | $0.25 (0.025x) | $50 |

- **No long-context premium:** Claude 4.6+ bills a 900K request at the same per-token rate as a 9K one.
- **Where prices live:** `mod/config/prices.json`, versioned with the mod.
