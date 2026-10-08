# F3b: work-log compaction (design)

Status: design approved in chat, 2026-10-08; not built. Replaces the plain snapshot (SPEC §4 F3) as the default way the mod answers `session.compact`, and changes the HANDOFF §3 "Compaction" decision.

## 1. Why

The maintainer's live use: after a snapshot compaction, Claude either redoes work it had already done or stops and asks. The transcripts (`~/.claude/projects`, 2026-10-02 to 10-07) show why and what it costs:

- **93 auto snapshot compactions. 56 (60%) were loops:** a compaction followed by another with no typed prompt in between. One session (`6c38c4c1`) compacted 20+ times in 14 minutes: each time Claude re-read HANDOFF, SPEC and `register.tsx`, refilled the context and compacted again. 128 requests, 578k cache-write tokens, ~$5–6 est., no progress. Each snapshot "saved" ~$0.03.
- **85 of 93 (91%) were mid-turn.** The snapshot keeps the asks but not what was done inside the running turn, so the work in progress is lost.
- **Re-discovery costs more than a summary.** `377972d1` (Opus, 465k): after the snapshot, 3 minutes of re-reading files already read: 90k cache-write tokens, ~$1 est. An engine summary there would have cost ~$0.19–0.27 (465k × $0.2/M read + 4–9k output × $20/M; engine summaries in the transcripts run 4.3k tokens median, 8.8k p90).
- **Stopping:** `94496c6b`: after compaction Claude asked "Ho gaya test, ya pending hai?". The snapshot says nothing about what is done.

Root causes in `src/snapshot.ts`:

1. The recent asks are quoted verbatim in a *user* message with no reply or status, under "the user's words are verbatim". Claude reads them as live instructions.
2. Short replies ("Ha", "working", "2. Done") fill the five ask slots and mean nothing without the question they answered.
3. Nothing Claude learned or decided survives (its own text, the tool results), except the last answer when no turn is kept.
4. No line says which task to continue, or that earlier ones are done.
5. A last turn too big for 15% of the limit is dropped whole (`keptTail` keeps 0 turns), which is the usual mid-turn case.

The maintainer compared four approaches (cache-aware engine summary, Haiku work log, snapshot fixes only, a mix) and chose the **Haiku work log on top of a fixed snapshot**: cheap per compaction, one path for warm and cold caches, and no main-model summary.

## 2. Out of scope

