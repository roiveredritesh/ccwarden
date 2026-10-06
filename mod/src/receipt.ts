import type { MetricEvent, SessionRecord } from './metrics'
import { fmtTokens } from './status'

// F16: this conversation's receipt for the /cw pane, from its F15 session record and the events of this
// part (since /clear). Monospace, 34 wide.

const WIDTH = 34
const RULE = '-'.repeat(WIDTH)
const row = (label: string, value: string) => `${label} `.padEnd(WIDTH - value.length) + value
const usd = (n: number) => `$${n.toFixed(2)}`

export function receiptText(r: SessionRecord, events: readonly MetricEvent[], rank: string): string {
  const saved = new Map<string, number>()
  for (const e of events) {
    if (e.would !== true && e.est !== undefined && e.at >= r.startedAt) saved.set(e.feature, (saved.get(e.feature) ?? 0) + e.est.usd)
  }
  const byFeature = [...saved].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1])
  return [
    'CCWARDEN · SESSION RECEIPT',
    RULE,
    row('Prompts', String(r.prompts)),
    row('Requests', String(r.requests)),
    row('Cache reads', `${fmtTokens(r.tokens.read)} tok`),
    row('Subagents', usd(r.subagentUsd)),
    row('Spent (est.)', usd(r.usd)),
    RULE,
    row('Warden saved', usd(byFeature.reduce((s, [, v]) => s + v, 0))),
    ...byFeature.map(([feature, v]) => row(`  ${feature}`, usd(v))),
    RULE,
    rank,
  ].join('\n')
}
