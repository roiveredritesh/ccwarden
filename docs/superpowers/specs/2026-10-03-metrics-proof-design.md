# F15: metrics log and holdout proof (design)

Status: draft for review, 2026-10-03. Builds on F14 (`/cw open`, SPEC §4 F14 "As built").

## 1. Why

The first `/cw open` showed two things. Features counted almost nothing, and the one striking measured figure (average prompt 170k → 118k) turned out to be a mix effect: projects worked on only before install. Users believe a report when they can check it. That takes two things:

- **Auditable:** every intervention leaves a raw record (what it did, the inputs, the formula), on the user's machine, in a file they can open.
- **Proven:** a controlled comparison. A share of sessions runs with the guards off, and their cost per prompt is compared with protected sessions. That gives a number a user can share.

Both are in scope: the log for each user, the holdout for a claim that holds up in public.

## 2. Out of scope

- Sending metrics anywhere (rule 4). Sharing is a file or text the user copies by hand.
- Holdout on by default. It is opt-in; a holdout session gets no protection.
- Comparing across machines or users.
- Changing what a feature does. F15 only records it, and in a holdout session turns it off.

## 3. Rules check (SPEC §2)

| Rule | How F15 keeps it |
|---|---|
| 1. No cache-breaking hooks | Uses hooks the mod already has (`turn.start`, `turn.step`, `turn.complete`, `session.end`, `agent.spawn`, `prompt.submit`, `tool.call`). No `prompt.*` / `tool.describe` / `skill.prompt`. |
| 2. Nothing added to context | The log and the comparison never reach Claude. |
| 3. Every block says why | A holdout session says so in the status line (`holdout`) for its whole length, and once in the log at start. |
| 4. No network | Local files only. Copy and download happen in the browser, from the page's own data. |
| 5. One codebase, both surfaces | Hooks tests on terminal and desktop × metered and window. |
| 6. Only documented behaviour | Unverified points go to SPEC §9 (Q20–Q23, §9 below). |

## 4. The metrics log

### Where

`<claude dir>/ccwarden/metrics/<session id>.jsonl`, one file per session. The Claude folder comes from the transcript path, as for the F14 page. `<session id>` is `$.session.id()`.

One file per session because `$.fs` has no append: a file shared by sessions would need read-modify-write, and two sessions would lose each other's events. Each session owns its file, so nothing races.

### When it is written

Events are buffered in memory (module runtime) and the session's file is rewritten whole (`$.fs.write`) at `turn.complete` and `session.end`, when the buffer holds anything new. A write failure is logged once per session and the buffer kept for the next flush. The file holds the session's events in order and, as its last line, the current session record (§4.4). On reload mid-session, the module reads its own file back before the first flush, so nothing written is lost.

Size: one event is ~250 bytes. A session over ~3.5 MiB stops adding events (the record still updates) and says so in the record (`truncated: true`), so a write never passes 4 MiB.

