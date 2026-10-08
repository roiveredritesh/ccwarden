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

/** Tool work still open after this message: a tool result, or a call with no result yet. */
function toolOpen(m: SessionMessage | undefined): boolean {
  return m !== undefined && ((m.toolResults?.length ?? 0) > 0 || m.toolUses.some(u => u.text === undefined && u.isError !== true))
}

/** The indexes of the prompts that start a turn; a prompt typed while tool work is open was added during one. */
export function turnStarts(messages: readonly SessionMessage[]): number[] {
  const starts: number[] = []
  messages.forEach((m, i) => {
    if (isPrompt(m) && !toolOpen(messages[i - 1])) starts.push(i)
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
      // A prompt with no reply after it is still running, at a boundary too.
      status: k === starts.length - 1 && (shape === 'mid-turn' || s === messages.length - 1) ? 'in progress' : 'done',
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
  const a = withoutMarker(earlier)
  const b = withoutMarker(later)
  const kept = a.steps.filter(s => !b.steps.includes(s))
  return capSteps([...kept, ...b.steps], a.omitted + b.omitted)
}

/** A capped list's leading `…and N earlier steps` marker, split off: its N and the steps after it. */
function withoutMarker(steps: readonly string[]): { omitted: number; steps: string[] } {
  const marker = /^…and (\d+) earlier steps$/.exec(steps[0] ?? '')
  return marker === null ? { omitted: 0, steps: [...steps] } : { omitted: Number(marker[1]), steps: steps.slice(1) }
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
  return readsOf(messages.flatMap(m => m.toolUses))
}

/** The Reads among these tool calls (oldest first), with their ranges, newest first, each path and range once. */
export function readsOf(uses: readonly { tool: string; input: Record<string, unknown> }[]): FileRead[] {
  const seen = new Set<string>()
  const reads: FileRead[] = []
  for (let i = uses.length - 1; i >= 0; i--) {
    const u = uses[i]!
    if (u.tool !== 'Read' || typeof u.input.file_path !== 'string') continue
    const read = { path: slashed(u.input.file_path), range: readRange(u.input) }
    const key = `${read.path}${read.range}`
    if (seen.has(key)) continue
    seen.add(key)
    reads.push(read)
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

/** The newest steps, under a marker counting every step left out: `omitted` from before, plus those cut here. */
function capSteps(steps: string[], omitted = 0): string[] {
  if (omitted === 0 && steps.length <= DONE_MAX) return steps
  const kept = steps.slice(-(DONE_MAX - 1))
  return [`…and ${omitted + steps.length - kept.length} earlier steps`, ...kept]
}
