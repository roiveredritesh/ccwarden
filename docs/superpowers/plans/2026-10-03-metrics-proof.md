# F15 Metrics Log and Holdout Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every ccwarden intervention leaves a raw, auditable event in a per-session file, F5 and F2 get measured savings, and an opt-in holdout gives the page a measured "$ per prompt, protected vs holdout" figure with a 90% range.

**Architecture:** Pure logic in `mod/src/metrics.ts` (events, session record, file format, estimates) and `mod/src/proof.ts` (the comparison). `mod/hooks/register.tsx` holds the session's file in memory (`runtime.metrics`), adds events at each feature's decision point and rewrites the file at `turn.complete` and `session.end`. The F14 page reads the files (summaries cached in `$.store`) through `mod/src/efficiency.ts` and draws them in `mod/src/htmlDashboard.ts`.

**Tech Stack:** TypeScript in the Claude Code plugin environment (no Node APIs: `$.fs`, `$.clock`, `$.store`, `$.state`), the `claude-code/testing` kit (`claude plugin test mod`).

**Spec:** `docs/superpowers/specs/2026-10-03-metrics-proof-design.md`

## Global Constraints

- Never hook `prompt.compose`, `prompt.context`, `tool.describe` or `skill.prompt` (SPEC rule 1).
- Nothing reaches Claude's context from F15 (rule 2).
- No network calls (rule 4). Copy and download use the page's own embedded data.
- Every hook and `$` call stays in `mod/hooks/register.tsx`; `mod/src/` is pure, tested in `mod/tests/`.
- Hooks tests run on `terminal` and `desktop`, and on `metered` and `window` where billing matters.
- Metrics files: `<claude dir>/ccwarden/metrics/<session id>.jsonl`; one write never passes 4 MiB (`MAX_FILE_CHARS = 3_500_000`).
- Holdout: `measureHoldout` (boolean, default `false`); a session is a holdout when `measureHoldout` was on at its start and `fnv1a(session id) % 10 === 0`.
- Claims: no figure below 10 holdout and 30 protected eligible sessions; eligible = `measuring`, ≥ 5 prompts, a known family, a project used with ccwarden.
- The page stays one self-contained file: no `http(s)://`, exactly one `<script>`, every text escaped.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Reply to the maintainer in Hinglish; code, comments and docs in English.

## Spec deltas (decided while planning; recorded in SPEC F15 "As built" in Task 6)

1. **Subagent usage comes from `turn.complete`**, not `turn.step`: the types state a subagent's run ends in a `turn.complete` carrying its `agentId` and the turn's summed `usage`, and `agent.spawn` resolves the `agentId`. F5 already prices subagents this way. Spec Q20 is answered by the types and dropped.
2. **Session tokens and $ come from `turn.complete` usage** (main and subagent turns); `requests` counts main-loop `turn.step` results. Cache writes are priced at the 5m rate, as F5's `turnUsd` does, in both groups alike.
3. **`would: true` marks a would-have event** (holdout, or the junk guard in observe), instead of `action: "would"`; `action` stays descriptive.
4. **An event whose saving is settled later carries no `est`;** its `outcome` event (same `ref`) carries it. No join is needed to total a file: originals count, estimates add.
5. **FNV-1a runs over UTF-16 code units** (session ids are ASCII, so this equals their UTF-8 bytes).
6. **F5 confidence:** `high` when the Agent call named a model; `medium` when it didn't (the agent's own default is unknown; the parent's model is assumed).

## Review Focus

1. **A session id change on `/clear`** (Q22): the old file must be written before the new one starts, and a topic clear's saving must land in the new conversation's file. Pinned by the Task 2 test "a topic clear's saving counts the next conversation's requests".
2. **A reload mid-session:** the module must read its own file back and not overwrite earlier events. Pinned by the Task 1 test "a reload reads the file back".
3. **A refused write:** logged once, retried at the next flush, never thrown into the turn. Pinned by the Task 1 test "a refused write is logged once and retried".
4. **Holdout must never block or rewrite:** a junk guard in `enforce`, a subagent that would be pinned, a cold cache and a compaction all pass through untouched. Pinned by the Task 3 tests.
5. **Existing behaviour:** sessions with no metrics data must render exactly as before (all F14 tests stay green), and existing hooks tests that count `w.writes` must not see metrics writes (they have no Claude folder, so nothing is written). Checked by running the whole suite after each task.

---

### Task 1: The log, the session record, F5 and F2 events

**Files:**
- Create: `mod/src/metrics.ts`
- Create: `mod/tests/metrics.test.ts`
- Modify: `mod/hooks/register.tsx` (Runtime, `agent.spawn`, `turn.start`, `turn.step`, `turn.complete`, `prompt.submit` cold ask, `session.end`, new helpers after `recordProject`)
- Modify: `mod/tests/hooks.test.ts` (harness: `sessionId`, mutable write refusal; new `describe('F15 metrics log')`)

**Interfaces:**
- Produces (from `mod/src/metrics.ts`): `METRICS_DIR`, `MAX_FILE_CHARS`, types `Feature`, `Confidence`, `Estimate`, `MetricEvent`, `SessionRecord`, `MetricsFile`, `Usage`, `Pin`; functions `fnv1a(s): number`, `isHoldoutId(id): boolean`, `newRecord(f): SessionRecord`, `emptyFile(r): MetricsFile`, `usageUsd(u, family?): number | undefined`, `addUsage(a, b): Usage`, `addTurn(r, u, isSubagent, now): SessionRecord`, `addEvent(f, ev): MetricsFile`, `putOutcome(f, ev): MetricsFile`, `serialize(f): string`, `parseFile(text)`, `resume(text, fallback): MetricsFile`, `nextPart(f, now): MetricsFile`, `pinEstimate(u, from, to, confidence): Estimate | undefined`, `coldEstimate(choice, tokens, rebuildUsd): Estimate`.
- Produces (register.tsx helpers): `metricsFile($, config, runtime)`, `editMetrics($, config, runtime, change)`, `recordEvent($, config, runtime, ev)`, `flushMetrics($, runtime)`, `endMetrics($, runtime, isClear)`, `recordSpawn($, config, runtime, s)`.

- [ ] **Step 1: Write the failing pure tests** — `mod/tests/metrics.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'
import { addEvent, addTurn, addUsage, coldEstimate, emptyFile, fnv1a, isHoldoutId, MAX_FILE_CHARS, newRecord, nextPart, parseFile, pinEstimate, putOutcome, resume, serialize, usageUsd } from '../src/metrics'
import type { MetricEvent, Usage } from '../src/metrics'

const r4 = (n: number) => Math.round(n * 1e4) / 1e4
const u = (model: string, x: Partial<Usage> = {}): Usage => ({ model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...x })
const ev = (x: Partial<MetricEvent> = {}): MetricEvent => ({ v: 1, at: 1, feature: 'handoff', action: 'written', measured: {}, ...x })
const rec = () => newRecord({ session: 'sess1', project: '/p', now: 100, measuring: false })

describe('F15 holdout choice', () => {
  test('FNV-1a 32-bit, and 1 in 10 ids are holdouts', () => {
    expect(fnv1a('sess1')).toBe(3256376694)
    expect(isHoldoutId('sess5')).toBe(true)
    expect(isHoldoutId('sess1')).toBe(false)
    let n = 0
    for (let i = 0; i < 10_000; i++) if (isHoldoutId(`id-${i}`)) n++
    expect(n > 900 && n < 1100).toBe(true)
  })

  test('a record is a holdout only when measuring', () => {
    expect(newRecord({ session: 'sess5', project: '/p', now: 1, measuring: true }).holdout).toBe(true)
    expect(newRecord({ session: 'sess5', project: '/p', now: 1, measuring: false }).holdout).toBe(false)
    expect(newRecord({ session: 'sess1', project: '/p', now: 1, measuring: true }).holdout).toBe(false)
  })
})

describe('F15 session record', () => {
  test('a main turn adds tokens, $ and its family; a subagent turn adds $ to subagentUsd only', () => {
    let r = addTurn(rec(), u('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 }), false, 200)
    expect(r.tokens).toEqual({ input: 1_000_000, read: 0, write: 0, output: 100_000 })
    expect(r4(r.usd)).toBe(3) // $2 + 100k × $10
    expect([r.family, r.familyTurns, r.lastAt]).toEqual(['sonnet', { sonnet: 1 }, 200])
    r = addTurn(r, u('claude-haiku-4-5-20251001', { input_tokens: 1_000_000 }), true, 300)
    expect([r4(r.usd), r4(r.subagentUsd), r.familyTurns]).toEqual([4, 1, { sonnet: 1 }])
  })

  test('usage adds up; an unknown model has no price', () => {
    expect(addUsage(u('a', { input_tokens: 1 }), u('b', { input_tokens: 2, output_tokens: 3 }))).toEqual(u('b', { input_tokens: 3, output_tokens: 3 }))
    expect(addUsage(undefined, u('b', { input_tokens: 2 }))).toEqual(u('b', { input_tokens: 2 }))
    expect(usageUsd(u('mystery', { input_tokens: 5 }))).toBeUndefined()
  })
})

describe('F15 file', () => {
  test('events, earlier parts and the current record, one JSON line each; read back the same', () => {
    let f = addEvent(emptyFile(rec()), ev({ at: 5 }))
    f = nextPart(f, 500)
    f = addEvent(f, ev({ at: 6 }))
    const back = parseFile(serialize(f))
    expect(back.events.map(e => e.at)).toEqual([5, 6])
    expect(back.records.map(r => [r.part, r.events, r.startedAt])).toEqual([[1, 1, 100], [2, 1, 500]])
    expect(back.skipped).toBe(0)
  })

  test('lines that are not JSON or carry another version are skipped and counted', () => {
    const back = parseFile(`${JSON.stringify(ev())}\nnot json\n${JSON.stringify({ ...ev(), v: 2 })}\n\n`)
    expect([back.events.length, back.skipped]).toEqual([1, 2])
  })

  test('a reload goes on from the newest part and keeps the earlier ones', () => {
    const text = serialize(addEvent(nextPart(addEvent(emptyFile(rec()), ev()), 500), ev()))
    const f = resume(text, newRecord({ session: 'sess1', project: '/p', now: 900, measuring: false }))
    expect([f.events.length, f.done.map(r => r.part), f.record.part, f.record.startedAt]).toEqual([2, [1], 2, 500])
    expect(resume('', rec()).record.startedAt).toBe(100) // nothing on disk: the fallback
  })

  test('an outcome is replaced by ref, not added again', () => {
    let f = putOutcome(emptyFile(rec()), ev({ action: 'outcome', ref: 'a', measured: { n: 1 } }))
    f = putOutcome(f, ev({ action: 'outcome', ref: 'a', measured: { n: 2 } }))
    expect(f.events.map(e => e.measured.n)).toEqual([2])
    expect(f.record.events).toBe(1)
  })

  test('past MAX_FILE_CHARS no event is added and the record says so', () => {
    const f = addEvent(emptyFile(rec()), ev({ measured: { x: 'a'.repeat(MAX_FILE_CHARS) } }))
    expect([f.events.length, f.record.truncated]).toEqual([0, true])
    expect(addEvent(f, ev()).events.length).toBe(0)
  })
})

describe('F15 estimates', () => {
  test('a pin: the subagent tokens at the model it would have run on, less what they cost', () => {
    const e = pinEstimate(u('haiku', { input_tokens: 1_000_000, output_tokens: 10_000 }), 'opus', 'haiku', 'high')!
    expect(r4(e.usd)).toBe(3.15) // (4 − 1) + 10k × (20 − 5) / 1M
    expect(e).toMatchObject({ tokens: 0, confidence: 'high', formula: 'subagent tokens × (price opus − price haiku)' })
    expect(pinEstimate(u('haiku'), 'claude-haiku-4-5-20251001', 'haiku', 'high')).toBeUndefined()
    expect(pinEstimate(u('haiku'), 'mystery', 'haiku', 'high')).toBeUndefined()
  })

  test('a cold ask saves the rebuild when the prompt was not sent', () => {
    expect(coldEstimate('keep', 180_000, 0.45)).toMatchObject({ tokens: 180_000, usd: 0.45, confidence: 'medium' })
    expect(coldEstimate('handoff', 180_000, 0.45).usd).toBe(0.45)
    expect(coldEstimate('send', 180_000, 0.45)).toMatchObject({ tokens: 0, usd: 0 })
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test mod 2>&1 | grep -E "metrics.test|fail|pass$"`
Expected: `tests\metrics.test.ts: (fail) the file did not load` (module `../src/metrics` missing).

- [ ] **Step 3: Write `mod/src/metrics.ts`**

