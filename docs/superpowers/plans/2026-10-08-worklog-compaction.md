# F3b Work-Log Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude Code compacts, ccwarden answers with a fixed snapshot plus a Haiku-written work log and a Resume block, so Claude continues the right task without redoing work, and a task that keeps compacting is stopped.

**Architecture:** Pure logic in three `mod/src/` files: `turns.ts` (reads turns, the running task and done steps out of `SessionMessage[]`), `worklog.ts` (the digest Haiku reads, its system prompt, reply parsing, the loop rule) and `snapshot.ts` (assembles the message: header, Haiku section, facts, Resume block; keeps a partial tail). Every `$` call stays in `mod/hooks/register.tsx`: the `$.model.complete` call, `$.state`, the loop counter and `$.turn.abort`.

**Tech Stack:** TypeScript Claude Code plugin ("mod"), tested with `claude plugin test mod` (`claude-code/testing`), no Node APIs.

**Spec:** `docs/superpowers/specs/2026-10-08-worklog-compaction-design.md`

## Global Constraints

- Work on branch `worklog-compaction-spec` (already checked out). One commit per task. Never push; never switch branches.
- Never hook `prompt.compose`, `prompt.context`, `tool.describe` or `skill.prompt`.
- Every `$` call lives in `mod/hooks/register.tsx`; `mod/src/` is pure (no `$`, no Node, no `require`, no dynamic `import()`).
- Code, comments, test names and commit messages in English. Match the surrounding style: short plain comments, no JSDoc essays.
- Commands, from the repo root `D:/New folder/ccwarden` (use the Bash tool, quote the path):
  - `claude plugin test mod` (the whole suite; ~95 s). Up to 3 F16 warden tests ("the chime plays once per cold spell…", "cold cache: the warden's row…") time out at 5000 ms on this machine on `main` too: ignore those, report any other failure.
  - `claude plugin validate mod` (must print `Validation passed`)
  - `npx -p typescript tsc -p mod --noEmit` (one error at `mod/tests/hooks.test.ts:153` is already on `main`; no new ones)
- Commit with `git add <files by name>` (never `git add mod`: it picks up the engine-written `tsconfig.json`), message ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec values: `compactMode` default `worklog`; `worklogModel` default `haiku`; `worklogCapUsd` default `0.5`; `compactLoopMax` default `3` (`0` never stops); digest budget 40k tokens (160000 characters); Haiku `maxTokens` 1500, `effort: 'low'`, `timeoutMs` 30000; failed-call excerpt 2000 characters; snapshot facts cap 10000 characters; Haiku section ≤ 6000 characters.

## Review Focus

- **One huge tool result** (a 2 MB Read or log): the digest must still be ≤ its budget, never the whole result. Test in Task 3.
- **A compaction with nothing to read** (no prompt, no assistant text, e.g. only a prior snapshot): no Haiku call, the plain snapshot, a boundary Resume block. Tests in Tasks 3 and 5.
- **A `worklogModel` the engine refuses** (typo, not allowed): `$.model.complete` rejects; the compaction must still answer with the plain snapshot and say why. Test in Task 5.
- **A Haiku reply without the expected headings, or "none" as next step:** the Resume block falls back to the last tool call. Test in Task 3 (`nextStepOf`) and Task 4 (`resumeText`).
- **`/clear` in the middle of a loop:** the loop count and the carried task start over. Test in Task 5.

---

### Task 1: Config: `worklog` mode and its settings

**Files:**
- Modify: `mod/src/config.ts`
- Modify: `mod/.claude-plugin/plugin.json` (the `compactMode` entry, ~line 57)
- Modify: `mod/src/snapshot.ts:35-42` (`planCompaction`)
- Test: `mod/tests/pure.test.ts`

**Interfaces:**
- Produces: `Config.compactMode: 'worklog' | 'snapshot' | 'summary'`, `Config.worklogModel: string`, `Config.worklogCapUsd: number`, `Config.compactLoopMax: number`; `planCompaction(e, mode: Config['compactMode']): CompactPlan` (`'worklog'` plans like `'snapshot'`).

- [ ] **Step 1: Write the failing tests**

In `mod/tests/pure.test.ts`, in the `describe` that holds `expect(readConfig({})).toEqual(DEFAULTS)` (~line 30), add a test:

```ts
  test('F3b: worklog is the default compaction; its model, cap and loop stop are read and checked', () => {
    expect(DEFAULTS).toMatchObject({ compactMode: 'worklog', worklogModel: 'haiku', worklogCapUsd: 0.5, compactLoopMax: 3 })
    expect(readConfig({ compactMode: 'snapshot' } as never).compactMode).toBe('snapshot')
    expect(readConfig({ compactMode: 'bogus' } as never).compactMode).toBe('worklog')
    expect(readConfig({ worklogModel: 'claude-haiku-5-5' } as never).worklogModel).toBe('claude-haiku-5-5')
    expect(readConfig({ worklogModel: '' } as never).worklogModel).toBe('haiku')
    expect(readConfig({ worklogCapUsd: 2 } as never).worklogCapUsd).toBe(2)
    expect(readConfig({ compactLoopMax: 0 } as never).compactLoopMax).toBe(0) // never stops
    expect(readConfig({ compactLoopMax: 1 } as never).compactLoopMax).toBe(2) // 1 would stop the first compaction
    expect(readConfig({ compactLoopMax: 4.7 } as never).compactLoopMax).toBe(4)
  })
```

In `describe('T3 snapshot', …)`, at the end of the test `'plan: snapshot by default, summary for a focus or summary mode, veto precompute'`, add:

```ts
    expect(planCompaction({ trigger: 'auto' }, 'worklog')).toBe('snapshot')
    expect(planCompaction({ trigger: 'precompute' }, 'worklog')).toBe('skip')
    expect(planCompaction({ trigger: 'manual', instructions: 'auth' }, 'worklog')).toBe('summary+facts')
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test mod 2>&1 | grep -E "^\(fail\)| pass$| fail$"`
Expected: the new F3b config test fails (`compactMode` is `snapshot`).

- [ ] **Step 3: Implement**

`mod/src/config.ts`:
- In `type Config`, replace `compactMode: 'snapshot' | 'summary'` with:
  ```ts
  compactMode: 'worklog' | 'snapshot' | 'summary'
  /** F3b: the model that writes the work log, and its $ cap per conversation. */
  worklogModel: string
  worklogCapUsd: number
  /** F3b: the compaction in one task (no typed prompt between) that stops the turn; 0 never stops. */
  compactLoopMax: number
  ```
- In `DEFAULTS`, replace `compactMode: 'snapshot',` with:
  ```ts
  compactMode: 'worklog',
  worklogModel: 'haiku',
  worklogCapUsd: 0.5,
  compactLoopMax: 3,
  ```
- In `readConfig`, replace the `compactMode:` line with:
  ```ts
    compactMode: pick('compactMode', ['worklog', 'snapshot', 'summary'], DEFAULTS.compactMode),
    worklogModel: typeof options.worklogModel === 'string' && options.worklogModel.trim() !== '' ? options.worklogModel.trim() : DEFAULTS.worklogModel,
    worklogCapUsd: num('worklogCapUsd'),
    compactLoopMax: loopMax(Math.floor(num('compactLoopMax'))),
  ```
  and add below `readConfig` (module level):
  ```ts
  /** 0 never stops; 1 would stop the first compaction, so the least is 2. */
  function loopMax(n: number): number {
    return n === 0 ? 0 : Math.max(2, n)
  }
  ```

`mod/.claude-plugin/plugin.json`: replace the `compactMode` entry and add three entries after it:

```json
    "compactMode": {
      "type": "string",
      "title": "Compaction",
      "description": "worklog: the mod builds the compacted conversation (a snapshot) and Haiku writes the state of work, about $0.03, no main-model summary. snapshot: the same without Haiku. summary: the engine's summary.",
      "options": [
        "worklog",
        "snapshot",
        "summary"
      ],
      "default": "worklog"
    },
    "worklogModel": {
      "type": "string",
      "title": "Work log: model",
      "description": "The model that writes the work log at a compaction (an alias such as haiku, or a full id).",
      "default": "haiku"
    },
    "worklogCapUsd": {
      "type": "number",
      "title": "Work log: max spend per conversation ($)",
      "description": "Past this estimate, compactions use the plain snapshot. Starts over on /clear.",
      "default": 0.5
    },
    "compactLoopMax": {
      "type": "number",
      "title": "Stop a task after this many compactions",
      "description": "Compactions in one task with no new typed prompt between them; at this one the turn is stopped so it doesn't keep spending. 0: never stop.",
      "default": 3
    },
```

`mod/src/snapshot.ts`, `planCompaction`: change the signature's `mode` to `mode: 'worklog' | 'snapshot' | 'summary'` and the precompute line to:

```ts
  if (e.trigger === 'precompute') return mode === 'summary' ? 'pass' : 'skip'
```

