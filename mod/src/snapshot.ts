import type { SessionCompactTrigger, SessionMessage } from 'claude-code'
import { relativeTo } from './paths'
import type { Todo } from './transcript'
import { oneLine, SNAPSHOT_TAG, turnStarts } from './turns'
import type { FileRead, Shape, Turn } from './turns'

export { SNAPSHOT_TAG }

// F3 snapshot compaction. The mod answers `session.compact` in core's place
// with a snapshot of the session's facts plus the last turns kept by their
// engine handles, so no summary request is made and no summary tokens are
// spent. Pure: the hook in hooks/register.tsx gathers the facts and answers.

export type FileStat = { added: number; removed: number }

export type SnapshotFacts = {
  /** The session's first ask; it survives earlier compactions via $.state. */
  goal?: string
  asks: readonly string[]
  todos: readonly Todo[] | null
  /** Edited files, most recent first. */
  files: readonly string[]
  /** `git diff --numstat HEAD`, keyed by repo-relative path. */
  diff: ReadonlyMap<string, FileStat>
  branch?: string
  lastError?: string
  lastAnswer?: string
  /** F3b: the turns of the messages compacted, with Claude's reply and status. */
  turns?: readonly Turn[]
  /** F3b: files Read in the messages compacted, with ranges, newest first. */
  reads?: readonly FileRead[]
}

export const SNAPSHOT_MAX_CHARS = 10_000
const RECENT_ASKS = 5
const MAX_FILES = 40
const MAX_READS = 30
const TURNS_SHARE = 0.4
const ASK_CHARS = 300
const REPLY_CHARS = 200
const QUESTION_CHARS = 160

/** How to answer a compaction (SPEC F3). */
export type CompactPlan = 'pass' | 'skip' | 'snapshot' | 'summary+facts'

export function planCompaction(e: { trigger: SessionCompactTrigger; instructions?: string; agentId?: string }, mode: 'worklog' | 'snapshot' | 'summary'): CompactPlan {
  if (e.agentId !== undefined) return 'pass' // subagent loops: T4
  if (e.trigger === 'precompute') return mode === 'summary' ? 'pass' : 'skip'
  if (mode === 'summary') return 'summary+facts'
  // A manual `/compact <focus>` asks for a summary on that focus.
  if (e.trigger === 'manual' && (e.instructions ?? '').trim() !== '') return 'summary+facts'
  return 'snapshot'
}

/**
 * The goal: the stored first ask, else the first ask that isn't ccwarden's own
 * output pasted back (a toast or probe line), else the first ask. Live test: a
 * session that opened with a pasted billing toast got that toast as its Goal.
 */
export function goalOf(f: { goal?: string; asks: readonly string[] }): string | undefined {
  return f.goal ?? f.asks.find(a => !/^\s*ccwarden\b/i.test(a)) ?? f.asks[0]
}

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
  /** At a boundary, the last typed prompt when it has no reply yet, verbatim. */
  pending?: string
  /** This task's compactions when 2 or more (the loop warning), else 0. */
  loopCount: number
}

/** The Resume block (F3b): what to continue and how, or, at a boundary, that everything above is done. */
export function resumeText(r: Resume): string {
  const warn = r.loopCount >= 2
    ? `\nThis task was compacted ${r.loopCount} times; the context refills because of re-reading. Read only the ranges you need, prefer Grep, and don't re-read the files listed above.`
    : ''
  if (r.shape === 'boundary' && r.pending !== undefined) {
    return `## Resume\nThe requests above are answered and done, except the last one, which isn't answered yet:\n  "${cut(r.pending, 2_000)}"\nAnswer it now; don't redo the done requests.${warn}`
  }
  if (r.shape === 'boundary') return `## Resume\nAll requests above are answered and done; work only on the user's message that follows.${warn}`
  const task = r.task === undefined || r.task === '' ? '(not in the kept messages; see Recent turns)' : cut(r.task, 2_000)
  const lines = ['## Resume: you were in the middle of this task', "Current task (the user's request, verbatim):", `  "${task}"`]
  if (r.added.length > 0) lines.push('Added by the user during the task:', ...r.added.map(a => `  - "${cut(a, 500)}"`))
  lines.push('', 'Already done in this task (from the transcript, not a guess):', ...(r.done.length === 0 ? ['  (none recorded)'] : r.done.map(d => `  - ${d}`)))
  if (r.next !== undefined) lines.push(r.next.isHaiku ? `Next step (Haiku's reading of the transcript): ${r.next.text}` : `Next step: continue after the last step: ${r.next.text}`)
  lines.push('', "Resume this task now from the next step. Don't start it over, don't redo the steps above, and don't work on any other request. Don't ask the user whether to continue. If unsure whether a step is done, check it cheaply (git diff, or the one file range) instead of redoing it." + warn)
  return lines.join('\n')
}