```ts
import { dayKey } from './ledger'
import { familyOf, PRICES } from './prices'
import type { Family } from './prices'

// F15: the metrics log. Every intervention is one event in the session's own
// file (<claude dir>/ccwarden/metrics/<session id>.jsonl); the file's last
// lines are the session's records (one per /clear part). One file per
// session because $.fs has no append: a shared file would need
// read-modify-write, and sessions would lose each other's events. Pure:
// hooks/register.tsx holds the file and writes it; the page reads it.

export const METRICS_V = 1
export const METRICS_DIR = 'ccwarden/metrics'
/** Past this a session adds no events (its record still updates), so a write never passes 4 MiB. */
export const MAX_FILE_CHARS = 3_500_000
const HOLDOUT_SHARE = 10
const RECORD_ROOM = 4_000 // the records' lines, kept free under MAX_FILE_CHARS

export type Feature = 'subagent' | 'cold' | 'topic' | 'junk' | 'snapshot' | 'keepwarm' | 'limit' | 'handoff'
export type Confidence = 'high' | 'medium' | 'low' | 'count only'
export type Estimate = { tokens: number; usd: number; formula: string; confidence: Confidence }
export type MetricEvent = {
  v: 1
  at: number
  feature: Feature
  action: string
  /** The main model when it happened. */
  model?: string
  /** Links an `outcome` to the event it settles. */
  ref?: string
  /** What a guard would have done: a holdout session, or the junk guard in observe. */
  would?: true
  /** Read from the engine; never estimated. */
  measured: Record<string, string | number | boolean>
  /** The saving; absent on an event whose `outcome` carries it. */
  est?: Estimate
}
export type TokenTotals = { input: number; read: number; write: number; output: number }
export type SessionRecord = {
  v: 1
  record: 'session'
  session: string
  /** 2, 3… when /clear kept the session id. */
  part: number
  project: string
  startedAt: number
  lastAt: number
  /** measureHoldout was on when this part started; `holdout` is only ever true with it. */
  measuring: boolean
  holdout: boolean
  /** The main loop's family with the most turns. */
  family?: Family
  familyTurns: Partial<Record<Family, number>>
  prompts: number
  requests: number
  tokens: TokenTotals
  usd: number
  subagentUsd: number
  events: number
  truncated: boolean
}
/** A session's file as the module holds it; `chars` is the events' share of the text. */
export type MetricsFile = { events: MetricEvent[]; done: SessionRecord[]; record: SessionRecord; chars: number }
export type Usage = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
/** F5: a pinned subagent whose saving adds up with each of its turns. `from` is what it would have run on, `to` what it ran on. */
export type Pin = { ref: string; from: string; to: string; confidence: Confidence; would: boolean; usage?: Usage }

/** FNV-1a (32-bit) over UTF-16 code units; session ids are ASCII, so these are their UTF-8 bytes. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** 1 in 10 sessions, by id alone: anyone can check which were holdouts, and a reload never changes it. */
export function isHoldoutId(sessionId: string): boolean {
  return fnv1a(sessionId) % HOLDOUT_SHARE === 0
}

export function newRecord(f: { session: string; project: string; now: number; measuring: boolean; part?: number }): SessionRecord {
  return {
    v: 1, record: 'session', session: f.session, part: f.part ?? 1, project: f.project, startedAt: f.now, lastAt: f.now,
    measuring: f.measuring, holdout: f.measuring && isHoldoutId(f.session), familyTurns: {},
    prompts: 0, requests: 0, tokens: { input: 0, read: 0, write: 0, output: 0 }, usd: 0, subagentUsd: 0, events: 0, truncated: false,
  }
}

export function emptyFile(record: SessionRecord): MetricsFile {
  return { events: [], done: [], record, chars: 0 }
}

/** List price, cache writes at the 5m rate (as F5's turnUsd); undefined for an unknown model. */
export function usageUsd(u: Usage, family = familyOf(u.model)): number | undefined {
  if (family === undefined) return undefined
  const p = PRICES[family]
  return (u.input_tokens * p.input + u.cache_read_input_tokens * p.read + u.cache_creation_input_tokens * p.write5m + u.output_tokens * p.output) / 1e6
}

/** Two usages summed, under the later one's model. */
export function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (a === undefined) return { ...b }
  return {
    model: b.model,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  }
}

/** A finished turn into the record: tokens and $, a subagent's $ also into subagentUsd, a main turn's family counted. */
export function addTurn(r: SessionRecord, u: Usage, isSubagent: boolean, now: number): SessionRecord {
  const usd = usageUsd(u) ?? 0
  const family = familyOf(u.model)
  const familyTurns = { ...r.familyTurns }
  if (!isSubagent && family !== undefined) familyTurns[family] = (familyTurns[family] ?? 0) + 1
  const top = (Object.entries(familyTurns) as [Family, number][]).sort((a, b) => b[1] - a[1])[0]?.[0]
  return {
    ...r, lastAt: now, familyTurns, ...(top === undefined ? {} : { family: top }),
    tokens: {
      input: r.tokens.input + u.input_tokens, read: r.tokens.read + u.cache_read_input_tokens,
      write: r.tokens.write + u.cache_creation_input_tokens, output: r.tokens.output + u.output_tokens,
    },
    usd: r.usd + usd,
    subagentUsd: r.subagentUsd + (isSubagent ? usd : 0),
  }
}

/** Adds an event, unless the file is full; then the record says so and nothing more is added. */
export function addEvent(f: MetricsFile, ev: MetricEvent): MetricsFile {
  if (f.record.truncated) return f
  const size = JSON.stringify(ev).length + 1
  if (f.chars + size + RECORD_ROOM * (f.done.length + 1) > MAX_FILE_CHARS) return { ...f, record: { ...f.record, truncated: true } }
  return { ...f, events: [...f.events, ev], record: { ...f.record, events: f.record.events + 1 }, chars: f.chars + size }
}

/** The outcome for `ev.ref` replaced if held, else added: a saving that grows is rewritten, not repeated. */
export function putOutcome(f: MetricsFile, ev: MetricEvent): MetricsFile {
  const i = f.events.findIndex(e => e.action === 'outcome' && e.ref === ev.ref)
  if (i === -1) return addEvent(f, ev)
  const events = [...f.events]
  events[i] = ev
  return { ...f, events, chars: f.chars - JSON.stringify(f.events[i]).length + JSON.stringify(ev).length }
}

export function serialize(f: MetricsFile): string {
  return `${[...f.events, ...f.done, f.record].map(x => JSON.stringify(x)).join('\n')}\n`
}

/** A file's events and records (the last line per part wins); lines that aren't JSON or carry another `v` are skipped and counted. */
export function parseFile(text: string): { events: MetricEvent[]; records: SessionRecord[]; skipped: number } {
  const events: MetricEvent[] = []
  const parts = new Map<number, SessionRecord>()
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let x: unknown
    try {
      x = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    const o = x as { v?: unknown; record?: unknown } | null
    if (o === null || typeof o !== 'object' || o.v !== METRICS_V) {
      skipped++
      continue
    }
    if (o.record === 'session') parts.set((x as SessionRecord).part, x as SessionRecord)
    else events.push(x as MetricEvent)
  }
  return { events, records: [...parts.values()].sort((a, b) => a.part - b.part), skipped }
}

/** The file back from disk after a reload: the newest part goes on, earlier parts are kept as they were. */
export function resume(text: string, fallback: SessionRecord): MetricsFile {
  const { events, records } = parseFile(text)
  return {
    events,
    done: records.slice(0, -1),
    record: records.at(-1) ?? fallback,
    chars: events.reduce((s, e) => s + JSON.stringify(e).length + 1, 0),
  }
}

/** /clear kept the session id: this part is done and the next starts now, with the same holdout choice. */
export function nextPart(f: MetricsFile, now: number): MetricsFile {
  const r = f.record
  return { ...f, done: [...f.done, r], record: newRecord({ session: r.session, project: r.project, now, measuring: r.measuring, part: r.part + 1 }) }
}

/** F5: the subagent's tokens priced at `from` less at `to`; undefined when the families match or one is unknown. */
export function pinEstimate(u: Usage, from: string, to: string, confidence: Confidence): Estimate | undefined {
  const a = familyOf(from)
  const b = familyOf(to)
  if (a === undefined || b === undefined || a === b) return undefined
  return { tokens: 0, usd: usageUsd(u, a)! - usageUsd(u, b)!, formula: `subagent tokens × (price ${a} − price ${b})`, confidence }
}

/** F2: not sending over a cold cache saves its rebuild (context × cache write price). */
export function coldEstimate(choice: 'send' | 'handoff' | 'keep', tokens: number, rebuildUsd: number | undefined): Estimate {
  const isAvoided = choice !== 'send'
  return { tokens: isAvoided ? tokens : 0, usd: isAvoided ? (rebuildUsd ?? 0) : 0, formula: 'context × cache write price, when the prompt was not sent', confidence: 'medium' }
}

/** The UTC day an event or record counts on. */
export function dayOf(at: number): string {
  return dayKey(at)
}
```

- [ ] **Step 4: Run the pure tests**

Run: `claude plugin test mod 2>&1 | grep -E "\(fail\)|^ *[0-9]+ (pass|fail)"`
Expected: `0 fail`. If `fnv1a('sess1')` differs, the hash is wrong; do not change the expected value (it was computed independently in Node).

- [ ] **Step 5: Extend the hooks harness** (`mod/tests/hooks.test.ts`, inside `world()`):

Add `sessionId?: string` to the `opts` type, `refuseWrites: false,` to `shown`, and change two handlers:

```ts
  on('fs.write', (_$, e) => {
    if (opts.isWriteRefused || shown.refuseWrites) return Promise.reject(new Error('EACCES'))
    shown.writes.push({ path: posix(e.path), text: e.text })
    return { value: undefined }
  })
  on('session.id', () => ({ value: opts.sessionId ?? 'sess1' }))
```

Add at the top: `import { parseFile } from '../src/metrics'`.

- [ ] **Step 6: Write the failing hooks tests** — append to `mod/tests/hooks.test.ts`:

```ts
describe('F15 metrics log', () => {
  const METRICS = '/home/u/.claude/ccwarden/metrics/sess1.jsonl'
  const HOME = { HOME: '/home/u' }
  const metricsOf = (w: World, path = METRICS) => {
    const f = w.writes.filter(x => x.path === path).at(-1)
    return f === undefined ? undefined : parseFile(f.text)
  }
  const spawn = (subagentType: string, extra: Record<string, unknown> = {}) => ({
    tool_use_id: `t-${subagentType}`, prompt: 'Find where sessions expire.', description: 'find expiry', subagentType,
    provider: { plugin: 'engine', tier: 'core' } as const, parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra,
  })
  const subTurn = (agentId: string, model = 'claude-haiku-4-5-20251001', input = 1_000_000) => ({
    ...turnDone(model), agentId, usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model },
  })
  const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`a pinned subagent: the pin, then its measured saving; the session record (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], env: HOME })
        await $.session.start(start(surface))
        const s = await $.agent.spawn(spawn('Explore', { model: 'opus' }))
        await $.turn.complete(subTurn(s.agentId!))
        await $.turn.complete(turnDone())
        const m = metricsOf(w)!
        const pinned = m.events.find(e => e.action === 'pinned')!
        expect(pinned).toMatchObject({ feature: 'subagent', measured: { type: 'Explore', asked: 'opus', ran: 'haiku' } })
        expect(pinned.est).toBeUndefined()
        const out = m.events.find(e => e.action === 'outcome' && e.ref === pinned.ref)!
        expect(out.est).toMatchObject({ usd: 3, confidence: 'high', formula: 'subagent tokens × (price opus − price haiku)' })
        expect(m.records[0]).toMatchObject({ session: 'sess1', project: '/p', part: 1, measuring: false, holdout: false, family: 'sonnet' })
        expect(m.records[0]!.subagentUsd).toBe(1)
      })
    }
  }

  test('no model named: the parent model is assumed, at medium confidence; a denied spawn is counted', { options: { billing: 'metered', maxParallelAgents: 1 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    const s = await $.agent.spawn(spawn('Explore'))
    await $.agent.spawn(spawn('Explore', { tool_use_id: 't2' }))
    await $.turn.complete(subTurn(s.agentId!))
    await $.turn.complete(turnDone())
    const m = metricsOf(w)!
    expect(m.events.find(e => e.action === 'pinned')!.measured.asked).toBe('claude-opus-5-5')
    expect(m.events.find(e => e.action === 'outcome')!.est!.confidence).toBe('medium')
    expect(m.events.filter(e => e.action === 'denied')).toHaveLength(1)
  })

  test('a cold-cache ask: the ask, and the rebuild saved when the prompt was kept back', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Cancel', usage: { tokens: 180_000 }, env: HOME })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await w.clock.advance(17 * MIN)
    await $.prompt.submit(typed('continue with the refactor'))
    const m = metricsOf(w)!
    const asked = m.events.find(e => e.feature === 'cold' && e.action === 'asked')!
    expect(asked.measured).toMatchObject({ tokens: 180_000, minutesCold: 12 })
    expect(m.events.find(e => e.action === 'outcome' && e.ref === asked.ref)!.est).toMatchObject({ tokens: 180_000, usd: 0.45 })
  })

  test('prompts and requests are counted; session end writes the file', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    on('turn.step', async function* () {
      return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' } }
    })
    await $.session.start(start('terminal'))
    await $.turn.start({ text: 'hi', turnId: 't' })
    for (const index of [0, 1]) { const s = $.turn.step({ turnId: 't', index, model: 'claude-sonnet-5-5', messageCount: 2 }); for await (const _ of s); }
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
    expect(metricsOf(w)!.records[0]).toMatchObject({ prompts: 1, requests: 2 })
  })

  test('a reload reads the file back and goes on from it', { options: { billing: 'metered' } }, async ($, on) => {
    const before = `${JSON.stringify({ v: 1, at: 1, feature: 'handoff', action: 'written', measured: {} })}\n${JSON.stringify({ v: 1, record: 'session', session: 'sess1', part: 1, project: '/p', startedAt: 1, lastAt: 1, measuring: false, holdout: false, familyTurns: {}, prompts: 3, requests: 4, tokens: { input: 0, read: 0, write: 0, output: 0 }, usd: 0, subagentUsd: 0, events: 1, truncated: false })}\n`
    const w = world(on, { surfaces: ['terminal'], env: HOME, files: { [METRICS]: before } })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    const m = metricsOf(w)!
    expect(m.events[0]!.feature).toBe('handoff')
    expect(m.records[0]).toMatchObject({ prompts: 3, requests: 4, startedAt: 1, family: 'sonnet' })
  })

  test('/clear with the same id starts part 2', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await $.session.end({ reason: 'clear', sessionId: 'sess1', resume: { id: 'sess1' } })
    await $.turn.complete(turnDone())
    expect(metricsOf(w)!.records.map(r => r.part)).toEqual([1, 2])
  })

  test('a refused write is logged once and retried at the next flush', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    w.refuseWrites = true
    await $.turn.complete(turnDone())
    await $.turn.complete(turnDone())
    expect(w.logs.filter(l => l.startsWith("ccwarden: couldn't write the metrics log"))).toHaveLength(1)
    w.refuseWrites = false
    await $.turn.complete(turnDone())
    expect(metricsOf(w)!.records[0]!.familyTurns).toEqual({ sonnet: 3 })
  })

  test('with no Claude folder nothing is written', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    expect(w.writes).toEqual([])
  })
})
```

- [ ] **Step 7: Run to see them fail**

Run: `claude plugin test mod 2>&1 | grep -E "\(fail\)|^ *[0-9]+ (pass|fail)"`
Expected: the eight F15 hooks tests fail (no metrics file written); everything else passes.

- [ ] **Step 8: Wire the log into `mod/hooks/register.tsx`**

Imports (add):

```ts
import { addEvent, addTurn, addUsage, coldEstimate, emptyFile, METRICS_DIR, newRecord, nextPart, pinEstimate, putOutcome, resume, serialize, usageUsd } from '../src/metrics'
import type { MetricEvent, MetricsFile, Pin, Usage } from '../src/metrics'
```

`Runtime` gains:

```ts
  /** F15: this session's metrics file as held in memory (loaded on first use), and whether it changed since the last write. */
  metrics?: MetricsFile
  isMetricsDirty: boolean
  isMetricsWarned: boolean
  /** F15: /clear ended the part; the next event starts a new one, or a new file if the id changed. */
  isNewPart: boolean
  /** F15: pinned subagents whose saving adds up with each turn (F5), by agentId. */
  pins: Record<string, Pin>