(`'worklog'` and `'snapshot'` both return `'snapshot'` below; the hook decides on Haiku.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `claude plugin test mod 2>&1 | grep -E "^\(fail\)| pass$| fail$"` and `claude plugin validate mod`
Expected: no new failures; `Validation passed`. If a pre-existing hooks test now fails only because the default changed to `worklog` and the world has no `model.complete` answer, leave it: Task 5 handles those. Report which ones.

- [ ] **Step 5: Commit**

```bash
git add mod/src/config.ts mod/.claude-plugin/plugin.json mod/src/snapshot.ts mod/tests/pure.test.ts
git commit -m "F3b: compactMode worklog (default), worklogModel, worklogCapUsd, compactLoopMax"
```

---

### Task 2: `turns.ts`: the running task, done steps, files read

**Files:**
- Create: `mod/src/turns.ts`
- Modify: `mod/src/snapshot.ts` (move `SNAPSHOT_TAG` and `isPrompt` out; import them)
- Modify: `mod/src/transcript.ts:3` (import `SNAPSHOT_TAG` from `./turns`)
- Test: create `mod/tests/compaction.test.ts`

**Interfaces:**
- Consumes: `relativeTo(path, cwd)`, `slashed(path)` from `mod/src/paths.ts`.
- Produces (all exported from `mod/src/turns.ts`):
  - `SNAPSHOT_TAG = '[ccwarden snapshot]'`
  - `isPrompt(m: SessionMessage): boolean`
  - `turnStarts(messages: readonly SessionMessage[]): number[]`
  - `type Shape = 'mid-turn' | 'boundary'`; `shapeOf(messages): Shape`
  - `type Turn = { ask: string; reply?: string; question?: string; status: 'done' | 'in progress' }`; `turnsOf(messages, shape: Shape): Turn[]`
  - `runningTurn(messages): { task?: string; added: string[]; body: SessionMessage[] }`
  - `readRange(input: Record<string, unknown>): string` (`''`, `':120-'`, `':120-179'`)
  - `callLine(tool: string, input: Record<string, unknown>): string`
  - `doneSteps(body: readonly SessionMessage[], cwd?: string): string[]`; `mergeSteps(earlier: readonly string[], later: readonly string[]): string[]`; `DONE_MAX = 25`
  - `lastCallOf(body: readonly SessionMessage[]): string | undefined`
  - `type FileRead = { path: string; range: string }`; `filesRead(messages): FileRead[]`
  - `oneLine(text: string, max: number): string`

- [ ] **Step 1: Write the failing tests**

Create `mod/tests/compaction.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { callLine, doneSteps, filesRead, isPrompt, lastCallOf, mergeSteps, runningTurn, shapeOf, turnsOf, turnStarts } from '../src/turns'

const msg = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
  ({ role, text, toolUses: [], handle: `h-${role}-${text}`, ...extra })
const use = (id: string, tool: string, input: Record<string, unknown>, text?: string, isError?: true) =>
  ({ tool_use_id: id, tool, input, ...(text === undefined ? {} : { text }), ...(isError === undefined ? {} : { isError }) })
const results = (id: string, text: string) => msg('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] })

// A finished turn, then a running one with a prompt the user queued mid-turn.
const convo = (): SessionMessage[] => [
  msg('user', 'Fix the login timeout bug'),
  msg('assistant', 'Edited auth.ts. Shall I also keep the old cookie name?', { toolUses: [use('e1', 'Edit', { file_path: '/p/src/auth.ts', new_string: 'x' }, 'ok')] }),
  msg('user', 'Ha'),
  msg('assistant', 'Kept it.'),
  msg('user', 'now run the e2e suite'),
  msg('assistant', 'Reading the config first.', { toolUses: [use('r1', 'Read', { file_path: '/p/e2e.config.ts', offset: 10, limit: 40 }, 'cfg')] }),
  results('r1', 'cfg'),
  msg('user', 'use the staging URL'), // queued during the turn
  msg('assistant', '', { toolUses: [use('b1', 'Bash', { command: 'npm run e2e' }, '2 failing', true)] }),
  results('b1', '2 failing'),
]

describe('F3b turns', () => {
  test('a prompt after a tool call or a tool result is added during a turn, not a new turn', () => {
    expect(turnStarts(convo())).toEqual([0, 2, 4])
    expect(isPrompt(msg('user', '[ccwarden snapshot] facts'))).toBe(false)
    expect(isPrompt(msg('user', '<command-name>/model</command-name>'))).toBe(false)
  })

  test('shape: mid-turn when the last message is a tool call or a tool result, else a boundary', () => {
    expect(shapeOf(convo())).toBe('mid-turn')
    expect(shapeOf(convo().slice(0, 4))).toBe('boundary')
    expect(shapeOf([...convo().slice(0, 4), msg('user', 'next ask')])).toBe('boundary')
    expect(shapeOf([])).toBe('boundary')
  })

  test('turns: the reply and status; a short reply carries the question it answered', () => {
    const turns = turnsOf(convo(), 'mid-turn')
    expect(turns).toHaveLength(3)
    expect(turns[0]).toEqual({ ask: 'Fix the login timeout bug', reply: 'Edited auth.ts. Shall I also keep the old cookie name?', status: 'done' })
    expect(turns[1]).toEqual({ ask: 'Ha', reply: 'Kept it.', question: 'Edited auth.ts. Shall I also keep the old cookie name?', status: 'done' })
    expect(turns[2]).toMatchObject({ ask: 'now run the e2e suite', reply: 'Reading the config first.', status: 'in progress' })
    expect(turnsOf(convo().slice(0, 4), 'boundary').every(t => t.status === 'done')).toBe(true)
  })

  test('the running turn: its prompt, prompts added during it, its messages', () => {
    const r = runningTurn(convo())
    expect(r.task).toBe('now run the e2e suite')
    expect(r.added).toEqual(['use the staging URL'])
    expect(r.body).toHaveLength(5)
    // After a compaction that kept only the end of a turn, no prompt is left.
    expect(runningTurn([msg('user', '[ccwarden snapshot] facts'), msg('assistant', 'More.')]).task).toBeUndefined()
  })

  test('call lines', () => {
    expect(callLine('Read', { file_path: '/p/a.ts' })).toBe('Read(/p/a.ts)')
    expect(callLine('Read', { file_path: '/p/a.ts', offset: 120, limit: 60 })).toBe('Read(/p/a.ts:120-179)')
    expect(callLine('Read', { file_path: '/p/a.ts', offset: 120 })).toBe('Read(/p/a.ts:120-)')
    expect(callLine('Bash', { command: 'git status\n  --short' })).toBe('Bash(git status --short)')
    expect(callLine('Grep', { pattern: 'isPrompt', path: 'mod/src' })).toBe('Grep(isPrompt in mod/src)')
    expect(callLine('Edit', { file_path: '/p/a.ts' })).toBe('Edit(/p/a.ts)')
    expect(callLine('Agent', { description: 'Find the tests' })).toBe('Agent(Find the tests)')
    expect(callLine('mcp__x__y', { q: 1 })).toBe('mcp__x__y({"q":1})')
  })

  test('done steps: only calls with a result, deduped, relative paths, failures named', () => {
    const steps = doneSteps(runningTurn(convo()).body, '/p')
    expect(steps).toEqual(['Read e2e.config.ts:10-49', 'Ran: npm run e2e → failed'])
    const inFlight = [msg('assistant', '', { toolUses: [use('w1', 'Write', { file_path: '/p/new.ts', content: 'x' })] })]
    expect(doneSteps(inFlight, '/p')).toEqual([]) // no result yet: not done
    const edits = [msg('assistant', '', { toolUses: [use('e1', 'Edit', { file_path: '/p/a.ts' }, 'ok'), use('e2', 'Edit', { file_path: '/p/a.ts' }, 'ok'), use('w1', 'Write', { file_path: 'C:\\p\\b.ts' }, 'ok')] })]
    expect(doneSteps(edits, '/p')).toEqual(['Edited a.ts', 'Wrote C:/p/b.ts'])
  })

  test('steps are capped at 25, newest kept; merging keeps earlier steps first', () => {
    const many = [msg('assistant', '', { toolUses: Array.from({ length: 30 }, (_, i) => use(`b${i}`, 'Bash', { command: `step ${i}` }, 'ok')) })]
    const steps = doneSteps(many)
    expect(steps).toHaveLength(25)
    expect(steps[0]).toBe('…and 6 earlier steps')
    expect(steps.at(-1)).toBe('Ran: step 29 → ok')
    expect(mergeSteps(['A', 'B'], ['B', 'C'])).toEqual(['A', 'B', 'C'])
  })

  test('the last call, and files read newest first', () => {
    expect(lastCallOf(convo())).toBe('Bash(npm run e2e) → 2 failing')
    expect(lastCallOf([msg('assistant', 'no tools')])).toBeUndefined()
    const reads = filesRead([
      msg('assistant', '', { toolUses: [use('r1', 'Read', { file_path: '/p/a.ts' }, 'x'), use('r2', 'Read', { file_path: '/p/b.ts', offset: 1, limit: 80 }, 'y')] }),
      msg('assistant', '', { toolUses: [use('r3', 'Read', { file_path: '/p/a.ts' }, 'x')] }),
    ])
    expect(reads).toEqual([{ path: '/p/a.ts', range: '' }, { path: '/p/b.ts', range: ':1-80' }])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test mod 2>&1 | grep -E "F3b turns|error|Cannot find| pass$| fail$" | head`
Expected: fails: `../src/turns` does not exist.

- [ ] **Step 3: Implement**

Create `mod/src/turns.ts`:

```ts
import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { relativeTo, slashed } from './paths'

// Reading a compacted conversation (F3b): which typed prompt started the
// running turn, what is done in it, and one-line forms of tool calls. Shared
// by the snapshot and the work-log digest. Pure.

/** Opens every snapshot message: ccwarden's own text, never an ask (transcript.ts drops it). */
export const SNAPSHOT_TAG = '[ccwarden snapshot]'
export const DONE_MAX = 25
const SHORT_REPLY_CHARS = 24

export type Shape = 'mid-turn' | 'boundary'
export type Turn = { ask: string; reply?: string; question?: string; status: 'done' | 'in progress' }
export type FileRead = { path: string; range: string }

/** A user message the person typed: not a tool result, a wrapper (`<command-name>`…) or a snapshot. */
export function isPrompt(m: SessionMessage): boolean {
  const text = m.text.trim()
  return m.role === 'user' && (m.toolResults?.length ?? 0) === 0 && text !== '' && !text.startsWith('<') && !text.startsWith(SNAPSHOT_TAG)
}

/** A tool call or a tool result: the turn goes on after it. */
function isWorking(m: SessionMessage | undefined): boolean {
  return m !== undefined && ((m.toolResults?.length ?? 0) > 0 || (m.role === 'assistant' && m.toolUses.length > 0))
}

/** The indexes of the prompts that start a turn; a prompt right after a tool call or result was added during one. */
export function turnStarts(messages: readonly SessionMessage[]): number[] {
  const starts: number[] = []
  messages.forEach((m, i) => {
    if (isPrompt(m) && !isWorking(messages[i - 1])) starts.push(i)
  })
  return starts
}

/** Mid-turn when the compaction came while Claude was working: the last message is a tool call or result. */
export function shapeOf(messages: readonly SessionMessage[]): Shape {
  return isWorking(messages.at(-1)) ? 'mid-turn' : 'boundary'
}

/** Each turn's prompt, the start of Claude's last text in it, and done or in progress. */
export function turnsOf(messages: readonly SessionMessage[], shape: Shape): Turn[] {
  const starts = turnStarts(messages)
  return starts.map((s, k) => {
    const body = messages.slice(s + 1, starts[k + 1] ?? messages.length)
    const reply = lastText(body)
    const question = lastText(messages.slice(0, s))
    const ask = messages[s]!.text.trim()
    const isShort = ask.length <= SHORT_REPLY_CHARS && ask.split(/\s+/).length <= 3
    return {
      ask,
      ...(reply === undefined ? {} : { reply }),
      ...(isShort && question !== undefined ? { question } : {}),
      status: k === starts.length - 1 && shape === 'mid-turn' ? 'in progress' : 'done',
    }
  })
}

/** The running turn: its prompt (undefined when it wasn't kept), prompts added during it, its messages. */
export function runningTurn(messages: readonly SessionMessage[]): { task?: string; added: string[]; body: SessionMessage[] } {
  const s = turnStarts(messages).at(-1)
  const body = messages.slice(s === undefined ? 0 : s + 1)
  return { ...(s === undefined ? {} : { task: messages[s]!.text.trim() }), added: body.filter(isPrompt).map(m => m.text.trim()), body }
}

/** A Read's line range as `:start-end` (offset is 1-based), `:start-` with no limit, '' for the default page. */
export function readRange(input: Record<string, unknown>): string {
  const offset = typeof input.offset === 'number' ? input.offset : undefined
  const limit = typeof input.limit === 'number' ? input.limit : undefined
  if (offset === undefined && limit === undefined) return ''
  const start = offset ?? 1
  return limit === undefined ? `:${start}-` : `:${start}-${start + limit - 1}`
}

/** One line naming a tool call: `Read(src/a.ts:1-80)`, `Bash(git status)`. */
export function callLine(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Read': return `Read(${str('file_path')}${readRange(input)})`
    case 'Bash': case 'PowerShell': return `${tool}(${oneLine(str('command'), 160)})`
    case 'Grep': return `Grep(${oneLine(str('pattern'), 160)}${str('path') === '' ? '' : ` in ${str('path')}`})`
    case 'Glob': return `Glob(${oneLine(str('pattern'), 160)})`
    case 'Edit': case 'MultiEdit': case 'Write': return `${tool}(${str('file_path')})`
    case 'NotebookEdit': return `NotebookEdit(${str('notebook_path')})`
    case 'Agent': case 'Task': return `${tool}(${oneLine(str('description'), 160)})`
    default: return `${tool}(${oneLine(JSON.stringify(input), 160)})`
  }
}

/** What the running turn did, from its tool calls: never a guess. Calls with no result yet are left out. */
export function doneSteps(body: readonly SessionMessage[], cwd?: string): string[] {
  const steps: string[] = []
  for (const m of body) {
    if (m.role !== 'assistant') continue
    for (const u of m.toolUses) {
      const step = stepOf(u, cwd)
      if (step !== undefined && !steps.includes(step)) steps.push(step)
    }
  }
  return capSteps(steps)
}

/** Steps carried from an earlier compaction of the same task, then this one's. */
export function mergeSteps(earlier: readonly string[], later: readonly string[]): string[] {
  return capSteps([...earlier.filter(s => !later.includes(s) && !s.startsWith('…and ')), ...later])
}

/** The running turn's last tool call and the start of its result: where to pick up without Haiku. */
export function lastCallOf(body: readonly SessionMessage[]): string | undefined {
  for (let i = body.length - 1; i >= 0; i--) {
    const u = body[i]!.toolUses.at(-1)
    if (u !== undefined) return `${callLine(u.tool, u.input)} → ${u.text === undefined ? '(no result yet)' : oneLine(u.text, 200)}`
  }
  return undefined
}

/** Files Read in these messages, with their ranges, newest first, each once. */
export function filesRead(messages: readonly SessionMessage[]): FileRead[] {
  const seen = new Set<string>()
  const reads: FileRead[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const u of [...messages[i]!.toolUses].reverse()) {
      if (u.tool !== 'Read' || typeof u.input.file_path !== 'string') continue
      const read = { path: slashed(u.input.file_path), range: readRange(u.input) }
      const key = `${read.path}${read.range}`
      if (seen.has(key)) continue
      seen.add(key)
      reads.push(read)
    }
  }
  return reads
}

/** Whitespace collapsed to single spaces, cut to `max` with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`
}

