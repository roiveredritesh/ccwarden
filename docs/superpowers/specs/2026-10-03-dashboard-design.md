# F14. Efficiency dashboard (browser): design

Date: 2026-10-03 · Status: approved in chat, spec under review · Milestone: M4

## 1. Goal

A page in the browser that answers two questions about ccwarden itself:

1. **What did ccwarden save?** An estimate per feature, and a total, with the method shown next to each number.
2. **Is it real?** A before/after view of measured figures from the transcripts, as a reality check on (1).

Across every project on the machine, in one place, with a per-project filter. It is for the maintainer (to tune features) and for showing others (README, marketplace). So every number says how it was made, and measured figures never share a total with estimates.

`/cw` stays as it is. The page is a richer view next to it, not a replacement.

## 2. Hard requirements

- **Nothing that works today breaks.** No existing store key changes shape (`ledger`, `hogDays`, `junkLog`, `topicLog`, `handoffsOffered`, `budgetSwitch`). New data goes in new keys; old events gain only optional fields. `/cw`, `/cw spent`, `/cw budget …`, the pane, month tracking and budget mode behave exactly as before. All existing tests pass unedited, apart from additions.
- **SPEC §2 rules hold:** no network (the page loads nothing external), nothing added to Claude's context, no prompt-cache-breaking hooks, one codebase for `terminal` and `desktop`, and only documented API behaviour.
- **Docs are cleaned up when the work is done** (§9).

## 3. The page

One self-contained HTML file. All CSS, the SVG charts, the data (embedded JSON) and a little JS for the project filter are inline.

- **Header:** the range (7 days, 30 days, since install), the last update time, the billing mode. Figures are tokens first, with $ at list price beside them. In window billing, $ is labelled "list-price equivalent".
- **1. Est. savings:** the total (`~X tokens / ~$Y saved (est.)`), then one row per feature: what it did, how many times, what it saved, the formula, and a confidence label (§5).
- **2. Reality check (measured):** before vs after install, per project. It shows cost per request, cache hit %, rebuilds per 100 requests and average context. It is labelled a trend, not a saving.
- **3. Projects:** one row per project with spend, sessions, requests, cache hit %, rebuilds, its top context hog and est. saved. Clicking a row filters sections 1, 2 and 4 to that project.
- **4. Spend over time:** daily spend, stacked by project, with the install day marked.
- **5. What to do:** up to three actions from the data, each naming its figure (e.g. "junk guard in observe would have saved ~$Z: `enforce`").
- **Coverage line:** for example, "92 of 102 transcripts read; 10 over 4 MiB skipped". It also counts failed reads.

## 4. Data

### 4.1 Going forward: recorded live (new key `projectDays`)

`projectDays: { [projectRoot]: { [day]: { usd, turns, peakContext, keepWarmSavedUsd, keepWarmSpentUsd, snapshots, coldAsks, topicClears, handoffs } } }`

- `usd`: in `session.measure`, the same `costDelta` that feeds `recordSpend` is also added here under `$.session.root()`. `ledger` is still written exactly as before.
- `turns`, `peakContext`: on turn completion.
- The keep-warm, snapshot, cold-guard (F2), F13 and handoff counts are added where those features already record their outcome.
- Bounded: days older than 400 are dropped.
- Spend from before this key existed (`ledger.days` with no project) is shown as the project "unattributed".

The `JunkEvent` type gains optional `project`, `session` and `turn` (the turn index when it fired). Events written before this change lack them and are shown under "unattributed".

### 4.2 History and cache figures: transcripts

- Source: `~/.claude/projects/*/*.jsonl` and each transcript's `cwd` for the project. They are parsed with `src/report.ts`, extended to also count `output_tokens`.
- Only files ≤ 4 MiB are read (the `$.fs.read` limit). Bigger ones are counted as skipped and shown on the coverage line. Before and after use the same rule, so the comparison is like for like. The page states the bias: the longest sessions are left out.
- Each transcript's summary is cached in `$.store` key `transcriptSummaries`, keyed by `path|mtimeMs|size`, so a file is parsed once. Entries for files that no longer exist are dropped.
- Install day: the first day in `ledger.days` or `projectDays`, whichever is earlier.