```

and the initialiser becomes:

```ts
  const runtime: Runtime = { isCompactAdvised: false, isTurnRunning: false, isPinging: false, queued: [], isBudget: false, isMetricsDirty: false, isMetricsWarned: false, isNewPart: false, pins: {} }
```

`session.end`:

```ts
  on('session.end', async ($, e, next) => {
    await endMetrics($, runtime, e.reason === 'clear')
    if (e.reason === 'clear') await startOver($, config)
    if (next.budget.remainingMs >= END_MIN_MS) await refreshEfficiency($, config, false)
    return next(e)
  })
```

`prompt.submit`, the cold ask (replace from `await recordProject($, { coldAsks: 1 })` to `if (choice === 'send') return next(e)`):

```ts
    await recordProject($, { coldAsks: 1 })
    const rebuild = rebuildUsd(tokens, model, ttl)
    const ref = `cold-${now}`
    await recordEvent($, config, runtime, { at: now, feature: 'cold', action: 'asked', ref, measured: { tokens, minutesCold: Math.round(cache.msCold / MIN_MS), rebuildUsd: rebuild ?? 0 } })
    const question = coldQuestion({ msCold: cache.msCold, tokens, rebuildUsd: rebuild })
    const choice = coldChoice(await $.ui.ask(question, { header: 'Cold cache', options: [COLD_CONTINUE, COLD_HANDOFF, COLD_CANCEL] }).catch(() => undefined))
    await recordEvent($, config, runtime, { at: now, feature: 'cold', action: 'outcome', ref, measured: { choice }, est: coldEstimate(choice, tokens, rebuild) })
    if (choice === 'send') return next(e)
    await flushMetrics($, runtime) // no turn follows to write it
```

Add `const MIN_MS = 60_000` beside the other constants.

`agent.spawn`:

```ts
  on('agent.spawn', async ($, e, next) => {
    if (!config.subagentGuard) return next(e)
    const plan = planSpawn(e, config, runningCount(await $.agent.list()))
    if ('deny' in plan) {
      $.ui.log(plan.deny)
      await recordEvent($, config, runtime, { feature: 'subagent', action: 'denied', measured: { type: e.subagentType } })
      return { deny: plan.deny }
    }
    const started = await next({ ...e, prompt: plan.prompt, ...(plan.model === undefined ? {} : { model: plan.model }) })
    if (started.deny === undefined) {
      $.ui.log(`ccwarden: ${e.subagentType} subagent: ${plan.notes.join(', ')}.`)
      await recordSpawn($, config, runtime, {
        type: e.subagentType, agentId: started.agentId, isPinned: plan.model !== undefined, would: false,
        from: e.model ?? e.parentModel, to: started.model, confidence: e.model === undefined ? 'medium' : 'high',
      })
    }
    await refreshStatus($, config)
    return started
  })
```

`turn.start` (after the `queued` lines, before `return next(e)`):

```ts
    if (runtime.turnSource === undefined) await editMetrics($, config, runtime, f => ({ ...f, record: { ...f.record, prompts: f.record.prompts + 1 } }))
```

`turn.step` (first lines):

```ts
    const r = yield* next(e)
    if (e.agentId === undefined && r.usage !== null) await countRequest($, config, runtime)
    if (e.agentId !== undefined || e.index !== 0 || r.usage === null) return r
```

`turn.complete`: right after `const result = await next(e)`:

```ts
    if (e.usage !== undefined) await addTurnMetrics($, config, runtime, e.usage, e.agentId)
```

and as the last line before the main path's `return result`:

```ts
    await flushMetrics($, runtime)
```

New helpers, after `recordProject`:

```ts
/** F15: this session's metrics file: held, else read back from disk (a reload), else new. A changed id writes the old file first. */
async function metricsFile($: $, config: Config, runtime: Runtime): Promise<MetricsFile> {
  const session = await $.session.id()
  const now = await $.clock.now()
  const held = runtime.metrics
  if (held !== undefined && held.record.session === session) {
    if (runtime.isNewPart) {
      runtime.isNewPart = false
      runtime.metrics = nextPart(held, now)
      runtime.isMetricsDirty = true
    }
    return runtime.metrics!
  }
  if (held !== undefined) await flushMetrics($, runtime) // /clear gave a new id (Q22): that file is done
  runtime.isNewPart = false
  const fresh = newRecord({ session, project: projectKey(await $.session.root()), now, measuring: false })
  const path = await metricsPath($, session)
  const text = path === undefined ? undefined : await $.fs.read(path).catch(() => undefined)
  runtime.metrics = text === undefined ? emptyFile(fresh) : resume(text, fresh)
  runtime.isMetricsDirty = true
  return runtime.metrics
}

async function metricsPath($: $, session: string): Promise<string | undefined> {
  const claude = await claudeDir($)
  return claude === undefined ? undefined : joinPath(claude, `${METRICS_DIR}/${session}.jsonl`)
}

/** F15: changes this session's file in memory; the next flush writes it. */
async function editMetrics($: $, config: Config, runtime: Runtime, change: (f: MetricsFile) => MetricsFile): Promise<void> {
  runtime.metrics = change(await metricsFile($, config, runtime))
  runtime.isMetricsDirty = true
}

/** F15: one event, stamped with the time (unless given) and the main model. */
async function recordEvent($: $, config: Config, runtime: Runtime, ev: Omit<MetricEvent, 'v' | 'at' | 'model'> & { at?: number }): Promise<void> {
  const at = ev.at ?? (await $.clock.now())
  const model = await $.session.model()
  await editMetrics($, config, runtime, f => addEvent(f, { ...ev, v: 1, at, model }))
}

/** F15: writes the file if anything changed; a refusal is logged once per session and retried at the next flush. */
async function flushMetrics($: $, runtime: Runtime): Promise<void> {
  const f = runtime.metrics
  if (f === undefined || !runtime.isMetricsDirty) return
  const path = await metricsPath($, f.record.session)
  if (path === undefined) return
  const isWritten = await $.fs.write(path, serialize(f)).then(() => true, () => false)
  if (isWritten) runtime.isMetricsDirty = false
  else if (!runtime.isMetricsWarned) {
    runtime.isMetricsWarned = true
    $.ui.log(`ccwarden: couldn't write the metrics log to ${path}; it will retry.`)
  }
}

/** F15: a conversation ended: the file is written; after /clear the next event starts a new part. */
async function endMetrics($: $, runtime: Runtime, isClear: boolean): Promise<void> {
  await flushMetrics($, runtime)
  if (isClear && runtime.metrics !== undefined) runtime.isNewPart = true
}

/** F15: a main-loop request, counted in the record. */
async function countRequest($: $, config: Config, runtime: Runtime): Promise<void> {
  await editMetrics($, config, runtime, f => ({ ...f, record: { ...f.record, requests: f.record.requests + 1 } }))
}

/** F15: a finished turn into the record; a pinned subagent's turn also rewrites its saving. */
async function addTurnMetrics($: $, config: Config, runtime: Runtime, usage: Usage, agentId: string | undefined): Promise<void> {
  const now = await $.clock.now()
  await editMetrics($, config, runtime, f => ({ ...f, record: addTurn(f.record, usage, agentId !== undefined, now) }))
  const pin = agentId === undefined ? undefined : runtime.pins[agentId]
  if (pin === undefined) return
  pin.usage = addUsage(pin.usage, usage)
  const total = pin.usage
  const est = pinEstimate(total, pin.from, pin.to, pin.confidence)
  const tokens = total.input_tokens + total.output_tokens + total.cache_read_input_tokens + total.cache_creation_input_tokens
  await editMetrics($, config, runtime, f => putOutcome(f, {
    v: 1, at: now, feature: 'subagent', action: 'outcome', ref: pin.ref, ...(pin.would ? { would: true as const } : {}),
    measured: { agentId: agentId!, tokens, usd: usageUsd(total) ?? 0 }, ...(est === undefined ? {} : { est }),
  }))
}

/** F15: a started subagent (F5): pinned or only capped; a pin's saving is settled by its turns. */
async function recordSpawn($: $, config: Config, runtime: Runtime, s: { type: string; agentId?: string; isPinned: boolean; would: boolean; from: string; to: string; confidence: 'high' | 'medium' }): Promise<void> {
  const at = await $.clock.now()
  const ref = `subagent-${at}-${s.agentId ?? ''}`
  await recordEvent($, config, runtime, {
    at, feature: 'subagent', action: s.isPinned ? 'pinned' : 'capped', ref, ...(s.would ? { would: true as const } : {}),
    measured: { type: s.type, asked: s.from, ran: s.to },
  })
  if (s.isPinned && s.agentId !== undefined) runtime.pins[s.agentId] = { ref, from: s.from, to: s.to, confidence: s.confidence, would: s.would }
}
```

- [ ] **Step 9: Validate and run the whole suite**

Run: `cd "D:/New folder/ccwarden" && claude plugin validate mod && claude plugin test mod 2>&1 | grep -E "\(fail\)|^ *[0-9]+ (pass|fail)"`
Expected: `✔ Validation passed`, `0 fail`. If an older test now sees an extra `w.writes` entry, it has a Claude folder (transcript path or `HOME`); filter its assertion to the path it checks rather than changing F15.

- [ ] **Step 10: Commit**

```bash
git add mod/src/metrics.ts mod/tests/metrics.test.ts mod/hooks/register.tsx mod/tests/hooks.test.ts
git commit -m "F15-T1: metrics log per session; F5 pin and F2 cold-ask savings measured

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Every feature's events, and the page reads the log

**Files:**
- Modify: `mod/src/metrics.ts` (pending savings, F4/F13 estimates, `summarizeMetrics`)
- Modify: `mod/src/efficiency.ts` (metrics input, rows from the log after it starts, used projects)
- Modify: `mod/hooks/register.tsx` (junk, topic, snapshot, keep-warm, limit, handoff events; pending; `readMetrics`)
- Test: `mod/tests/metrics.test.ts`, `mod/tests/efficiency.test.ts`, `mod/tests/hooks.test.ts`

**Interfaces:**
- Consumes: Task 1's `metricsFile`, `editMetrics`, `recordEvent`, `flushMetrics`, `putOutcome`, `MetricEvent`.
- Produces: `Pending`, `pendingOutcome(p): MetricEvent`, `junkEstimate`, `topicEstimate`, `FeatureTotals`, `MetricsSummary`, `summarizeMetrics(text, session): MetricsSummary`; `EfficiencyInput.metrics?: Record<string, MetricsSummary>`; `MetricsCache` (`$.store` `metricsSummaries`: path → `{ mtimeMs, size, summary }`).