function lastText(messages: readonly SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.text.trim() !== '') return m.text.trim()
  }
  return undefined
}

function stepOf(u: ToolUseSummary, cwd?: string): string | undefined {
  if (u.text === undefined && u.isError !== true) return undefined // no result yet: not done
  const str = (k: string) => (typeof u.input[k] === 'string' ? (u.input[k] as string) : '')
  const rel = (k: string) => relativeTo(slashed(str(k)), cwd)
  const failed = u.isError === true
  switch (u.tool) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': {
      const file = rel(u.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path')
      return failed ? `${u.tool} of ${file} failed` : `${u.tool === 'Write' ? 'Wrote' : 'Edited'} ${file}`
    }
    case 'Read': return failed ? undefined : `Read ${rel('file_path')}${readRange(u.input)}`
    case 'Bash': case 'PowerShell': return `Ran: ${oneLine(str('command'), 100)} → ${failed ? 'failed' : 'ok'}`
    case 'Grep': case 'Glob': return `Searched: ${oneLine(str('pattern'), 80)}`
    default: return undefined
  }
}

function capSteps(steps: string[]): string[] {
  return steps.length <= DONE_MAX ? steps : [`…and ${steps.length - DONE_MAX + 1} earlier steps`, ...steps.slice(-(DONE_MAX - 1))]
}
```

In `mod/src/snapshot.ts`: delete `export const SNAPSHOT_TAG = '[ccwarden snapshot]'` and the private `function isPrompt(...)` at the bottom; add `import { isPrompt, SNAPSHOT_TAG } from './turns'` at the top and `export { SNAPSHOT_TAG }` right after the imports (other files import it from `./snapshot`).

In `mod/src/transcript.ts:3`: change `import { SNAPSHOT_TAG } from './snapshot'` to `import { SNAPSHOT_TAG } from './turns'`.

`relativeTo` check: open `mod/src/paths.ts` and confirm `relativeTo('/p/src/auth.ts', '/p')` gives `src/auth.ts` and that a path outside `cwd` (`C:/p/b.ts` vs `/p`) comes back unchanged; the test above relies on both.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `claude plugin test mod 2>&1 | grep -E "^\(fail\)| pass$| fail$"`, then `claude plugin validate mod`, then `npx -p typescript tsc -p mod --noEmit`
Expected: the F3b turns tests pass; nothing else newly fails; validate passes; no new tsc errors.

- [ ] **Step 5: Commit**

```bash
git add mod/src/turns.ts mod/src/snapshot.ts mod/src/transcript.ts mod/tests/compaction.test.ts
git commit -m "F3b: turns.ts: the running task, done steps, files read, call lines"
```

---

### Task 3: `worklog.ts`: the digest, the system prompt, the reply, the loop rule

**Files:**
- Create: `mod/src/worklog.ts`
- Test: `mod/tests/compaction.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `callLine`, `isPrompt`, `turnStarts` from `mod/src/turns.ts` (Task 2).
- Produces (exported from `mod/src/worklog.ts`):
  - `DIGEST_MAX_CHARS = 160_000`, `WORKLOG_MAX_TOKENS = 1_500`, `WORKLOG_TIMEOUT_MS = 30_000`, `WORKLOG_MAX_CHARS = 6_000`
  - `WORKLOG_SYSTEM: string`
  - `digest(messages: readonly SessionMessage[], maxChars?: number): string` (`''` when there is nothing to read)
  - `cutResult(use: ToolUseSummary): string`
  - `cleanWorklog(text: string): string` (headings `## ` → `### `, trimmed, ≤ 6000 chars)
  - `nextStepOf(worklog: string): string | undefined`
  - `loopAction(count: number, max: number): 'none' | 'warn' | 'stop'`

- [ ] **Step 1: Write the failing tests**

Append to `mod/tests/compaction.test.ts` (and add `import { cleanWorklog, cutResult, digest, loopAction, nextStepOf, WORKLOG_SYSTEM } from '../src/worklog'` to the imports):

```ts
describe('F3b work log', () => {
  const bigLog = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\n') + '\nFAILED: 2 tests'

  test('the digest: prompts, Claude\'s text, one line per call, results under their call', () => {
    const d = digest(convo())
    expect(d).toContain('User: Fix the login timeout bug')
    expect(d).toContain('Claude: Reading the config first.')
    expect(d).toContain('→ Read(/p/e2e.config.ts:10-49)\n  ⎿ cfg')
    expect(d).toContain('→ Bash(npm run e2e) (failed)\n  ⎿ 2 failing')
    expect(d).toContain('User: use the staging URL') // added during the turn
    expect(d.indexOf('Fix the login')).toBeLessThan(d.indexOf('npm run e2e')) // oldest first
    expect(digest([])).toBe('')
    expect(digest([msg('user', '[ccwarden snapshot] facts')])).toBe('')
  })

  test('results fill newest first: whole while they fit, then cut by tool', () => {
    const messages = [
      msg('user', 'go'),
      msg('assistant', '', { toolUses: [use('b0', 'Bash', { command: 'old' }, bigLog)] }),
      results('b0', bigLog),
      msg('assistant', '', { toolUses: [use('b1', 'Bash', { command: 'new' }, bigLog)] }),
      results('b1', bigLog),
    ]
    const d = digest(messages, bigLog.length + 3_000)
    expect(d).toContain(`→ Bash(new)\n  ⎿ ${bigLog}`) // the newest, whole
    expect(d).toContain('characters cut]') // the older one, head and tail
    expect(d).toContain('FAILED: 2 tests\n→ Bash(new)') // the cut keeps the tail
    expect(d.length).toBeLessThanOrEqual(bigLog.length + 3_000)
  })

  test('one huge result never takes the digest past its budget', () => {
    const huge = 'x'.repeat(2_000_000)
    const d = digest([msg('user', 'read it'), msg('assistant', '', { toolUses: [use('r', 'Read', { file_path: '/p/huge.log' }, huge)] })], 10_000)
    expect(d.length).toBeLessThanOrEqual(10_000)
    expect(d).toContain('User: read it')
  })

  test('the oldest turns go when even the skeleton is too big; the last turn stays', () => {
    const turns = Array.from({ length: 50 }, (_, i) => [msg('user', `ask ${i} ${'w'.repeat(200)}`), msg('assistant', `answer ${i}`)]).flat()
    const d = digest(turns, 2_000)
    expect(d).toMatch(/^\(\d+ earlier turns left out\)/)
    expect(d).toContain('answer 49')
    expect(d.length).toBeLessThanOrEqual(2_000)
  })

  test('cut rules by tool', () => {
    expect(cutResult(use('a', 'Bash', { command: 'x' }, bigLog))).toMatch(/^line 0[\s\S]*characters cut[\s\S]*FAILED: 2 tests$/)
    expect(cutResult(use('a', 'Bash', { command: 'x' }, bigLog, true)).length).toBeLessThanOrEqual(2_100)
    expect(cutResult(use('a', 'Grep', { pattern: 'p' }, bigLog))).toMatch(/^line 0\nline 1[\s\S]*\n…\[more cut\]$/)
    expect(cutResult(use('a', 'Read', { file_path: '/p/a' }, bigLog))).toBe('')
    expect(cutResult(use('a', 'Edit', { file_path: '/p/a', new_string: 'const timeout = 30' }, 'ok'))).toBe('changed: const timeout = 30')
  })

  test('the system prompt names the sections; the reply is demoted under ours and capped', () => {
    for (const s of ['## Done', '## In progress', '## Pending', '## Key findings', '## Next step']) expect(WORKLOG_SYSTEM).toContain(s)
    expect(cleanWorklog('\n## Done\n- a\n## Next step\n- b\n')).toBe('### Done\n- a\n### Next step\n- b')
    expect(cleanWorklog('z'.repeat(10_000)).length).toBeLessThanOrEqual(6_000)
  })

  test('the next step: its lines without bullets; none or missing is undefined', () => {
    expect(nextStepOf('### Done\n- a\n### Next step\n- fix the 2 failing tests in src/x.ts\n')).toBe('fix the 2 failing tests in src/x.ts')
    expect(nextStepOf('### Next step\n- run npm test\n- then commit\n### Notes\n- n')).toBe('run npm test; then commit')
    expect(nextStepOf('### Next step\n- none')).toBeUndefined()
    expect(nextStepOf('no headings at all')).toBeUndefined()
  })

  test('the loop rule: warn from the 2nd compaction, stop at the max, 0 never stops', () => {
    expect(loopAction(1, 3)).toBe('none')
    expect(loopAction(2, 3)).toBe('warn')
    expect(loopAction(3, 3)).toBe('stop')
    expect(loopAction(9, 0)).toBe('warn')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test mod 2>&1 | grep -E "F3b work log|Cannot find| pass$| fail$" | head`
