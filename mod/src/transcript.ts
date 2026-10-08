import type { SessionMessage } from 'claude-code'
import { slashed } from './paths'
import { SNAPSHOT_TAG } from './turns'

// Session facts for the snapshot (F3) and handoffs (F7): the user's verbatim
// asks, the files edited, and the latest TodoWrite list. Ported from
// hooks-edition/lib.js and hooks/session-start.js.
//
// Two sources: the transcript JSONL (complete: it keeps the history across
// compaction and has mid-turn `queued_command` asks, but its format is
// undocumented), and $.session.messages() (typed, but the newest 4096 rows
// only, and it is not stated whether queued asks are among them). Prefer the
// JSONL when its path is known. Pure: the reading is done in hooks/register.tsx.

export type Todo = { content: string; status: string }
export type SessionFacts = {
  /** Verbatim asks, oldest first, consecutive repeats dropped. */
  asks: string[]
  /** Files edited this session, most recent first. */
  files: string[]
  /** The latest TodoWrite list, or null when there was none. */
  todos: Todo[] | null
}

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }
export type TranscriptEntry = {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  timestamp?: string
  message?: {
    id?: string
    content?: string | Block[]
    usage?: { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null }
  }
  attachment?: { type?: string; prompt?: unknown; humanTurn?: boolean; origin?: { kind?: string } }
}

/** When the main thread's last response was written (ms), so a resumed conversation knows its cache's age. */
export function lastResponseTime(entries: readonly TranscriptEntry[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.type !== 'assistant' || e.isSidechain || e.timestamp === undefined) continue
    const ms = Date.parse(e.timestamp)
    if (!Number.isNaN(ms)) return ms
  }
  return undefined
}

export function parseJsonl(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as TranscriptEntry)
    } catch {
      // a partially written last line
    }
  }
  return entries
}

/**
 * Text the user actually typed, or null for tool results, hook and system
 * injections, slash-command wrappers, compaction summaries and subagent
 * turns. Asks typed while Claude was mid-turn are `queued_command`
 * attachments.
 */
export function userPromptText(entry: TranscriptEntry): string | null {
  if (entry.isSidechain) return null
  if (entry.type === 'attachment') {
    const a = entry.attachment ?? {}
    const isHuman = a.humanTurn === true || a.origin?.kind === 'human'
    return a.type === 'queued_command' && isHuman && typeof a.prompt === 'string' && a.prompt.trim() !== ''
      ? a.prompt.trim()
      : null
  }
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary) return null
  const content = entry.message?.content
  let text: string | null = null
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content) && !content.some(b => b?.type === 'tool_result')) {
    text = content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n')
  }
  return cleanAsk(text)
}

export function toolUses(entry: TranscriptEntry): { name: string; input: Record<string, unknown> }[] {
  if (entry.type !== 'assistant' || entry.isSidechain) return []
  const content = entry.message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter(b => b?.type === 'tool_use' && typeof b.name === 'string')
    .map(b => ({ name: b.name as string, input: b.input ?? {} }))
}

export function collectFromTranscript(entries: readonly TranscriptEntry[]): SessionFacts {
  const facts = new FactsBuilder()
  for (const entry of entries) {
    facts.ask(userPromptText(entry))
    for (const use of toolUses(entry)) facts.toolUse(use.name, use.input)
  }
  return facts.done()
}

export function collectFromMessages(messages: readonly SessionMessage[]): SessionFacts {
  const facts = new FactsBuilder()
  for (const m of messages) {
    if (m.role === 'user' && (m.toolResults?.length ?? 0) === 0) facts.ask(cleanAsk(m.text))
    for (const use of m.toolUses) facts.toolUse(use.tool, use.input)
  }
  return facts.done()
}

/** A prior snapshot is ccwarden's own message, not an ask: keeping it nests snapshots. */
function cleanAsk(text: string | null): string | null {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' || trimmed.startsWith('<') || trimmed.startsWith(SNAPSHOT_TAG) ? null : trimmed
}

class FactsBuilder {
  private asks: string[] = []
  private edited = new Map<string, number>() // path -> order of its last edit
  private todos: Todo[] | null = null
  private order = 0

  ask(text: string | null): void {
    if (text !== null && text !== this.asks.at(-1)) this.asks.push(text)
  }

  toolUse(name: string, input: Record<string, unknown>): void {
    if (EDIT_TOOLS.has(name)) {
      const file = input.file_path ?? input.notebook_path
      if (typeof file === 'string') this.edited.set(slashed(file), this.order++)
    } else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      this.todos = (input.todos as unknown[]).filter(isTodo)
    }
  }

  done(): SessionFacts {
    const files = [...this.edited.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
    return { asks: this.asks, files, todos: this.todos }
  }
}

function isTodo(t: unknown): t is Todo {
  return typeof t === 'object' && t !== null && typeof (t as Todo).content === 'string' && typeof (t as Todo).status === 'string'
}