- [ ] **Step 1: Failing pure tests** — add to `mod/tests/metrics.test.ts` (extend the import with `junkEstimate, pendingOutcome, summarizeMetrics, topicEstimate`):

```ts
describe('F15 pending savings', () => {
  test('kept-out output: written once, re-read by each later request; a dropped context: not re-read', () => {
    expect(junkEstimate(10_000, 'sonnet', 2)).toMatchObject({ tokens: 30_000, confidence: 'medium' })
    expect(r4(junkEstimate(10_000, 'sonnet', 2).usd)).toBe(0.029)
    expect(topicEstimate(100_000, 'opus', 3)).toMatchObject({ tokens: 300_000 })
    expect(r4(topicEstimate(100_000, 'opus', 3).usd)).toBe(0.06)
  })

  test('the outcome: junk counts the requests after the first, topic all of them; would carried over', () => {
    const junk = pendingOutcome({ ref: 'j', feature: 'junk', at: 7, tokens: 10_000, family: 'sonnet', requests: 3, would: true })
    expect(junk).toMatchObject({ at: 7, feature: 'junk', action: 'outcome', ref: 'j', would: true, measured: { requestsAfter: 2 } })
    expect(junk.est!.tokens).toBe(30_000)
    const topic = pendingOutcome({ ref: 't', feature: 'topic', at: 8, tokens: 100_000, family: 'opus', requests: 3, would: false })
    expect([topic.would, topic.measured.requestsAfter, topic.est!.tokens]).toEqual([undefined, 3, 300_000])
  })
})

describe('F15 file summary', () => {
  const DAY = Date.parse('2026-10-03T10:00:00Z')
  test('per day and feature: originals count, estimates add, would apart; the records and project', () => {
    const f0 = emptyFile(newRecord({ session: 's', project: '/p', now: DAY, measuring: true }))
    let f = addEvent(f0, ev({ at: DAY, feature: 'cold', action: 'asked', ref: 'c' }))
    f = addEvent(f, ev({ at: DAY, feature: 'cold', action: 'outcome', ref: 'c', est: { tokens: 9, usd: 0.5, formula: 'x', confidence: 'medium' } }))
    f = addEvent(f, ev({ at: DAY, feature: 'junk', action: 'would-keep-out', would: true, est: { tokens: 4, usd: 0.1, formula: 'x', confidence: 'medium' } }))
    const s = summarizeMetrics(serialize(f), 's')
    expect(s.days['2026-10-03']!.cold).toEqual({ done: { count: 1, tokens: 9, usd: 0.5 }, would: { count: 0, tokens: 0, usd: 0 } })
    expect(s.days['2026-10-03']!.junk!.would).toEqual({ count: 1, tokens: 4, usd: 0.1 })
    expect([s.project, s.records.length, s.estUsd, s.wouldUsd, s.skipped]).toEqual(['/p', 1, 0.5, 0.1, 0])
  })
})
```

- [ ] **Step 2: Run, see the new tests fail** (`claude plugin test mod`; expect the file not to load: the new exports are missing).

- [ ] **Step 3: Add to `mod/src/metrics.ts`**

```ts
/** F4 kept-out output, F13 a dropped context: savings that grow with each later main-loop request. */
export type Pending = { ref: string; feature: 'junk' | 'topic'; at: number; tokens: number; family: Family; requests: number; would: boolean }

/** F4: the output is written once, then re-read by each later request, up to the next compaction (F14's formula). */
export function junkEstimate(tokens: number, family: Family, requestsAfter: number): Estimate {
  const p = PRICES[family]
  return { tokens: tokens * (1 + requestsAfter), usd: (tokens * (p.write5m + p.read * requestsAfter)) / 1e6, formula: 'tokens × (write5m + read × requests after, to the next compaction)', confidence: 'medium' }
}

/** F13: a context dropped by /clear is not re-read by the next conversation's requests. */
export function topicEstimate(dropped: number, family: Family, requests: number): Estimate {
  return { tokens: dropped * requests, usd: (dropped * PRICES[family].read * requests) / 1e6, formula: 'dropped context × read × requests in the next conversation', confidence: 'medium' }
}

/** A pending saving as its outcome event; junk's first request only writes the output, so it isn't a re-read. */
export function pendingOutcome(p: Pending): MetricEvent {
  const after = p.feature === 'junk' ? Math.max(0, p.requests - 1) : p.requests
  const est = p.feature === 'junk' ? junkEstimate(p.tokens, p.family, after) : topicEstimate(p.tokens, p.family, after)
  return { v: 1, at: p.at, feature: p.feature, action: 'outcome', ref: p.ref, ...(p.would ? { would: true as const } : {}), measured: { requestsAfter: after }, est }
}

export type FeatureTotals = { count: number; tokens: number; usd: number }
export type DayFeatures = Partial<Record<Feature, { done: FeatureTotals; would: FeatureTotals }>>
/** One file, summarised for the page and cached in $.store (`metricsSummaries`). */
export type MetricsSummary = { session: string; project?: string; records: SessionRecord[]; days: Record<string, DayFeatures>; estUsd: number; wouldUsd: number; skipped: number }

/** Per UTC day and feature: each event but an outcome counts once; an estimate adds wherever it is; would-have events apart. */
export function summarizeMetrics(text: string, session: string): MetricsSummary {
  const { events, records, skipped } = parseFile(text)
  const days: Record<string, DayFeatures> = {}
  const zero = (): FeatureTotals => ({ count: 0, tokens: 0, usd: 0 })
  let estUsd = 0
  let wouldUsd = 0
  for (const e of events) {
    const slot = ((days[dayOf(e.at)] ??= {})[e.feature] ??= { done: zero(), would: zero() })
    const t = e.would ? slot.would : slot.done
    if (e.action !== 'outcome') t.count++
    if (e.est === undefined) continue
    t.tokens += e.est.tokens
    t.usd += e.est.usd
    if (e.would) wouldUsd += e.est.usd
    else estUsd += e.est.usd
  }
  return { session, ...(records[0] === undefined ? {} : { project: records[0].project }), records, days, estUsd, wouldUsd, skipped }
}
```

Run the pure tests: expect `0 fail`.

- [ ] **Step 4: Failing efficiency tests** — append to `mod/tests/efficiency.test.ts` (import `MetricsSummary` type from `../src/metrics`):

```ts
describe('F15 rows from the metrics log', () => {
  const total = (count: number, tokens: number, usd: number) => ({ count, tokens, usd })
  const none = total(0, 0, 0)
  const SUMMARY: MetricsSummary = {
    session: 's2', project: '/p', records: [], estUsd: 0, wouldUsd: 0, skipped: 0,
    days: { '2026-10-03': {
      subagent: { done: total(2, 0, 1.5), would: none },
      cold: { done: total(1, 180_000, 0.45), would: none },
      junk: { done: total(1, 5_000, 0.02), would: total(1, 8_000, 0.03) },
      limit: { done: total(1, 0, 0), would: none },
    } },
  }
  const data = efficiencyData({ ...FIXTURE, metrics: { '/h/.claude/ccwarden/metrics/s2.jsonl': SUMMARY } })
  const all = data.ranges['7d'].views['']!
  const row = (feature: string) => all.savings.find(r => r.feature === feature)

  test('from the first logged day the log replaces junkLog and projectDays for every feature', () => {
    expect(row('Subagent guard')).toMatchObject({ count: 2, usd: 1.5, isInTotal: true, confidence: 'high' })
    expect(row('Cold-cache guard')).toMatchObject({ count: 1, usd: 0.45, isInTotal: true, confidence: 'medium' })
    expect(row('Junk guard')).toMatchObject({ count: 1, tokens: 5_000 }) // 10-03 junkLog events are left to the log
    expect(row('Junk guard (observe)')).toMatchObject({ count: 1, tokens: 8_000, isInTotal: false })
    expect(row('Limit hints')).toMatchObject({ count: 1, confidence: 'count only', isInTotal: false })
    expect(row('Keep-warm')).toBeUndefined() // projectDays' 10-03 keep-warm is left to the log too
  })

  test('no log: exactly the F14 rows', () => {
    expect(efficiencyData(FIXTURE).ranges['7d'].views['']!.savings.map(r => r.feature)).toEqual(['Junk guard', 'Junk guard (observe)', 'Keep-warm', 'Snapshot compaction', 'Cold-cache guard', 'Handoffs'])
  })

  test('a project with only metrics since install is a used project', () => {
    const only = { ...SUMMARY, project: '/m' }
    expect(efficiencyData({ ...FIXTURE, metrics: { x: only } }).projects).toContain('/m')
  })
})
```

Run: expect these three to fail (`metrics` not read).

- [ ] **Step 5: Read the log in `mod/src/efficiency.ts`**

Add the import `import type { Feature, MetricsSummary } from './metrics'` and `metrics?: Record<string, MetricsSummary>` to `EfficiencyInput` (doc: "Metrics file path → its summary (F15)."). Then:

1. In `efficiencyData`, add the log's projects to `all`: `...Object.values(input.metrics ?? {}).map(m => m.project ?? UNATTRIBUTED),` and compute `const logStart = metricsStart(input.metrics)` passed into `viewOf` and on to `savingsRows`.
2. In `isUsedSince`, add `|| Object.values(input.metrics ?? {}).some(m => (m.project ?? UNATTRIBUTED) === project && Object.keys(m.days).some(after))`.
3. Add:

```ts
/** The first UTC day the metrics log has anything for; undefined with no log. */
function metricsStart(metrics: Record<string, MetricsSummary> | undefined): string | undefined {
  return Object.values(metrics ?? {}).flatMap(m => Object.keys(m.days)).sort()[0]
}

/** Each logged feature's row: its name, what it did, formula and confidence; would-have totals go to `would` (not in the total). */
const LOGGED: Record<Feature, { feature: string; did: string; formula: string; confidence: Confidence; would: string; wouldDid: string }> = {
  subagent: { feature: 'Subagent guard', did: 'subagents pinned to a cheaper model', formula: 'subagent tokens × (price asked − price ran)', confidence: 'high', would: 'Subagent guard (holdout)', wouldDid: 'subagents it would have pinned' },
  cold: { feature: 'Cold-cache guard', did: 'asked before a send over a cold cache', formula: 'context × cache write price, when the prompt was not sent', confidence: 'medium', would: 'Cold-cache guard (holdout)', wouldDid: 'sends over a cold cache it would have asked about' },
  topic: { feature: 'Unrelated-prompt hint', did: 'cleared for a new topic', formula: 'dropped context × read × requests in the next conversation', confidence: 'medium', would: 'Unrelated-prompt hint (holdout)', wouldDid: 'new topics it would have asked about' },
  junk: { feature: 'Junk guard', did: 'oversized output kept out of the context', formula: 'tokens × (write5m + read × requests after, to the session end or next compaction)', confidence: 'medium', would: 'Junk guard (observe)', wouldDid: 'oversized output it would have kept out' },
  snapshot: { feature: 'Snapshot compaction', did: 'compactions with no summary request', formula: `context × read + ${SUMMARY_OUTPUT_TOKENS} × output`, confidence: 'low', would: 'Snapshot compaction (holdout)', wouldDid: 'compactions it would have answered' },
  keepwarm: { feature: 'Keep-warm', did: 'pings that kept the cache warm', formula: 'rebuilds avoided − pings spent', confidence: 'high', would: 'Keep-warm (holdout)', wouldDid: 'pings it would have sent' },
  limit: { feature: 'Limit hints', did: '/compact hints past the model limit', formula: 'count only', confidence: 'count only', would: 'Limit hints (holdout)', wouldDid: 'hints it would have shown' },
  handoff: { feature: 'Handoffs', did: 'notes written', formula: 'count only', confidence: 'count only', would: 'Handoffs (holdout)', wouldDid: 'notes' },
}

/** Adds a logged feature's totals to its row, making the row if the range has none yet. */
function addLogged(rows: SavingRow[], feature: Feature, isWould: boolean, t: { count: number; tokens: number; usd: number }): void {
  const d = LOGGED[feature]
  const name = isWould ? d.would : d.feature
  const isCounted = !isWould && d.confidence !== 'count only'
  let row = rows.find(r => r.feature === name)
  if (row === undefined) {
    row = { feature: name, did: isWould ? d.wouldDid : d.did, count: 0, tokens: 0, usd: 0, unpriced: 0, formula: d.formula, confidence: d.confidence, isInTotal: isCounted }
    rows.push(row)
  }
  row.count += t.count
  row.tokens += t.tokens
  row.usd += t.usd
  if (isCounted) [row.isInTotal, row.confidence, row.formula] = [true, d.confidence, d.formula]
}
```

4. In `savingsRows(input, prices, isIn, from, logStart)`: filter the junk events with `dayKey(ev.at) >= from && (logStart === undefined || dayKey(ev.at) < logStart)` and the `projectDays` days with `day >= from && (logStart === undefined || day < logStart)`. After the existing rows are built, add:

