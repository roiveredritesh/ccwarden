// F4 junk guard: keep oversized tool output out of the context, where it
// would be paid for again on every later request.
//   Read: no limit on a file over `readMaxLines` → denied, pointing at Grep
//         or a ranged Read (redirecting avoids blind retries).
//   Bash: output over `bashMaxChars` → cut to head + tail, the full text
//         saved to a file Claude can grep (no re-run needed).
//   Tests: a test runner's output over `bashMaxChars` → its failure lines
//         and the closing summary only, failed runs included.
// `observe` mode only records what it would have done (in $.store), so the
// thresholds can be checked for false positives before `enforce`. Pure: the
// tool.call hooks in hooks/register.tsx apply it.

export type JunkMode = 'observe' | 'enforce' | 'off'

/** One thing the guard did, or would have done in observe mode. */
export type JunkEvent = {
  at: number
  tool: 'Read' | 'Bash'
  mode: 'observe' | 'enforce'
  /** The file read, or the command run (cut to 200 characters). */
  target: string
  /** Lines in the file, or characters of output. */
  size: number
  /** Characters kept out of the context (est. for a denied Read: the file's). */
  savedChars: number
}

export const JUNK_LOG_MAX = 500

const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb|zip|gz|tar|wasm|woff2?|ttf|otf|mp[34]|mov|avi)$/i

/** A Read the guard checks: a text file read whole (no offset, limit or pages). */
export function isWholeTextRead(e: { file_path: string; offset?: number; limit?: number; pages?: string }): boolean {
  return e.offset === undefined && e.limit === undefined && e.pages === undefined && !BINARY_EXT.test(e.file_path)
}

export function countLines(text: string): number {
  if (text === '') return 0
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < text.length - 1; i = text.indexOf('\n', i + 1)) n++
  return n
}

export function readDenyText(path: string, lines: number, max: number): string {
  return (
    `ccwarden junk guard: ${path} has ${lines} lines (more than ${max}), so reading it whole would put all of it in the context. ` +
    'Use Grep to find what you need in it, or Read it with offset and limit.'
  )
}

/** A command whose output Claude already cut down (piped through head, tail, grep, …). */
export function isAlreadyFiltered(command: string): boolean {
  return /\|\s*(head|tail|grep|rg|egrep|fgrep|wc|sort\s+-u|uniq|less|more|jq|cut|awk|sed)\b/.test(command)
}

/** Head and tail of `text` within `max` characters; `cut` is how many were left out. */
export function trimOutput(text: string, max: number): { head: string; tail: string; cut: number } {
  if (text.length <= max) return { head: text, tail: '', cut: 0 }
  const headLen = Math.floor(max * 0.6)
  const tailLen = max - headLen
  return { head: text.slice(0, headLen), tail: text.slice(text.length - tailLen), cut: text.length - headLen - tailLen }
}

export function trimmedOutput(text: string, max: number, savedTo: string): string {
  const { head, tail, cut } = trimOutput(text, max)
  return (
    `${head}\n\n[ccwarden junk guard: ${cut} characters cut from the middle of this output. ` +
    `The full output is in ${savedTo}: use Grep on that file for what you need (no need to re-run the command).]\n\n${tail}`
  )
}

/** A test runner's command: npm/pnpm/yarn/bun test, jest, vitest, mocha, pytest, go/cargo/dotnet test, … */
export function isTestCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(jest|vitest|mocha|pytest|py\.test|rspec|phpunit|nextest)\b|\b(go|cargo|dotnet|deno)\s+test\b|\bnode\s+--test\b|\bplugin\s+test\b|\bgradlew?\b[^|;&]*\btest\b|\bmvn\b[^|;&]*\btest\b/.test(command)
}

const FAILURE_LINE = /\b(fail(ed|ure|ures|ing)?|errors?|assert(ion)?(error)?|expected|received|panic(ked)?|traceback|exception)\b|[✗✕×]|^\s*(E\s|>\s|not ok\b)/i
const AFTER_FAILURE = 3
const SUMMARY_LINES = 15

/**
 * A test run cut to what Claude needs: each failure line with the lines just
 * after it (the assertion, the stack's top), then the closing summary, all
 * within `max` characters (head + tail of that, past it). With no failure
 * line, the summary alone.
 */
export function failuresOnly(text: string, max: number): string {
  const lines = text.split('\n')
  const keep = new Set<number>()
  lines.forEach((line, i) => {
    if (!FAILURE_LINE.test(line)) return
    for (let j = i; j <= Math.min(i + AFTER_FAILURE, lines.length - 1); j++) keep.add(j)
  })
  for (let j = Math.max(0, lines.length - SUMMARY_LINES); j < lines.length; j++) keep.add(j)
  const out: string[] = []
  let last = -1
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`… (${i - last - 1} lines)`)
    out.push(lines[i]!)
    last = i
  }
  const kept = out.join('\n')
  if (kept.length <= max) return kept
  const { head, tail, cut } = trimOutput(kept, max)
  return `${head}\n… (${cut} characters)\n${tail}`
}

/**
 * The filtered run as Claude reads it. A failed run goes back as a plain
 * result (a hook can't shorten an error result), so it says it failed first.
 */
export function testOutput(text: string, max: number, savedTo: string, failed: boolean): string {
  const exit = /^Exit code (\d+)/.exec(text)?.[1]
  const status = failed ? `This test run FAILED${exit === undefined ? '' : ` (exit code ${exit})`}. ` : ''
  return (
    `[ccwarden junk guard: ${status}Kept the failure lines and the summary of ${text.length} characters of test output. ` +
    `The full output is in ${savedTo}: use Grep on that file for more (no need to re-run the tests).]\n\n${failuresOnly(text, max)}`
  )
}

/** Comma-separated globs (`*` within a path segment, `**` across segments). */
export function parseGlobs(list: string): RegExp[] {
  return list
    .split(',')
    .map(g => g.trim())
    .filter(g => g !== '')
    .map(g => {
      const re = g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*')
      return new RegExp(`(^|/)${re}$`)
    })
}

export function isAllowlisted(path: string, globs: readonly RegExp[]): boolean {
  const p = path.replace(/\\/g, '/')
  return globs.some(g => g.test(p))
}

/** Where a trimmed output is kept: a file per call under ~/.claude/ccwarden/outputs. */
export function outputPath(home: string, sessionId: string, toolUseId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  return [home.replace(/[\\/]$/, ''), '.claude', 'ccwarden', 'outputs', `${safe(sessionId)}-${safe(toolUseId)}.txt`].join(sep)
}

/** The log with one more event, the oldest dropped past JUNK_LOG_MAX. */
export function appendJunk(log: readonly JunkEvent[] | undefined, event: JunkEvent): JunkEvent[] {
  return [...(log ?? []), event].slice(-JUNK_LOG_MAX)
}
