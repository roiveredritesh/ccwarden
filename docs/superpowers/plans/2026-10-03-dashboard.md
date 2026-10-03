# F14 Efficiency Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/cw open` writes one self-contained HTML page (`~/.claude/ccwarden/dashboard.html`) that shows what ccwarden saved (est.), a measured before/after from the transcripts, and per-project spend, and opens it in the browser.

**Architecture:** Live figures go to a new `$.store` key `projectDays`, junk events gain optional `project`/`session`. A page build reads every transcript (≤ 4 MiB) once, caches a per-day summary in `transcriptSummaries`, aggregates everything in pure `src/efficiency.ts`, and renders HTML in pure `src/htmlDashboard.ts`. `hooks/register.tsx` holds only the `$` calls: recording, `/cw open`, the 5-minute timer, the session-end rewrite, the file write and the opener.

**Tech Stack:** TypeScript in the Claude Code mod runtime (no Node, no `require`), `claude-code/testing` kit, `claude plugin test mod`.

**Spec:** `docs/superpowers/specs/2026-10-03-dashboard-design.md`

## Global Constraints

- No existing store key changes shape: `ledger`, `hogDays`, `junkLog`, `topicLog`, `handoffsOffered`, `budgetSwitch`. New data goes in new keys (`projectDays`, `transcriptSummaries`, `dashboardOpened`); `JunkEvent` gains only optional fields.
- `/cw`, `/cw spent`, `/cw budget …`, the pane, month tracking and budget mode behave exactly as before.
- The existing suite (206 tests at `ec2bd9b`) passes. Existing test bodies are not edited; the only change to `tests/hooks.test.ts` outside new `describe` blocks is the additive harness change in Task 6.
- Never hook `prompt.compose`, `prompt.context`, `tool.describe` or `skill.prompt`. Nothing is added to Claude's context.
- No network: the page loads nothing external (no `http://`/`https://` anywhere in it).
- One codebase for `terminal` and `desktop`; every hook test runs on both surfaces.
- Every `$` call lives in `mod/hooks/register.tsx`; `mod/src/` is pure; `$.env.get` takes string literals only.
- Code, comments, commits and docs in English.
- Run all tests with `claude plugin test mod` from the repo root (it has no per-file filter); validate with `claude plugin validate mod`.

## Spec clarifications (decided while planning; the reviewer should confirm)

1. **`requestsAfter` comes from the transcript, not from turns.** `$.session.id()` is documented as the transcript file's name, so a junk event's `session` finds its transcript; the summary counts the main-loop API requests after the event up to the next compaction. This is exact (requests, not turns) and needs no per-session store key. So `JunkEvent` gains `project?` and `session?` only, no `turn`.
2. **`transcriptSummaries` is keyed by path**, each entry holding `mtimeMs`, `size` and the junk-event count it was priced with. Same invalidation as `path|mtimeMs|size`, and it lets the session-end rewrite reuse the last summary without parsing.
3. **`projectDays` has a few more fields** than spec §4.1 lists: `keepWarmPings`, `keepWarmSavedTokens`, `snapshotSavedUsd`, `snapshotSavedTokens`. Snapshot savings are priced when the snapshot happens, because the model and context size are known then.
4. **Store types live in `src/efficiency.ts`**, like `Ledger` and `HogDays` in `src/`. `types/index.d.ts` declares only `$.state` and stays as it is.
5. **New pure tests go in a new `mod/tests/efficiency.test.ts`**, so `pure.test.ts` stays untouched.
6. **At session end no transcript is parsed** (the exit has one short bound). The page is rebuilt from cached summaries, and only when at least 1.5 s of the bound is left.
7. **"Top context hog" per project** is the biggest file hog whose path is under the project (`hogDays` has no project and keeps 31 days). Bash and Grep hogs aren't attributed.
8. **Windows opener argv** is `['cmd', '/c', 'start', '', path]`: argv, no shell, with an empty window title. macOS or Linux is decided by `uname -s`.
9. **The Claude folder** comes from the transcript path (`<dir>/projects/<slug>/<id>.jsonl`). If that isn't known, it falls back to `$HOME`/`$USERPROFILE` + `.claude`.
10. **"No http" in the page** means no URL. `<meta http-equiv="refresh">` stays, as spec §6 requires.

## Review Focus

1. **A machine with no ledger, no `projectDays` and no transcripts** (fresh install, `/cw open` at once): the page must still render, with "Nothing yet" text, no `NaN`, no `Infinity`, and no crash. Pinned in Task 5.
2. **A project path with HTML in it** (`<script>`, `&`, quotes), from a transcript's `cwd`: it must be escaped everywhere it appears (table, header, chart tooltip). Pinned in Task 5.
3. **Windows paths**: `D:\proj` from `$.session.root()` and `D:\proj` or `d:/proj` from a transcript's `cwd` must land on one project row. Pinned in Task 1 (`projectKey`) and Task 3 (`summarize`).
4. **The transcripts folder can't be listed** (missing `~/.claude/projects`, a permission error): the cache in `$.store` must not be wiped, and the page still writes. Pinned in Task 6.
5. **The existing `/cw` paths** after `/cw open` has run: same month line, the pane still opens, and `/cw spent` still calibrates. Pinned in Task 6.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `mod/src/report.ts` | Modify | `Request` gains `output` (output tokens). Nothing else changes. |
| `mod/src/junk.ts` | Modify | `JunkEvent` gains optional `project` and `session`. |
| `mod/src/efficiency.ts` | Create | Pure: `projectDays` updates, snapshot pricing, transcript summaries, the cache check, aggregation, savings formulas, actions, the opener argv. |
| `mod/src/htmlDashboard.ts` | Create | Pure: `EfficiencyData` → one HTML string, with every text escaped. |
| `mod/hooks/register.tsx` | Modify | Recording into `projectDays`, tagging junk events, `/cw open`, the timer, the session-end rewrite, reading transcripts, the file write, the opener. |
| `mod/tests/efficiency.test.ts` | Create | Pure tests for both new `src/` files. |
| `mod/tests/hooks.test.ts` | Modify | Additive harness change (`process.run` records argv and answers `uname` and openers; `fs.list` lists subfolders), plus a new `describe('F14 …')` block. |
| `docs/SPEC.md`, `docs/HANDOFF.md`, `README.md` | Modify | Docs cleanup (Task 7). |
| `docs/superpowers/specs/2026-10-03-dashboard-design.md` | Delete | Folded into SPEC F14 (Task 7). |

---

### Task 1: `projectDays` and snapshot pricing (pure)

**Files:**
- Create: `mod/src/efficiency.ts`
- Modify: `mod/src/report.ts` (types `UsageEntry`, `Request`, function `requestsOf`)
- Modify: `mod/src/junk.ts` (type `JunkEvent`)
- Test: `mod/tests/efficiency.test.ts` (new)

**Interfaces:**
- Consumes: `dayKey` (`src/ledger.ts`), `slashed` (`src/paths.ts`), `familyOf`, `PRICES` (`src/prices.ts`).
- Produces:
  - `type DayFigures = { usd?, turns?, peakContext?, keepWarmPings?, keepWarmSavedUsd?, keepWarmSavedTokens?, keepWarmSpentUsd?, snapshots?, snapshotSavedUsd?, snapshotSavedTokens?, coldAsks?, topicClears?, handoffs?: number }`
  - `type ProjectDays = Record<string, Record<string, DayFigures>>`
  - `projectKey(path: string): string`
  - `addProjectDay(pd: ProjectDays | undefined, project: string, day: string, add: DayFigures): ProjectDays`
  - `snapshotSaving(tokens: number, model: string): { usd: number; tokens: number } | undefined`
  - constants `PROJECT_DAYS_KEEP = 400`, `UNATTRIBUTED = 'unattributed'`, `SUMMARY_OUTPUT_TOKENS = 2_000`
  - `Request.output: number`; `JunkEvent.project?: string`, `JunkEvent.session?: string`

- [ ] **Step 1: Write the failing tests**

Create `mod/tests/efficiency.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'
import { addProjectDay, projectKey, snapshotSaving } from '../src/efficiency'
import { requestsOf } from '../src/report'

// Floating sums compared to 4 decimals (the kit has no toBeCloseTo).
const r4 = (n: number) => Math.round(n * 1e4) / 1e4

describe('F14 projectDays', () => {
  test('a project path files under one key: slashes, no trailing slash, drive letter lower-cased', () => {
    expect(projectKey('D:\\work\\app\\')).toBe('d:/work/app')
    expect(projectKey('d:/work/app')).toBe('d:/work/app')
    expect(projectKey('/home/u/app/')).toBe('/home/u/app')
  })

  test('sums per project and day, keeps the peak context, drops days over 400 old', () => {
    let pd = addProjectDay(undefined, 'D:\\work\\app\\', '2026-10-01', { usd: 1.5, turns: 1, peakContext: 50_000 })
    pd = addProjectDay(pd, 'd:/work/app', '2026-10-01', { usd: 0.25, turns: 1, peakContext: 20_000 })
    expect(pd).toEqual({ 'd:/work/app': { '2026-10-01': { usd: 1.75, turns: 2, peakContext: 50_000 } } })
    // 2027-11-10 is 405 days on: the old day goes, and the project with it.
    pd = addProjectDay(pd, '/other', '2027-11-10', { handoffs: 1 })
    expect(pd).toEqual({ '/other': { '2027-11-10': { handoffs: 1 } } })
  })

  test('a snapshot saves the summary request: context read from the cache plus its output', () => {
    const s = snapshotSaving(100_000, 'claude-sonnet-5-5')!
    expect(r4(s.usd)).toBe(0.04) // (100k × $0.20 + 2k × $10) / 1M
    expect(s.tokens).toBe(102_000)
    expect(snapshotSaving(100_000, 'some-other-model')).toBeUndefined()
  })

  test('requestsOf counts output tokens', () => {
    const entry = { type: 'assistant', timestamp: '2026-10-01T10:00:00Z', message: { id: 'a', model: 'm', usage: { input_tokens: 1, output_tokens: 700 } } }
    expect(requestsOf([entry] as never)[0]!.output).toBe(700)
  })
})
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `claude plugin test mod`
Expected: `efficiency.test.ts` fails to load (`../src/efficiency` not found). The other 206 tests pass.

- [ ] **Step 3: Implement**

In `mod/src/report.ts`, add `output_tokens` to the usage type, add `output` to `Request`, and set it in `requestsOf`:

```ts
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
```

```ts
export type Request = { ts: number; model?: string; input: number; output: number; read: number; write: number; write5m: number; write1h: number; afterCompact: boolean }
```

```ts
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      read: u.cache_read_input_tokens ?? 0,
```

In `mod/src/junk.ts`, add these two optional fields to the end of `JunkEvent`:

```ts
  /** Characters kept out of the context (est. for a denied Read: the file's). */
  savedChars: number
  /** The project (its `projectKey`) and session (the transcript's name) it happened in (F14); absent on events from before. */
  project?: string
  session?: string
}
```

Create `mod/src/efficiency.ts`:

```ts
import { dayKey } from './ledger'
import { slashed } from './paths'
import { familyOf, PRICES } from './prices'

// F14 efficiency dashboard: what ccwarden saved (est.), and a measured
// before/after from the transcripts, for every project on this machine.
// Live figures go to `projectDays` in $.store; each transcript's summary is
// cached in `transcriptSummaries`. Pure: hooks/register.tsx records, reads
// the transcripts and writes the page (drawn by src/htmlDashboard.ts).

export const PROJECT_DAYS_KEEP = 400
/** Where spend and events with no project are filed. */
export const UNATTRIBUTED = 'unattributed'
/** What a summary compaction would have written; shown on the page. */
export const SUMMARY_OUTPUT_TOKENS = 2_000
const DAY_MS = 86_400_000