Expected: fails: `../src/worklog` does not exist.

- [ ] **Step 3: Implement**

Create `mod/src/worklog.ts`:

```ts
import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { callLine, isPrompt, turnStarts } from './turns'

// F3b work log: the digest of a conversation that Haiku reads at a
// compaction to write the state of the work, what is done with its reply,
// and when a task that keeps compacting is warned or stopped. Pure: the call
// is in hooks/register.tsx.

export const DIGEST_MAX_CHARS = 160_000 // 40k tokens at 4 characters a token
export const WORKLOG_MAX_TOKENS = 1_500
export const WORKLOG_TIMEOUT_MS = 30_000
export const WORKLOG_MAX_CHARS = 6_000
const PROMPT_CHARS = 4_000
const TEXT_CHARS = 1_500
const FAILED_CHARS = 2_000
const RESULT_MARK = '\n  ⎿ '
const NOTE_ROOM = 40 // "(N earlier turns left out)\n"
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export const WORKLOG_SYSTEM = [
  'You read a digest of a Claude Code conversation that is about to be compacted, and write the state of the work for the assistant that continues it.',
  'Write exactly these sections, in this order, as Markdown headings:',
  '## Done',
  '## In progress',
  '## Pending',
  '## Key findings',
  '## Next step',
  'Under each, short bullet points. Use the exact file paths, function names, commands and line numbers from the digest; no generic statements.',
  'Done: requests and steps that were finished. In progress: what was being done when the digest ends, if anything. Pending: what the user asked for that is not done yet.',
  'Key findings: facts learned from tool results that the next steps need (where something is defined, what a failure said, a decision and its reason).',
  'Next step: the single next action. Write nothing the digest does not support; write "none" under an empty section.',
].join('\n')

type Item = { line: string; use?: ToolUseSummary; result?: string }

/**
 * What Haiku reads: prompts, Claude's text and one line per tool call, oldest
 * first, then tool results filled newest first: whole while they fit, else cut
 * by tool, else left out. The oldest turns go first when even that is too big.
 */
export function digest(messages: readonly SessionMessage[], maxChars = DIGEST_MAX_CHARS): string {
  const starts = new Set(turnStarts(messages))
  const turns: Item[][] = [[]]
  messages.forEach((m, i) => {
    if (starts.has(i)) turns.push([])
    const turn = turns.at(-1)!
    if (isPrompt(m)) turn.push({ line: `User: ${cut(m.text.trim(), PROMPT_CHARS)}` })
    if (m.role !== 'assistant') return
    if (m.text.trim() !== '') turn.push({ line: `Claude: ${cut(m.text.trim(), TEXT_CHARS)}` })
    for (const use of m.toolUses) turn.push({ line: `→ ${callLine(use.tool, use.input)}${use.isError === true ? ' (failed)' : ''}`, use })
  })
  let kept = turns.filter(t => t.length > 0)
  if (kept.length === 0) return ''
  const skeleton = () => kept.reduce((n, t) => n + t.reduce((k, item) => k + item.line.length + 1, 0), 0)
  // Once turns are dropped, leave room for the note that says so.
  let dropped = 0
  const room = () => (dropped > 0 ? maxChars - NOTE_ROOM : maxChars)
  while (kept.length > 1 && skeleton() > room()) {
    kept = kept.slice(1)
    dropped++
  }
  let left = room() - skeleton()
  for (const item of kept.flat().filter(i => i.use !== undefined).reverse()) {
    const whole = fullResult(item.use!)
    const short = cutResult(item.use!)
    const pick = whole.length + RESULT_MARK.length <= left ? whole : short.length + RESULT_MARK.length <= left ? short : ''
    if (pick === '') continue
    item.result = pick
    left -= pick.length + RESULT_MARK.length
  }
  const note = dropped > 0 ? `(${dropped} earlier turn${dropped === 1 ? '' : 's'} left out)\n` : ''
  const text = note + kept.flat().map(i => (i.result === undefined ? i.line : `${i.line}${RESULT_MARK}${i.result}`)).join('\n')
  return text.length <= maxChars ? text : text.slice(text.length - maxChars)
}

/** A result cut to what matters for its tool: the end of a command, the matches of a search, the change of an edit. */
export function cutResult(use: ToolUseSummary): string {
  if (EDIT_TOOLS.has(use.tool)) return changeOf(use.input)
  const text = use.text ?? ''
  if (use.isError === true) return headTail(text, FAILED_CHARS / 4, (FAILED_CHARS * 3) / 4)
  switch (use.tool) {
    case 'Bash': case 'PowerShell': return headTail(text, 300, 900)
    case 'Grep': case 'Glob': return headLines(text, 1_200)
    case 'Read': return '' // the content is on disk; the call line names the range
    default: return headTail(text, 400, 400)
  }
}

/** Haiku's reply under our own heading: its `## ` headings become `### `, capped. */
export function cleanWorklog(text: string): string {
  return cut(text.trim().replace(/^## /gm, '### '), WORKLOG_MAX_CHARS)
}

/** The work log's Next step, its lines joined without bullets; undefined for none or no such section. */
export function nextStepOf(worklog: string): string | undefined {
  const m = /^#{2,3} Next step[^\n]*\n([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/m.exec(worklog)
  const lines = (m?.[1] ?? '').split('\n').map(l => l.replace(/^\s*[-*]\s*/, '').trim()).filter(l => l !== '')
  if (lines.length === 0 || (lines.length === 1 && /^none\.?$/i.test(lines[0]!))) return undefined
  return lines.join('; ')
}

/** The nth compaction with no typed prompt since: warn from the 2nd, stop at `max` (0: never). */
export function loopAction(count: number, max: number): 'none' | 'warn' | 'stop' {
  if (max > 0 && count >= max) return 'stop'
  return count >= 2 ? 'warn' : 'none'
}

function fullResult(use: ToolUseSummary): string {
  return EDIT_TOOLS.has(use.tool) ? changeOf(use.input) : use.text ?? ''
}

function changeOf(input: Record<string, unknown>): string {
  const edits = Array.isArray(input.edits) ? (input.edits as { new_string?: unknown }[]) : []
  const text = input.new_string ?? input.content ?? input.new_source ?? edits[0]?.new_string
  return typeof text === 'string' && text !== '' ? `changed: ${cut(text, 400)}` : ''
}

function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text
  return `${text.slice(0, head)}\n…[${text.length - head - tail} characters cut]…\n${text.slice(-tail)}`
}

function headLines(text: string, max: number): string {
  if (text.length <= max) return text
  const end = text.lastIndexOf('\n', max)
  return `${text.slice(0, end > 0 ? end : max)}\n…[more cut]`
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `claude plugin test mod 2>&1 | grep -E "^\(fail\)| pass$| fail$"`, `claude plugin validate mod`, `npx -p typescript tsc -p mod --noEmit`
Expected: F3b work log tests pass; no new failures or tsc errors.

- [ ] **Step 5: Commit**

```bash
git add mod/src/worklog.ts mod/tests/compaction.test.ts
git commit -m "F3b: worklog.ts: the digest Haiku reads, its prompt and reply, the loop rule"
```

---

### Task 4: `snapshot.ts`: turns with status, files read, the Resume block, a partial tail

**Files:**
- Modify: `mod/src/snapshot.ts`
- Test: `mod/tests/pure.test.ts` (update `describe('T3 snapshot')`), `mod/tests/compaction.test.ts` (append)

**Interfaces:**
- Consumes: `SNAPSHOT_TAG`, `isPrompt`, `oneLine`, `Turn`, `FileRead`, `Shape` from `./turns` (Task 2).
- Produces:
  - `SnapshotFacts` gains optional `turns?: readonly Turn[]` and `reads?: readonly FileRead[]`.
  - `SNAPSHOT_MAX_CHARS = 10_000`
  - `snapshotText(f, opts: { cwd?: string; maxChars?: number; keptTurns: number; isPartialTail?: boolean; worklog?: string; resume?: string }): string`
  - `keptTail(messages, budgetChars): { tail: SessionMessage[]; turns: number; isPartial: boolean }`
  - `type Resume = { shape: Shape; task?: string; added: readonly string[]; done: readonly string[]; next?: { text: string; isHaiku: boolean }; loopCount: number }`; `resumeText(r: Resume): string`

- [ ] **Step 1: Write the failing tests**

In `mod/tests/pure.test.ts`, `describe('T3 snapshot')`, replace the body of `'tail: two turns when they fit, else one, else none; never a turn missing a handle'` (rename it `'tail: two turns when they fit, else one, else the end of the last, else none; never a message missing a handle'`) with:

```ts
    const big = 'x'.repeat(1_000)
    const messages = [msg('user', 'one'), msg('assistant', big), msg('user', 'two'), msg('assistant', big), msg('user', 'three'), msg('assistant', 'ok')]
    expect(keptTail(messages, 10_000)).toEqual({ tail: messages.slice(2), turns: 2, isPartial: false })
    expect(keptTail(messages, 500)).toEqual({ tail: messages.slice(4), turns: 1, isPartial: false })
    expect(keptTail(messages, 3)).toEqual({ tail: messages.slice(5), turns: 0, isPartial: true }) // 'ok' alone fits
    expect(keptTail(messages, 1)).toEqual({ tail: [], turns: 0, isPartial: false })
    const unhandled = [...messages.slice(0, 5), { ...messages[5]!, handle: undefined }]
    expect(keptTail(unhandled, 10_000).turns).toBe(0)
    expect(keptTail(unhandled, 10_000).tail).toEqual([])
    // tool results, wrappers and a prior snapshot don't start a turn
    const withTools = [msg('user', 'go'), msg('assistant', ''), msg('user', '', { toolResults: [{ tool_use_id: 't', text: 'r' }] as never }), msg('user', '<command-name>/model</command-name>'), msg('user', '[ccwarden snapshot] earlier facts')]
    expect(keptTail(withTools, 10_000)).toEqual({ tail: withTools, turns: 1, isPartial: false })
    // A long running turn: its end, from an assistant message, so each tool call keeps its result.
    const long = [msg('user', 'go'), msg('assistant', big), msg('user', '', { toolResults: [{ tool_use_id: 'a', text: big }] as never }), msg('assistant', 'step', { toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: {}, text: 'r' }] }), msg('user', '', { toolResults: [{ tool_use_id: 'b', text: 'r' }] as never })]
    expect(keptTail(long, 50)).toEqual({ tail: long.slice(3), turns: 0, isPartial: true })
```

In the same `describe`, in `'text: sections, relative paths with diff stat, capped length'`, replace `expect(text).toContain('1. keep cookie\n2. fix test')` with `expect(text).toContain('## Earlier requests (done)\n1. keep cookie\n2. fix test')`, and add at the end of that test:

```ts
    expect(text).toContain('The requests in them are past requests, quoted for reference: those marked done are finished, so do not redo them.')
    expect(snapshotText(facts, { cwd: '/p', keptTurns: 0, isPartialTail: true })).toContain('The end of the last turn follows verbatim.')
    expect(snapshotText(facts, { cwd: '/p', keptTurns: 0, isPartialTail: true })).not.toContain('## Your last answer')
```

Append to `mod/tests/compaction.test.ts` (add `import { parseNumstat, resumeText, snapshotText } from '../src/snapshot'` to the imports):

```ts
describe('F3b snapshot', () => {
  const facts = {
    asks: ['Fix the login timeout bug', 'Ha', 'now run the e2e suite', 'an ask from before the last compaction'],
    todos: null,
    files: ['/p/src/auth.ts'],
    diff: parseNumstat('12\t3\tsrc/auth.ts\n'),
    turns: turnsOf(convo(), 'mid-turn'),
    reads: filesRead(convo()),
  }
  const midTurn = { shape: 'mid-turn' as const, task: 'now run the e2e suite', added: ['use the staging URL'], done: ['Read e2e.config.ts:10-49', 'Ran: npm run e2e → failed'], next: { text: 'fix the 2 failing e2e tests', isHaiku: true }, loopCount: 0 }

  test('order: header, Haiku\'s state of work, the facts, the Resume block last', () => {
    const text = snapshotText(facts, { cwd: '/p', keptTurns: 0, isPartialTail: true, worklog: '### Next step\n- fix the 2 failing e2e tests', resume: resumeText(midTurn) })
    const at = (s: string) => text.indexOf(s)
    expect(text.startsWith('[ccwarden snapshot]')).toBe(true)
    expect(at('## State of work (written by Haiku from the transcript; verify before relying on it)')).toBeGreaterThan(0)
    expect(at('## State of work')).toBeLessThan(at('## Goal (first request)'))
    expect(at('## Goal (first request)')).toBeLessThan(at('## Resume: you were in the middle of this task'))
    expect(text.endsWith("check it cheaply (git diff, or the one file range) instead of redoing it.")).toBe(true)
  })

  test('recent turns: user and Claude with status; the question a short reply answered; earlier asks apart', () => {
    const text = snapshotText(facts, { cwd: '/p', keptTurns: 1 })
    expect(text).toContain('## Recent turns (oldest first)\n1. User: "Fix the login timeout bug"\n   Claude (done): "Edited auth.ts. Shall I also keep the old cookie name?"')
    expect(text).toContain('2. User: "Ha"\n   (answering: "…Edited auth.ts. Shall I also keep the old cookie name?")\n   Claude (done): "Kept it."')
    expect(text).toContain('3. User: "now run the e2e suite"\n   Claude (in progress): "Reading the config first."')
    expect(text).toContain('## Earlier requests (done)\n1. an ask from before the last compaction')
    expect(text).toContain('## Files read (most recent first; re-read only the range you need)\n- e2e.config.ts:10-49')
  })

  test('recent turns fill from the newest within their share', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ask: `ask ${i} ${'w'.repeat(100)}`, reply: 'ok', status: 'done' as const }))
    const text = snapshotText({ ...facts, turns: many, asks: [] }, { keptTurns: 0 })
    expect(text).toContain('60. User: "ask 59')
    expect(text).not.toContain('1. User: "ask 0 ')
    expect(text.length).toBeLessThanOrEqual(10_000)
  })

  test('the Resume block: mid-turn names the task, added prompts, done steps and the next step', () => {
    const r = resumeText(midTurn)
    expect(r).toBe([
      '## Resume: you were in the middle of this task',
      "Current task (the user's request, verbatim):",
      '  "now run the e2e suite"',
      'Added by the user during the task:',
      '  - "use the staging URL"',
      '',
      'Already done in this task (from the transcript, not a guess):',
      '  - Read e2e.config.ts:10-49',
      '  - Ran: npm run e2e → failed',
      "Next step (Haiku's reading of the transcript): fix the 2 failing e2e tests",
      '',
      "Resume this task now from the next step. Don't start it over, don't redo the steps above, and don't work on any other request. Don't ask the user whether to continue. If unsure whether a step is done, check it cheaply (git diff, or the one file range) instead of redoing it.",
    ].join('\n'))
  })

  test('the Resume block without Haiku, without the task, at a boundary, and in a loop', () => {
    const noHaiku = resumeText({ ...midTurn, task: undefined, added: [], done: [], next: { text: 'Bash(npm run e2e) → 2 failing', isHaiku: false } })
    expect(noHaiku).toContain('  "(not in the kept messages; see Recent turns)"')
    expect(noHaiku).toContain('  (none recorded)')
    expect(noHaiku).toContain('Next step: continue after the last step: Bash(npm run e2e) → 2 failing')
    expect(noHaiku).not.toContain('Added by the user')
    expect(resumeText({ ...midTurn, next: undefined })).not.toContain('Next step')
    expect(resumeText({ shape: 'boundary', added: [], done: [], loopCount: 0 })).toBe("## Resume\nAll requests above are answered and done; work only on the user's message that follows.")
    expect(resumeText({ ...midTurn, loopCount: 2 })).toMatch(/instead of redoing it\.\nThis task was compacted 2 times; the context refills because of re-reading\. Read only the ranges you need, prefer Grep, and don't re-read the files listed above\.$/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test mod 2>&1 | grep -E "^\(fail\)| pass$| fail$"`
Expected: the updated T3 tail/text tests and the F3b snapshot tests fail (`isPartial`, `resumeText` missing).

- [ ] **Step 3: Implement**

In `mod/src/snapshot.ts`:

1. Imports at the top:
   ```ts
   import type { SessionCompactTrigger, SessionMessage } from 'claude-code'
   import { relativeTo } from './paths'
   import type { Todo } from './transcript'
   import { isPrompt, oneLine, SNAPSHOT_TAG } from './turns'
   import type { FileRead, Shape, Turn } from './turns'

   export { SNAPSHOT_TAG }
   ```
2. In `SnapshotFacts`, add after `lastAnswer?: string`:
   ```ts
     /** F3b: the turns of the messages compacted, with Claude's reply and status. */
     turns?: readonly Turn[]
     /** F3b: files Read in the messages compacted, with ranges, newest first. */
     reads?: readonly FileRead[]
   ```
3. Constants: `SNAPSHOT_MAX_CHARS = 10_000`; add `const MAX_READS = 30`, `const TURNS_SHARE = 0.4`, `const REPLY_CHARS = 200`, `const QUESTION_CHARS = 160`, `const ASK_CHARS = 300`.
4. Replace `snapshotText` with:

```ts
/**
 * The snapshot message: a header, Haiku's state of work (F3b, when written),
 * the facts the next turns need (capped at `maxChars`), and the Resume block
 * last, so it is what Claude reads just before the kept tail.
 */
export function snapshotText(f: SnapshotFacts, opts: { cwd?: string; maxChars?: number; keptTurns: number; isPartialTail?: boolean; worklog?: string; resume?: string }): string {
  const max = opts.maxChars ?? SNAPSHOT_MAX_CHARS
  const sections: string[] = []
  const goal = goalOf(f)
  if (goal !== undefined) sections.push(`## Goal (first request)\n${cut(goal, max * 0.25)}`)
  const turns = f.turns ?? []
  if (turns.length > 0) sections.push(`## Recent turns (oldest first)\n${turnLines(turns, max * TURNS_SHARE)}`)
  const inTurns = new Set(turns.map(t => t.ask))
  const earlier = f.asks.filter(a => a !== goal && !inTurns.has(a)).slice(-RECENT_ASKS)
  if (earlier.length > 0) {
    const each = (max * 0.2) / earlier.length
    sections.push(`## Earlier requests (done)\n${earlier.map((a, i) => `${i + 1}. ${cut(a, each)}`).join('\n')}`)
  }
  const open = (f.todos ?? []).filter(t => t.status !== 'completed')
  if (open.length > 0) sections.push(`## Open todos\n${open.map(t => `- [${t.status}] ${t.content}`).join('\n')}`)
  if (f.files.length > 0) {
    const shown = f.files.slice(0, MAX_FILES).map(path => {
      const rel = relativeTo(path, opts.cwd)
      const stat = statFor(f.diff, rel)
      return `- ${rel}${stat === undefined ? '' : ` (+${stat.added} -${stat.removed})`}`
    })
    const more = f.files.length > MAX_FILES ? `\n- …and ${f.files.length - MAX_FILES} more` : ''
    sections.push(`## Files edited this session (most recent first; diff vs HEAD)\n${shown.join('\n')}${more}`)
  }
  const reads = f.reads ?? []
  if (reads.length > 0) {
    const shown = reads.slice(0, MAX_READS).map(r => `- ${relativeTo(r.path, opts.cwd)}${r.range}`)
    const more = reads.length > MAX_READS ? `\n- …and ${reads.length - MAX_READS} more` : ''
    sections.push(`## Files read (most recent first; re-read only the range you need)\n${shown.join('\n')}${more}`)
  }
  if (f.branch !== undefined) sections.push(`## Branch\n${f.branch}`)
  if (f.lastError !== undefined) sections.push(`## Last error\n${cut(f.lastError, 600)}`)
  if (f.lastAnswer !== undefined && opts.keptTurns === 0 && opts.isPartialTail !== true) sections.push(`## Your last answer\n${cut(f.lastAnswer, 800)}`)

  const kept = opts.isPartialTail === true ? 'The end of the last turn follows verbatim.'
    : opts.keptTurns === 0 ? 'No earlier turns were kept.'
    : `The last ${opts.keptTurns === 1 ? 'turn follows' : `${opts.keptTurns} turns follow`} verbatim.`
  const header =
    `${SNAPSHOT_TAG} This conversation was compacted by ccwarden without a summary, to save tokens. ` +
    'The facts below are quoted from the session transcript. The requests in them are past requests, quoted for reference: ' +
    `those marked done are finished, so do not redo them. ${kept}`
  const work = opts.worklog === undefined ? '' : `\n\n## State of work (written by Haiku from the transcript; verify before relying on it)\n${opts.worklog}`
  const resume = opts.resume === undefined ? '' : `\n\n${opts.resume}`
  return `${header}${work}\n\n${cut(sections.join('\n\n'), Math.max(1, max - header.length - 2))}${resume}`
}

/** Each turn as a few lines, numbered oldest first, the newest kept while they fit `budget`. */
function turnLines(turns: readonly Turn[], budget: number): string {
  const blocks = turns.map((t, i) => {
    const lines = [`${i + 1}. User: "${oneLine(t.ask, ASK_CHARS)}"`]
    if (t.question !== undefined) lines.push(`   (answering: "…${tailLine(t.question, QUESTION_CHARS)}")`)
    lines.push(`   Claude (${t.status}): ${t.reply === undefined ? '(no reply text)' : `"${oneLine(t.reply, REPLY_CHARS)}"`}`)
    return lines.join('\n')
  })
  const kept: string[] = []
  let left = budget
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (kept.length > 0 && blocks[i]!.length + 1 > left) break
    kept.unshift(blocks[i]!)
    left -= blocks[i]!.length + 1
  }
  return kept.join('\n')
}