- F2 "Compact & send" (snapshot before a prompt over a cold cache, by lowering the engine's compaction window): its own sub-project, after this one; it depends on an unverified engine behaviour.
- Delegating exploration to Haiku subagents (HANDOFF §5d): separate sub-project.
- Subagent loops' own compaction: still passed through (`agentId`).
- A manual `/compact <focus>`: still the engine summary with the snapshot facts added (`summary+facts`).

## 3. Rules check (SPEC §2)

| Rule | How F3b keeps it |
|---|---|
| 1. No cache-breaking hooks | Only `session.compact`, `turn.start`, `prompt.submit` (already hooked). The Haiku call is a separate request (`$.model.complete`: no tools, no history); it neither reads nor writes the main model's cache. |
| 2. Nothing added to context unless switched on | The work log replaces what the snapshot already put there; `compactMode: snapshot` turns it off. |
| 3. Every block says why | The loop stop says why, in the log and one toast (R9 budget). A failed or capped Haiku call says why in the log. |
| 4. Model calls only where the feature says so, within a $ cap | One `$.model.complete` per compaction, capped per session by `worklogCapUsd`; past it, the plain snapshot. |
| 5. One codebase, both surfaces | Hooks tests on terminal and desktop × metered and window. |
| 6. Only documented behaviour | Unverified points are Q35–Q38 (§9 below). |

## 4. Flow

`session.compact`, trigger `auto`, or `manual` with no instructions, main loop, not a holdout session, `compactMode: worklog`:

1. **Facts,** as today (`snapshotFacts`): goal, asks, todos, edited files with `git diff --numstat HEAD`, branch, last error. New: files read, with their ranges.
2. **Loop count** (§7). On the 3rd compaction of one task, answer as below, then stop the turn.
3. **Digest** (pure, `src/worklog.ts`) from `e.messages`, ≤ 40k tokens (`CHARS_PER_TOKEN` 4):
   - user prompts verbatim; Claude's text; one line per tool call (`Read(src/x.ts:1-80)`, `Bash(git status)`, `Edit(src/y.ts)`).
   - tool results filled **newest first**, whole while the budget lasts. Once it runs short, older results are cut by tool:

     | Tool | Kept when cut |
     |---|---|
     | Bash, PowerShell | a few head lines + the tail (more tail: errors and summaries are at the end) |
     | any failed call (`isError`) | up to 2,000 characters |
     | Grep, Glob | the matching lines (`path:line`) |
     | Edit, Write | path + the start of what changed |
     | Read | path + range; content only if budget is left |
     | anything else | head + tail |
   - the last turn is never cut; the oldest turns go first.
4. **Haiku call:** `$.model.complete({ model: worklogModel, system: WORKLOG_SYSTEM, prompt: digest, maxTokens: 1500, effort: 'low', timeoutMs: 30_000 })`, unless `worklogCapUsd` is spent. `WORKLOG_SYSTEM` asks for fixed sections, with exact paths, names and line numbers, no generic statements:
   `Done` · `In progress` · `Pending` · `Key findings` · `Next step`.
   Cost: ≤ 40k × $1/M + 1.5k × $5/M ≈ $0.05; ~$0.02–0.03 typical.
5. **Message** (one user message, then the kept tail by handle):
   1. header (§5.2)
   2. `## State of work (written by Haiku from the transcript; verify before relying on it)`: the Haiku sections
   3. the fixed snapshot facts (§5)
   4. the Resume block (§6), last
6. **Fallback:** an API error, a timeout, an empty reply or the cap spent → the same message without the Haiku section, and one log line: `ccwarden: work log skipped (<reason>); plain snapshot.`

`precompute` stays `{ skip }` (no engine summary computed ahead that would go unused). The log line becomes `ccwarden: work-log compaction (<trigger>): N messages → …; Haiku $x.xx` (or `plain snapshot: <reason>`).

## 5. Snapshot fixes (`src/snapshot.ts`)

1. **Turns, not asks.** "Recent requests" becomes recent turns, oldest first, filled by a character budget instead of a count of 5:
   ```
   3. User: "haan spec likho"
      Claude (done): "Spec likh diya: docs/superpowers/specs/2026-10-05-…"
   5. User: "spec theek hai, plan likho"
      Claude (in progress): "Plan likhne se pehle status.ts padh raha hoon…"
   ```
   The reply excerpt is the start of Claude's last text in that turn. Every turn is `done` except the last one in a mid-turn compaction (§6), which is `in progress`. A short reply such as "Ha" gets the end of Claude's previous text (the question it answered) so it reads in context.
2. **Header:** "These are **past** requests, quoted for reference. Those marked done are finished: do not redo them." It no longer calls the user's words instructions.
3. **Files read,** with ranges (`src/status.ts:1-80`), apart from files edited.
4. **Partial tail:** when the last turn doesn't fit `TAIL_SHARE` (15% of the limit), keep its end instead of nothing: the suffix that starts at an assistant message, so every kept `tool_use` has its `tool_result`. Two full turns, then one, then a suffix, then none.
5. **Size:** the snapshot facts cap rises from 6k to 10k characters; the Haiku section adds ≤ ~6k (1.5k tokens). About 4k tokens in all.

Unchanged: goal (first ask, kept across compactions in `$.state`), open todos, branch, diff stat, last error, `SNAPSHOT_TAG` (snapshots don't nest).

## 6. The Resume block

Always the last section of the message, so it is the last thing Claude reads before the kept tail.

Which one is read from the end of `e.messages`, not from `runtime.isTurnRunning` (a compaction on a new prompt can come after its `turn.start`):

- **mid-turn:** the last message is a tool result, or an assistant message with a `tool_use`; the task's prompt already has a reply under way.
- **boundary:** the last message is a typed prompt (the one that follows), or an assistant message with text and no `tool_use`.

**Mid-turn:**

```
## Resume: you were in the middle of this task
Current task (the user's request, verbatim):
  "spec theek hai, plan likho"
Added by the user during the task:
  (queued messages, if any)

Already done in this task (from the transcript, not a guess):
  - Read docs/superpowers/specs/2026-10-05-warden-ui-design.md
  - Read mod/src/status.ts:1-80, mod/src/metrics.ts:1-62
  - Wrote docs/superpowers/plans/2026-10-05-warden-ui.md (+212)
  - Ran: claude plugin test mod → failed (2 tests)
Next step (Haiku's reading of the transcript): fix the 2 failing tests in …

Resume this task now from the next step. Don't start it over, don't redo
the steps above, and don't work on any other request. Don't ask the user
whether to continue. If unsure whether a step is done, check it cheaply
(git diff, or the one file range) instead of redoing it.
```

- **Current task:** the typed prompt that started the running turn (the last prompt in `e.messages`, as `isPrompt` reads it). Prompts queued during the turn (`queued_command`) are listed as added.
- **Already done:** mechanical, from the running turn's tool calls only: files written or edited (with the diff stat when known), ranges read, commands run with pass/fail (`isError`). Never from Haiku, so it can't claim a step that didn't happen.
- **Next step:** Haiku's `Next step`; without Haiku, `continue after: <the last tool call and the start of its result>`.

**At a turn boundary** (a compaction before a new prompt): "All requests above are answered and done; work only on the user's message that follows."

On the 2nd compaction of one task (§7) the block adds: "This task was compacted twice; the context refills because of re-reading. Read only the ranges you need, prefer Grep, and don't re-read the files listed above."

## 7. Loop guard

`runtime` counts compactions since the last typed prompt (`prompt.submit`, origin `composer`, resets it; a background or queued prompt doesn't).

| Compaction in one task | Action |
|---|---|
| 1st | work log + snapshot |
| 2nd | the same, the Resume warning (§6), one toast (R9) |
| `compactLoopMax`th (default 3) | the same answer, then `$.turn.abort({ turnId })` (the id `turn.start` gave) from `$.clock.after(0)`, so the compaction stands first. Log + toast: `ccwarden: compacted 3 times in one task with no new prompt; stopped the turn so it doesn't keep spending. Split the task, or type "continue" to go on.` A `compact-loop` metrics event. |

Why stop rather than summarise: the maintainer chose no main-model summary, and `{ skip }` would leave the context over its limit. A stopped turn costs nothing more; typing "continue" is a typed prompt, so the count starts over.

## 8. Configuration (`userConfig`)

| Field | Default | Meaning |
|---|---|---|
| `compactMode` | `worklog` (was `snapshot`) | `worklog`: Haiku work log + snapshot. `snapshot`: the fixed snapshot, no model call. `summary`: the engine summary with the snapshot facts. |
| `worklogModel` | `haiku` | The alias or id for the work log (`claude-haiku-5-5` to pin). |
| `worklogCapUsd` | `0.50` | Per conversation (reset on `/clear`); past it, the plain snapshot. |
| `compactLoopMax` | `3` | The compaction in one task that stops the turn; `0` never stops. |

Fixed constants, not config: digest budget 40k tokens, `maxTokens` 1500, `timeoutMs` 30000, failed-call excerpt 2000 characters.

## 9. Metrics (F15) and status

- The `snapshot` `answered` event gains `measured.worklogUsd` (from the `$.model.complete` result's usage, priced with `PRICES`) and `measured.worklog: 'written' | '<fallback reason>'`. `est.usd` becomes the engine summary avoided (context × read + `SUMMARY_OUTPUT_TOKENS` × output) minus the Haiku cost.
- New events: `compact-loop` `warned` (2nd) and `stopped` (stop).
- `$.state` `conversation.worklog = { calls, spentUsd }`; `/cw` shows "work log: N calls, $x.xx".
- `recordProject` adds `worklogUsd`.
- The F15 proof compares the cache writes from a compaction to the next typed prompt, protected vs holdout, per family.

## 10. Unverified (to SPEC §9)

- **Q35:** `$.turn.abort` from a `clock.after(0)` scheduled inside a `session.compact` hook stops the turn, and the compacted conversation stands.
- **Q36:** `$.model.complete` usage on a `window` machine: counted in the 5h window, and does its result `usage` give the tokens to price?
- **Q37:** `timeoutMs` 30000 is enough for a 40k-token Haiku input at `effort: 'low'`.
- **Q38:** a kept tail that starts at an assistant message (the partial tail, §5.4) is accepted after the snapshot's user message.

## 11. Testing

Pure (`mod/tests/pure.test.ts`):

- Digest: whole results while they fit; newest first; each cut rule in the §4 table; the last turn never cut; ≤ budget.
- Turns: reply excerpt and status; a short reply carries the question before it; the budget fills from the newest.
- Resume block: mid-turn vs boundary read from the last message; the current task is the prompt that started the running turn; queued prompts listed; "Already done" only from tool calls; the fallback next step; the boundary block; the 2nd-compaction warning.
- Partial tail: starts at an assistant message; every `tool_use` keeps its `tool_result`; full turns preferred.
- Loop count: 1st, 2nd, `compactLoopMax`th; reset by a typed prompt only.

Hooks (`mod/tests/hooks.test.ts`, terminal + desktop × metered + window; `model.complete` answered by a test hook):

- The Haiku section is in the message; an API error, a timeout and a spent cap each give the plain snapshot and their log line, and a spent cap makes no call.
- The 3rd compaction aborts the running turn's id and toasts once.
- Regression: `compactMode: snapshot` (no call), `summary`, `/compact <focus>`, `precompute` skip, subagent pass-through and holdout pass-through behave as before. The existing snapshot tests are updated to the new format without dropping what they assert.
- The metrics event carries the measured Haiku `usd`.

Checks: `claude plugin validate mod`, `claude plugin test mod`, `npx -p typescript tsc -p mod --noEmit`.

Live (HANDOFF §1):

1. `/config` → `limitOther` 100000; work past it mid-task. The log shows `ccwarden: work-log compaction (auto)`; the next request resumes the task at its next step, without restarting it, re-reading the listed files or asking.
2. `/cw` shows the work-log spend.
3. After a week, re-run the transcript measure from this design (cache writes from compaction to the next typed prompt; compactions with no typed prompt between them) against the baseline in §1: ~$1 re-discovery per big compaction, 60% loops.

## 12. Decision changed

HANDOFF §3 "Compaction" was "Snapshot compaction: no summary tokens are spent". It becomes: "**Work-log compaction:** the mod answers `session.compact` with a snapshot plus a Haiku work log (≈ $0.03, capped), never the main model's summary; a manual `/compact <focus>` still uses the engine summary." Why: the snapshot alone made Claude redo or stall, and the re-discovery after it cost more than any summary (§1).