/** One project's figures for one UTC day, recorded live. A day has only what happened. */
export type DayFigures = {
  usd?: number
  turns?: number
  peakContext?: number
  keepWarmPings?: number
  keepWarmSavedUsd?: number
  keepWarmSavedTokens?: number
  keepWarmSpentUsd?: number
  snapshots?: number
  snapshotSavedUsd?: number
  snapshotSavedTokens?: number
  coldAsks?: number
  topicClears?: number
  handoffs?: number
}

/** `projectDays` in $.store: project (its `projectKey`) → `YYYY-MM-DD` → figures. */
export type ProjectDays = Record<string, Record<string, DayFigures>>

/** The key a project path is filed under: `/`-separated, no trailing slash, a drive letter lower-cased. */
export function projectKey(path: string): string {
  return slashed(path).replace(/\/+$/, '').replace(/^[A-Z]:/, d => d.toLowerCase())
}

/** `pd` with `add` counted into `project`'s `day` (peakContext keeps the max); days more than PROJECT_DAYS_KEEP before `day` dropped. */
export function addProjectDay(pd: ProjectDays | undefined, project: string, day: string, add: DayFigures): ProjectDays {
  const key = projectKey(project)
  const cur: DayFigures = { ...(pd?.[key]?.[day] ?? {}) }
  for (const [k, v] of Object.entries(add) as [keyof DayFigures, number][]) {
    cur[k] = k === 'peakContext' ? Math.max(cur[k] ?? 0, v) : round4((cur[k] ?? 0) + v)
  }
  const cutoff = dayKey(Date.parse(day) - PROJECT_DAYS_KEEP * DAY_MS)
  const next: ProjectDays = {}
  for (const [p, days] of Object.entries({ ...(pd ?? {}), [key]: { ...(pd?.[key] ?? {}), [day]: cur } })) {
    const kept = Object.entries(days).filter(([d]) => d > cutoff)
    if (kept.length > 0) next[p] = Object.fromEntries(kept)
  }
  return next
}

/** What a snapshot saved (est.): the summary request's cached read of the context, and its output. */
export function snapshotSaving(tokens: number, model: string): { usd: number; tokens: number } | undefined {
  const family = familyOf(model)
  if (family === undefined) return undefined
  const p = PRICES[family]
  return { usd: (tokens * p.read + SUMMARY_OUTPUT_TOKENS * p.output) / 1e6, tokens: tokens + SUMMARY_OUTPUT_TOKENS }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `claude plugin test mod`
Expected: 210 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add mod/src/efficiency.ts mod/src/report.ts mod/src/junk.ts mod/tests/efficiency.test.ts
git commit -m "F14: projectDays updates, snapshot pricing, output tokens"
```

---

### Task 2: Record live figures in the hooks

**Files:**
- Modify: `mod/hooks/register.tsx` (imports; hooks `session.measure`, `prompt.submit`, `turn.complete`, `session.compact`; functions `topicHint`, `recordSpend` neighbourhood, `writeHandoff`, `recordJunk`, `keepWarmTick`)
- Test: `mod/tests/hooks.test.ts` (append a new `describe` at the end of the file)

**Interfaces:**
- Consumes: `addProjectDay`, `projectKey`, `snapshotSaving`, `DayFigures`, `ProjectDays` (Task 1); `dayKey` (already imported).
- Produces: store key `projectDays` (`ProjectDays`), filled live; `junkLog` events tagged with `project` and `session`; helper `recordProject($, add: DayFigures): Promise<void>` in `register.tsx`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `mod/tests/hooks.test.ts`:

```ts
describe('F14 efficiency dashboard: live figures', () => {
  const DAY = Date.parse('2026-10-03T10:00:00Z')
  const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
  const today = (w: World) => (w.store.get('projectDays') as Record<string, Record<string, Record<string, number>>> | undefined)?.['/p']?.['2026-10-03']

  for (const surface of SURFACES) {
    test(`spend goes to projectDays under the project, and to the ledger as before (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], usage: { tokens: 30_000 } })
      await w.clock.advance(DAY)
      await $.session.start(start(surface))
      w.usage.usd = 1.5
      await $.session.measure(measure(w))
      await $.turn.complete(turnDone())
      expect((w.store.get('ledger') as { days: Record<string, number> }).days).toEqual({ '2026-10-03': 1.5 })
      expect(today(w)).toEqual({ usd: 1.5, turns: 1, peakContext: 30_000 })
    })

    test(`a cold-cache ask and a handoff are counted (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], answer: 'Cancel', usage: { tokens: 180_000 } })
      await w.clock.advance(DAY)
      await $.session.start(start(surface))
      await $.turn.complete(turnDone())
      await w.clock.advance(17 * MIN)
      await $.prompt.submit(typed('continue with the refactor'))
      await $.command.run({ command: 'handoff', args: 'quick', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
      expect(today(w)).toMatchObject({ coldAsks: 1, handoffs: 1 })
    })
  }

  test('a snapshot compaction records what a summary would have cost', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 100_000 } })
    await w.clock.advance(DAY)
    await $.session.start(start('terminal'))
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'Ship it', toolUses: [] }] })
    expect(today(w)).toMatchObject({ snapshots: 1, snapshotSavedTokens: 102_000 })
    expect(Math.round(today(w)!.snapshotSavedUsd! * 1e4) / 1e4).toBe(0.04)
  })

  test('junk events carry the project and the session', { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
    const LONG = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join('\n')
    const w = world(on, { surfaces: ['terminal'], files: { '/p/big.log': LONG } })
    await $.session.start(start('terminal'))
    await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })
    expect((w.store.get('junkLog') as Record<string, unknown>[])[0]).toMatchObject({ tool: 'Read', project: '/p', session: 'sess1' })
  })
})
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `claude plugin test mod`
Expected: the 4 new tests fail (`projectDays` is undefined; the junk event has no `project`). All earlier tests pass.

- [ ] **Step 3: Implement**

In `mod/hooks/register.tsx`, add imports next to the others:

```ts
import { addProjectDay, projectKey, snapshotSaving } from '../src/efficiency'
import type { DayFigures, ProjectDays } from '../src/efficiency'
```

Add the store key to the constants block (after `TOPIC_LOG_KEY`):

```ts
const PROJECT_DAYS_KEY = 'projectDays' // $.store: per project and day, spend and what each guard did (F14)
```

Add the helper right after `recordSpend`:

```ts
/** F14: adds `add` to today's line for this session's project in `projectDays`. */
async function recordProject($: $, add: DayFigures): Promise<void> {
  const day = dayKey(await $.clock.now())
  const pd = (await $.store.get(PROJECT_DAYS_KEY)) as ProjectDays | undefined
  await $.store.set(PROJECT_DAYS_KEY, addProjectDay(pd, await $.session.root(), day, add))
}
```

`session.measure`: replace

```ts
    if (spent > 0) await trackMonth($, config, await recordSpend($, spent))
```

with

```ts
    if (spent > 0) {
      await trackMonth($, config, await recordSpend($, spent))
      await recordProject($, { usd: spent })
    }
```

`prompt.submit`, keep-warm: replace

```ts
    if (saved > 0) await refreshStatus($, config, conv)
```

with

```ts
    if (saved > 0) {
      await recordProject($, { keepWarmSavedUsd: saved, keepWarmSavedTokens: tokens ?? 0 })
      await refreshStatus($, config, conv)
    }
```

`prompt.submit`, cold ask: right after

```ts
    await update($, conversation, prev => ({ ...(prev ?? { alerted: 0 }), coldAskedFor: conv.lastResponseAt }))
```

add

```ts
    await recordProject($, { coldAsks: 1 })
```

`turn.complete` (main loop, F3 part): right after `const tokens = usage.context.tokens ?? 0` add

```ts
    await recordProject($, { turns: 1, peakContext: tokens })
```

`session.compact`, snapshot branch: right after

```ts
    const text = snapshotText(facts, { cwd: await $.session.cwd(), keptTurns: turns })
```

add

```ts
    const saving = snapshotSaving(usage.context.tokens ?? 0, await $.session.model())
    await recordProject($, { snapshots: 1, ...(saving === undefined ? {} : { snapshotSavedUsd: saving.usd, snapshotSavedTokens: saving.tokens }) })
```

`topicHint`: right after `const isCleared = choice !== 'keep'` add

```ts
  if (isCleared) await recordProject($, { topicClears: 1 })
```

`writeHandoff`: right before `return written ? path : undefined` add

```ts
  if (written) await recordProject($, { handoffs: 1 })
```

`keepWarmTick`: right before the `$.ui.log(\`ccwarden keep-warm: ping read …` line add

```ts
  await recordProject($, { keepWarmPings: 1, keepWarmSpentUsd: spent })
```

`recordJunk`: replace its body's first line so the event is tagged:

```ts
async function recordJunk($: $, event: JunkEvent): Promise<void> {
  const tagged: JunkEvent = { ...event, project: projectKey(await $.session.root()), session: await $.session.id() }
  await $.store.set(JUNK_LOG_KEY, appendJunk((await $.store.get(JUNK_LOG_KEY)) as JunkEvent[] | undefined, tagged))
  $.ui.log(`ccwarden junk guard (${event.mode}): ${event.tool} ${event.target}`, { to: 'debug' })
}
```

- [ ] **Step 4: Run tests and validate**

Run: `claude plugin test mod` and then `claude plugin validate mod`
Expected: 216 pass, 0 fail (206 existing + 4 from Task 1 + 6 here). Validate passes.

- [ ] **Step 5: Commit**

```bash
git add mod/hooks/register.tsx mod/tests/hooks.test.ts
git commit -m "F14: record spend and guard outcomes per project and day"
```

---

### Task 3: Transcript summaries, cache check, paths and opener (pure)

**Files:**
- Modify: `mod/src/efficiency.ts`
- Test: `mod/tests/efficiency.test.ts`

**Interfaces:**
- Consumes: `requestsOf`, `analyze`, `Request` (`src/report.ts`, with `output` from Task 1); `TranscriptEntry` (`src/transcript.ts`); `JunkEvent` (`src/junk.ts`); `Family` (`src/prices.ts`).
- Produces:
  - `type DayUsage = { requests: number; input: number; read: number; write: number; output: number; usd: number; rebuilds: number; context: number }`
  - `type JunkPrice = { at: number; requestsAfter: number; family?: Family }`
  - `type TranscriptSummary = { project?: string; days: Record<string, DayUsage>; junk: JunkPrice[] }`
  - `type SummaryEntry = { mtimeMs: number; size: number; junk: number; summary: TranscriptSummary }`, `type SummaryCache = Record<string, SummaryEntry>`
  - `summarize(entries: readonly TranscriptEntry[], junkAt?: readonly number[]): TranscriptSummary`
  - `isFresh(entry: SummaryEntry, file: { mtimeMs: number; size: number }, junk: number): boolean`
  - `junkTimesBySession(log: readonly JunkEvent[]): Record<string, number[]>`
  - `sessionOf(path: string): string`
  - `claudeDirOf(transcript: string | undefined): string | undefined`
  - `type HostOs = 'windows' | 'mac' | 'linux'`, `openerArgv(os: HostOs, path: string): string[]`

- [ ] **Step 1: Write the failing tests**

Change the efficiency import at the top of `mod/tests/efficiency.test.ts` to:

```ts
import { addProjectDay, claudeDirOf, isFresh, junkTimesBySession, openerArgv, projectKey, sessionOf, snapshotSaving, summarize } from '../src/efficiency'
```

Append:

```ts
describe('F14 transcript summaries', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z')
  const row = (id: string, min: number, u: Record<string, number>) => ({
    type: 'assistant', cwd: 'D:\\p\\', timestamp: new Date(T0 + min * 60_000).toISOString(),
    message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u } },
  })
  const entries = [
    row('a', 0, { cache_creation_input_tokens: 40_000, output_tokens: 1_000 }),
    row('b', 1, { cache_read_input_tokens: 40_000, cache_creation_input_tokens: 10_000 }), // writes the junk result
    row('c', 2, { cache_read_input_tokens: 50_000 }),
    row('d', 3, { cache_read_input_tokens: 50_000 }),
    { type: 'system', subtype: 'compact_boundary' },
    row('e', 4, { cache_creation_input_tokens: 15_000 }),
  ]

  test('by day: requests, tokens, $ at list price, rebuilds, context; the project from cwd', () => {
    const s = summarize(entries as never)
    const day = s.days['2026-10-01']!
    expect(s.project).toBe('d:/p')
    expect({ ...day, usd: 0 }).toEqual({ requests: 5, input: 0, read: 140_000, write: 65_000, output: 1_000, usd: 0, rebuilds: 1, context: 205_000 })
    expect(r4(day.usd)).toBe(0.2005) // 65k × $2.50 + 140k × $0.20 + 1k × $10, per million
    expect(s.junk).toEqual([])
  })

  test('a junk event: the requests that re-read it, up to the next compaction', () => {
    const s = summarize(entries as never, [T0 + 30_000, T0 + 10 * 60_000])
    // b writes it, c and d read it, e comes after a compaction.
    expect(s.junk[0]).toEqual({ at: T0 + 30_000, requestsAfter: 2, family: 'sonnet' })
    // Nothing after it: counted, never priced.
    expect(s.junk[1]).toEqual({ at: T0 + 10 * 60_000, requestsAfter: 0 })
  })

  test('the cache: fresh only while mtime, size and the junk count all match', () => {
    const entry = { mtimeMs: 5, size: 100, junk: 1, summary: { days: {}, junk: [] } }
    expect(isFresh(entry, { mtimeMs: 5, size: 100 }, 1)).toBe(true)
    expect(isFresh(entry, { mtimeMs: 6, size: 100 }, 1)).toBe(false)
    expect(isFresh(entry, { mtimeMs: 5, size: 101 }, 1)).toBe(false)
    expect(isFresh(entry, { mtimeMs: 5, size: 100 }, 2)).toBe(false)
  })

  test('junk times by session; events from before F14 have none', () => {
    const ev = (at: number, session?: string) => ({ at, tool: 'Read' as const, mode: 'enforce' as const, target: 'x', size: 1, savedChars: 4, ...(session === undefined ? {} : { session }) })
    expect(junkTimesBySession([ev(1, 's1'), ev(2), ev(3, 's1'), ev(4, 's2')])).toEqual({ s1: [1, 3], s2: [4] })
    expect(sessionOf('C:\\Users\\u\\.claude\\projects\\C--p\\abc.jsonl')).toBe('abc')
  })

  test('the Claude folder from a transcript path, either separator', () => {
    expect(claudeDirOf('/home/u/.claude/projects/-p/s1.jsonl')).toBe('/home/u/.claude')
    expect(claudeDirOf('C:\\Users\\u\\.claude\\projects\\C--p\\s1.jsonl')).toBe('C:\\Users\\u\\.claude')
    expect(claudeDirOf('/tmp/s1.jsonl')).toBeUndefined()
    expect(claudeDirOf(undefined)).toBeUndefined()
  })

  test('the opener per OS, argv with no shell', () => {
    expect(openerArgv('windows', 'C:\\u\\d.html')).toEqual(['cmd', '/c', 'start', '', 'C:\\u\\d.html'])
    expect(openerArgv('mac', '/u/d.html')).toEqual(['open', '/u/d.html'])
    expect(openerArgv('linux', '/u/d.html')).toEqual(['xdg-open', '/u/d.html'])
  })
})
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `claude plugin test mod`
Expected: `efficiency.test.ts` fails (no export `summarize` and the others).

- [ ] **Step 3: Implement**

At the top of `mod/src/efficiency.ts`, replace the imports with:

```ts
import type { JunkEvent } from './junk'
import { dayKey } from './ledger'
import { slashed } from './paths'
import { familyOf, PRICES } from './prices'
import type { Family } from './prices'
import { analyze, requestsOf } from './report'
import type { Request } from './report'
import type { TranscriptEntry } from './transcript'
```

Then append to `mod/src/efficiency.ts` (above `round4`):

```ts
/** One transcript's main-loop usage on one UTC day; `context` sums each request's prompt size. */
export type DayUsage = { requests: number; input: number; read: number; write: number; output: number; usd: number; rebuilds: number; context: number }
/** A junk event's price inputs: the requests that re-read its output, and the model family then. No family: not priced. */
export type JunkPrice = { at: number; requestsAfter: number; family?: Family }
export type TranscriptSummary = { project?: string; days: Record<string, DayUsage>; junk: JunkPrice[] }
/** `transcriptSummaries` in $.store: transcript path → its summary, and the file and junk count it was made from. */
export type SummaryEntry = { mtimeMs: number; size: number; junk: number; summary: TranscriptSummary }
export type SummaryCache = Record<string, SummaryEntry>

/**
 * One transcript by day (requests, tokens, $ at list price, rebuilds,
 * context), its project (the first `cwd`), and for each junk event at
 * `junkAt` (ms) the requests that re-read its output.
 */
export function summarize(entries: readonly TranscriptEntry[], junkAt: readonly number[] = []): TranscriptSummary {
  const cwd = (entries as (TranscriptEntry & { cwd?: unknown })[]).find(e => typeof e.cwd === 'string' && e.cwd !== '')?.cwd as string | undefined
  const requests = requestsOf(entries)
  const days: Record<string, DayUsage> = {}
  const dayOf = (ts: number) => (days[dayKey(ts * 1000)] ??= { requests: 0, input: 0, read: 0, write: 0, output: 0, usd: 0, rebuilds: 0, context: 0 })
  for (const r of requests) {
    const d = dayOf(r.ts)
    d.requests++
    d.input += r.input
    d.read += r.read
    d.write += r.write
    d.output += r.output
    d.context += r.input + r.read + r.write
    d.usd += requestUsd(r)
  }
  for (const rb of analyze(requests).rebuilds) dayOf(rb.at).rebuilds++
  return { ...(cwd === undefined ? {} : { project: projectKey(cwd) }), days, junk: junkAt.map(at => junkPrice(requests, at)) }
}

function requestUsd(r: Request): number {
  const family = r.model === undefined ? undefined : familyOf(r.model)
  if (family === undefined) return 0
  const p = PRICES[family]
  return (r.input * p.input + r.write5m * p.write5m + r.write1h * p.write1h + r.read * p.read + r.output * p.output) / 1e6
}

/** The first request after `atMs` writes the output into the cache; each later one reads it, until a compaction drops it. */
function junkPrice(requests: readonly Request[], atMs: number): JunkPrice {
  const first = requests.findIndex(r => r.ts * 1000 > atMs)
  if (first === -1) return { at: atMs, requestsAfter: 0 }
  const model = requests[first]!.model
  let n = 0
  for (let i = first + 1; i < requests.length && !requests[i]!.afterCompact; i++) n++
  const family = model === undefined ? undefined : familyOf(model)
  return { at: atMs, requestsAfter: n, ...(family === undefined ? {} : { family }) }
}

/** A cached summary still holds: the file and the junk events priced in it are unchanged. */
export function isFresh(entry: SummaryEntry, file: { mtimeMs: number; size: number }, junk: number): boolean {
  return entry.mtimeMs === file.mtimeMs && entry.size === file.size && entry.junk === junk
}

/** Junk event times (ms) per session; events from before F14 have no session and are left out. */
export function junkTimesBySession(log: readonly JunkEvent[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const ev of log) if (ev.session !== undefined) (out[ev.session] ??= []).push(ev.at)
  return out
}

/** A transcript's session id: its file name without `.jsonl` (what `$.session.id()` returns). */
export function sessionOf(path: string): string {
  return (path.split(/[\\/]/).at(-1) ?? '').replace(/\.jsonl$/, '')
}

/** The Claude folder a transcript sits in (`<dir>/projects/<project>/<id>.jsonl`), else undefined. */
export function claudeDirOf(transcript: string | undefined): string | undefined {
  if (transcript === undefined) return undefined
  const parts = transcript.split(/[\\/]/)
  if (parts.length < 4 || parts.at(-3) !== 'projects') return undefined
  return transcript.slice(0, transcript.length - parts.slice(-3).join('/').length - 1)
}

export type HostOs = 'windows' | 'mac' | 'linux'

/** The command that opens `path` in the default browser; argv, no shell (`start`'s first argument is the window title). */
export function openerArgv(os: HostOs, path: string): string[] {
  if (os === 'windows') return ['cmd', '/c', 'start', '', path]
  return [os === 'mac' ? 'open' : 'xdg-open', path]
}
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `claude plugin test mod`
Expected: 222 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add mod/src/efficiency.ts mod/tests/efficiency.test.ts
git commit -m "F14: transcript summaries, the summary cache check, the opener"
```

---

### Task 4: Aggregation, savings formulas and actions (pure)

**Files:**
- Modify: `mod/src/efficiency.ts`
- Test: `mod/tests/efficiency.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 3; `Ledger` (`src/ledger.ts`); `HogDays`, `Hog`, `hogsOver` (`src/hogs.ts`); `relativeTo` (`src/paths.ts`); `JunkMode` (`src/junk.ts`); `Billing` (`src/config.ts`).
- Produces:
  - `type Range = '7d' | '30d' | 'install'`, `RANGES: readonly Range[]`
  - `type Coverage = { total: number; read: number; skippedBig: number; failed: number; pending: number }`
  - `type Confidence = 'high' | 'medium' | 'low' | 'count only'`
  - `type SavingRow = { feature: string; did: string; count: number; tokens: number; usd: number; unpriced: number; formula: string; confidence: Confidence; isInTotal: boolean }`
  - `type Measured = { requests: number; usdPerRequest: number; hitPct: number; rebuildsPer100: number; avgContext: number }`
  - `type ProjectRow = { project: string; usd: number; sessions: number; requests: number; hitPct?: number; rebuilds: number; topHog?: Hog; savedUsd: number }`
  - `type View = { savings: SavingRow[]; totalTokens: number; totalUsd: number; before?: Measured; after?: Measured; spend: { day: string; usd: Record<string, number> }[] }`
  - `type RangeData = { from: string; projects: ProjectRow[]; views: Record<string, View>; actions: string[] }` (`views['']` is all projects)
  - `type EfficiencyData = { at: number; billing?: Billing; installDay?: string; coverage: Coverage; projects: string[]; ranges: Record<Range, RangeData> }`
  - `type EfficiencyInput = { now: number; billing?: Billing; junkMode: JunkMode; ledger?: Ledger; projectDays?: ProjectDays; junkLog?: readonly JunkEvent[]; hogDays?: HogDays; summaries: Record<string, TranscriptSummary>; coverage: Coverage }`
  - `efficiencyData(input: EfficiencyInput): EfficiencyData`
  - `installDay(ledger: Ledger | undefined, pd: ProjectDays | undefined): string | undefined`

- [ ] **Step 1: Write the failing tests**

Change the efficiency import line in `mod/tests/efficiency.test.ts` to:

```ts
import { addProjectDay, claudeDirOf, efficiencyData, installDay, isFresh, junkTimesBySession, openerArgv, projectKey, sessionOf, snapshotSaving, summarize } from '../src/efficiency'
import type { DayUsage, EfficiencyInput } from '../src/efficiency'
```