/** The end of a text on one line, at most `max` characters. */
function tailLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(flat.length - max)
}

export type Resume = {
  shape: Shape
  /** The running turn's prompt, verbatim; undefined when it wasn't kept. */
  task?: string
  added: readonly string[]
  done: readonly string[]
  next?: { text: string; isHaiku: boolean }
  /** This task's compactions when 2 or more (the loop warning), else 0. */
  loopCount: number
}

/** The Resume block (F3b): what to continue and how, or, at a boundary, that everything above is done. */
export function resumeText(r: Resume): string {
  const warn = r.loopCount >= 2
    ? `\nThis task was compacted ${r.loopCount} times; the context refills because of re-reading. Read only the ranges you need, prefer Grep, and don't re-read the files listed above.`
    : ''
  if (r.shape === 'boundary') return `## Resume\nAll requests above are answered and done; work only on the user's message that follows.${warn}`
  const task = r.task === undefined || r.task === '' ? '(not in the kept messages; see Recent turns)' : cut(r.task, 2_000)
  const lines = ['## Resume: you were in the middle of this task', "Current task (the user's request, verbatim):", `  "${task}"`]
  if (r.added.length > 0) lines.push('Added by the user during the task:', ...r.added.map(a => `  - "${cut(a, 500)}"`))
  lines.push('', 'Already done in this task (from the transcript, not a guess):', ...(r.done.length === 0 ? ['  (none recorded)'] : r.done.map(d => `  - ${d}`)))
  if (r.next !== undefined) lines.push(r.next.isHaiku ? `Next step (Haiku's reading of the transcript): ${r.next.text}` : `Next step: continue after the last step: ${r.next.text}`)
  lines.push('', "Resume this task now from the next step. Don't start it over, don't redo the steps above, and don't work on any other request. Don't ask the user whether to continue. If unsure whether a step is done, check it cheaply (git diff, or the one file range) instead of redoing it." + warn)
  return lines.join('\n')
}
```

5. Replace `keptTail` with:

```ts
/**
 * The tail to keep by handle: the last two turns when they fit `budgetChars`,
 * else the last one, else the end of the last one (F3b: the longest suffix
 * that starts at an assistant message, so every kept tool call keeps its
 * result), else none. A turn starts at a typed prompt and runs to the next.
 */