```ts
  for (const m of Object.values(input.metrics ?? {})) {
    if (!isIn(m.project)) continue
    for (const [day, features] of Object.entries(m.days)) {
      if (day < from) continue
      for (const [feature, t] of Object.entries(features) as [Feature, { done: FeatureTotals; would: FeatureTotals }][]) {
        if (t.done.count > 0 || t.done.usd !== 0) addLogged(rows, feature, false, t.done)
        if (t.would.count > 0 || t.would.usd !== 0) addLogged(rows, feature, true, t.would)
      }
    }
  }
```

(import `FeatureTotals` too). `Confidence` is the type already declared in this file.

Run `claude plugin test mod`: expect `0 fail`.

- [ ] **Step 6: Failing hooks tests** — add to `describe('F15 metrics log')`:

```ts
  const run = async ($: Engine) => { const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 2 }); for await (const _ of s); }
  const stepAnswer = () => ({ turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' } })

  test('junk kept out: the event, then its saving from the requests after, settled at session end', { options: { billing: 'metered', junkGuard: 'enforce' } }, async ($, on) => {
    const LONG = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join('\n')
    const w = world(on, { surfaces: ['terminal'], env: HOME, files: { '/p/big.log': LONG } })
    on('turn.step', async function* () { return stepAnswer() })
    await $.session.start(start('terminal'))
    await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })
    for (let i = 0; i < 3; i++) await run($)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess1', resume: { id: 'sess1' } })
    const m = metricsOf(w)!
    const kept = m.events.find(e => e.feature === 'junk' && e.action === 'kept-out')!
    expect(kept.measured).toMatchObject({ tool: 'Read', chars: LONG.length })
    expect(m.events.find(e => e.action === 'outcome' && e.ref === kept.ref)!.measured.requestsAfter).toBe(2)
  })

  test('a snapshot, a limit hint and a handoff each leave an event', { options: { billing: 'metered', limitOther: 100_000 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME, usage: { tokens: 120_000 } })
    await $.session.start(start('terminal'))
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'Ship it', toolUses: [] }] })
    await $.command.run({ command: 'handoff', args: 'quick', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    await $.turn.complete(turnDone())
    const m = metricsOf(w)!
    expect(m.events.find(e => e.feature === 'snapshot')!.est).toMatchObject({ tokens: 122_000, confidence: 'low' })
    expect(m.events.find(e => e.feature === 'handoff')!.measured.route).toBe('quick')
    expect(m.events.find(e => e.feature === 'limit')!.measured).toMatchObject({ tokens: 120_000, limit: 100_000 })
  })

  test("a topic clear's saving counts the next conversation's requests", { options: { billing: 'metered', topicShiftHint: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], answer: 'Clear and send', usage: { tokens: 90_000 }, env: HOME })
    on('turn.step', async function* () { return stepAnswer() })
    w.messages = [{ role: 'user', text: 'Fix the login cookie expiry bug in auth.ts', toolUses: [] } as never]
    await $.session.start(start('terminal'))
    await $.turn.complete(turnDone())
    await $.prompt.submit(typed('write a haiku about mountains and rivers in spring'))
    await run($)
    await run($)
    await $.turn.complete(turnDone())
    const m = metricsOf(w)!
    const cleared = m.events.find(e => e.feature === 'topic' && e.action === 'cleared')!
    expect(cleared.measured.tokens).toBe(90_000)
    expect(m.events.find(e => e.action === 'outcome' && e.ref === cleared.ref)!.measured.requestsAfter).toBe(2)
  })

  test('/cw open puts the logged savings on the page', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    const s = await $.agent.spawn(spawn('Explore', { model: 'opus' }))
    await $.turn.complete(subTurn(s.agentId!))
    await $.turn.complete(turnDone())
    await $.command.run({ command: 'cw', args: 'open', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    const page = w.writes.filter(f => f.path === '/home/u/.claude/ccwarden/dashboard.html').at(-1)!.text
    expect(page).toContain('Subagent guard')
    expect(Object.keys(w.store.get('metricsSummaries') as object)).toEqual([METRICS])
  })
```

The topic test answers `'Clear and send'`; check `TOPIC_CLEAR` in `mod/src/topic.ts` and use its exact text. If `isTopicShift` doesn't fire for the fixture, mirror the prompt and history used by the existing F13 hooks test (`describe('F13 unrelated-prompt hint')`).

Run: expect these four to fail.

- [ ] **Step 7: Wire the events in `mod/hooks/register.tsx`**

Imports: add `pendingOutcome, summarizeMetrics` and types `Pending, MetricsSummary`; add `familyOf` to the `../src/prices` import; add `SUMMARY_OUTPUT_TOKENS` to the `../src/efficiency` import.

`Runtime` gains:

```ts
  /** F15: savings that grow with each main-loop request (F4 kept-out output, F13 dropped context). */
  pending: Pending[]
  /** F15: a topic clear waiting for /clear to land; its saving counts the next conversation (F13). */
  topicCleared?: Pending
```

and the initialiser `pending: []`.

`countRequest` also counts pending savings:

```ts
async function countRequest($: $, config: Config, runtime: Runtime): Promise<void> {
  for (const p of runtime.pending) p.requests++
  await editMetrics($, config, runtime, f => ({ ...f, record: { ...f.record, requests: f.record.requests + 1 } }))
}
```

`flushMetrics` rewrites pending outcomes first (replace its first line):

```ts
  if (runtime.metrics === undefined || !runtime.isMetricsDirty) return
  for (const p of runtime.pending) runtime.metrics = putOutcome(runtime.metrics, pendingOutcome(p))
  const f = runtime.metrics
```

`endMetrics` settles them (replace the body):

```ts
async function endMetrics($: $, runtime: Runtime, isClear: boolean): Promise<void> {
  if (runtime.metrics === undefined) return
  runtime.isMetricsDirty = true
  await flushMetrics($, runtime)
  // ponytail: a topic saving with no request yet belongs to the conversation after this /clear, so it waits
  runtime.pending = runtime.pending.filter(p => p.feature === 'topic' && p.requests === 0 && isClear)
  if (isClear) runtime.isNewPart = true
}
```

A new helper settles junk at a compaction (the snapshot drops the output):

```ts
/** F15: a compaction drops kept-out output from the context, so its re-reads stop here. */
async function settleJunk($: $, config: Config, runtime: Runtime): Promise<void> {
  const junk = runtime.pending.filter(p => p.feature === 'junk')
  if (junk.length === 0) return
  await editMetrics($, config, runtime, f => junk.reduce((acc, p) => putOutcome(acc, pendingOutcome(p)), f))
  runtime.pending = runtime.pending.filter(p => p.feature !== 'junk')
}
```

`startOver($, config, runtime)` (add the parameter; update both callers) moves a topic clear into the pending list:

```ts
  if (runtime.topicCleared !== undefined) {
    runtime.pending = [...runtime.pending.filter(p => p.ref !== runtime.topicCleared!.ref), runtime.topicCleared]
    runtime.topicCleared = undefined
  }
```

`session.end` already calls `endMetrics` before `startOver`; `topicHint` gets `runtime` (and passes it to `startOver` and `writeHandoff`), and calls `await endMetrics($, runtime, true)` before its own `startOver` after `$.command.run('clear')` succeeds.

`recordJunk($, config, runtime, event)` (update its three callers) adds, after the store write:

```ts
  const family = familyOf(await $.session.model())
  const ref = `junk-${event.at}`
  const would = event.mode === 'observe'
  await recordEvent($, config, runtime, {
    at: event.at, feature: 'junk', action: would ? 'would-keep-out' : 'kept-out', ref, ...(would ? { would: true as const } : {}),
    measured: { tool: event.tool, target: event.target.slice(0, 200), size: event.size, chars: event.savedChars },
  })
  if (family !== undefined) runtime.pending.push({ ref, feature: 'junk', at: event.at, tokens: event.savedChars / CHARS_PER_TOKEN, family, requests: 0, would })
```

`topicHint`, where `isCleared` is decided:

```ts
  if (isCleared) {
    await recordProject($, { topicClears: 1 })
    const family = familyOf(await $.session.model())
    const at = await $.clock.now()
    const ref = `topic-${at}`
    await recordEvent($, config, runtime, { at, feature: 'topic', action: 'cleared', ref, measured: { tokens } })
    if (family !== undefined) runtime.topicCleared = { ref, feature: 'topic', at, tokens, family, requests: 0, would: false }
  }
```

`session.compact`: after the `update(...)` of compactions, `await settleJunk($, config, runtime)`; after the snapshot's `recordProject`:

```ts
    if (saving !== undefined) await recordEvent($, config, runtime, { feature: 'snapshot', action: 'answered', measured: { tokens: usage.context.tokens ?? 0, trigger: e.trigger }, est: { tokens: saving.tokens, usd: saving.usd, formula: `context × read + ${SUMMARY_OUTPUT_TOKENS} × output`, confidence: 'low' } })
```

`turn.complete`, inside the `else if (!runtime.isCompactAdvised)` branch:

```ts
      await recordEvent($, config, runtime, { feature: 'limit', action: 'compact-hint', measured: { tokens, limit } })
```

`writeHandoff($, config, runtime, mode, known)` (update every caller), after `recordProject($, { handoffs: 1 })`:

```ts
  if (written) await recordEvent($, config, runtime, { feature: 'handoff', action: 'written', measured: { route: full === undefined ? 'quick' : 'full' } })
```

Keep-warm: in `prompt.submit` inside `if (saved > 0)`:

```ts
      await recordEvent($, config, runtime, { at: now, feature: 'keepwarm', action: 'avoided', measured: { tokens: tokens ?? 0 }, est: { tokens: tokens ?? 0, usd: saved, formula: 'rebuild avoided by a ping: context × cache write price', confidence: 'high' } })
```

and in `keepWarmTick` after its `recordProject`:

```ts
  await recordEvent($, config, runtime, { at, feature: 'keepwarm', action: 'ping', measured: { read: reply.usage.cache_read_input_tokens, didRead }, est: { tokens: 0, usd: -spent, formula: 'ping cost', confidence: 'high' } })
```

Reading for the page — add after `readSummaries`:

```ts
const METRICS_SUMMARIES_KEY = 'metricsSummaries' // $.store: each metrics file's summary, parsed once (F15)

type MetricsCache = Record<string, { mtimeMs: number; size: number; summary: MetricsSummary }>

/** F15: every metrics file's summary, cached while the file is unchanged; `canParse` false reads no file anew. */
async function readMetrics($: $, dir: string, canParse: boolean): Promise<Record<string, MetricsSummary>> {
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
  const cache = ((await $.store.get(METRICS_SUMMARIES_KEY)) as MetricsCache | undefined) ?? {}
  const next: MetricsCache = {}
  for (const f of files) {
    const path = joinPath(dir, f.name)
    const cached = cache[path]
    if (cached !== undefined && (!canParse || (cached.mtimeMs === f.mtimeMs && cached.size === f.size))) {
      next[path] = cached
      continue
    }
    if (!canParse || f.size > MAX_TRANSCRIPT_BYTES) continue
    const text = await $.fs.read(path).catch(() => undefined)
    if (text !== undefined) next[path] = { mtimeMs: f.mtimeMs, size: f.size, summary: summarizeMetrics(text, f.name.replace(/\.jsonl$/, '')) }
  }
  await $.store.set(METRICS_SUMMARIES_KEY, next)
  return Object.fromEntries(Object.entries(next).map(([p, e]) => [p, e.summary]))
}
```

and in `writeEfficiency`, flush first so the page sees this session, then pass the log:

```ts
  await flushMetrics($, runtime)
  ...
    metrics: await readMetrics($, joinPath(claude, METRICS_DIR), canParse),
```

(`writeEfficiency` and `refreshEfficiency` gain the `runtime` parameter; update their callers.)

- [ ] **Step 8: Validate, run the whole suite** — `claude plugin validate mod` and `claude plugin test mod`; expect `0 fail`.

- [ ] **Step 9: Commit**

```bash
git add mod/src/metrics.ts mod/src/efficiency.ts mod/hooks/register.tsx mod/tests/
git commit -m "F15-T2: every feature logs its event; the page reads the metrics log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Holdout

**Files:**
- Modify: `mod/.claude-plugin/plugin.json` (`measureHoldout`), `mod/src/config.ts`, `mod/src/status.ts` (`isHoldout`), `mod/types/index.d.ts` (`holdout` state key), `mod/hooks/register.tsx`
- Test: `mod/tests/pure.test.ts` (config, status), `mod/tests/hooks.test.ts`

**Interfaces:**
- Consumes: `isHoldoutId`, `newRecord({ measuring })`, `recordSpawn`, `recordEvent`, `snapshotSaving`.
- Produces: `Config.measureHoldout: boolean`; `StatusFacts.isHoldout?: boolean`; `$.state` `ccwarden.holdout: boolean`; register helper `isHoldout($, config, runtime): Promise<boolean>`.

- [ ] **Step 1: Failing pure tests** — add to `mod/tests/pure.test.ts` (find the existing config and status describes and add beside them):

```ts
  test('measureHoldout: off by default, a boolean', () => {
    expect(readConfig({} as never).measureHoldout).toBe(false)
    expect(readConfig({ measureHoldout: true } as never).measureHoldout).toBe(true)
    expect(readConfig({ measureHoldout: 'yes' } as never).measureHoldout).toBe(false)
  })

  test('a holdout session says so in the status line', () => {
    const base = { billing: 'metered' as const, model: 'claude-sonnet-5-5', tokens: 1_000, limit: 300_000, cache: { kind: 'none' } as never, ttl: '5m' as const, now: 0, isAlerted: false, usd: 0 }
    expect(formatStatus({ ...base, isHoldout: true })).toContain(' · holdout')
    expect(formatStatus(base)).not.toContain('holdout')
  })
