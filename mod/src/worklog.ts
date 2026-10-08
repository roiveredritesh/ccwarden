import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { callLine, isPrompt, SNAPSHOT_TAG, turnStarts } from './turns'

// F3b work log: the digest of a conversation that Haiku reads at a
// compaction to write the state of the work, what is done with its reply,
// and when a task that keeps compacting is warned or stopped. Pure: the call
// is in hooks/register.tsx.

export const DIGEST_MAX_CHARS = 160_000 // 40k tokens at 4 characters a token
export const PRIOR_SNAPSHOT_CHARS = 12_000
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
  'If the digest starts with an earlier ccwarden snapshot, carry forward its Key findings and Pending items that still apply.',
  'Key findings: facts learned from tool results that the next steps need (where something is defined, what a failure said, a decision and its reason).',
  'Next step: the single next action. Write nothing the digest does not support; write "none" under an empty section.',
].join('\n')

type Item = { line: string; use?: ToolUseSummary; result?: string }

/**
 * What Haiku reads: prompts, Claude's text and one line per tool call, oldest
 * first, then tool results filled newest first: whole while they fit, else cut
 * by tool, else left out. The oldest turns go first when even that is too big.
 * The newest earlier snapshot leads, cut, so the work it states is read too.
 */
export function digest(messages: readonly SessionMessage[], maxChars = DIGEST_MAX_CHARS): string {
  const prior = messages.filter(m => m.text.trim().startsWith(SNAPSHOT_TAG)).at(-1)?.text.trim()
  const head = prior === undefined ? '' : `Earlier ccwarden snapshot (from the last compaction; its State of work covers the work before it):\n${cut(prior, PRIOR_SNAPSHOT_CHARS)}\n`
  const turns = turnsDigest(messages, maxChars - head.length)
  return turns === '' ? '' : head + turns
}

function turnsDigest(messages: readonly SessionMessage[], maxChars: number): string {
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
  return text.length <= maxChars ? text : overflow(note, kept.at(-1)!, text, maxChars)
}

/** A result cut to what matters for its tool: the end of a command, the matches of a search, the change of an edit. */
export function cutResult(use: ToolUseSummary): string {
  const text = use.text ?? ''
  if (use.isError === true) return headTail(text, FAILED_CHARS / 4, (FAILED_CHARS * 3) / 4)
  if (EDIT_TOOLS.has(use.tool)) return changeOf(use.input)
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
  return use.isError !== true && EDIT_TOOLS.has(use.tool) ? changeOf(use.input) : use.text ?? ''
}

// Even the last turn alone is over budget: its prompt, a marker, then the end of the digest, cut at a line.
function overflow(note: string, turn: Item[], text: string, maxChars: number): string {
  const first = turn[0]?.line ?? ''
  const head = `${note}${first.startsWith('User: ') ? `${first}\n` : ''}…[earlier steps of this turn cut]…\n`
  const room = maxChars - head.length
  if (room <= 0) return head.slice(0, maxChars)
  const tail = text.slice(text.length - room)
  const nl = tail.indexOf('\n')
  return head + (nl < 0 ? tail : tail.slice(nl + 1))
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