Append (the fixture is exported for Task 5's tests, which sit in the same file):

```ts
const AT = Date.parse('2026-10-03T10:00:00Z')
const use = (u: Partial<DayUsage>): DayUsage => ({ requests: 0, input: 0, read: 0, write: 0, output: 0, usd: 0, rebuilds: 0, context: 0, ...u })
const FIXTURE: EfficiencyInput = {
  now: Date.parse('2026-10-03T12:00:00Z'),
  billing: 'metered',
  junkMode: 'observe',
  ledger: { days: { '2026-10-02': 5, '2026-10-03': 2 } },
  projectDays: { '/p': { '2026-10-03': { usd: 2, keepWarmPings: 3, keepWarmSavedUsd: 0.1, keepWarmSavedTokens: 40_000, keepWarmSpentUsd: 0.25, snapshots: 1, snapshotSavedUsd: 0.04, snapshotSavedTokens: 102_000, coldAsks: 2, handoffs: 1 } } },
  junkLog: [
    { at: AT, tool: 'Read', mode: 'enforce', target: '/p/big.log', size: 3_000, savedChars: 40_000, project: '/p', session: 's1' },
    { at: AT + 1_000, tool: 'Bash', mode: 'observe', target: 'cat x', size: 80_000, savedChars: 80_000, project: '/p', session: 's1' },
    { at: AT + 2_000, tool: 'Read', mode: 'enforce', target: '/q/old.log', size: 3_000, savedChars: 4_000 }, // from before F14
  ],
  hogDays: { '2026-10-03': { 'Read\t/p/src/big.ts': 9_000, 'Read\t/elsewhere/x.ts': 20_000, 'Bash\tnpm test': 30_000 } },
  summaries: {
    '/h/.claude/projects/-p/s1.jsonl': {
      project: '/p',
      days: {
        '2026-10-01': use({ requests: 10, read: 50_000, write: 50_000, usd: 1, rebuilds: 2, context: 1_000_000 }),
        '2026-10-03': use({ requests: 10, read: 90_000, write: 10_000, usd: 0.5, context: 1_000_000 }),
      },
      junk: [{ at: AT, requestsAfter: 2, family: 'sonnet' }, { at: AT + 1_000, requestsAfter: 0, family: 'sonnet' }],
    },
  },
  coverage: { total: 2, read: 1, skippedBig: 1, failed: 0, pending: 0 },
}

describe('F14 aggregation and savings', () => {
  const data = efficiencyData(FIXTURE)
  const week = data.ranges['7d']
  const all = week.views['']!
  const row = (feature: string) => all.savings.find(r => r.feature === feature)!

  test('install day: the first day in the ledger or projectDays', () => {
    expect(installDay(FIXTURE.ledger, FIXTURE.projectDays)).toBe('2026-10-02')
    expect(installDay(undefined, undefined)).toBeUndefined()
    expect(data.ranges.install.from).toBe('2026-10-02')
    expect(week.from).toBe('2026-09-27')
  })

  test('junk guard enforce: tokens × (write5m + read × requests after); events from before F14 counted, not priced', () => {
    const r = row('Junk guard')
    expect([r.count, r.unpriced, r.tokens, r.isInTotal, r.confidence]).toEqual([2, 1, 30_000, true, 'medium'])
    expect(r4(r.usd)).toBe(0.029) // 10k × ($2.50 + $0.20 × 2) / 1M
  })

  test('junk guard observe: "would save", not in the total', () => {
    const r = row('Junk guard (observe)')
    expect([r.count, r.tokens, r.isInTotal]).toEqual([1, 20_000, false])
    expect(r4(r.usd)).toBe(0.05)
  })

  test('keep-warm may be negative and is shown so; snapshot priced when it happened; F2 and handoffs count only', () => {
    expect(r4(row('Keep-warm').usd)).toBe(-0.15)
    expect(row('Keep-warm').confidence).toBe('high')
    expect([row('Snapshot compaction').usd, row('Snapshot compaction').confidence]).toEqual([0.04, 'low'])
    expect([row('Cold-cache guard').count, row('Cold-cache guard').isInTotal]).toEqual([2, false])
    expect(row('Handoffs').count).toBe(1)
    expect(r4(all.totalUsd)).toBe(-0.081) // 0.029 − 0.15 + 0.04: observe left out
    expect(all.totalTokens).toBe(172_000)
  })

  test('before and after install, measured from the transcripts', () => {
    expect(all.before).toEqual({ requests: 10, usdPerRequest: 0.1, hitPct: 50, rebuildsPer100: 20, avgContext: 100_000 })
    expect(all.after).toEqual({ requests: 10, usdPerRequest: 0.05, hitPct: 90, rebuildsPer100: 0, avgContext: 100_000 })
  })

  test('projects: spend from projectDays, the ledger rest as unattributed, transcript figures, the top file hog', () => {
    expect(data.projects).toEqual(['/p', 'unattributed'])
    expect(week.projects.map(p => [p.project, p.usd, p.sessions, p.requests, p.rebuilds])).toEqual([['unattributed', 5, 0, 0, 0], ['/p', 2, 1, 20, 2]])
    const p = week.projects[1]!
    expect(Math.round(p.hitPct!)).toBe(70)
    expect(p.topHog).toEqual({ tool: 'Read', target: '/p/src/big.ts', tokens: 9_000 })
    expect(r4(p.savedUsd)).toBe(-0.081)
  })

  test('a project view holds only its own events and spend', () => {
    expect(week.views['/p']!.savings.find(r => r.feature === 'Junk guard')!.count).toBe(1)
    expect(week.views.unattributed!.savings.map(r => [r.feature, r.count, r.unpriced])).toEqual([['Junk guard', 1, 1]])
    expect(all.spend.map(d => d.day)).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    expect(all.spend.at(-2)!.usd).toEqual({ unattributed: 5 })
    expect(all.spend.at(-1)!.usd).toEqual({ '/p': 2 })
    expect(week.views['/p']!.spend.at(-2)!.usd).toEqual({})
  })

  test('what to do: each line names its figure', () => {
    expect(week.actions).toEqual([
      'Junk guard in observe would have saved ~$0.05 (est.): set junkGuard to enforce in /config.',
      'Keep-warm cost ~$0.15 more than it saved (est.): switch keepWarm off in /config.',
    ])
  })

  test('an empty machine: no install day, nothing saved, no NaN', () => {
    const empty = efficiencyData({ now: FIXTURE.now, junkMode: 'observe', summaries: {}, coverage: { total: 0, read: 0, skippedBig: 0, failed: 0, pending: 0 } })
    expect(empty.installDay).toBeUndefined()
    expect(empty.projects).toEqual([])
    expect(empty.ranges['30d'].views['']!).toMatchObject({ savings: [], totalUsd: 0, totalTokens: 0 })
    expect(empty.ranges['30d'].views['']!.before).toBeUndefined()
    expect(empty.ranges['30d'].actions).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `claude plugin test mod`
Expected: `efficiency.test.ts` fails (no export `efficiencyData`).

- [ ] **Step 3: Implement**

Add these imports to `mod/src/efficiency.ts`:

```ts
import type { Billing } from './config'
import { hogsOver } from './hogs'
import type { Hog, HogDays } from './hogs'
import type { JunkMode } from './junk'
import type { Ledger } from './ledger'
```

(`slashed` from `./paths` is already imported and is all this task needs from it.)

Append (above `round4`):

```ts
export type Range = '7d' | '30d' | 'install'
export const RANGES: readonly Range[] = ['7d', '30d', 'install']
/** Transcripts found, read (or from the cache), skipped for size, failed, and not read yet (session end parses none). */
export type Coverage = { total: number; read: number; skippedBig: number; failed: number; pending: number }
export type Confidence = 'high' | 'medium' | 'low' | 'count only'
export type SavingRow = { feature: string; did: string; count: number; tokens: number; usd: number; unpriced: number; formula: string; confidence: Confidence; isInTotal: boolean }
export type Measured = { requests: number; usdPerRequest: number; hitPct: number; rebuildsPer100: number; avgContext: number }
export type ProjectRow = { project: string; usd: number; sessions: number; requests: number; hitPct?: number; rebuilds: number; topHog?: Hog; savedUsd: number }
export type View = { savings: SavingRow[]; totalTokens: number; totalUsd: number; before?: Measured; after?: Measured; spend: { day: string; usd: Record<string, number> }[] }
/** One range: its first day, the project table, a view per project (`''`: all of them), and what to do. */
export type RangeData = { from: string; projects: ProjectRow[]; views: Record<string, View>; actions: string[] }
export type EfficiencyData = { at: number; billing?: Billing; installDay?: string; coverage: Coverage; projects: string[]; ranges: Record<Range, RangeData> }
export type EfficiencyInput = {
  now: number
  billing?: Billing
  junkMode: JunkMode
  ledger?: Ledger
  projectDays?: ProjectDays
  junkLog?: readonly JunkEvent[]
  hogDays?: HogDays
  /** Transcript path → summary. */
  summaries: Record<string, TranscriptSummary>
  coverage: Coverage
}

/** Everything the page shows, for every range and project. */
export function efficiencyData(input: EfficiencyInput): EfficiencyData {
  const install = installDay(input.ledger, input.projectDays)
  const byDay = spendByDay(input)
  const prices = new Map<string, JunkPrice>()
  for (const [path, s] of Object.entries(input.summaries)) for (const j of s.junk) prices.set(`${sessionOf(path)}@${j.at}`, j)
  const projects = [...new Set([
    ...Object.keys(input.projectDays ?? {}),
    ...Object.values(input.summaries).map(s => s.project ?? UNATTRIBUTED),
    ...(input.junkLog ?? []).map(ev => ev.project ?? UNATTRIBUTED),
    ...Object.values(byDay).flatMap(by => Object.keys(by)),
  ])].sort()
  const ranges = {} as Record<Range, RangeData>
  for (const range of RANGES) {
    const from = range === 'install' ? (install ?? dayKey(input.now)) : dayKey(input.now - (range === '7d' ? 6 : 29) * DAY_MS)
    const views: Record<string, View> = {}
    for (const p of ['', ...projects]) views[p] = viewOf(input, prices, byDay, p, from, install)
    const rows = projects.map(p => projectRow(input, byDay, p, from, views[p]!.totalUsd)).sort((a, b) => b.usd - a.usd || b.requests - a.requests)
    ranges[range] = { from, projects: rows, views, actions: actionsFor(views['']!, input.junkMode, rows) }
  }
  return { at: input.now, ...(input.billing === undefined ? {} : { billing: input.billing }), ...(install === undefined ? {} : { installDay: install }), coverage: input.coverage, projects, ranges }
}

/** The first day ccwarden recorded anything: the earliest in the ledger or `projectDays`. */
export function installDay(ledger: Ledger | undefined, pd: ProjectDays | undefined): string | undefined {
  const days = [...Object.keys(ledger?.days ?? {}), ...Object.values(pd ?? {}).flatMap(d => Object.keys(d))].sort()
  return days[0]
}

/** Est. $ per day and project: `projectDays`, plus what the ledger counted that no project did (spend from before F14). */
function spendByDay(input: EfficiencyInput): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const [project, days] of Object.entries(input.projectDays ?? {})) {
    for (const [day, f] of Object.entries(days)) if ((f.usd ?? 0) > 0) (out[day] ??= {})[project] = f.usd!
  }
  for (const [day, usd] of Object.entries(input.ledger?.days ?? {})) {
    const rest = usd - Object.values(out[day] ?? {}).reduce((s, v) => s + v, 0)
    if (rest >= 0.005) (out[day] ??= {})[UNATTRIBUTED] = round4(rest) // ponytail: half a cent of rounding drift isn't a project
  }
  return out
}