```

Adjust `base` to whatever the existing `formatStatus` tests in `pure.test.ts` pass (copy one of their fact objects).

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Config, manifest, status, state contract**

`mod/src/config.ts`: `measureHoldout: boolean` in `Config`; `measureHoldout: false, // opt-in: holdout sessions get no protection (SPEC F15)` in `DEFAULTS`; `measureHoldout: bool('measureHoldout'),` in `readConfig`.

`mod/.claude-plugin/plugin.json`, after `topicShiftHint`:

```json
    "measureHoldout": {
      "type": "boolean",
      "title": "Proof mode (holdout)",
      "description": "About 1 in 10 new sessions run with ccwarden's guards off, to measure what it saves: /cw open shows protected vs holdout cost per prompt. Those sessions get no protection; the status line says holdout.",
      "default": false
    }
```

`mod/src/status.ts`: `isHoldout?: boolean` in `StatusFacts` (doc: "F15: guards are off in this session (a holdout)."), and in `formatStatus` after the budget line: `if (f.isHoldout === true) parts.push('holdout')`.

`mod/types/index.d.ts`, in `PluginState.ccwarden`: `/** F15: this session is a holdout: guards off, display on. */ holdout: boolean`.

Run: expect the two pure tests to pass.

- [ ] **Step 4: Failing hooks tests** — add to `describe('F15 metrics log')`:

```ts
  const METRICS5 = '/home/u/.claude/ccwarden/metrics/sess5.jsonl'
  for (const surface of SURFACES) {
    test(`a holdout session: nothing pinned, asked, denied or compacted by ccwarden; would-have events; status says holdout (${surface})`, { options: { billing: 'metered', measureHoldout: true, junkGuard: 'enforce' } }, async ($, on) => {
      const LONG = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join('\n')
      const w = world(on, { surfaces: [surface], env: HOME, sessionId: 'sess5', answer: 'Cancel', usage: { tokens: 180_000 }, files: { '/p/big.log': LONG } })
      await $.session.start(start(surface))
      expect(w.status.at(-1)).toContain('holdout')
      expect(w.logs).toContain('ccwarden: proof mode: this session is a holdout, so guards are off and what they would have done is logged.')
      expect(w.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBeUndefined()

      const s = await $.agent.spawn(spawn('Explore', { model: 'opus' }))
      expect(w.spawned[0]!.model).toBe('opus')
      expect(w.spawned[0]!.prompt).toBe('Find where sessions expire.')
      await $.turn.complete(subTurn(s.agentId!, 'claude-opus-5-5'))

      await $.tool.call({ tool: 'Read', file_path: '/p/big.log' })
      expect(w.reads).toContain('/p/big.log')

      await $.turn.complete(turnDone())
      await w.clock.advance(17 * MIN)
      await $.prompt.submit(typed('continue with the refactor'))
      expect(w.asks).toEqual([])
      expect(w.sent).toContain('continue with the refactor')

      await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'Ship it', toolUses: [] }] })
      expect(w.coreCompactions).toHaveLength(1)

      await $.turn.complete(turnDone())
      const m = metricsOf(w, METRICS5)!
      expect(m.records[0]).toMatchObject({ measuring: true, holdout: true })
      const pin = m.events.find(e => e.feature === 'subagent' && e.action === 'pinned')!
      expect(pin.would).toBe(true)
      expect(m.events.find(e => e.action === 'outcome' && e.ref === pin.ref)!.est!.usd).toBe(3) // opus 1M input − haiku
      expect(m.events.filter(e => e.would).map(e => e.feature)).toEqual(expect.arrayContaining(['subagent', 'junk', 'cold', 'snapshot']))
    })
  }

  test('measuring, but not a holdout id: guards on, the record says measuring', { options: { billing: 'metered', measureHoldout: true } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME })
    await $.session.start(start('terminal'))
    await $.agent.spawn(spawn('Explore'))
    await $.turn.complete(turnDone())
    expect(w.spawned[0]!.model).toBe('haiku')
    expect(w.status.at(-1)).not.toContain('holdout')
    expect(metricsOf(w)!.records[0]).toMatchObject({ measuring: true, holdout: false })
  })

  test('a holdout id with measureHoldout off is protected', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], env: HOME, sessionId: 'sess5' })
    await $.session.start(start('terminal'))
    await $.agent.spawn(spawn('Explore'))
    expect(w.spawned[0]!.model).toBe('haiku')
  })
```

If the kit has no `expect.arrayContaining`, assert with `for (const f of ['subagent', 'junk', 'cold', 'snapshot']) expect(m.events.some(e => e.would && e.feature === f)).toBe(true)`.

Run: expect them to fail.

- [ ] **Step 5: The holdout switch in `mod/hooks/register.tsx`**

`metricsFile`: `measuring: config.measureHoldout` instead of `false`, and after `runtime.metrics` is set:

```ts
  await $.state.set(holdoutRef, runtime.metrics.record.holdout)
  if (runtime.metrics.record.holdout && text === undefined) $.ui.log('ccwarden: proof mode: this session is a holdout, so guards are off and what they would have done is logged.')
```

with `const holdoutRef = { plugin: 'ccwarden', key: 'holdout' } as const` beside the other refs, and:

```ts
/** F15: this session runs with the guards off (a holdout); decided once per session id. */
async function isHoldout($: $, config: Config, runtime: Runtime): Promise<boolean> {
  return (await metricsFile($, config, runtime)).record.holdout
}
```

`session.start`: call `await metricsFile($, config, runtime)` before `syncCompactWindow`, and pass `runtime` to `syncCompactWindow` (both call sites). `syncCompactWindow($, config, runtime)` starts with `if (await isHoldout($, config, runtime)) return`.

`refreshStatus`: `isHoldout: (await $.state.get(holdoutRef)).value === true,` in the `formatStatus` facts.

`prompt.submit`, right before `await update($, conversation, prev => ({ ...(prev ?? { alerted: 0 }), coldAskedFor: ...`:

```ts
    if (await isHoldout($, config, runtime)) {
      await update($, conversation, prev => ({ ...(prev ?? { alerted: 0 }), coldAskedFor: conv.lastResponseAt }))
      await recordEvent($, config, runtime, { at: now, feature: 'cold', action: 'would-ask', would: true, measured: { tokens, rebuildUsd: rebuildUsd(tokens, model, ttl) ?? 0 } })
      return next(e)
    }
```

and the F13 branch: `const reason = config.topicShiftHint ? await topicHint($, config, runtime, e.text, tokens, conv, await isHoldout($, config, runtime)) : undefined`. In `topicHint`, right after `if (!isTopicShift(text, history)) return undefined`:

```ts
  if (isHoldout) {
    await recordEvent($, config, runtime, { feature: 'topic', action: 'would-ask', would: true, measured: { tokens } })
    return undefined
  }
```

Junk, in both `tool.call` hooks: compute `const mode = (await isHoldout($, config, runtime)) ? 'observe' : config.junkGuard` after the `junkGuard === 'off'` check and use `mode` in place of `config.junkGuard` for `recordJunk` and the observe returns.

`agent.spawn`, after `planSpawn`:

```ts
    if (await isHoldout($, config, runtime)) {
      const started = await next(e)
      if ('deny' in plan) await recordEvent($, config, runtime, { feature: 'subagent', action: 'would-deny', would: true, measured: { type: e.subagentType } })
      else if (started.deny === undefined) {
        await recordSpawn($, config, runtime, { type: e.subagentType, agentId: started.agentId, isPinned: plan.model !== undefined, would: true, from: started.model, to: plan.model ?? started.model, confidence: 'high' })
      }
      return started
    }
```

`session.compact`, after `if (plan === 'pass') return next(e)`:

```ts
    if (await isHoldout($, config, runtime)) {
      if (plan !== 'skip') {
        const usage = await $.session.usage()
        const saving = snapshotSaving(usage.context.tokens ?? 0, await $.session.model())
        await recordEvent($, config, runtime, { feature: 'snapshot', action: 'would-answer', would: true, measured: { tokens: usage.context.tokens ?? 0, trigger: e.trigger }, ...(saving === undefined ? {} : { est: { tokens: saving.tokens, usd: saving.usd, formula: `context × read + ${SUMMARY_OUTPUT_TOKENS} × output`, confidence: 'low' as const } }) })
      }
      return next(e)
    }
```

`turn.complete` limit hint: wrap the advise branch: `else if (!runtime.isCompactAdvised && !(await isHoldout($, config, runtime)))`, and in holdout record `{ feature: 'limit', action: 'would-hint', would: true, measured: { tokens, limit } }` once (set `runtime.isCompactAdvised = true` too).

`keepWarmTick`: first line after `if (runtime.isPinging) return`: `if (await isHoldout($, config, runtime)) return`.

- [ ] **Step 6: Validate, run the whole suite**; expect `0 fail`.

- [ ] **Step 7: Commit** — `git commit -m "F15-T3: measureHoldout: 1 in 10 sessions run with the guards off and log what they would have done"` (with the Co-Authored-By line).

---

### Task 4: The proof

**Files:**
- Create: `mod/src/proof.ts`, `mod/tests/proof.test.ts`
- Modify: `mod/src/efficiency.ts` (`EfficiencyData.proof`), `mod/src/htmlDashboard.ts` (proof section)
- Test: `mod/tests/efficiency.test.ts`

**Interfaces:**
- Consumes: `SessionRecord`, `MetricsSummary`, `fnv1a`, `Family`.
- Produces: `MIN_HOLDOUT = 10`, `MIN_PROTECTED = 30`, `MIN_PROMPTS = 5`; `ProofSession = { record: SessionRecord; estUsd: number }`; `ProofResult`; `proof(sessions: readonly ProofSession[]): ProofResult`; `proofClaim(p: ProofResult): string`; `selfCheck(p): string | undefined`; `EfficiencyData.proof: ProofResult`.

- [ ] **Step 1: Failing tests** — `mod/tests/proof.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'
import { newRecord } from '../src/metrics'
import type { Family } from '../src/prices'
import { proof, proofClaim, selfCheck } from '../src/proof'
import type { ProofSession } from '../src/proof'

/** A finished session: `perPrompt` $ over 10 prompts. */
function s(id: string, holdout: boolean, perPrompt: number, family: Family = 'sonnet', o: { measuring?: boolean; prompts?: number; estUsd?: number } = {}): ProofSession {
  const r = newRecord({ session: id, project: '/p', now: 0, measuring: o.measuring ?? true })
  const prompts = o.prompts ?? 10
  return { record: { ...r, holdout, family, prompts, usd: perPrompt * prompts }, estUsd: o.estUsd ?? 0 }
}
const many = (n: number, holdout: boolean, base: number, family: Family = 'sonnet', estUsd = 0) =>
  Array.from({ length: n }, (_, i) => s(`${holdout ? 'h' : 'p'}${family}${i}`, holdout, base + (i % 5) * 0.02, family, { estUsd }))

describe('F15 proof', () => {
  test('nothing measured: off', () => {
    expect(proof([s('a', false, 1, 'sonnet', { measuring: false })])).toEqual({ kind: 'off' })
    expect(proofClaim({ kind: 'off' })).toBe('Not proven yet: turn on measureHoldout in /config to measure what ccwarden saves.')
  })

  test('too few: collecting, with the counts; short sessions are not counted', () => {
    const p = proof([...many(5, true, 1), ...many(40, false, 0.75), s('short', true, 1, 'sonnet', { prompts: 4 })])
    expect(p).toEqual({ kind: 'collecting', holdout: 5, protected: 40 })
    expect(proofClaim(p)).toBe('Not proven yet: 5 of 10 holdout sessions and 40 of 30 protected ones.')
  })

  test('protected cheaper: the % less per prompt, a 90% range above 0, the claim', () => {
    const p = proof([...many(12, true, 1), ...many(40, false, 0.75)])
    if (p.kind !== 'measured') throw new Error(p.kind)
    expect(Math.round(p.lessPct)).toBe(23) // medians 0.79 / 1.03
    expect(p.lowPct > 0 && p.lowPct <= p.lessPct && p.lessPct <= p.highPct).toBe(true)
    expect([p.holdout, p.protected, p.families, p.left]).toEqual([12, 40, ['sonnet'], []])
    expect(proofClaim(p)).toMatch(/^Protected sessions cost 23% less per prompt \(90% range \d+–\d+%; 12 holdout vs 40 protected; Sonnet\)\.$/)
  })

  test('the same sessions give the same range every time', () => {
    const input = [...many(12, true, 1), ...many(40, false, 0.75)]
    expect(proof(input)).toEqual(proof([...input].reverse()))
  })

  test('no clear difference, and more expensive, are both said', () => {
    expect(proofClaim(proof([...many(12, true, 1), ...many(40, false, 1)]))).toMatch(/^No clear difference yet \(90% range -?\d+% to -?\d+%\)\.$/)
    expect(proofClaim(proof([...many(12, true, 1), ...many(40, false, 1.3)]))).toMatch(/^Protected sessions cost \d+% more per prompt/)
  })

  test('a family with fewer than 3 holdouts is left out and named; families are weighted by the protected mix', () => {
    const p = proof([...many(12, true, 1), ...many(30, false, 0.75), s('ho1', true, 5, 'opus'), s('ho2', true, 5, 'opus'), ...many(10, false, 1, 'opus')])
    if (p.kind !== 'measured') throw new Error(p.kind)
    expect([p.families, p.left]).toEqual([['sonnet'], ['opus']])
    expect(proofClaim(p)).toContain('Opus left out: fewer than 3 holdout sessions')
  })

  test('self-check: the estimate against the measured range', () => {
    const agree = proof([...many(12, true, 1), ...many(40, false, 0.75, 'sonnet', 2.3)])  // est $2.30 of $7.90 + $2.30 ≈ 23%
    expect(selfCheck(agree)).toMatch(/^The estimates agree with the holdout/)
    const high = proof([...many(12, true, 1), ...many(40, false, 0.75, 'sonnet', 20)])
    expect(selfCheck(high)).toMatch(/^The estimates look optimistic: they claim \d+%, the holdout measured \d+–\d+%\.$/)
    expect(selfCheck({ kind: 'off' })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, see it fail** (module missing).

- [ ] **Step 3: Write `mod/src/proof.ts`**

```ts
import { fnv1a } from './metrics'
import type { SessionRecord } from './metrics'
import type { Family } from './prices'