Retention: files older than 400 days are skipped by the dashboard. The plugin API has no delete, so they stay on disk (as with F4's output files; SPEC "Not built").

### Event schema (v1)

```json
{"v":1,"at":1790935075168,"feature":"subagent","action":"pinned","model":"claude-opus-5-5",
 "measured":{"requested":"opus","pinned":"haiku","agentId":"a6059e","tokens":48210,"usd":0.031},
 "est":{"tokens":48210,"usd":0.21,"formula":"subagent tokens × (price opus − price haiku)","confidence":"high"}}
```

- `v`: schema version. A reader skips lines with an unknown `v` and counts them.
- `feature`, `action`: see §5. `action` is `would` for any event in a holdout session or in observe mode.
- `model`: the main model when the event happened.
- `measured`: inputs read from the engine. Never estimated.
- `est`: the saving, its formula as text, and a confidence (`high`, `medium`, `low`, `count only`). Absent when the saving is not known yet; a later `outcome` event for the same `ref` fills it.
- `ref` (optional): links an outcome to its event (an F2 ask to the user's choice, a subagent pin to its finished usage).

Session id and project are not repeated on each line: they are in the file name and the session record.

### The session record

The file's last line, rewritten at every flush:

```json
{"v":1,"record":"session","session":"…","project":"d:/new folder/ccwarden","startedAt":…,"lastAt":…,
 "measuring":true,"holdout":false,"family":"opus","prompts":14,"requests":61,"tokens":{"input":…,"read":…,"write":…,"output":…},
 "usd":3.42,"subagentUsd":0.31,"events":9,"truncated":false}
```

- `prompts`: user turns (turns whose prompt is not a queued background source; the `turn.start` logic F8 already has).
- `requests`, `tokens`, `usd`: from `turn.step` usage, main loop and subagents, priced with `src/prices.ts` at list price. Own pricing, not `$.session.usage().cost`, so metered and window machines report the same unit.
- `measuring`: `measureHoldout` was on when the session started. `holdout` is only ever true when `measuring` is.
- `family`: the main loop's model family with the most requests in the session.
- `/clear` ends the record (SPEC §4: `/clear` raises `session.end` with no `session.start` after). The next conversation gets its own file under its own session id; if the id does not change on `/clear` (Q22), the file gets a second record with `"part": 2` and the comparison treats each part as a session.

## 5. What each feature records

| Feature | Event (`feature` / `action`) | `measured` | `est` (formula) | Confidence |
|---|---|---|---|---|
| F5 subagent guard | `subagent` / `pinned`, `capped`, `denied` | requested and pinned model, report cap; at the subagent's end (`outcome`), its tokens and $ from `turn.step` steps with its `agentId` | `tokens × (price(requested or parent) − price(haiku))` per token kind; `denied`: count only | high (pinned), count only (denied) |
| F2 cold guard | `cold` / `asked`, then `outcome` with the choice | context tokens, minutes cold, `rebuildUsd` at ask time | Cancel or Handoff: `rebuildUsd`; Send: 0 | medium (the user may send later anyway) |
| F13 Clear | `topic` / `cleared` | context tokens dropped | `dropped × read price × requests in the next conversation`, counted live until it ends | medium |
| F4 junk guard | `junk` / `kept-out` (`enforce`), `would` (`observe`) | tool, size, chars kept out | F14 formula: `tokens × (write5m + read × requestsAfter)`, `requestsAfter` counted live | medium |
| F3 snapshot | `snapshot` / `answered` | context tokens, model | F14 formula: `context × read + 2000 × output` | low |
| F6 keep-warm | `keepwarm` / `ping` | ping cost, cache size kept | F14: rebuild avoided − ping spent | high |
| F3 limits | `limit` / `compact-hint` | context, model limit | count only | count only |
| Handoff | `handoff` / `written` | route (quick, full) | count only | count only |

`projectDays` stays as it is: the F14 page keeps working for days before F15, and its counters are cheap. The F15 page reads the log first and falls back to `projectDays` for days with no log.

## 6. The holdout

### Turning it on

New `userConfig` field `measureHoldout` (boolean, default `false`), described in `/config` as: "Proof mode: about 1 in 10 new sessions run with ccwarden's guards off, to measure what it saves. Those sessions get no protection."

### Which sessions

A session is a holdout when `measureHoldout` is on and `hash(session id) mod 10 = 0`: FNV-1a over the id's UTF-8 bytes. The choice is deterministic, so anyone can check which sessions were holdouts from the ids alone, and a reload never changes it. It is decided at `session.start` (or the first event of a module that loaded mid-session) and kept in `$.state`.

### What a holdout session does

Guards off, display on: the engine's own behaviour, with ccwarden watching.

| Off (logged as `would`) | Still on |
|---|---|
| F2 cold ask, F13 topic hint, F4 junk guard (forced to observe), F5 pin, cap and parallel limit, F3 snapshot (the engine summarises), F3 per-model limit hints and the auto-compact window set by #27, F6 keep-warm | F1 status line (shows `holdout`), F1b spend alerts, F7 handoff when the user asks, `/cw`, the metrics log |

Spend alerts stay on: they are information, and turning them off would risk a surprise bill in a session that is already unprotected.

## 7. The comparison

Pure, in `src/proof.ts`, from session records.

- **Unit:** one session (or `part`). **Metric:** $ per user prompt, list price. Tokens per prompt shown alongside. Per request is wrong here: guards change how many requests there are.
- **Eligible:** at least 5 prompts; `measuring` is true (protected sessions from before the user turned `measureHoldout` on are left out, so both groups come from the same weeks); only projects used with ccwarden (F14 rule).
- **Stratified by `family`:** within each family, the ratio of medians `protected / holdout`. The overall figure weights the families by the protected sessions' mix. A family with fewer than 3 holdout sessions is left out and named.
- **Uncertainty:** 90% interval of the overall ratio by bootstrap, 2000 resamples within each family, PRNG seeded from the session ids, so the page shows the same figure on every refresh until a session is added.
- **When a claim is made:**

| Data | The page says |
|---|---|
| Fewer than 10 holdout or 30 protected eligible sessions | "Proof: 6 of 10 holdout sessions" with a progress bar. No figure. |
| Interval entirely below 1 | "Protected sessions cost **23% less per prompt** (90% range 12–31%; 14 holdout vs 126 protected; Opus, Sonnet)." |
| Interval contains 1 | "No clear difference yet (90% range −8% to +19%)." |
| Interval entirely above 1 | "Protected sessions cost **9% more per prompt** (…)": shown, not hidden. |

- **Self-check:** next to the proof, the estimate as a share of protected spend in the same sessions ("estimated 30%, measured 23%"). When the estimate is outside the measured interval, the page says the formulas look optimistic (or pessimistic).

## 8. The page

Changes to `src/htmlDashboard.ts`, still one self-contained file (no URL, everything escaped).

1. **Verdict line** at the top, one sentence: what was saved (est.) and whether it is proven. For example "This month ccwarden saved ~2.1M tokens (~$9.40 est.). Proven by holdout: 23% cheaper per prompt." or "… Not proven yet: 3 of 10 holdout sessions (turn on measureHoldout in /config)."
2. **Proof section:** dot-and-interval chart (holdout vs protected median $ per prompt, with the 90% range), the counts, the self-check.
3. **Savings by feature** as a horizontal bar chart (tokens, est.); the table with formula and confidence goes under "How it's computed" (`<details>`).
4. **What ccwarden did:** events per day stacked by feature.
5. **Sessions:** date, project, model, holdout, prompts, $ per prompt, saved; a click shows that session's events.
6. **Event viewer:** the latest 100 events with a feature filter, and the metrics folder's path.
7. **Copy summary:** a short Markdown summary (verdict, proof, top savings, coverage) to the clipboard, with a select-the-text fallback when the clipboard is refused.
8. **Download raw JSON:** the page's embedded data (session records and the last 30 days of events) saved as a file from a Blob. No network.
9. **Tooltips** on every chart mark (an HTML tooltip on hover and focus), replacing `<title>`.

Page size: events embedded are capped at the last 30 days and 5,000 events; past that the page says how many were left out and the files still have them.

## 9. Modules and data flow

| Unit | Kind | Does |
|---|---|---|
| `src/metrics.ts` | pure | event and record types, `serialize`/`parse` (skips and counts bad lines), `applyStep` (adds a `turn.step` usage to the record), the per-feature `est` formulas, `isHoldout(sessionId)` |
| `src/proof.ts` | pure | eligibility, stratified ratio, seeded bootstrap, the claim text |
| `src/efficiency.ts` | pure | takes session records and events as more input; feature rows from events, falling back to `projectDays` |
| `src/htmlDashboard.ts` | pure | §8 |
| `hooks/register.tsx` | hooks | the buffer and flushes, one `record(...)` call at each feature's decision point, the holdout switch in each guard, reading the files for the page |

Reading for the page: `metrics/` is listed, files modified in the range are parsed, and each file's session record is cached in `$.store` `metricsSessions` (session id → record, ~200 bytes each; keyed by mtime and size like `transcriptSummaries`). Events are read only for the page's 30-day window.

## 10. Testing

- **Pure:** schema round trip; bad and unknown-version lines skipped and counted; each formula in §5 against a hand-worked case; `isHoldout` stable for a fixed id list (and about 10% over 10,000 ids); the comparison on fixtures for each row of the §7 table; the bootstrap gives the same interval twice; a family with too few holdouts is left out and named.
- **Hooks (terminal and desktop × metered and window):** each feature writes its event at its decision point; a holdout session asks nothing, pins nothing, compacts with the engine summary, shows `holdout` in the status, and logs `would` events; flush at `turn.complete` and `session.end`; a reload reads the file back and loses nothing; `/clear` ends the record; a write failure logs once and keeps the buffer.
- **Page:** verdict for each claim state; the page has no URL and one script; copy and download work from embedded data; no NaN or Infinity on an empty machine.

## 11. Open questions (to SPEC §9)

| # | Question | Why it matters |
|---|---|---|
| 20 | Does `turn.step` fire with `usage` for subagent steps (`agentId` set)? The mod's F1 hook already filters on `agentId`, which suggests it does. | F5's measured saving and the session's subagent $ |
| 21 | Does `$.fs.write` create a missing parent folder (`metrics/`)? | If not, the first write fails; fallback: write next to the dashboard page |
| 22 | Does `/clear` give the next conversation a new `$.session.id()`? | One file per conversation, or `part` records |
| 23 | Does `navigator.clipboard.writeText` work on a `file://` page in Chrome, Edge and Safari? | Copy summary; the fallback selects the text |

## 12. Build order (M5)

Each a branch and a PR, tests on both surfaces × both billing modes.

1. **F15-T1 log:** `src/metrics.ts`, the buffer and flush, the session record, F5 and F2 events (the two features with no saving recorded today).
2. **F15-T2 the rest of the events:** F13, F4, F3, F6, limits, handoff; the page's feature rows read the log.
3. **F15-T3 holdout:** `measureHoldout`, `isHoldout`, the guard switches, the status marker.
4. **F15-T4 proof:** `src/proof.ts` and the proof section.
5. **F15-T5 page:** verdict line, charts, sessions, event viewer, copy and download, tooltips.
6. **Docs:** SPEC F15 "As built", §5 config, §6 state keys, §9; HANDOFF; README.