function viewOf(input: EfficiencyInput, prices: Map<string, JunkPrice>, byDay: Record<string, Record<string, number>>, project: string, from: string, install: string | undefined): View {
  const isIn = (p: string | undefined) => project === '' || (p ?? UNATTRIBUTED) === project
  const savings = savingsRows(input, prices, isIn, from)
  const counted = savings.filter(r => r.isInTotal)
  const days = Object.values(input.summaries).filter(s => isIn(s.project)).flatMap(s => Object.entries(s.days))
  const spend: View['spend'] = []
  for (let t = Date.parse(from); dayKey(t) <= dayKey(input.now); t += DAY_MS) {
    const day = dayKey(t)
    spend.push({ day, usd: Object.fromEntries(Object.entries(byDay[day] ?? {}).filter(([p]) => isIn(p))) })
  }
  return {
    savings,
    totalTokens: counted.reduce((s, r) => s + r.tokens, 0),
    totalUsd: counted.reduce((s, r) => s + r.usd, 0),
    ...(install === undefined ? {} : {
      before: measured(days.filter(([d]) => d < install).map(([, u]) => u)),
      after: measured(days.filter(([d]) => d >= install).map(([, u]) => u)),
    }),
    spend,
  }
}

function savingsRows(input: EfficiencyInput, prices: Map<string, JunkPrice>, isIn: (p: string | undefined) => boolean, from: string): SavingRow[] {
  const rows: SavingRow[] = []
  for (const mode of ['enforce', 'observe'] as const) {
    const events = (input.junkLog ?? []).filter(ev => ev.mode === mode && isIn(ev.project) && dayKey(ev.at) >= from)
    if (events.length === 0) continue
    const row: SavingRow = {
      feature: mode === 'enforce' ? 'Junk guard' : 'Junk guard (observe)',
      did: mode === 'enforce' ? 'oversized output kept out of the context' : 'oversized output it would have kept out',
      count: events.length, tokens: 0, usd: 0, unpriced: 0,
      formula: 'tokens × (write5m + read × requests after, to the session end or next compaction)',
      confidence: 'medium', isInTotal: mode === 'enforce',
    }
    for (const ev of events) {
      const price = ev.session === undefined ? undefined : prices.get(`${ev.session}@${ev.at}`)
      if (price?.family === undefined) {
        row.unpriced++
        continue
      }
      const tokens = ev.savedChars / 4
      const p = PRICES[price.family]
      row.tokens += tokens * (1 + price.requestsAfter)
      row.usd += (tokens * (p.write5m + p.read * price.requestsAfter)) / 1e6
    }
    rows.push(row)
  }
  const f: DayFigures = {}
  for (const [p, days] of Object.entries(input.projectDays ?? {})) {
    if (!isIn(p)) continue
    for (const [day, x] of Object.entries(days)) {
      if (day < from) continue
      for (const [k, v] of Object.entries(x) as [keyof DayFigures, number][]) f[k] = (f[k] ?? 0) + v
    }
  }
  if ((f.keepWarmPings ?? 0) > 0) {
    rows.push({ feature: 'Keep-warm', did: 'pings that kept the cache warm', count: f.keepWarmPings!, tokens: f.keepWarmSavedTokens ?? 0, usd: (f.keepWarmSavedUsd ?? 0) - (f.keepWarmSpentUsd ?? 0), unpriced: 0, formula: 'rebuilds avoided − pings spent', confidence: 'high', isInTotal: true })
  }
  if ((f.snapshots ?? 0) > 0) {
    rows.push({ feature: 'Snapshot compaction', did: 'compactions with no summary request', count: f.snapshots!, tokens: f.snapshotSavedTokens ?? 0, usd: f.snapshotSavedUsd ?? 0, unpriced: 0, formula: `context × read + ${SUMMARY_OUTPUT_TOKENS} × output`, confidence: 'low', isInTotal: true })
  }
  const counts = [['coldAsks', 'Cold-cache guard', 'asked before a send over a cold cache'], ['topicClears', 'Unrelated-prompt hint', 'cleared for a new topic'], ['handoffs', 'Handoffs', 'notes written']] as const
  for (const [key, feature, did] of counts) {
    if ((f[key] ?? 0) > 0) rows.push({ feature, did, count: f[key]!, tokens: 0, usd: 0, unpriced: 0, formula: 'count only', confidence: 'count only', isInTotal: false })
  }
  return rows
}

function measured(days: readonly DayUsage[]): Measured | undefined {
  const t = sumUsage(days)
  if (t.requests === 0) return undefined
  const all = t.input + t.read + t.write
  return { requests: t.requests, usdPerRequest: t.usd / t.requests, hitPct: all > 0 ? (t.read / all) * 100 : 0, rebuildsPer100: (t.rebuilds / t.requests) * 100, avgContext: t.context / t.requests }
}

function sumUsage(days: readonly DayUsage[]): DayUsage {
  const t: DayUsage = { requests: 0, input: 0, read: 0, write: 0, output: 0, usd: 0, rebuilds: 0, context: 0 }
  for (const d of days) for (const k of Object.keys(t) as (keyof DayUsage)[]) t[k] += d[k]
  return t
}

function projectRow(input: EfficiencyInput, byDay: Record<string, Record<string, number>>, project: string, from: string, savedUsd: number): ProjectRow {
  const sessions = Object.values(input.summaries)
    .filter(s => (s.project ?? UNATTRIBUTED) === project)
    .map(s => Object.entries(s.days).filter(([d]) => d >= from).map(([, u]) => u))
    .filter(days => days.some(u => u.requests > 0))
  const t = sumUsage(sessions.flat())
  const all = t.input + t.read + t.write
  // ponytail: hogDays has no project, so only file hogs under its path count; Bash and Grep hogs aren't attributed
  const root = `${project.toLowerCase()}/`
  const hogs = hogsOver(Object.fromEntries(Object.entries(input.hogDays ?? {}).filter(([d]) => d >= from)), '', 100)
  const topHog = hogs.find(h => slashed(h.target).toLowerCase().startsWith(root))
  return {
    project,
    usd: round4(Object.entries(byDay).filter(([d]) => d >= from).reduce((s, [, by]) => s + (by[project] ?? 0), 0)),
    sessions: sessions.length,
    requests: t.requests,
    ...(all > 0 ? { hitPct: (t.read / all) * 100 } : {}),
    rebuilds: t.rebuilds,
    ...(topHog === undefined ? {} : { topHog }),
    savedUsd,
  }
}