// F15: the holdout comparison. $ per user prompt, protected vs holdout
// sessions, within each model family, weighted by the protected sessions'
// family mix; a 90% range by a bootstrap seeded from the session ids, so the
// page shows the same figure until a session is added. Pure.

export const MIN_HOLDOUT = 10
export const MIN_PROTECTED = 30
export const MIN_PROMPTS = 5
const MIN_FAMILY_HOLDOUT = 3
const RESAMPLES = 2_000

export type ProofSession = { record: SessionRecord; estUsd: number }
export type ProofResult =
  | { kind: 'off' }
  | { kind: 'collecting'; holdout: number; protected: number }
  | {
    kind: 'measured'
    /** (1 − protected/holdout) × 100, and its 90% range. */
    lessPct: number
    lowPct: number
    highPct: number
    holdout: number
    protected: number
    families: Family[]
    left: Family[]
    holdoutMedian: number
    protectedMedian: number
    /** The estimate as a share of the protected sessions' spend plus it. */
    estimatePct: number
  }

export function proof(sessions: readonly ProofSession[]): ProofResult {
  const measuring = sessions.filter(s => s.record.measuring)
  if (measuring.length === 0) return { kind: 'off' }
  const eligible = measuring.filter(s => s.record.prompts >= MIN_PROMPTS && s.record.family !== undefined)
    .sort((a, b) => (a.record.session + a.record.part).localeCompare(b.record.session + b.record.part))
  const perPrompt = (s: ProofSession) => s.record.usd / s.record.prompts
  const groups = new Map<Family, { h: number[]; p: number[] }>()
  for (const s of eligible) {
    const g = groups.get(s.record.family!) ?? { h: [], p: [] }
    ;(s.record.holdout ? g.h : g.p).push(perPrompt(s))
    groups.set(s.record.family!, g)
  }
  const kept = [...groups].filter(([, g]) => g.h.length >= MIN_FAMILY_HOLDOUT && g.p.length > 0 && median(g.h) > 0).sort(([a], [b]) => a.localeCompare(b))
  const left = [...groups.keys()].filter(f => !kept.some(([k]) => k === f)).sort()
  const holdout = kept.reduce((n, [, g]) => n + g.h.length, 0)
  const prot = kept.reduce((n, [, g]) => n + g.p.length, 0)
  if (holdout < MIN_HOLDOUT || prot < MIN_PROTECTED) {
    return { kind: 'collecting', holdout: eligible.filter(s => s.record.holdout).length, protected: eligible.filter(s => !s.record.holdout).length }
  }
  const ratio = ratioOf(kept.map(([, g]) => g))
  const random = mulberry32(fnv1a(eligible.map(s => `${s.record.session}#${s.record.part}`).join(',')))
  const draws: number[] = []
  for (let i = 0; i < RESAMPLES; i++) draws.push(ratioOf(kept.map(([, g]) => ({ h: resample(g.h, random), p: resample(g.p, random) }))))
  draws.sort((a, b) => a - b)
  const lo = draws[Math.floor(0.05 * (RESAMPLES - 1))]!
  const hi = draws[Math.ceil(0.95 * (RESAMPLES - 1))]!
  const protectedSessions = eligible.filter(s => !s.record.holdout && kept.some(([f]) => f === s.record.family))
  const spent = protectedSessions.reduce((n, s) => n + s.record.usd, 0)
  const est = protectedSessions.reduce((n, s) => n + s.estUsd, 0)
  return {
    kind: 'measured', lessPct: (1 - ratio) * 100, lowPct: (1 - hi) * 100, highPct: (1 - lo) * 100, holdout, protected: prot,
    families: kept.map(([f]) => f), left,
    holdoutMedian: median(kept.flatMap(([, g]) => g.h)), protectedMedian: median(kept.flatMap(([, g]) => g.p)),
    estimatePct: spent + est > 0 ? (est / (spent + est)) * 100 : 0,
  }
}