## 5. Savings formulas (est.)

Prices come from `src/prices.ts` for the event's model family (`Price`: `input`, `write5m`, `read`, `output`).

| Feature | Formula | Confidence |
|---|---|---|
| Junk guard, `enforce` | `tokens × (write5m + read × requestsAfter)`, where `requestsAfter` runs to the session's end or its next compaction, whichever comes first | medium |
| Junk guard, `observe` | same, shown as "would save", **not in the total** | medium |
| Keep-warm | `keepWarmSavedUsd − keepWarmSpentUsd` (from the existing `avoidedRebuild`); may be negative and is shown so | high |
| Snapshot compaction | `context × read + SUMMARY_OUTPUT_TOKENS × output`, with `SUMMARY_OUTPUT_TOKENS = 2000` shown on the page | low |
| F2 cold guard, F13 Clear, handoff | count only, no $ (the saving depends on what the user did next, which isn't measured) | — |

`requestsAfter` comes from the event's `turn` and the session's final `turns`. If either is missing, the event is counted but not priced.

## 6. Generating and opening

- `/cw open`: gathers the data, writes `~/.claude/ccwarden/dashboard.html` and opens it with `$.process.run`: `cmd /c start "" <path>` on Windows, `open` on macOS, `xdg-open` on Linux. If the opener fails, the path is logged instead. Any other `/cw` argument behaves as today, and the usage line gains `open`.
- While a session runs, the file is rewritten every 5 minutes, but only after `/cw open` has run once on this machine (a `$.store` flag), so users who never open it pay nothing. It is also rewritten at session end. The page has `<meta http-equiv="refresh" content="60">`.
- Concurrent sessions may each rewrite the file. The last write wins, and every write holds the full picture, so that's fine.

## 7. Code layout

- `mod/src/efficiency.ts` (pure): `projectDays` updates, the transcript summary cache, aggregation by project, range and before/after, the savings formulas and the "what to do" lines.
- `mod/src/htmlDashboard.ts` (pure): data → the HTML string, escaping every project path and text.
- `mod/hooks/register.tsx`: the `$` calls only (recording, `/cw open`, the timer, file write and opener), per the project's convention.
- `mod/types/index.d.ts`: the new store shapes.

## 8. Errors and tests

- **Errors:** a transcript that fails to parse is skipped and counted. A failed write or opener logs one line, with the path. Nothing throws out of a hook.
- **Pure tests** (`pure.test.ts`): each formula, including the observe exclusion, negative keep-warm and an unpriced event. Also aggregation across projects and days, the summary cache (hit, invalidation by mtime or size, pruning), the coverage counts, and before/after split on the install day. The HTML has no `http`, escapes a `<script>` in a project path, labels every estimate "est." and shows the coverage line.
- **Hook tests** (`hooks.test.ts`, terminal and desktop): `/cw open` writes the file and runs the platform opener. A failing opener logs the path. `session.measure` adds to `projectDays` and still to `ledger`. Plain `/cw`, `/cw spent` and `/cw budget` give the same output as before. The timer doesn't run before the first `/cw open`.
- **Regression:** the whole existing suite passes unedited. `claude plugin validate mod` passes.

## 9. Docs cleanup at the end

- SPEC: add F14 to §4 with an "As built" block, add the new store keys to §6, and add anything unverified live (opener on each OS, refresh of a `file://` page) to §9.
- HANDOFF: move F14 into the done list, and add the live checks to the next-steps list.
- README: one paragraph and the `/cw open` command.
- Remove this spec's "Status" line once it is built, or fold the file into SPEC F14 and delete it, whichever leaves one source of truth. Preferred: fold and delete.
- Trim anything in HANDOFF that the merged PRs (#41–#43) made stale.

## 10. Out of scope (v1)

- $ estimates for F2, F13 and handoff.
- Reading transcripts over 4 MiB.
- A live server, or publishing anywhere off the machine.
- A config option for the refresh interval.