export function keptTail(messages: readonly SessionMessage[], budgetChars: number): { tail: SessionMessage[]; turns: number; isPartial: boolean } {
  const starts: number[] = []
  messages.forEach((m, i) => { if (isPrompt(m)) starts.push(i) })
  for (const turns of [2, 1]) {
    if (starts.length < turns) continue
    const tail = messages.slice(starts[starts.length - turns])
    if (tail.every(m => m.handle !== undefined) && size(tail) <= budgetChars) return { tail, turns, isPartial: false }
  }
  for (let i = (starts.at(-1) ?? -1) + 1; i < messages.length; i++) {
    if (messages[i]!.role !== 'assistant') continue
    const tail = messages.slice(i)
    if (tail.every(m => m.handle !== undefined) && size(tail) <= budgetChars) return { tail, turns: 0, isPartial: true }
  }
  return { tail: [], turns: 0, isPartial: false }
}
```

6. Delete the old private `isPrompt` and the old `cut` only if unused (keep `cut`: `snapshotText` and `resumeText` use it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `claude plugin test mod 2>&1 | grep -E "^\(fail\)| pass$| fail$"`, `claude plugin validate mod`, `npx -p typescript tsc -p mod --noEmit`
Expected: pure and compaction tests pass. `mod/hooks/register.tsx` destructures `{ tail, turns }` from `keptTail`, which still type-checks. Hooks tests that assert the old snapshot wording (`'1. also keep the old cookie name'`) may fail now: list them in your report; Task 5 updates them.

- [ ] **Step 5: Commit**

```bash
git add mod/src/snapshot.ts mod/tests/pure.test.ts mod/tests/compaction.test.ts
git commit -m "F3b: snapshot: turns with status, files read, the Resume block, a partial tail"
```

---

### Task 5: Wire it: the Haiku call, the Resume block, the loop guard

**Files:**
- Modify: `mod/hooks/register.tsx` (imports; `Runtime`; `turn.start`, `turn.complete`, `prompt.submit`; the `session.compact` hook ~716–753; `snapshotFacts` ~824; `startOver` ~757; dashboard fill ~1085; new helpers `writeWorklog`, `resumeFor`, `loopGuard`)
- Modify: `mod/types/index.d.ts` (`CcwardenConversation`; `CcwardenDashboard.savings`)
- Modify: `mod/src/dashboard.ts:34`
- Test: `mod/tests/hooks.test.ts` (`world()`; `describe('F3 per-model limits and snapshot compaction')`; pre-existing tests that break), `mod/tests/pure.test.ts:745`

**Interfaces:**
- Consumes: Task 1 config fields; Task 2 `shapeOf`, `turnsOf`, `runningTurn`, `doneSteps`, `mergeSteps`, `lastCallOf`, `filesRead`; Task 3 `digest`, `WORKLOG_SYSTEM`, `WORKLOG_MAX_TOKENS`, `WORKLOG_TIMEOUT_MS`, `cleanWorklog`, `nextStepOf`, `loopAction`; Task 4 `snapshotText`, `keptTail` (`isPartial`), `resumeText`.
- Produces: `CcwardenConversation.worklog?: { calls: number; spentUsd: number }`, `CcwardenConversation.task?: { text: string; done: string[] }`; `CcwardenDashboard.savings.worklogCalls: number`, `.worklogUsd: number`; log lines `ccwarden: work-log compaction (<trigger>): …` / `ccwarden: snapshot compaction (<trigger>): …`; metrics `snapshot`/`answered` with `measured.worklog` and `measured.worklogUsd`; `compact`/`loop-warned` and `compact`/`loop-stopped`.

- [ ] **Step 1: Extend the test world**

In `mod/tests/hooks.test.ts`, `world()`:
- in `shown`, after `forkHandoff: …`, add:
  ```ts
    // F3b: the work log's Haiku calls; `worklogReply` undefined answers an API error, null rejects (a refused model).
    completions: [] as { model: string; prompt: string; system?: string; maxTokens?: number; effort?: string; timeoutMs?: number }[],
    worklogReply: '## Done\n- Edited src/auth.ts\n## In progress\n- none\n## Pending\n- none\n## Key findings\n- the timeout is in src/auth.ts:42\n## Next step\n- run npm test' as string | null | undefined,
    // F3b: turns the mod stopped.
    aborts: [] as string[],
  ```
- after the `on('model.fork', …)` handler, add:
  ```ts
  on('model.complete', (_$, e) => {
    shown.completions.push({ model: e.model, prompt: e.prompt, system: e.system, maxTokens: e.maxTokens, effort: e.effort as string | undefined, timeoutMs: e.timeoutMs })
    if (shown.worklogReply === null) return Promise.reject(new Error('model not allowed'))
    const usage = { input_tokens: 20_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: (shown.worklogReply === undefined ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } : { isAnswered: true, text: shown.worklogReply, usage }) as never }
  })
  on('turn.abort', (_$, e) => { shown.aborts.push(e.turnId); return { value: undefined } as never })
  ```
  (At $1/M in and $5/M out, that usage prices at $0.025.) If the test kit rejects the `turn.abort` answer's shape, read `'turn.abort'` in `mod/.claude-plugin/types/claude-code/index.d.ts` (the op's result is `void`) and answer the way the other `void` ops here do.

- [ ] **Step 2: Write the failing hooks tests**

In `describe('F3 per-model limits and snapshot compaction', …)` (~line 513), after the `history` helper, add:

```ts
  // history(), then a turn still running: a prompt, a failed command, its result.
  const midTurn = (): SessionMessage[] => [
    ...history(),
    msg('user', 'now run the e2e suite'),
    msg('assistant', 'Running.', { toolUses: [{ tool_use_id: 'b2', tool: 'Bash', input: { command: 'npm run e2e' }, text: '2 failing', isError: true }] }),
    msg('user', '', { toolResults: [{ tool_use_id: 'b2', text: '2 failing', isError: true }] as never }),
  ]
  const typedPrompt = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

  for (const surface of SURFACES) {
    for (const billing of BILLINGS) {
      test(`work-log compaction: Haiku's state of work, the facts, the Resume block last (${surface}, ${billing})`, { options: { billing } }, async ($, on) => {
        const w = world(on, { surfaces: [surface], usage: { tokens: 10_000 }, git: { branch: 'fix/login', numstat: '12\t3\tsrc/auth.ts\n' } })
        await $.session.start(start(surface))
        const out = await $.session.compact({ trigger: 'auto', messages: history() })

        expect(w.completions).toHaveLength(1)
        expect(w.completions[0]).toMatchObject({ model: 'haiku', maxTokens: 1_500, effort: 'low', timeoutMs: 30_000 })
        expect(w.completions[0]!.system).toContain('## Next step')
        expect(w.completions[0]!.prompt).toContain('User: Fix the login timeout bug')
        expect(w.completions[0]!.prompt).toContain('→ Edit(/p/src/auth.ts)')
        const snap = out.messages![0]!.text
        expect(snap).toContain('## State of work (written by Haiku from the transcript; verify before relying on it)\n### Done\n- Edited src/auth.ts')
        expect(snap).toContain('User: "also keep the old cookie name"')
        expect(snap.endsWith("## Resume\nAll requests above are answered and done; work only on the user's message that follows.")).toBe(true)
        expect(w.coreCompactions).toEqual([])
        expect(w.logs.at(-1)).toMatch(/^ccwarden: work-log compaction \(auto\): 10 messages → a \d+-character snapshot \+ 2 turn\(s\) kept; Haiku \$0\.025; no summary request\.$/)
      })
    }
  }

  test('a mid-turn compaction resumes the running task: the task, what is done, the next step', { options: { billing: 'metered' } }, async ($, on) => {
    world(on, { surfaces: ['terminal'], usage: { tokens: 10_000 } })
    await $.session.start(start('terminal'))
    const out = await $.session.compact({ trigger: 'auto', messages: midTurn() })
    const snap = out.messages![0]!.text
    expect(snap).toContain('## Resume: you were in the middle of this task\nCurrent task (the user\'s request, verbatim):\n  "now run the e2e suite"')
    expect(snap).toContain('  - Ran: npm run e2e → failed')
    expect(snap).toContain("Next step (Haiku's reading of the transcript): run npm test")
    expect(snap).toContain("Don't ask the user whether to continue.")
    expect(snap).toContain('4. User: "now run the e2e suite"\n   Claude (in progress): "Running."') // history() has three turns before it
  })

  // compactLoopMax 0: these compactions have no typed prompt between them, and a stop would log after them.
  test('no work log: an API error, a refused model, the cap, nothing to read', { options: { billing: 'metered', worklogCapUsd: 0.03, compactLoopMax: 0 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 10_000 } })
    await $.session.start(start('terminal'))
    w.worklogReply = undefined
    const failed = await $.session.compact({ trigger: 'auto', messages: history() })
    expect(failed.messages![0]!.text).not.toContain('## State of work')
    expect(w.logs.at(-1)).toContain('kept; plain snapshot: api-error; no summary request.')
    w.worklogReply = null
    await $.session.compact({ trigger: 'auto', messages: history() })
    expect(w.logs.at(-1)).toContain('kept; plain snapshot: refused (')
    w.worklogReply = '## Next step\n- x'
    await $.session.compact({ trigger: 'auto', messages: history() }) // $0.025 more: past the $0.03 cap
    await $.session.compact({ trigger: 'auto', messages: history() })
    expect(w.completions).toHaveLength(3)
    expect(w.logs.at(-1)).toContain('kept; plain snapshot: cap reached; no summary request.')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } }) // /clear: the cap starts over
    await $.session.compact({ trigger: 'auto', messages: [msg('user', '[ccwarden snapshot] only facts')] })
    expect(w.completions).toHaveLength(3) // nothing to read: no call
    expect(w.logs.at(-1)).toContain('kept; plain snapshot: nothing to read; no summary request.')
  })

  test('compactMode snapshot makes no model call and logs as before', { options: { billing: 'metered', compactMode: 'snapshot' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 10_000 } })
    await $.session.start(start('terminal'))
    await $.session.compact({ trigger: 'auto', messages: history() })
    expect(w.completions).toEqual([])
    expect(w.logs.at(-1)).toMatch(/^ccwarden: snapshot compaction \(auto\): 10 messages → a \d+-character snapshot \+ 2 turn\(s\) kept; no summary request\.$/)
  })

  test('a task compacted again with no typed prompt is warned, then stopped at compactLoopMax; a typed prompt starts over', { options: { billing: 'metered' } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 10_000 } })
    await $.session.start(start('terminal'))
    await $.prompt.submit(typedPrompt('now run the e2e suite'))
    await $.turn.start({ text: 'now run the e2e suite', turnId: 't9' })
    await $.session.compact({ trigger: 'auto', messages: midTurn() })
    // The second compaction kept only the end of the turn: no prompt left, the task is carried.
    const again = [msg('user', '[ccwarden snapshot] facts'), msg('assistant', 'Reading.', { toolUses: [{ tool_use_id: 'r5', tool: 'Read', input: { file_path: '/p/e2e/login.spec.ts' }, text: 'spec' }] }), msg('user', '', { toolResults: [{ tool_use_id: 'r5', text: 'spec' }] as never })]
    const second = (await $.session.compact({ trigger: 'auto', messages: again })).messages![0]!.text
    expect(second).toContain('  "now run the e2e suite"')
    expect(second).toContain('  - Ran: npm run e2e → failed\n  - Read e2e/login.spec.ts')
    expect(second).toContain('This task was compacted 2 times')
    expect(w.aborts).toEqual([])
    await $.session.compact({ trigger: 'auto', messages: again })
    await w.clock.advance(0)
    expect(w.aborts).toEqual(['t9'])
    expect(w.logs).toContain('ccwarden: compacted 3 times in one task with no new prompt; stopped the turn so it doesn\'t keep spending. Split the task, or type "continue" to go on.')
    expect(w.toasts.some(t => t.includes('compacted 3 times'))).toBe(true)

    await $.prompt.submit(typedPrompt('continue'))
    await $.turn.start({ text: 'continue', turnId: 't10' })
    const fresh = (await $.session.compact({ trigger: 'auto', messages: again })).messages![0]!.text
    expect(fresh).not.toContain('compacted 2 times')
    expect(fresh).toContain('(not in the kept messages; see Recent turns)') // the task was reset by the typed prompt
    await w.clock.advance(0)
    expect(w.aborts).toEqual(['t9'])
  })

  test('/clear starts the loop count over', { options: { billing: 'metered', compactLoopMax: 2 } }, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'], usage: { tokens: 10_000 } })
    await $.session.start(start('terminal'))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.session.compact({ trigger: 'auto', messages: midTurn() })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await $.session.compact({ trigger: 'auto', messages: midTurn() })
    await w.clock.advance(0)
    expect(w.aborts).toEqual([])
  })
