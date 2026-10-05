import { dayKey } from './ledger'
import type { Estimate, MetricEvent } from './metrics'
import { fmtTokens } from './status'

// F16: the /cw pane's patrol log: today's interventions (UTC day, as the metrics log keeps them), newest
// first, one line each; an action's saving comes from the `outcome` that settles it (same `ref`).

const PATROL_MAX = 8
const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const word = (v: unknown) => String(v ?? '')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const an = (s: string) => `${/^[aeiou]/i.test(s) ? 'an' : 'a'} ${s}`
const fileOf = (v: unknown) => word(v).split(/[\/]/).pop() ?? ''
// ponytail: thousands by regex, not toLocaleString: the mod runtime may not carry Intl
const count = (v: unknown) => String(Math.round(num(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16)

function what(e: MetricEvent, outcome: MetricEvent | undefined): string {
  const m = e.measured
  switch (`${e.feature}/${e.action.replace(/^would-/, '')}`) {
    case 'junk/kept-out':
    case 'junk/keep-out':
      return m.tool === 'Read' ? `Blocked a whole Read of ${fileOf(m.target)} (${count(m.size)} lines)` : `Trimmed ${word(m.tool)} output (${count(m.size)} characters)`
    case 'subagent/pinned': return `Pinned ${an(word(m.type))} subagent from ${cap(word(m.asked))} to ${cap(word(m.ran))}`
    case 'subagent/capped': return `Capped ${an(word(m.type))} subagent's report`
    case 'subagent/deny':
    case 'subagent/denied':
      return `Held back ${an(word(m.type))} subagent`
    case 'cold/ask':
    case 'cold/asked': {
      const choice = outcome?.measured.choice
      return `Asked before a prompt on a cold cache (${fmtTokens(num(m.tokens))})${choice === undefined ? '' : ` · you chose ${word(choice)}`}`
    }
    case 'snapshot/answer':
    case 'snapshot/answered':
      return `Snapshot compaction at ${fmtTokens(num(m.tokens))}, no summary request`
    case 'compact/summarised': return `The engine summarised the conversation at ${fmtTokens(num(m.tokens))}`
    case 'keepwarm/ping': return 'Kept the cache warm with a ping'
    case 'keepwarm/avoided': return `A keep-warm ping spared a ${fmtTokens(num(m.tokens))} rebuild`
    case 'limit/hint':
    case 'limit/compact-hint':
      return `Suggested /compact at ${fmtTokens(num(m.tokens))} of ${fmtTokens(num(m.limit))}`
    case 'topic/ask': return `Asked about an unrelated prompt (${fmtTokens(num(m.tokens))})`
    case 'topic/cleared': return `Cleared for an unrelated prompt (${fmtTokens(num(m.tokens))} left behind)`
    case 'handoff/written': return `Wrote ${an(word(m.route))} handoff`
    case 'alert/sent': return `Spend alert (${word(m.kind)})`
    default: return `${e.feature} ${e.action}`
  }
}

function gain(e: MetricEvent, est: Estimate | undefined): string {
  if (est === undefined || est.usd <= 0) return ''
  return e.feature === 'junk' ? ` · kept ~${fmtTokens(Math.round(est.tokens))} tokens out ($${est.usd.toFixed(2)})` : ` · saved ~$${est.usd.toFixed(2)}`
}

export function patrolLines(events: readonly MetricEvent[], now: number): string[] {
  const today = dayKey(now)
  const outcomes = new Map(events.filter(e => e.action === 'outcome' && e.ref !== undefined).map(e => [e.ref!, e]))
  return events
    .filter(e => e.action !== 'outcome' && dayKey(e.at) === today)
    .sort((a, b) => b.at - a.at)
    .slice(0, PATROL_MAX)
    .map(e => {
      const outcome = e.ref === undefined ? undefined : outcomes.get(e.ref)
      // What a guard only would have done saved nothing, so it shows no saving.
      const tag = e.would === true ? (e.feature === 'junk' ? ' (observe)' : ' (holdout)') : gain(e, e.est ?? outcome?.est)
      return `${hhmm(e.at)}  ${what(e, outcome)}${tag}`
    })
}