/** Up to three things to change, each naming the figure behind it. */
function actionsFor(all: View, junkMode: JunkMode, rows: readonly ProjectRow[]): string[] {
  const out: string[] = []
  const observe = all.savings.find(r => r.feature === 'Junk guard (observe)')
  if (junkMode === 'observe' && observe !== undefined && observe.usd >= 0.01) out.push(`Junk guard in observe would have saved ~$${observe.usd.toFixed(2)} (est.): set junkGuard to enforce in /config.`)
  const kw = all.savings.find(r => r.feature === 'Keep-warm')
  if (kw !== undefined && kw.usd < 0) out.push(`Keep-warm cost ~$${(-kw.usd).toFixed(2)} more than it saved (est.): switch keepWarm off in /config.`)
  if (all.before !== undefined && all.after !== undefined && all.after.hitPct < all.before.hitPct - 5) {
    out.push(`Cache hits fell from ${Math.round(all.before.hitPct)}% to ${Math.round(all.after.hitPct)}% since install: /cw names this session's rebuild causes.`)
  } else if (all.after !== undefined && all.after.rebuildsPer100 > 10) {
    out.push(`${Math.round(all.after.rebuildsPer100)} rebuilds per 100 requests since install: idle gaps past the cache TTL are the usual cause; /cw names them.`)
  }
  const low = rows.find(r => r.hitPct !== undefined && r.hitPct < 60 && r.requests >= 20)
  if (low !== undefined) out.push(`${low.project} had ${Math.round(low.hitPct!)}% cache hits over ${low.requests} requests: its prompt prefix changed or went cold often.`)
  return out.slice(0, 3)
}
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `claude plugin test mod`
Expected: 231 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add mod/src/efficiency.ts mod/tests/efficiency.test.ts
git commit -m "F14: aggregate by project and range, savings formulas, actions"
```

---

### Task 5: The HTML page (pure)

**Files:**
- Create: `mod/src/htmlDashboard.ts`
- Test: `mod/tests/efficiency.test.ts`

**Interfaces:**
- Consumes: `EfficiencyData`, `RangeData`, `View`, `Measured`, `Coverage`, `Range`, `RANGES`, `UNATTRIBUTED` (Task 4); `fmtTokens` (`src/status.ts`).
- Produces: `dashboardHtml(d: EfficiencyData): string`, `escapeHtml(s: string): string`, `coverageLine(c: Coverage): string`.

- [ ] **Step 1: Write the failing tests**

Add the import to the top of `mod/tests/efficiency.test.ts`:

```ts
import { coverageLine, dashboardHtml, escapeHtml } from '../src/htmlDashboard'
```

Append:

```ts
describe('F14 the page', () => {
  const html = dashboardHtml(efficiencyData(FIXTURE))

  test('self-contained: no URL, one script (ours), refreshes every minute', () => {
    expect(html).not.toMatch(/https?:\/\//)
    expect(html.split('<script').length).toBe(2)
    expect(html).toContain('<meta http-equiv="refresh" content="60">')
  })

  test('a project path is escaped everywhere', () => {
    const evil = '/x/<script>alert(1)</script>&"'
    const page = dashboardHtml(efficiencyData({ ...FIXTURE, projectDays: { [evil]: { '2026-10-03': { usd: 1 } } } }))
    expect(page).not.toContain('<script>alert(1)')
    expect(page).toContain('/x/&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;')
    expect(escapeHtml(`<a href='x'>&`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;')
  })

  test('every saving is labelled est.; observe says "would save"; the coverage line is shown', () => {
    const cells = html.match(/<td class="saved">[^]*?<\/td>/g) ?? []
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) if (!cell.includes('–')) expect(cell).toContain('est.')
    expect(html).toContain('would save')
    expect(html).toContain('saved (est.)')
    expect(html).toContain(escapeHtml(coverageLine(FIXTURE.coverage)))
    expect(coverageLine(FIXTURE.coverage)).toBe('1 of 2 transcripts read; 1 over 4 MiB skipped')
    expect(coverageLine({ total: 5, read: 2, skippedBig: 0, failed: 1, pending: 2 })).toBe('2 of 5 transcripts read; 1 could not be read; 2 not read yet')
  })

  test('window billing labels $ as a list-price equivalent', () => {
    expect(dashboardHtml(efficiencyData({ ...FIXTURE, billing: 'window' }))).toContain('list-price equivalent')
    expect(html).not.toContain('list-price equivalent')
  })

  test('an empty machine still renders, with no NaN or Infinity', () => {
    const empty = dashboardHtml(efficiencyData({ now: FIXTURE.now, junkMode: 'observe', summaries: {}, coverage: { total: 0, read: 0, skippedBig: 0, failed: 0, pending: 0 } }))
    expect(empty).toContain('Nothing yet in this range.')
    expect(empty).not.toMatch(/NaN|Infinity/)
  })
})
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `claude plugin test mod`
Expected: `efficiency.test.ts` fails (`../src/htmlDashboard` not found).

- [ ] **Step 3: Implement**

Create `mod/src/htmlDashboard.ts`:

```ts
import type { Coverage, EfficiencyData, Measured, Range, RangeData, View } from './efficiency'
import { RANGES, UNATTRIBUTED } from './efficiency'
import { fmtTokens } from './status'

// F14: the efficiency dashboard as one self-contained HTML page: inline CSS,
// SVG charts, and a few lines of JS for the range and project filters.
// Nothing external is loaded, and every path and text is escaped. Each
// range × project block is drawn here and the script only shows one, so
// no figure is worked out twice. Pure.

const RANGE_LABEL: Record<Range, string> = { '7d': '7 days', '30d': '30 days', install: 'Since install' }
const COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f']
const W = 720
const H = 160

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** "92 of 102 transcripts read; 10 over 4 MiB skipped", plus failed and not-yet-read counts when there are any. */
export function coverageLine(c: Coverage): string {
  const parts = [`${c.read} of ${c.total} transcripts read`]
  if (c.skippedBig > 0) parts.push(`${c.skippedBig} over 4 MiB skipped`)
  if (c.failed > 0) parts.push(`${c.failed} could not be read`)
  if (c.pending > 0) parts.push(`${c.pending} not read yet`)
  return parts.join('; ')
}

export function dashboardHtml(d: EfficiencyData): string {
  const money = d.billing === 'window' ? '$ is a list-price equivalent' : '$ at list price'
  const index = new Map(d.projects.map((p, i) => [p, String(i)]))
  const updated = new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccwarden efficiency</title><style>${CSS}</style></head><body>
<header><h1>ccwarden efficiency</h1>
<p class="dim">Updated ${updated} UTC · billing ${escapeHtml(d.billing ?? 'not set')} · tokens first, ${money}${d.installDay === undefined ? '' : ` · installed ${escapeHtml(d.installDay)}`}</p>
<nav>${RANGES.map(r => `<button data-set-range="${r}">${RANGE_LABEL[r]}</button>`).join('')}<button data-set-project="">All projects</button></nav></header>
${RANGES.map(r => rangeHtml(r, d.ranges[r], index, d.installDay)).join('\n')}
<footer class="dim">${escapeHtml(coverageLine(d.coverage))}. Transcripts over 4 MiB are left out before and after alike, so the longest sessions are not in the measured figures.</footer>
<script>${SCRIPT}</script></body></html>
`
}

function rangeHtml(range: Range, r: RangeData, index: Map<string, string>, install: string | undefined): string {
  const views = (part: (v: View) => string) => Object.entries(r.views)
    .map(([p, v]) => `<div class="view" data-project="${p === '' ? '' : index.get(p)}">${p === '' ? '' : `<p class="filter">Project: ${escapeHtml(p)}</p>`}${part(v)}</div>`)
    .join('')
  return `<main class="range" data-range="${range}">
${views(v => savingsHtml(v) + realityHtml(v))}
${projectsHtml(r, index)}
${views(v => spendHtml(v, index, install))}
${actionsHtml(r.actions)}
</main>`
}

function usd(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
}

function pct(n: number | undefined): string {
  return n === undefined ? '–' : `${Math.round(n)}%`
}

function savingsHtml(v: View): string {
  const rows = v.savings.map(s => {
    const saved = s.confidence === 'count only' ? '–' : `${s.isInTotal ? '' : 'would save '}~${fmtTokens(Math.round(s.tokens))} tokens · ~${usd(s.usd)} est.`
    const unpriced = s.unpriced > 0 ? ` <span class="tag">${s.unpriced} not priced</span>` : ''
    return `<tr><td>${escapeHtml(s.feature)}${s.isInTotal ? '' : ' <span class="tag">not in total</span>'}</td><td>${escapeHtml(s.did)}</td><td>${s.count}</td><td class="saved">${saved}${unpriced}</td><td><code>${escapeHtml(s.formula)}</code></td><td>${s.confidence}</td></tr>`
  }).join('')
  const table = rows === ''
    ? '<p class="dim">Nothing yet in this range.</p>'
    : `<table><tr><th>Feature</th><th>What it did</th><th>Times</th><th>Saved</th><th>Formula</th><th>Confidence</th></tr>${rows}</table>`
  return `<section><h2>1. Est. savings</h2><p class="total">~${fmtTokens(Math.round(v.totalTokens))} tokens / ~${usd(v.totalUsd)} saved (est.)</p>${table}</section>`
}

function realityHtml(v: View): string {
  const lines: [string, (m: Measured) => string][] = [
    ['Requests', m => String(m.requests)],
    ['Cost per request', m => `$${m.usdPerRequest.toFixed(3)}`],
    ['Cache hit', m => pct(m.hitPct)],
    ['Rebuilds per 100 requests', m => m.rebuildsPer100.toFixed(1)],
    ['Average context', m => `${fmtTokens(Math.round(m.avgContext))} tokens`],
  ]
  const cell = (m: Measured | undefined, f: (m: Measured) => string) => (m === undefined ? '–' : f(m))
  const body = v.before === undefined && v.after === undefined
    ? '<p class="dim">No transcripts read yet.</p>'
    : `<table><tr><th></th><th>Before install</th><th>After install</th></tr>${lines.map(([label, f]) => `<tr><td>${label}</td><td>${cell(v.before, f)}</td><td>${cell(v.after, f)}</td></tr>`).join('')}</table>`
  return `<section><h2>2. Reality check (measured)</h2><p class="dim">From the transcripts, at list price. A trend, not a saving: how you worked changed too.</p>${body}</section>`
}

function projectsHtml(r: RangeData, index: Map<string, string>): string {
  if (r.projects.length === 0) return '<section><h2>3. Projects</h2><p class="dim">No projects yet.</p></section>'
  const rows = r.projects.map(p => {
    const hog = p.topHog === undefined ? '–' : escapeHtml(`${p.topHog.tool} ${p.topHog.target} (${fmtTokens(p.topHog.tokens)})`)
    return `<tr data-set-project="${index.get(p.project)}"><td>${escapeHtml(p.project)}</td><td>${usd(p.usd)} est.</td><td>${p.sessions}</td><td>${p.requests}</td><td>${pct(p.hitPct)}</td><td>${p.rebuilds}</td><td>${hog}</td><td>${usd(p.savedUsd)} est.</td></tr>`
  }).join('')
  return `<section><h2>3. Projects</h2><p class="dim">Click a row to filter sections 1, 2 and 4.</p><table><tr><th>Project</th><th>Spend</th><th>Sessions</th><th>Requests</th><th>Cache hit</th><th>Rebuilds</th><th>Top context hog</th><th>Saved</th></tr>${rows}</table></section>`
}

function spendHtml(v: View, index: Map<string, string>, install: string | undefined): string {
  const total = (u: Record<string, number>) => Object.values(u).reduce((s, x) => s + x, 0)
  const max = Math.max(0, ...v.spend.map(d => total(d.usd)))
  if (max === 0) return '<section><h2>4. Spend over time</h2><p class="dim">No spend recorded in this range.</p></section>'
  const color = (p: string) => (p === UNATTRIBUTED ? '#999' : COLORS[Number(index.get(p) ?? 0) % COLORS.length]!)
  const bw = W / v.spend.length
  const bars = v.spend.map((d, i) => {
    let y = H
    return Object.entries(d.usd).map(([p, x]) => {
      const h = (x / max) * H
      y -= h
      return `<rect x="${(i * bw).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${color(p)}"><title>${escapeHtml(`${d.day} ${p}: ${usd(x)} est.`)}</title></rect>`
    }).join('')
  }).join('')
  const at = install === undefined ? -1 : v.spend.findIndex(d => d.day === install)
  const mark = at === -1 ? '' : `<line class="install" x1="${(at * bw).toFixed(1)}" x2="${(at * bw).toFixed(1)}" y1="0" y2="${H}"/><text class="install" x="${(at * bw + 3).toFixed(1)}" y="12">install</text>`
  const shown = [...new Set(v.spend.flatMap(d => Object.keys(d.usd)))]
  const legend = shown.map(p => `<span><i style="background:${color(p)}"></i>${escapeHtml(p)}</span>`).join('')
  return `<section><h2>4. Spend over time</h2><p class="dim">Est. $ per day, up to ${usd(max)}.</p><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spend per day">${bars}${mark}</svg><p class="legend">${legend}</p></section>`
}

function actionsHtml(actions: readonly string[]): string {
  const body = actions.length === 0 ? '<p class="dim">Nothing stands out.</p>' : `<ul>${actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
  return `<section><h2>5. What to do</h2>${body}</section>`
}

const CSS = `
:root{color-scheme:light dark;--fg:#1d1d1f;--dim:#6e6e73;--bg:#fff;--line:#d2d2d7;--on:#0a66c2}
@media(prefers-color-scheme:dark){:root{--fg:#f5f5f7;--dim:#a1a1a6;--bg:#1c1c1e;--line:#3a3a3c;--on:#4ea1ff}}
body{font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:20px 0 6px}
.dim{color:var(--dim)}.total{font-size:18px;font-weight:600}.filter{font-weight:600}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
tr[data-set-project]{cursor:pointer}tr.on{outline:2px solid var(--on)}
.tag{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 4px}
nav{margin:10px 0;display:flex;gap:6px;flex-wrap:wrap}button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:none;color:inherit;cursor:pointer}button.on{border-color:var(--on);color:var(--on)}
svg{width:100%;height:auto}line.install{stroke:var(--on);stroke-dasharray:4 3}text.install{fill:var(--on);font-size:11px}
.legend span{margin-right:12px;white-space:nowrap}.legend i{display:inline-block;width:10px;height:10px;margin-right:4px}
`

// Shows one range and one project; kept in the URL's hash so the minute refresh keeps them.
const SCRIPT = `
const st={range:'30d',project:''};
const h=decodeURIComponent(location.hash.slice(1)).split('|');
if(['7d','30d','install'].includes(h[0]))st.range=h[0];
if(h.length>1)st.project=h[1];
function show(){
  if(!document.querySelector('.view[data-project="'+CSS.escape(st.project)+'"]'))st.project='';
  for(const el of document.querySelectorAll('.range'))el.hidden=el.dataset.range!==st.range;
  for(const el of document.querySelectorAll('.view'))el.hidden=el.dataset.project!==st.project;
  for(const b of document.querySelectorAll('[data-set-range]'))b.classList.toggle('on',b.dataset.setRange===st.range);
  for(const r of document.querySelectorAll('tr[data-set-project]'))r.classList.toggle('on',r.dataset.setProject===st.project);
  history.replaceState(null,'','#'+encodeURIComponent(st.range+'|'+st.project));
}
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-set-range],[data-set-project]');
  if(!t)return;
  if(t.dataset.setRange)st.range=t.dataset.setRange;
  if(t.dataset.setProject!==undefined)st.project=t.dataset.setProject;
  show();
});
show();
`
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `claude plugin test mod`
Expected: 236 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add mod/src/htmlDashboard.ts mod/tests/efficiency.test.ts
git commit -m "F14: the self-contained dashboard page"
```

---

### Task 6: `/cw open`, the timer, the session-end rewrite

**Files:**
- Modify: `mod/hooks/register.tsx` (imports, constants, `session.start`, `session.end`, the `/cw` command, new functions `writeEfficiency`, `claudeDirs`, `readSummaries`, `openInBrowser`, `refreshEfficiency`)
- Modify: `mod/tests/hooks.test.ts`: the harness (`world()`: `process.run`, `fs.list`, two new `shown` fields, one new option) and a new `describe` at the end.

**Interfaces:**
- Consumes: `efficiencyData`, `summarize`, `isFresh`, `junkTimesBySession`, `claudeDirOf`, `openerArgv`, `Coverage`, `SummaryCache`, `TranscriptSummary`, `ProjectDays` (Tasks 1, 3, 4); `dashboardHtml` (Task 5); `parseJsonl`, `joinPath`, `MAX_TRANSCRIPT_BYTES`, `JUNK_LOG_KEY`, `LEDGER_KEY`, `HOG_DAYS_KEY`, `PROJECT_DAYS_KEY` (already in `register.tsx`).
- Produces: `/cw open`; store keys `transcriptSummaries` (`SummaryCache`) and `dashboardOpened` (`true`); the file `<claude dir>/ccwarden/dashboard.html`.

- [ ] **Step 1: Extend the test harness (additive only)**

In `world()`'s `opts` type in `mod/tests/hooks.test.ts`, add after `mtimes?: Record<string, number>`:

```ts
  uname?: string
```

In `shown`, add after `forkCacheRead: 180_000,`:

```ts
    // Commands $.process.run was asked to run, and the exit code a browser opener gets.
    runs: [] as string[][],
    openerExit: 0,
```

Replace the `fs.list` handler with one that also lists subfolders, as kind `dir`. Existing callers keep only `file` entries, so they see what they saw before:

```ts
  on('fs.list', (_$, e) => {
    const dir = `${posix(e.path)}/`
    const paths = [...Object.keys(opts.files ?? {}), ...shown.writes.map(f => f.path)].filter(p => p.startsWith(dir))
    const files = paths.filter(p => !p.slice(dir.length).includes('/'))
    const dirs = [...new Set(paths.map(p => p.slice(dir.length)).filter(rest => rest.includes('/')).map(rest => rest.split('/')[0]!))]
    return { value: [
      ...files.map(p => ({ name: p.slice(dir.length), kind: 'file' as const, size: file(p)?.length ?? 1, mtimeMs: opts.mtimes?.[p] ?? 0, isLink: false })),
      ...dirs.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
    ] }
  })
```

Replace the `process.run` handler with one that records argv and answers `uname` and the openers. Git keeps its old answers:

```ts
  on('process.run', (_$, e) => {
    shown.runs.push([...e.argv])
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'uname') return done(0, `${opts.uname ?? 'Linux'}\n`)
    if (['cmd', 'open', 'xdg-open'].includes(e.argv[0]!)) return done(shown.openerExit)
    const out = e.argv.includes('rev-parse') ? opts.git?.branch : e.argv.includes('--numstat') ? opts.git?.numstat : undefined
    return done(out === undefined ? 128 : 0, out ?? '')
  })
```

Run `claude plugin test mod`. Expected: 236 pass (no behaviour change yet).

- [ ] **Step 2: Write the failing tests**

Append to the end of `mod/tests/hooks.test.ts`:

```ts
describe('F14 efficiency dashboard: /cw open', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z')
  const TRANSCRIPT = '/home/u/.claude/projects/-p/sess1.jsonl'
  const PAGE = '/home/u/.claude/ccwarden/dashboard.html'
  const cw = (args = '') => ({ command: 'cw', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
  const line = JSON.stringify({ type: 'assistant', cwd: '/p', timestamp: new Date(NOW - 60 * MIN).toISOString(), message: { id: 'a', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 1_000 } } })
  const files = { [TRANSCRIPT]: line, '/home/u/.claude/projects/-q/big.jsonl': 'x' }
  const pages = (w: World) => w.writes.filter(f => f.path === PAGE)
  async function begin($: Engine, w: World, surface: RenderSurface) {
    await w.clock.advance(NOW)
    await $.classic.SessionStart({ source: 'resume', transcript_path: TRANSCRIPT })
    await $.session.start(start(surface))
  }

  for (const surface of SURFACES) {
    test(`writes the page next to the transcripts and opens it, Windows (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files, env: { OS: 'Windows_NT' } })
      await begin($, w, surface)
      await $.command.run(cw('open'))
      expect(pages(w)).toHaveLength(1)
      expect(pages(w)[0]!.text).toContain('<td>/p</td>')
      expect(pages(w)[0]!.text).toContain('1 of 2 transcripts read')
      expect(w.runs.at(-1)).toEqual(['cmd', '/c', 'start', '', PAGE])
      expect(w.logs).toContain(`ccwarden: dashboard opened in your browser (${PAGE}).`)
      expect(w.opened).toEqual([]) // /cw open doesn't open the pane
      expect(Object.keys(w.store.get('transcriptSummaries') as object)).toEqual([TRANSCRIPT, '/home/u/.claude/projects/-q/big.jsonl'])
    })

    test(`macOS opens with open; a failing opener logs the path (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files, uname: 'Darwin' })
      await begin($, w, surface)
      w.openerExit = 1
      await $.command.run(cw('open'))
      expect(w.runs.at(-1)).toEqual(['open', PAGE])
      expect(w.logs).toContain(`ccwarden: dashboard written to ${PAGE}; open it in a browser.`)
    })

    test(`the timer and session end rewrite it only after /cw open has run once (${surface})`, { options: { billing: 'metered' } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files })
      await begin($, w, surface)
      await w.clock.advance(11 * MIN)
      await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
      expect(pages(w)).toHaveLength(0)

      await $.command.run(cw('open'))
      await w.clock.advance(5 * MIN)
      expect(pages(w)).toHaveLength(2)
      await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
      expect(pages(w)).toHaveLength(3)
    })

    test(`plain /cw, /cw spent and /cw budget are unchanged after /cw open (${surface})`, { options: { billing: 'metered', monthlyBudgetUsd: 100 } }, async ($, on) => {
      const w = world(on, { surfaces: [surface], files, store: { ledger: { days: { '2026-10-02': 20 } } } })
      await begin($, w, surface)
      await $.command.run(cw('open'))
      await $.command.run(cw())
      expect(w.logs).toContain('ccwarden: this month $20.00 of your $100 budget on this machine (est.), ~$207 at this pace; budget mode off.')
      expect(w.opened).toEqual(['ccwarden-cw'])
      await $.command.run(cw('spent 30'))
      expect(w.logs).toContain('ccwarden: month to date calibrated to $30.00; the estimate counts on from there.')
      await $.command.run(cw('nonsense'))
      expect(w.logs.at(-1)).toBe('ccwarden: /cw, /cw open, /cw spent <amount>, /cw budget on|off|auto')
    })
  }

  test('no transcripts folder: the page still writes and the summary cache is kept', { options: { billing: 'metered' } }, async ($, on) => {
    const cached = { '/old/a.jsonl': { mtimeMs: 1, size: 1, junk: 0, summary: { days: {}, junk: [] } } }
    const w = world(on, { surfaces: ['terminal'], env: { HOME: '/home/u' }, store: { transcriptSummaries: cached } })
    w.messages = []
    await w.clock.advance(NOW)
    await $.session.start(start('terminal'))
    await $.command.run(cw('open'))
    expect(pages(w)).toHaveLength(1)
    expect(pages(w)[0]!.text).toContain('0 of 0 transcripts read')
    expect(w.store.get('transcriptSummaries')).toEqual(cached)
  })
})
```

Notes for the implementer:
- `files` gives `big.jsonl` 1 character, so it isn't over 4 MiB. "1 of 2 read" holds because `big.jsonl`'s one line (`x`) parses to no entries, which is still a read. If you would rather test the 4 MiB skip here, give it `'x'.repeat(4 * 1024 * 1024 + 1)`; the harness reports `size` as the text length.
- In the last test there is no transcript path in `$.state` and no `projects` folder in the fixtures, so `fs.list` returns `[]` for it. To check "the cache is kept", `readSummaries` must not write the store when the projects folder lists empty. That is the rule below.
- The `~$207 at this pace` figure is what the existing F10 test setup gives for $20 on 2026-10-03 12:00. If it differs, copy the exact line the existing code logs (from a quick run); the point is that it equals what plain `/cw` logs today.

- [ ] **Step 3: Run the tests and check they fail**

Run: `claude plugin test mod`
Expected: the new F14 `/cw open` tests fail. `/cw open` currently logs the usage line and writes nothing.

- [ ] **Step 4: Implement**

Imports in `mod/hooks/register.tsx`. Extend the efficiency imports from Task 2:

```ts
import { addProjectDay, claudeDirOf, efficiencyData, isFresh, junkTimesBySession, openerArgv, projectKey, snapshotSaving, summarize } from '../src/efficiency'
import type { Coverage, DayFigures, ProjectDays, SummaryCache, TranscriptSummary } from '../src/efficiency'
import { dashboardHtml } from '../src/htmlDashboard'
```

Constants (after `PROJECT_DAYS_KEY`):

```ts
const SUMMARIES_KEY = 'transcriptSummaries' // $.store: each transcript's summary, parsed once (F14)
const DASHBOARD_OPENED_KEY = 'dashboardOpened' // $.store: /cw open has run on this machine, so the page is kept fresh
const DASHBOARD_TICK_MS = 5 * 60_000
const DASHBOARD_FILE = 'ccwarden/dashboard.html'
const END_MIN_MS = 1_500 // of session end's short bound, needed to rewrite the page
```

`session.start`: register the `/cw` hint with `open`, and start the timer. Replace

```ts
    await $.command.register({ name: 'cw', description: 'ccwarden: month to date, budget mode, calibration', argumentHint: '[spent <amount> | budget on|off|auto]' })
```

with

```ts
    await $.command.register({ name: 'cw', description: 'ccwarden: month to date, budget mode, calibration; open: the efficiency dashboard', argumentHint: '[open | spent <amount> | budget on|off|auto]' })
```

and right after `$.clock.every(STATUS_TICK_MS, () => void refreshStatus($, config))` add

```ts
    $.clock.every(DASHBOARD_TICK_MS, () => void refreshEfficiency($, config, true))
```

`session.end`: replace the hook with

```ts
  // /clear ends the conversation: its figures start over, a held alert is
  // dropped, and the window share is measured from here. F14: the page
  // catches up from the summaries already made (the exit's bound is short).
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await startOver($, config)
    if (next.budget.remainingMs >= END_MIN_MS) await refreshEfficiency($, config, false)
    return next(e)
  })
```

`/cw`: right after `const now = await $.clock.now()` in the `cw` command, add

```ts
    if (verb === 'open') {
      await $.store.set(DASHBOARD_OPENED_KEY, true)
      const path = await writeEfficiency($, config, true)
      if (path !== undefined) await openInBrowser($, path)
      return {}
    }
```

and change the usage line to

```ts
      $.ui.log('ccwarden: /cw, /cw open, /cw spent <amount>, /cw budget on|off|auto')
```

New functions (put them after `buildDashboard`):

```ts
/** F14: rewrites the page if /cw open has run on this machine; never throws. `canParse` false reads no transcript anew. */
async function refreshEfficiency($: $, config: Config, canParse: boolean): Promise<void> {
  if ((await $.store.get(DASHBOARD_OPENED_KEY)) !== true) return
  await writeEfficiency($, config, canParse).catch((err: unknown) => $.ui.log(`ccwarden: dashboard refresh failed: ${String(err)}`, { to: 'debug' }))
}

/** F14: gathers the figures and writes the page; resolves its path, or undefined (logged) when it couldn't. */
async function writeEfficiency($: $, config: Config, canParse: boolean): Promise<string | undefined> {
  const claude = await claudeDir($)
  if (claude === undefined) {
    $.ui.log('ccwarden: no home folder found, so the dashboard has nowhere to go.')
    return undefined
  }
  const junkLog = ((await $.store.get(JUNK_LOG_KEY)) as JunkEvent[] | undefined) ?? []
  const { summaries, coverage } = await readSummaries($, joinPath(claude, 'projects'), junkLog, canParse)
  const data = efficiencyData({
    now: await $.clock.now(),
    ...(config.billing === undefined ? {} : { billing: config.billing }),
    junkMode: config.junkGuard,
    ledger: (await $.store.get(LEDGER_KEY)) as Ledger | undefined,
    projectDays: (await $.store.get(PROJECT_DAYS_KEY)) as ProjectDays | undefined,
    junkLog,
    hogDays: (await $.store.get(HOG_DAYS_KEY)) as HogDays | undefined,
    summaries,
    coverage,
  })
  const path = joinPath(claude, DASHBOARD_FILE)
  const written = await $.fs.write(path, dashboardHtml(data)).then(() => true, () => false)
  if (!written) $.ui.log(`ccwarden: couldn't write the dashboard to ${path}.`)
  return written ? path : undefined
}

