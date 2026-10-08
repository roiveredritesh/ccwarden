import type { SessionCompactTrigger, SessionMessage } from 'claude-code'
import { relativeTo } from './paths'
import type { Todo } from './transcript'

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
}

/** Opens every snapshot message; transcript.ts drops it from the asks so snapshots don't nest. */
export const SNAPSHOT_TAG = '[ccwarden snapshot]'
export const SNAPSHOT_MAX_CHARS = 6_000
const RECENT_ASKS = 5
const MAX_FILES = 40

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

/** The snapshot message's text: the facts the next turns need, capped at `maxChars`. */
export function snapshotText(f: SnapshotFacts, opts: { cwd?: string; maxChars?: number; keptTurns: number }): string {
  const max = opts.maxChars ?? SNAPSHOT_MAX_CHARS
  const sections: string[] = []
  const goal = goalOf(f)
  if (goal !== undefined) sections.push(`## Goal (first request)\n${cut(goal, max * 0.25)}`)
  const recent = f.asks.filter(a => a !== goal).slice(-RECENT_ASKS)
  if (recent.length > 0) {
    const each = (max * 0.35) / recent.length
    sections.push(`## Recent requests, verbatim (oldest first)\n${recent.map((a, i) => `${i + 1}. ${cut(a, each)}`).join('\n')}`)
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
  if (f.branch !== undefined) sections.push(`## Branch\n${f.branch}`)
  if (f.lastError !== undefined) sections.push(`## Last error\n${cut(f.lastError, 600)}`)
  if (f.lastAnswer !== undefined && opts.keptTurns === 0) sections.push(`## Your last answer\n${cut(f.lastAnswer, 800)}`)

  const kept = opts.keptTurns === 0 ? 'No earlier turns were kept.' : `The last ${opts.keptTurns === 1 ? 'turn follows' : `${opts.keptTurns} turns follow`} verbatim.`
  const header =
    `${SNAPSHOT_TAG} This conversation was compacted by ccwarden without a summary, to save tokens. ` +
    `The facts below are quoted from the session transcript; the user's words are verbatim. ${kept}`
  return cut(`${header}\n\n${sections.join('\n\n')}`, max)
}

/**
 * The tail to keep by handle: the last two turns when they fit `budgetChars`,
 * else the last one, else none. A turn starts at a typed prompt and runs to
 * the next, so every tool_use keeps its tool_result.
 */
export function keptTail(messages: readonly SessionMessage[], budgetChars: number): { tail: SessionMessage[]; turns: number } {
  const starts: number[] = []
  messages.forEach((m, i) => { if (isPrompt(m)) starts.push(i) })
  for (const turns of [2, 1]) {
    if (starts.length < turns) continue
    const tail = messages.slice(starts[starts.length - turns])
    if (tail.every(m => m.handle !== undefined) && size(tail) <= budgetChars) return { tail, turns }
  }
  return { tail: [], turns: 0 }
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

function isPrompt(m: SessionMessage): boolean {
  const text = m.text.trim()
  return m.role === 'user' && (m.toolResults?.length ?? 0) === 0 && text !== '' && !text.startsWith('<') && !text.startsWith(SNAPSHOT_TAG)
}

function size(messages: readonly SessionMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += m.text.length
    for (const u of m.toolUses) chars += JSON.stringify(u.input).length + (u.text?.length ?? 0)
    for (const r of m.toolResults ?? []) chars += r.text?.length ?? 0
  }
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