/** Σ over families of (protected median / holdout median), weighted by the protected count. */
function ratioOf(groups: readonly { h: number[]; p: number[] }[]): number {
  const total = groups.reduce((n, g) => n + g.p.length, 0)
  return groups.reduce((sum, g) => sum + (g.p.length / total) * (median(g.p) / median(g.h)), 0)
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function resample(xs: readonly number[], random: () => number): number[] {
  return xs.map(() => xs[Math.floor(random() * xs.length)]!)
}

/** A small seeded PRNG (mulberry32): the same seed, the same draws. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const cap = (f: string) => f[0]!.toUpperCase() + f.slice(1)

/** The page's sentence for a result; never a figure the data doesn't hold. */
export function proofClaim(p: ProofResult): string {
  if (p.kind === 'off') return 'Not proven yet: turn on measureHoldout in /config to measure what ccwarden saves.'
  if (p.kind === 'collecting') return `Not proven yet: ${p.holdout} of ${MIN_HOLDOUT} holdout sessions and ${p.protected} of ${MIN_PROTECTED} protected ones.`
  const range = `${Math.round(p.lowPct)}–${Math.round(p.highPct)}%`
  const counts = `${p.holdout} holdout vs ${p.protected} protected; ${p.families.map(cap).join(', ')}`
  const left = p.left.length === 0 ? '' : ` ${p.left.map(cap).join(', ')} left out: fewer than ${MIN_FAMILY_HOLDOUT} holdout sessions.`
  if (p.lowPct > 0) return `Protected sessions cost ${Math.round(p.lessPct)}% less per prompt (90% range ${range}; ${counts}).${left}`
  if (p.highPct < 0) return `Protected sessions cost ${Math.round(-p.lessPct)}% more per prompt (90% range ${Math.round(-p.highPct)}–${Math.round(-p.lowPct)}%; ${counts}).${left}`
  return `No clear difference yet (90% range ${Math.round(p.lowPct)}% to ${Math.round(p.highPct)}%).${left}`
}

/** Whether the per-feature estimates fit what the holdout measured. */
export function selfCheck(p: ProofResult): string | undefined {
  if (p.kind !== 'measured') return undefined
  const est = Math.round(p.estimatePct)
  const range = `${Math.round(p.lowPct)}–${Math.round(p.highPct)}%`
  if (p.estimatePct > p.highPct) return `The estimates look optimistic: they claim ${est}%, the holdout measured ${range}.`
  if (p.estimatePct < p.lowPct) return `The estimates look pessimistic: they claim ${est}%, the holdout measured ${range}.`
  return `The estimates agree with the holdout: they claim ${est}%, the holdout measured ${range}.`
}
```

Run: expect the proof tests to pass. If `Math.round(p.lessPct)` is not 23, recompute the medians by hand from the fixture before touching the code; the fixture's medians are 1.03 (holdout) and 0.79 (protected).

- [ ] **Step 4: Failing efficiency test** — add to `describe('F15 rows from the metrics log')`:

```ts
  test('the proof is worked out from the log\'s records of used projects', () => {
    const rec = (id: string, holdout: boolean, usd: number) => ({ ...newRecord({ session: id, project: '/p', now: Date.parse('2026-10-03T10:00:00Z'), measuring: true }), holdout, family: 'sonnet' as const, prompts: 10, usd })
    const files = Object.fromEntries([
      ...Array.from({ length: 12 }, (_, i) => rec(`h${i}`, true, 10)),
      ...Array.from({ length: 30 }, (_, i) => rec(`p${i}`, false, 7)),
    ].map(r => [r.session, { session: r.session, project: '/p', records: [r], days: { '2026-10-03': {} }, estUsd: 0, wouldUsd: 0, skipped: 0 }]))
    const p = efficiencyData({ ...FIXTURE, metrics: files }).proof
    expect(p.kind).toBe('measured')
    expect(efficiencyData(FIXTURE).proof).toEqual({ kind: 'off' })
  })
```

(import `newRecord` from `../src/metrics`).

- [ ] **Step 5: `EfficiencyData.proof`** — in `mod/src/efficiency.ts` import `proof` and `ProofResult` from `./proof`; add `proof: ProofResult` to `EfficiencyData`; in `efficiencyData`:

```ts
  const proofSessions = Object.values(input.metrics ?? {})
    .filter(m => used.has(m.project ?? UNATTRIBUTED))
    .flatMap(m => m.records.map(record => ({ record, estUsd: m.estUsd / Math.max(1, m.records.length) })))
```

and `proof: proof(proofSessions)` in the returned object. (`ponytail:` comment on the split: a file's estimate is spread evenly over its parts; per-part estimates when parts matter.)

- [ ] **Step 6: Proof section on the page** — in `mod/src/htmlDashboard.ts` import `proofClaim, selfCheck` and type `ProofResult`; add after the `<header>` (outside the ranges, the proof covers every session since measuring began):

```ts
function proofHtml(p: ProofResult): string {
  const claim = escapeHtml(proofClaim(p))
  if (p.kind === 'off') return `<section class="proof"><h2>Proof (holdout)</h2><p>${claim}</p></section>`
  if (p.kind === 'collecting') {
    const bar = (n: number, of: number) => `<span class="bar"><i style="width:${Math.min(100, (n / of) * 100).toFixed(0)}%"></i></span>`
    return `<section class="proof"><h2>Proof (holdout)</h2><p>${claim}</p><p class="dim">Holdout ${p.holdout}/${MIN_HOLDOUT}${bar(p.holdout, MIN_HOLDOUT)}Protected ${p.protected}/${MIN_PROTECTED}${bar(p.protected, MIN_PROTECTED)}</p></section>`
  }
  const lo = Math.min(-20, p.lowPct - 5)
  const hi = Math.max(40, p.highPct + 5)
  const x = (v: number) => (((v - lo) / (hi - lo)) * 600 + 60).toFixed(1)
  const svg = `<svg viewBox="0 0 720 60" role="img" aria-label="${claim}"><line class="axis" x1="60" x2="660" y1="30" y2="30"/><line class="zero" x1="${x(0)}" x2="${x(0)}" y1="12" y2="48"/><text class="axis" x="${x(0)}" y="58" text-anchor="middle">0%</text><line class="range" x1="${x(p.lowPct)}" x2="${x(p.highPct)}" y1="30" y2="30" data-tip="${escapeHtml(`90% range ${Math.round(p.lowPct)}% to ${Math.round(p.highPct)}%`)}"/><circle class="point" cx="${x(p.lessPct)}" cy="30" r="6" data-tip="${escapeHtml(`${Math.round(p.lessPct)}% less per prompt`)}"/><text class="axis" x="60" y="12">more per prompt</text><text class="axis" x="660" y="12" text-anchor="end">less per prompt</text></svg>`
  const check = selfCheck(p)
  return `<section class="proof"><h2>Proof (holdout)</h2><p class="total">${claim}</p>${svg}<p class="dim">Median per prompt: holdout $${p.holdoutMedian.toFixed(3)}, protected $${p.protectedMedian.toFixed(3)}.${check === undefined ? '' : ` ${escapeHtml(check)}`}</p></section>`
}
```

with `import { MIN_HOLDOUT, MIN_PROTECTED, proofClaim, selfCheck } from './proof'`, `${proofHtml(d.proof)}` right after `</header>`, and CSS:

```css
.proof{border-left:3px solid var(--on);padding-left:12px}.proof .total{font-size:16px;font-weight:600}
line.axis{stroke:var(--line)}line.zero{stroke:var(--dim);stroke-dasharray:3 3}line.range{stroke:var(--on);stroke-width:4;stroke-linecap:round}circle.point{fill:var(--on);stroke:var(--bg);stroke-width:2}
```

Add to `describe('F14 the page')`: `expect(html).toContain('Not proven yet: turn on measureHoldout in /config')`.

- [ ] **Step 7: Validate, run the suite; commit** — `git commit -m "F15-T4: the holdout proof: \$ per prompt by family, seeded 90% range, self-check"` (with the Co-Authored-By line).

---

### Task 5: The page

**Files:**
- Modify: `mod/src/efficiency.ts` (`View.activity`, `EfficiencyData.sessions`, `EfficiencyData.events`), `mod/src/htmlDashboard.ts`, `mod/hooks/register.tsx` (`readRecentEvents`)
- Test: `mod/tests/efficiency.test.ts`, `mod/tests/hooks.test.ts`

**Interfaces:**
- Consumes: `MetricsSummary`, `MetricEvent`, `ProofResult`, `proofClaim`.
- Produces: `EfficiencyInput.events?: SessionEvent[]` (`SessionEvent = MetricEvent & { session: string }`); `View.activity: { day: string; counts: Partial<Record<Feature, number>> }[]`; `EfficiencyData.sessions: SessionRow[]`, `EfficiencyData.events: SessionEvent[]` (newest first, at most 5,000, last 30 days); `summaryMarkdown(d: EfficiencyData): string`; `RECENT_EVENTS = 5_000`, `EVENTS_SHOWN = 100`.

- [ ] **Step 1: Failing tests** — add to `mod/tests/efficiency.test.ts`:

```ts
describe('F15 the page', () => {
  const DAY = Date.parse('2026-10-03T10:00:00Z')
  const r = { ...newRecord({ session: 's2', project: '/p', now: DAY, measuring: true }), family: 'sonnet' as const, prompts: 8, usd: 4 }
  const SUMMARY = { session: 's2', project: '/p', records: [r], estUsd: 1.5, wouldUsd: 0, skipped: 0, days: { '2026-10-03': { subagent: { done: { count: 2, tokens: 0, usd: 1.5 }, would: { count: 0, tokens: 0, usd: 0 } } } } }
  const evs = [
    { v: 1 as const, at: DAY, feature: 'subagent' as const, action: 'pinned', measured: { type: 'Explore' }, session: 's2' },
    { v: 1 as const, at: DAY + 1, feature: 'subagent' as const, action: 'outcome', measured: {}, est: { tokens: 0, usd: 1.5, formula: 'x', confidence: 'high' as const }, session: 's2' },
  ]
  const data = efficiencyData({ ...FIXTURE, metrics: { m: SUMMARY }, events: evs })
  const html = dashboardHtml(data)

  test('a verdict line per range, with the proof state', () => {
    expect(html).toMatch(/<p class="verdict">7 days: ccwarden saved ~[^<]+ est\.\) Not proven yet: turn on measureHoldout/)
  })

  test('activity per day by feature; sessions; the latest events', () => {
    expect(data.ranges['7d'].views['']!.activity.at(-1)!.counts).toEqual({ subagent: 2 })
    expect(data.sessions[0]).toMatchObject({ session: 's2', project: '/p', prompts: 8, usdPerPrompt: 0.5, estUsd: 1.5, holdout: false })
    expect(data.events.map(e => e.action)).toEqual(['outcome', 'pinned'])
    expect(html).toContain('data-session="s2"')
  })

  test('savings as bars, the table under How it is computed; tooltips instead of <title>', () => {
    expect(html).toContain('<details><summary>How it\'s computed</summary>')
    expect(html).toContain('class="hbar"')
    expect(html).toContain('data-tip=')
    expect(html).not.toContain('<title>ccwarden')
    expect(html.split('<title>').length).toBe(2) // only the page's own
  })

  test('copy summary and raw data are embedded, escaped, with one script still', () => {
    expect(html).toContain('<pre id="cw-summary" hidden>')
    expect(html).toContain('<pre id="cw-raw" hidden>')
    expect(html.split('<script').length).toBe(2)
    expect(summaryMarkdown(data)).toMatch(/^## ccwarden report \(2026-10-03\)\n- Saved \(est\., 30 days\): ~/)
    expect(summaryMarkdown(data)).toContain('- Proof: Not proven yet')
  })
})
```

(import `summaryMarkdown` from `../src/htmlDashboard`).

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Data in `mod/src/efficiency.ts`**

```ts
export const RECENT_EVENTS = 5_000
export type SessionEvent = MetricEvent & { session: string }
export type SessionRow = { session: string; project: string; startedAt: number; family?: Family; holdout: boolean; prompts: number; usd: number; usdPerPrompt?: number; estUsd: number }
```

- `EfficiencyInput.events?: SessionEvent[]` ("The last 30 days' events, newest first (F15).").
- `View.activity` in `viewOf`: for each day in the range, sum `done.count + would.count` per feature from `input.metrics` summaries that `isIn(m.project)`.
- `EfficiencyData.sessions`: one row per summary of a used project with a record started in the last 30 days: `prompts` and `usd` summed over its records, `startedAt` the first record's, `family`/`holdout` from the last record, `usdPerPrompt` when prompts > 0, `estUsd` the summary's; newest first.
- `EfficiencyData.events`: `(input.events ?? []).filter(used project of its session's summary or unknown).slice(0, RECENT_EVENTS)` (already newest first).

- [ ] **Step 4: The page in `mod/src/htmlDashboard.ts`**

- `verdictHtml(rangeLabel, v, proof)`: `<p class="verdict">${label}: ccwarden saved ~${tokens} tokens (~${usd} est.) ${escapeHtml(proofClaim(proof))}</p>`, first in each view (before the cards). Pass `d.proof` and the range label through `rangeHtml`.
- Savings: `savingsHtml` draws a horizontal bar per row with `usd !== 0` (`<div class="hbar"><span>${feature}</span><i class="${usd < 0 ? 'neg' : 'pos'}" style="width:${pct}%"></i><b>${usd(r.usd)} est.</b></div>`, widths against the largest `|usd|`), then the existing table inside `<details><summary>How it's computed</summary>…</details>`. The `<td class="saved">` cells stay as they are.
- Activity: `activityHtml(v)`: stacked bars per day like the spend chart, one colour slot per feature in the fixed order of `Feature` (`--s1`…`--s7`, `handoff` → `--other`), each rect with `data-tip="${day} · ${feature}: ${n}"`; a legend of features shown; "No ccwarden activity logged in this range." when empty. Place after the reality check.
- Sessions: `sessionsHtml(d)`: a table (date, project short name, model family, holdout yes/–, prompts, $ per prompt, saved est.) with `data-session="${escapeHtml(id)}"` on each row; a click filters the event viewer to that session. Place after Projects, outside the per-range views (the last 30 days).
- Event viewer: `eventsHtml(d)`: the first `EVENTS_SHOWN` events as table rows (`time`, `session` short, `feature`, `action`, `would` tag, `est` or `–`, measured as `k=v` pairs), each row `data-feature` and `data-session`; above it a `<select data-filter-feature>` with "All features" and each feature present, and the metrics folder's path as text (`<claude dir>/ccwarden/metrics`, passed in `EfficiencyData.metricsDir`, set by register).
- Copy and download: buttons `<button data-copy>Copy summary</button>` and `<button data-download>Download raw JSON</button>` in the header nav; `<pre id="cw-summary" hidden>${escapeHtml(summaryMarkdown(d))}</pre>` and `<pre id="cw-raw" hidden>${escapeHtml(JSON.stringify({ sessions: d.sessions, events: d.events }))}</pre>` before the footer.
- Tooltips: replace every `<title>…</title>` in chart rects with `data-tip="…"` and `tabindex="0"`; one `<div id="tip" role="tooltip" hidden></div>`.
- `summaryMarkdown(d)`:

```ts
export function summaryMarkdown(d: EfficiencyData): string {
  const v = d.ranges['30d'].views['']!
  const top = v.savings.filter(r => r.isInTotal && r.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 3)
  return [
    `## ccwarden report (${new Date(d.at).toISOString().slice(0, 10)})`,
    `- Saved (est., 30 days): ~${fmtTokens(Math.round(v.totalTokens))} tokens / ~${usd(v.totalUsd)}`,
    `- Proof: ${proofClaim(d.proof)}`,
    ...(top.length === 0 ? [] : [`- Top savings: ${top.map(r => `${r.feature} ~${usd(r.usd)}`).join(', ')}`]),
    `- Coverage: ${coverageLine(d.coverage)}; ${d.sessions.length} sessions in the metrics log`,
  ].join('\n')
}
```

- Script additions (inside the one `SCRIPT`):

```js
const tip=document.getElementById('tip');
function showTip(t){const r=t.getBoundingClientRect();tip.textContent=t.dataset.tip;tip.hidden=false;tip.style.left=(r.left+window.scrollX)+'px';tip.style.top=(r.top+window.scrollY-28)+'px';}
document.addEventListener('mouseover',e=>{const t=e.target.closest('[data-tip]');if(t)showTip(t);else tip.hidden=true;});
document.addEventListener('focusin',e=>{const t=e.target.closest('[data-tip]');if(t)showTip(t);});
let evFeature='',evSession='';
function filterEvents(){for(const r of document.querySelectorAll('tr[data-feature]'))r.hidden=(evFeature&&r.dataset.feature!==evFeature)||(evSession&&r.dataset.session!==evSession);}
document.addEventListener('change',e=>{if(e.target.matches('[data-filter-feature]')){evFeature=e.target.value;filterEvents();}});
document.addEventListener('click',e=>{
  const s=e.target.closest('tr[data-session]:not([data-feature])');if(s){evSession=evSession===s.dataset.session?'':s.dataset.session;filterEvents();}
  if(e.target.closest('[data-copy]')){const text=document.getElementById('cw-summary').textContent;navigator.clipboard.writeText(text).then(()=>{e.target.textContent='Copied';},()=>{const p=document.getElementById('cw-summary');p.hidden=false;getSelection().selectAllChildren(p);});}
  if(e.target.closest('[data-download]')){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([document.getElementById('cw-raw').textContent],{type:'application/json'}));a.download='ccwarden-metrics.json';a.click();}
});
```

CSS: `.verdict{font-size:16px;font-weight:600;margin:16px 0 0}.hbar{display:grid;grid-template-columns:200px 1fr 110px;gap:8px;align-items:center;margin:4px 0}.hbar i{display:block;height:10px;border-radius:2px}.hbar i.pos{background:var(--good)}.hbar i.neg{background:var(--bad)}.hbar b{text-align:right;font-weight:600}#tip{position:absolute;background:var(--fg);color:var(--bg);font-size:12px;padding:2px 6px;border-radius:4px;pointer-events:none;z-index:2}tr[data-session]{cursor:pointer}details summary{cursor:pointer;color:var(--dim)}`.

- [ ] **Step 5: `readRecentEvents` in register** — events of files modified in the last 30 days, newest first, at most `RECENT_EVENTS`:

```ts
/** F15: the last 30 days' events from the metrics files, newest first, at most RECENT_EVENTS. */
async function readRecentEvents($: $, dir: string, now: number): Promise<SessionEvent[]> {
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl') && now - f.mtimeMs <= 30 * DAY_MS && f.size <= MAX_TRANSCRIPT_BYTES)
  const out: SessionEvent[] = []
  for (const f of files) {
    const text = await $.fs.read(joinPath(dir, f.name)).catch(() => undefined)
    if (text === undefined) continue
    const session = f.name.replace(/\.jsonl$/, '')
    for (const e of parseFile(text).events) if (now - e.at <= 30 * DAY_MS) out.push({ ...e, session })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, RECENT_EVENTS)
}
```

(`const DAY_MS = 86_400_000`; pass `events: await readRecentEvents(...)` and `metricsDir` into `efficiencyData` in `writeEfficiency`, only when `canParse`; the session-end rewrite passes none.)

Hooks test, in `describe('F15 metrics log')`: after the `/cw open` test's flow, `expect(page).toContain('data-session="sess1"')`.

- [ ] **Step 6: Validate, run the whole suite; render the page from real data and look at it** (the dataviz rule: render it and look). Use the render script from F14's page pass (`node --experimental-strip-types` over a copy of `src/` with `.ts` import suffixes) and a headless Chrome screenshot; check light and dark, phone width (`--window-size=390,2400`), no overflow, labels readable.

- [ ] **Step 7: Commit** — `git commit -m "F15-T5: page: verdict, proof, savings bars, activity, sessions, event viewer, copy and download, tooltips"` (with the Co-Authored-By line).

---

### Task 6: Docs

**Files:**
- Modify: `docs/SPEC.md` (F15 "As built", §5 `measureHoldout`, §6 state keys `metricsSummaries` and `holdout`, §9: drop Q20 as answered by the types, keep Q21–Q23; files line), `docs/HANDOFF.md` (M5 status and live checks), `README.md` (proof mode in one paragraph), `docs/superpowers/specs/2026-10-03-metrics-proof-design.md` (status line: built; point at SPEC for the deltas)

- [ ] **Step 1:** Write SPEC F15 "As built" from the code: file location and format, each feature's event and formula (the Task 2 `LOGGED` table), the spec deltas above, holdout rules, proof thresholds and claim texts, the page sections, unverified live (Q21–Q23 and "F15 live: turn on measureHoldout, use it for 2–3 weeks, read the proof").
- [ ] **Step 2:** HANDOFF: an M5 paragraph under §1 and the live checks in "Still open".
- [ ] **Step 3:** `claude plugin validate mod && claude plugin test mod` one last time; expect `0 fail`.
- [ ] **Step 4: Commit** — `git commit -m "F15: docs: SPEC As built, config and state keys, open questions; HANDOFF; README"` (with the Co-Authored-By line).
