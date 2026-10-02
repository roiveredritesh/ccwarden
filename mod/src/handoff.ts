import { relativeTo } from './paths'
import { goalOf } from './snapshot'
import type { SnapshotFacts } from './snapshot'

// F7 handoff: a note for whoever continues the work in a fresh session.
//   quick (zero tokens): the session's facts from the transcript and git.
//   full: the same, plus the decisions and why, the current state, the
//         exact next step and what to verify first, written by one fork of
//         the main thread ($.model.fork): one short request, cheap while
//         the cache is warm, and nothing added to the conversation.
// Written to `<handoffDir>/<date>-<topic>.md`; the next session start in the
// project offers the newest unread one. Pure: the /handoff command and the
// pickup in hooks/register.tsx write and offer them.

export const FULL_PROMPT =
  'Write the second half of a handoff note for whoever continues this work in a fresh session ' +
  "that won't see this conversation. Output only these four markdown sections, at most 250 words in all, " +
  'facts from this conversation only, no tool calls:\n' +
  '## Decisions and why\n## Current state\n## Next step\n(the exact next action)\n## Verify first'

const OPEN_SECTIONS = ['## Decisions and why', '## Current state', '## Next step', '## Verify first']

export type HandoffFacts = SnapshotFacts & { model: string; writtenAt: number }

/** A short kebab-case topic from the goal: its first words, at most 40 characters. */
export function handoffTopic(goal: string | undefined): string {
  const slug = (goal ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w !== '')
    .slice(0, 6)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug === '' ? 'session' : slug
}

/** `YYYY-MM-DD-HHMM-<topic>.md`, in UTC so names sort the same on every machine. */
export function handoffFileName(writtenAt: number, topic: string): string {
  const iso = new Date(writtenAt).toISOString() // 2026-10-02T07:46:38.000Z
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}-${topic}.md`
}

/** The note. `full` is the fork's four sections; without it the note says how to get them. */
export function handoffMarkdown(f: HandoffFacts, opts: { cwd?: string; full?: string; modelLine?: string }): string {
  const goal = goalOf(f)
  const out: string[] = [
    `# Handoff: ${handoffTopic(goal).replace(/-/g, ' ')}`,
    '',
    `_Written by ccwarden on ${new Date(f.writtenAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` +
      ` (${opts.full === undefined ? 'quick: from the transcript and git' : 'full'}); model ${f.model}` +
      `${f.branch === undefined ? '' : `, branch \`${f.branch}\``}._`,
    ...(opts.modelLine === undefined ? [] : ['', `_${opts.modelLine}_`]),
    '',
    '## Goal',
    goal ?? '_(no request recorded)_',
  ]
  const asks = f.asks.filter(a => a !== goal)
  if (asks.length > 0) out.push('', '## Requests so far (verbatim, oldest first)', ...asks.map((a, i) => `${i + 1}. ${oneLine(a)}`))
  const open = (f.todos ?? []).filter(t => t.status !== 'completed')
  if (open.length > 0) out.push('', '## Open todos', ...open.map(t => `- [ ] ${t.content}${t.status === 'in_progress' ? ' (in progress)' : ''}`))
  if (f.files.length > 0) {
    out.push('', '## Files touched (diff vs HEAD)', ...f.files.map(path => {
      const rel = relativeTo(path, opts.cwd)
      const stat = f.diff.get(rel)
      return `- \`${rel}\`${stat === undefined ? '' : ` (+${stat.added} -${stat.removed})`}`
    }))
  }
  if (f.lastError !== undefined) out.push('', '## Last error', '```', f.lastError.slice(0, 1_500), '```')
  out.push('')
  out.push(opts.full === undefined
    ? OPEN_SECTIONS.map(h => `${h}\n_(quick handoff: run /handoff while the cache is warm to have this written)_`).join('\n\n')
    : opts.full.trim())
  return `${out.join('\n')}\n`
}

/** The fork's reply, if it is the four sections asked for (else undefined: fall back to quick). */
export function fullSections(reply: string): string | undefined {
  const start = reply.indexOf('## Decisions and why')
  if (start === -1 || !reply.includes('## Next step')) return undefined
  return reply.slice(start).trim()
}

/** The newest handoff not yet offered, by file name (names sort by time). */
export function newestUnread(names: readonly string[], offered: readonly string[]): string | undefined {
  return [...names].filter(n => /^\d{4}-\d{2}-\d{2}-\d{4}-.+\.md$/.test(n) && !offered.includes(n)).sort().at(-1)
}

export function pickupPrompt(relPath: string): string {
  return `Continue from the handoff in ${relPath}: read it first, then verify what it says to verify before the next step.`
}

function oneLine(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ')
  return flat.length <= 500 ? flat : `${flat.slice(0, 499)}…`
}