/** The Claude folder: the one the transcript is in, else ~/.claude. */
async function claudeDir($: $): Promise<string | undefined> {
  const fromTranscript = claudeDirOf((await $.state.get(transcriptPath)).value)
  if (fromTranscript !== undefined) return fromTranscript
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home === undefined ? undefined : joinPath(home, '.claude')
}

/**
 * F14: every transcript's summary, parsed once and cached in $.store while
 * the file (and the junk events priced in it) is unchanged. Files one
 * $.fs.read can't take are skipped and counted. With `canParse` false a
 * changed file keeps its last summary and a new one waits. A projects
 * folder that lists empty leaves the cache as it was.
 */
async function readSummaries($: $, projectsDir: string, junkLog: readonly JunkEvent[], canParse: boolean): Promise<{ summaries: Record<string, TranscriptSummary>; coverage: Coverage }> {
  const coverage: Coverage = { total: 0, read: 0, skippedBig: 0, failed: 0, pending: 0 }
  const folders = (await $.fs.list(projectsDir).catch(() => [])).filter(f => f.kind === 'dir')
  if (folders.length === 0) return { summaries: {}, coverage }
  const cache = ((await $.store.get(SUMMARIES_KEY)) as SummaryCache | undefined) ?? {}
  const junkAt = junkTimesBySession(junkLog)
  const next: SummaryCache = {}
  for (const folder of folders) {
    const dir = joinPath(projectsDir, folder.name)
    for (const f of await $.fs.list(dir).catch(() => [])) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
      coverage.total++
      if (f.size > MAX_TRANSCRIPT_BYTES) {
        coverage.skippedBig++
        continue
      }
      const path = joinPath(dir, f.name)
      const times = junkAt[f.name.replace(/\.jsonl$/, '')] ?? []
      const cached = cache[path]
      if (cached !== undefined && (!canParse || isFresh(cached, f, times.length))) {
        next[path] = cached
        coverage.read++
        continue
      }
      if (!canParse) {
        coverage.pending++
        continue
      }
      const text = await $.fs.read(path).catch(() => undefined)
      if (text === undefined) {
        coverage.failed++
        continue
      }
      next[path] = { mtimeMs: f.mtimeMs, size: f.size, junk: times.length, summary: summarize(parseJsonl(text), times) }
      coverage.read++
    }
  }
  await $.store.set(SUMMARIES_KEY, next) // files gone since are dropped
  return { summaries: Object.fromEntries(Object.entries(next).map(([p, e]) => [p, e.summary])), coverage }
}