```

Update pre-existing tests in the same file:
- `Haiku past 120k advises /compact, and that /compact is a snapshot, no summary request`: replace the last `expect(w.logs.at(-1)).toMatch(…)` regex with `/^ccwarden: work-log compaction \(manual\): 10 messages → a \d+-character snapshot \+ 2 turn\(s\) kept; Haiku \$0\.025; no summary request\.$/`.
- `the snapshot: goal, verbatim asks, files with diff stat, branch, last error, then the last turns by handle`: replace `expect(snap!.text).toContain('1. also keep the old cookie name')` with `expect(snap!.text).toContain('User: "also keep the old cookie name"')`.
- `a snapshot compaction records what a summary would have cost` (~line 1558): add `compactMode: 'snapshot'` to its `options` (it measures the snapshot's own saving; the Haiku cost is tested above).
- Run the suite; for any other pre-existing test that fails only because compactions now call Haiku (an extra log line, a toast count, a cost figure), add `compactMode: 'snapshot'` to that test's options and say which in your report. Don't change what a test asserts otherwise.

In `mod/tests/pure.test.ts` ~line 745, add `worklogCalls: 0, worklogUsd: 0` to the `savings` object.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `claude plugin test mod 2>&1 | grep -E "^\(fail\)| pass$| fail$"`
Expected: the new F3b hooks tests fail (no Haiku call, no Resume block yet).

- [ ] **Step 4: Implement**

`mod/types/index.d.ts`, in `CcwardenConversation` after `snapshots?: number`:

```ts
  /** F3b: the work log's Haiku calls in this conversation and their cost (est.), against worklogCapUsd. */
  worklog?: { calls: number; spentUsd: number }
  /** F3b: the task a mid-turn compaction left running, and its done steps, carried to the next compaction of it; cleared by a typed prompt. */
  task?: { text: string; done: string[] }
```

and in `CcwardenDashboard.savings` add `worklogCalls: number; worklogUsd: number` after `snapshots: number`.

`mod/src/dashboard.ts:34`: replace the line with

```ts
      `snapshot compactions ${v.snapshots} (no summary tokens; work log ${v.worklogCalls} call${v.worklogCalls === 1 ? '' : 's'}, $${v.worklogUsd.toFixed(2)}) · keep-warm spent $${v.keepWarmSpent.toFixed(2)}, saved $${v.keepWarmSaved.toFixed(2)}`,
```

`mod/hooks/register.tsx`:

1. Imports: add
   ```ts
   import { doneSteps, filesRead, lastCallOf, mergeSteps, runningTurn, shapeOf, turnsOf } from '../src/turns'
   import { cleanWorklog, digest, loopAction, nextStepOf, WORKLOG_MAX_TOKENS, WORKLOG_SYSTEM, WORKLOG_TIMEOUT_MS } from '../src/worklog'
   ```
   and add `resumeText` to the existing `../src/snapshot` import. Make sure `usageUsd` is imported from `../src/metrics` (add it to that import if it isn't).
2. `type Runtime`: add
   ```ts
     /** F3b: the running turn's id (turn.start), for the loop guard's stop. */
     turnId?: string
     /** F3b: compactions since the last typed prompt. */
     compactsInTask: number
   ```
   and add `compactsInTask: 0` to the `runtime` object literal in `register`.
3. `on('turn.start', …)`: add `runtime.turnId = e.turnId` next to `runtime.isTurnRunning = true`.
4. `on('turn.complete', …)`: change `if (e.agentId === undefined) runtime.isTurnRunning = false` to
   ```ts
    if (e.agentId === undefined) {
      runtime.isTurnRunning = false
      runtime.turnId = undefined
    }
   ```
5. `on('prompt.submit', …)`: right after `if (e.origin.kind !== 'composer' || e.turnId !== undefined) return next(e)`, add
   ```ts
    // F3b: a typed prompt starts a new task: the loop count and the carried task start over.
    runtime.compactsInTask = 0
   ```
   and in the `update(...)` callback a few lines below (the one that sets `lastPromptAt: now`), add `delete c.task` next to `delete c.bandAlert`.
6. `startOver`: add `runtime.compactsInTask = 0` as its first line (`$.state` `conversation` is replaced there, which drops `worklog` and `task`).
7. `snapshotFacts`: in the returned object, add
   ```ts
    turns: turnsOf(messages, shapeOf(messages)),
    reads: filesRead(messages),
   ```
8. In `on('session.compact', …)`, replace everything from `const usage = await $.session.usage()` (the line after the `summary+facts` block) to the end of the hook with:

```ts
    const cwd = await $.session.cwd()
    const usage = await $.session.usage()
    const model = await $.session.model()
    const limit = await limitOf($, model, config, usage.context.window)
    const { tail, turns, isPartial } = keptTail(e.messages, limit * TAIL_SHARE * CHARS_PER_TOKEN)
    runtime.compactsInTask++
    const loop = loopAction(runtime.compactsInTask, config.compactLoopMax)
    const worklog = config.compactMode === 'worklog' ? await writeWorklog($, config, e.messages) : undefined
    const resume = await resumeFor($, e.messages, cwd, worklog?.text, loop === 'none' ? 0 : runtime.compactsInTask)
    const text = snapshotText(facts, { cwd, keptTurns: turns, isPartialTail: isPartial, worklog: worklog?.text, resume })
    const spent = worklog?.usd ?? 0
    const saving = snapshotSaving(usage.context.tokens ?? 0, model)
    const net = saving === undefined ? undefined : { tokens: saving.tokens, usd: saving.usd - spent }
    await recordProject($, { snapshots: 1, ...(net === undefined ? {} : { snapshotSavedUsd: net.usd, snapshotSavedTokens: net.tokens }) })
    if (net !== undefined) await recordEvent($, config, runtime, { feature: 'snapshot', action: 'answered', measured: { tokens: usage.context.tokens ?? 0, trigger: e.trigger, worklog: worklog?.status ?? 'off', worklogUsd: spent }, est: { tokens: net.tokens, usd: net.usd, formula: `context × read + ${SUMMARY_OUTPUT_TOKENS} × output − work log`, confidence: 'low' } })
    const kept = isPartial ? 'the end of the last turn' : `${turns} turn(s)`
    const how = worklog === undefined ? '' : worklog.text === undefined ? `; plain snapshot: ${worklog.status}` : `; Haiku $${spent.toFixed(3)}`
    $.ui.log(`ccwarden: ${worklog === undefined ? 'snapshot' : 'work-log'} compaction (${e.trigger}): ${e.messages.length} messages → a ${text.length}-character snapshot + ${kept} kept${how}; no summary request.`)
    if (loop !== 'none') await loopGuard($, config, runtime, loop)
    return { messages: [{ role: 'user', text, toolUses: [] }, ...tail] }
  })
