// F10 context hogs: tool results big enough to matter, with their estimated
// tokens (characters / 4). The session's top ones live in $.state; a
// per-day tally in $.store feeds the dashboard's month view and tunes the
// junk guard (F4). Pure: the tool.call hook in hooks/register.ts records.

export type Hog = { tool: string; target: string; tokens: number }

/** Results under this many tokens aren't hogs. */
export const HOG_MIN_TOKENS = 2_000
export const SESSION_HOGS = 20
const DAY_HOGS = 100
export const HOG_DAYS = 31

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** What a call was about: its file, command, pattern or URL, cut to 120 characters. */
export function hogTarget(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'path']) {
    const v = input[key]
    if (typeof v === 'string' && v !== '') return v.length > 120 ? `${v.slice(0, 119)}…` : v
  }
  return ''
}

/** The session's top hogs with one more, largest first. */
export function topHogs(hogs: readonly Hog[] | undefined, hog: Hog, max = SESSION_HOGS): Hog[] {
  return [...(hogs ?? []), hog].sort((a, b) => b.tokens - a.tokens).slice(0, max)
}

/** Per-day tallies: `day → "tool\ttarget" → tokens`, the biggest DAY_HOGS a day, HOG_DAYS days. */
export type HogDays = Record<string, Record<string, number>>

export function tallyHog(days: HogDays | undefined, day: string, hog: Hog): HogDays {
  const next: HogDays = { ...(days ?? {}) }
  const key = `${hog.tool}\t${hog.target}`
  const today = { ...(next[day] ?? {}), [key]: (next[day]?.[key] ?? 0) + hog.tokens }
  next[day] = Object.fromEntries(Object.entries(today).sort((a, b) => b[1] - a[1]).slice(0, DAY_HOGS))
  const keep = Object.keys(next).sort().slice(-HOG_DAYS)
  return Object.fromEntries(keep.map(k => [k, next[k]!]))
}

/** The biggest hogs over days starting with `prefix` (a month `YYYY-MM`, or `''` for all kept). */
export function hogsOver(days: HogDays | undefined, prefix: string, max = 10): Hog[] {
  const sum = new Map<string, number>()
  for (const [day, tally] of Object.entries(days ?? {})) {
    if (!day.startsWith(prefix)) continue
    for (const [key, tokens] of Object.entries(tally)) sum.set(key, (sum.get(key) ?? 0) + tokens)
  }
  return [...sum.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key, tokens]) => {
      const [tool, target] = key.split('\t')
      return { tool: tool ?? '', target: target ?? '', tokens }
    })
}