/** F14: opens the page in the default browser; when that fails, says where it is. */
async function openInBrowser($: $, path: string): Promise<void> {
  let os: HostOs = 'linux'
  if ((await $.env.get('OS')) === 'Windows_NT') os = 'windows'
  else if ((await $.process.run(['uname', '-s'], { timeoutMs: 5_000 }).catch(() => undefined))?.stdout.trim() === 'Darwin') os = 'mac'
  const ran = await $.process.run(openerArgv(os, path), { timeoutMs: 10_000 }).catch(() => undefined)
  $.ui.log(ran?.exitCode === 0 ? `ccwarden: dashboard opened in your browser (${path}).` : `ccwarden: dashboard written to ${path}; open it in a browser.`)
}
```

Add `HostOs` to the type import: `import type { Coverage, DayFigures, HostOs, ProjectDays, SummaryCache, TranscriptSummary } from '../src/efficiency'`. `HogDays` and `Ledger` are already imported as types.

- [ ] **Step 5: Run tests and validate**

Run: `claude plugin test mod` and then `claude plugin validate mod`
Expected: 245 pass, 0 fail (236 + 9). Validate passes. If validate complains that a `$` call is not followed, check that every new function takes `$` as its first parameter and is declared in `register.tsx`.

- [ ] **Step 6: Try it for real (terminal)**

Run from the repo root: `claude --plugin-dir ./mod`, then type `/cw open`.
Expected: a browser tab opens `~/.claude/ccwarden/dashboard.html` with the five sections and a coverage line. Note the result (works or not, per OS) for Task 7's SPEC §9 entry. Do not block on it: if it fails, the logged path is the fallback, and that's a §9 item.

- [ ] **Step 7: Commit**

```bash
git add mod/hooks/register.tsx mod/tests/hooks.test.ts
git commit -m "F14: /cw open writes and opens the dashboard; timer and session-end refresh"
```

---

### Task 7: Docs cleanup, final checks, PR

**Files:**
- Modify: `docs/SPEC.md` (§4 "Later (M2+)": add F14; §6 State; §9 Open questions)
- Modify: `docs/HANDOFF.md` (§1 "Where things stand", plus the "Still open" list)
- Modify: `README.md` (feature table near line 82; command table near line 91)
- Delete: `docs/superpowers/specs/2026-10-03-dashboard-design.md` (folded into SPEC F14)
- Keep: this plan file is deleted too, once the PR merges. Mention that in the PR body; don't delete it on the branch.

- [ ] **Step 1: SPEC F14 with "As built"**

In `docs/SPEC.md` §4 "Later (M2+)", after the F13 entry, add an `### F14 Efficiency dashboard (browser)` entry. Write it the way F13's entry is written (read F13 first and copy its shape). Content:
- Goal: spec §1, two sentences.
- **As built:** `/cw open` writes `<claude dir>/ccwarden/dashboard.html` (the Claude folder from the transcript path, else `~/.claude`) and opens it: `cmd /c start "" <path>` on Windows (`OS=Windows_NT`), `open` when `uname -s` is Darwin, `xdg-open` otherwise. If the opener fails, the path is logged. It is rewritten every 5 minutes and at session end once `/cw open` has run on the machine. The page has five sections and a coverage line. The formula table from spec §5 goes here verbatim, plus the junk guard's `requestsAfter` source (clarification 1 of this plan). Session end parses no transcript and skips the rewrite with < 1.5 s of the bound left. "Top context hog" counts only file hogs under the project's path.
- Out of scope: spec §10, verbatim.

- [ ] **Step 2: SPEC §6 State**

Add these lines to §6 in its existing style:
- `projectDays` ($.store): per project (`projectKey`: `/`-separated, drive letter lower-cased) and UTC day, `usd`, `turns`, `peakContext`, `keepWarmPings`, `keepWarmSavedUsd`, `keepWarmSavedTokens`, `keepWarmSpentUsd`, `snapshots`, `snapshotSavedUsd`, `snapshotSavedTokens`, `coldAsks`, `topicClears`, `handoffs`. Days older than 400 are dropped.
- `transcriptSummaries` ($.store): transcript path → `{ mtimeMs, size, junk, summary }`; entries for gone files are dropped on each build.
- `dashboardOpened` ($.store): `true` once `/cw open` has run.
- `junkLog` events: optional `project` and `session` (F14). Older events lack them.

- [ ] **Step 3: SPEC §9 open questions**

Add, numbered after the last existing Q:
- `/cw open` opener on Windows (`cmd /c start ""` via argv), macOS (`open`) and Linux (`xdg-open`): live check per OS. Put the Task 6 Step 6 result here.
- Does a `file://` page with `<meta http-equiv="refresh" content="60">` reload and keep its `#hash` in Chrome, Edge and Safari?
- Is `$.process.run` available in the Desktop Code tab (the types say "CLI only")? If not, the path is logged.
- How long is the `session.end` bound in practice: does the rewrite fit, or is it always skipped?
- Is `OS=Windows_NT` visible through `$.env.get` on Windows?

- [ ] **Step 4: HANDOFF**

In `docs/HANDOFF.md` §1:
- Add a dated line: **F14 done (2026-10-03):** `/cw open`, the efficiency dashboard in the browser. One line on what it shows, and a pointer to SPEC F14.
- Add to "Still open, all live": `/cw open` on each OS; the page refreshes; the per-project figures look right after a week of use.
- Trim what PRs #41–#43 made stale. Read §1 against `git log --oneline -15` and the merged PR titles (`gh pr list --state merged --limit 5`). Remove or rewrite every line that #41 (F13 min keywords), #42 (F13 from 2 keywords) or #43 (F7 pickup / F13 mute) superseded, e.g. a "4 keywords" rule now 2, or "any answer mutes" now "only Send mutes". Change only what is stale.
- Fix the title if it still says "starting the mod (milestone M1)": make it `# Handoff: ccwarden mod`.

- [ ] **Step 5: README**

- Feature table (near line 82): add a row `| **Efficiency dashboard** | `/cw open`: what ccwarden saved (est.), a measured before/after per project, and spend over time, in your browser. Nothing leaves the machine. |`
- Command table (near line 91): add `| `/cw open` | Writes the efficiency dashboard to `~/.claude/ccwarden/dashboard.html` and opens it; it refreshes itself while you work |`
- One paragraph under the feature table or wherever `/cw` is described: the numbers marked est. are estimates with the formula shown on the page; the reality check is measured from the transcripts and is a trend, not a saving.

- [ ] **Step 6: Fold and delete the design spec**

```bash
git rm docs/superpowers/specs/2026-10-03-dashboard-design.md
```

Check nothing still points at it: `grep -rn "2026-10-03-dashboard-design" docs README.md mod` should print nothing except this plan's header.

- [ ] **Step 7: Final checks**

Run, from the repo root:
- `claude plugin validate mod` → passes
- `claude plugin test mod` → 245 pass, 0 fail
- `git diff main --stat -- mod/tests/pure.test.ts` → empty (pure tests untouched)
- `git diff main -- mod/tests/hooks.test.ts | grep '^-' | grep -v '^---'`: only the old `fs.list` and `process.run` handler lines appear as removed (the harness change). No test body is removed.
- `cd hooks-edition && node --test "test/*.test.js"` → passes (untouched, but CI runs it)

- [ ] **Step 8: Commit and open the PR**

```bash
git add docs/SPEC.md docs/HANDOFF.md README.md
git commit -m "F14: docs: SPEC As built, state keys, open questions; HANDOFF; README"
git push -u origin m4-dashboard
gh pr create --base main --title "F14: efficiency dashboard (/cw open)" --body "$(cat <<'EOF'
`/cw open` writes a self-contained HTML page (`~/.claude/ccwarden/dashboard.html`) and opens it in the browser: est. savings per feature with the formula, a measured before/after from the transcripts, a per-project table that filters the page, spend over time, and up to three actions.

- New store keys only (`projectDays`, `transcriptSummaries`, `dashboardOpened`); `junkLog` events gain optional `project`/`session`.
- `/cw`, `/cw spent`, `/cw budget`, the pane, month tracking and budget mode are unchanged; the existing tests pass. The only test-harness change is additive (`process.run` records argv, `fs.list` lists subfolders).
- No network, nothing added to Claude's context, no model calls.
- Live checks to do are in SPEC §9 and HANDOFF §1.
- After merge: delete `docs/superpowers/plans/2026-10-03-dashboard.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: CI (ubuntu, macOS) green.