```

   (The old block computed `usage`, `limit`, `keptTail`, `text`, `saving`, the `recordProject`/`recordEvent` calls and the log; all of that is in the replacement. Keep the `snapshots:` counter update and everything above it unchanged.)

9. Add these helpers after `snapshotFacts`:

```ts
/** F3b: Haiku's state of work from the digest, within worklogCapUsd; why there is none otherwise. */
async function writeWorklog($: $, config: Config, messages: readonly SessionMessage[]): Promise<{ text?: string; usd: number; status: string }> {
  const prompt = digest(messages)
  if (prompt.trim() === '') return { usd: 0, status: 'nothing to read' }
  const conv = (await $.state.get(conversation)).value
  if ((conv?.worklog?.spentUsd ?? 0) >= config.worklogCapUsd) return { usd: 0, status: 'cap reached' }
  const r = await $.model.complete({ model: config.worklogModel, system: WORKLOG_SYSTEM, prompt, maxTokens: WORKLOG_MAX_TOKENS, effort: 'low', timeoutMs: WORKLOG_TIMEOUT_MS })
    .catch((err: unknown) => `refused (${String(err)})`)
  if (typeof r === 'string') return { usd: 0, status: r }
  const usd = usageUsd({ model: config.worklogModel, ...r.usage }) ?? 0
  await update($, conversation, prev => {
    const w = prev?.worklog ?? { calls: 0, spentUsd: 0 }
    return { ...(prev ?? { alerted: 0 }), worklog: { calls: w.calls + 1, spentUsd: w.spentUsd + usd } }
  })
  if (!r.isAnswered) return { usd, status: r.reason === 'aborted' ? 'timed out' : r.reason }
  const text = cleanWorklog(r.text)
  return text === '' ? { usd, status: 'empty-reply' } : { text, usd, status: 'written' }
}

/**
 * F3b: the Resume block. Mid-turn, the running task and its done steps are
 * kept in $.state, so a compaction that kept only the end of the turn (no
 * prompt left) still names the task and what was done before.
 */
async function resumeFor($: $, messages: readonly SessionMessage[], cwd: string, worklog: string | undefined, loopCount: number): Promise<string> {
  const shape = shapeOf(messages)
  const running = runningTurn(messages)
  const steps = doneSteps(running.body, cwd)
  const conv = await update($, conversation, prev => {
    const c: CcwardenConversation = { ...(prev ?? { alerted: 0 }) }
    if (shape === 'boundary') delete c.task
    else if (running.task !== undefined) c.task = { text: running.task, done: steps }
    else c.task = { text: c.task?.text ?? '', done: mergeSteps(c.task?.done ?? [], steps) }
    return c
  })
  const haikuNext = worklog === undefined ? undefined : nextStepOf(worklog)
  const lastCall = lastCallOf(running.body)
  const next = haikuNext !== undefined ? { text: haikuNext, isHaiku: true } : lastCall !== undefined ? { text: lastCall, isHaiku: false } : undefined
  return resumeText({
    shape,
    ...(conv.task?.text ? { task: conv.task.text } : {}),
    added: running.added,
    done: conv.task?.done ?? [],
    ...(next === undefined ? {} : { next }),
    loopCount,
  })
}

/** F3b: a task compacted again with no typed prompt: say so; at compactLoopMax, stop the turn. */
async function loopGuard($: $, config: Config, runtime: Runtime, action: 'warn' | 'stop'): Promise<void> {
  const n = runtime.compactsInTask
  await recordEvent($, config, runtime, { feature: 'compact', action: action === 'stop' ? 'loop-stopped' : 'loop-warned', measured: { compactions: n } })
  if (action === 'warn') {
    await notify($, 'advisor', `ccwarden: this task was compacted ${n} times with no new prompt; Claude is told to re-read less.`)
    return
  }
  const text = `ccwarden: compacted ${n} times in one task with no new prompt; stopped the turn so it doesn't keep spending. Split the task, or type "continue" to go on.`
  $.ui.log(text)
  await notify($, 'advisor', text)
  const turnId = runtime.turnId
  if (turnId === undefined) return
  // After this compaction stands (SPEC §9 Q35).
  $.clock.after(0, () => void $.turn.abort({ turnId }).catch((err: unknown) => $.ui.log(`ccwarden: could not stop the turn: ${String(err)}`, { to: 'debug' })))
}
```

   `cwd` from `$.session.cwd()` may be typed `string | undefined`; if so, type the `resumeFor` parameter `cwd: string | undefined`.

10. Dashboard fill (~line 1085, the `savings:` object): add
   ```ts
      worklogCalls: conv.worklog?.calls ?? 0,
      worklogUsd: conv.worklog?.spentUsd ?? 0,
   ```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `claude plugin test mod 2>&1 | grep -E "^\(fail\)| pass$| fail$"`, `claude plugin validate mod`, `npx -p typescript tsc -p mod --noEmit`
Expected: all F3b tests pass; only the known F16 timeouts may fail; validate passes; no new tsc errors. `claude plugin validate` checks every `$` use is in `register.tsx`: if it complains about a `$.state` reference "what it holds at the call could not be listed", pass the value in rather than reading it in a helper (HANDOFF §7).

- [ ] **Step 6: Commit**

```bash
git add mod/hooks/register.tsx mod/types/index.d.ts mod/src/dashboard.ts mod/tests/hooks.test.ts mod/tests/pure.test.ts
git commit -m "F3b: the Haiku work log, the Resume block and the loop guard at compaction"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/SPEC.md` (F3 "As built", §5 config table ~line 409, the F15 events table ~line 393, §9 open questions)
- Modify: `docs/HANDOFF.md` (§1, §3 "Compaction" row, the `mod/` row's test count)
- Modify: `README.md:128` (config table)
- Modify: `docs/superpowers/specs/2026-10-08-worklog-compaction-design.md` (Status line; as-built differences)

**Interfaces:** none (documentation only).

- [ ] **Step 1: SPEC**
  - In §4 F3, after the existing "As built" notes, add a bullet **Work log (F3b, as built 2026-10-08)** that summarises spec §4–§7 in 6–10 lines: `compactMode` `worklog` default; the digest (≤ 160000 characters, newest results first, cut by tool); one `$.model.complete` on `worklogModel` (`effort: 'low'`, 1500 tokens, 30 s), capped by `worklogCapUsd` per conversation; the message order (header, State of work, facts, Resume block); mid-turn vs boundary read from the last message; the done steps from tool calls only, carried in `$.state` `conversation.task`; the partial tail; the loop guard (warn at the 2nd, `$.turn.abort` at `compactLoopMax`).
  - §5 table: change the `compactMode` row to `worklog` (`snapshot`, `summary`; `summary` for manual `/compact <focus>`) and add rows `worklogModel` (`haiku`, F3), `worklogCapUsd` (`0.5`, F3), `compactLoopMax` (`3`, F3).
  - F15 events table: add `snapshot` / `answered` now measures `worklog` (status) and `worklogUsd`, and its est. is net of the work log; add a row `compact` / `loop-warned`, `loop-stopped` (count only).
  - §9: add Q35–Q38 exactly as in the design's §10.
- [ ] **Step 2: README** — the `compactMode` row: default `worklog`, "Haiku writes the state of work at each compaction (~$0.03, capped by `worklogCapUsd`); `snapshot` without Haiku; `summary` the engine's summary". Add rows for `worklogModel`, `worklogCapUsd`, `compactLoopMax` in the same style as the rows around it.
- [ ] **Step 3: HANDOFF**
  - §1, the "Work-log compaction designed" paragraph: change to "built" with the date, and add the live check list from the design's §11 "Live" (3 items).
  - §3 table, the "Compaction" row: Decision "**Work-log compaction:** the mod answers `session.compact` with a snapshot plus a Haiku work log (≈ $0.03, capped), never the main model's summary. A manual `/compact <focus>` still uses the engine summary."; Why "The snapshot alone made Claude redo or stall (60% of compactions looped), and re-reading after it cost more than any summary".
  - §1 piece table, `mod/` row: replace the test count with the number `claude plugin test mod` reports now.
- [ ] **Step 4: Design doc** — Status: "built 2026-10-08 (PR link added at merge)". Add a short "As built" section listing the differences from the design: the loop events are feature `compact`, actions `loop-warned` / `loop-stopped` (no new feature name); the fallback reason is in the compaction's own log line (`…; plain snapshot: <reason>; …`), not a separate line; the work log's cost is taken off `snapshotSavedUsd` (no new day figure).
- [ ] **Step 5: Commit**

```bash
git add docs/SPEC.md docs/HANDOFF.md README.md docs/superpowers/specs/2026-10-08-worklog-compaction-design.md
git commit -m "F3b: SPEC as built, config rows, Q35-Q38; HANDOFF; README"
```