/**
 * The tail to keep by handle: the last two turns when they fit `budgetChars`,
 * else the last one, else the end of the last one (F3b: the longest suffix
 * that starts at an assistant message, so every kept tool call keeps its
 * result), else none. A turn starts at a typed prompt and runs to the next.
 */
export function keptTail(messages: readonly SessionMessage[], budgetChars: number): { tail: SessionMessage[]; turns: number; isPartial: boolean } {
  const starts = turnStarts(messages)
  const first = fitFrom(messages, budgetChars)
  // A suffix that fits makes every later one fit too, so a turn fits when it starts at or after `first`.
  for (const turns of [2, 1]) {
    if (starts.length < turns) continue
    const s = starts[starts.length - turns]!
    if (s >= first) return { tail: messages.slice(s), turns, isPartial: false }
  }
  // The longest suffix that starts at an assistant message and fits: the first one at or after `first`.
  for (let i = Math.max(first, (starts.at(-1) ?? -1) + 1); i < messages.length; i++) {
    if (messages[i]!.role === 'assistant') return { tail: messages.slice(i), turns: 0, isPartial: true }
  }
  return { tail: [], turns: 0, isPartial: false }
}

/** The smallest index from which the messages to the end all have handles and fit `budget` together; `messages.length` when none do. One backward scan, stopped at the first unhandled message or once over budget. */
function fitFrom(messages: readonly SessionMessage[], budget: number): number {
  let first = messages.length
  let chars = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    chars += sizeOf(m)
    if (m.handle === undefined || chars > budget) break
    first = i
  }
  return first
}

export function lastError(messages: readonly SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const failed = [...messages[i]!.toolUses].reverse().find(u => u.isError)
    if (failed !== undefined) return `${failed.tool}: ${failed.text ?? ''}`.trim()
  }
  return undefined
}

export function lastAnswer(messages: readonly SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.text.trim() !== '') return m.text.trim()
  }
  return undefined
}

/** `git diff --numstat` output: `added<TAB>removed<TAB>path` per line (`-` for binary). */
export function parseNumstat(stdout: string): Map<string, FileStat> {
  const stats = new Map<string, FileStat>()
  for (const line of stdout.split('\n')) {
    const [added, removed, path] = line.split('\t')
    if (path === undefined || path === '') continue
    stats.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 })
  }
  return stats
}

/** Facts for a summary's instructions: `/compact <focus>` keeps its focus and gains the verbatim asks. */
export function summaryInstructions(instructions: string | undefined, text: string): string {
  const focus = (instructions ?? '').trim()
  return `${focus === '' ? '' : `${focus}\n\n`}Keep these facts from the session verbatim in the summary:\n${text}`
}

function sizeOf(m: SessionMessage): number {
  let chars = m.text.length
  for (const u of m.toolUses) chars += JSON.stringify(u.input).length + (u.text?.length ?? 0)
  for (const r of m.toolResults ?? []) chars += r.text?.length ?? 0
  return chars
}

function statFor(diff: ReadonlyMap<string, FileStat>, rel: string): FileStat | undefined {
  const exact = diff.get(rel)
  if (exact !== undefined) return exact
  for (const [path, stat] of diff) if (rel.endsWith(`/${path}`) || path.endsWith(`/${rel}`)) return stat
  return undefined
}

function cut(text: string, max: number): string {
  const n = Math.max(1, Math.floor(max))
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`
}
