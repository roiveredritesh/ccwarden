import type { CcwardenDashboard } from '../types'
import { fmtTokens } from './status'
import { junkSavedText } from './junk'

// F10 /cw dashboard: the figures, gathered by hooks/register.tsx when /cw
// opens or Refresh is pressed, as the lines the pane draws and Copy report
// copies. Pure.

export const PANE_ID = 'ccwarden-cw'

export type DashboardSection = { title: string; lines: string[] }

export function dashboardSections(d: CcwardenDashboard): DashboardSection[] {
  const s = d.session
  const sections: DashboardSection[] = []

  const rebuilds = s.rebuilds.length === 0
    ? 'no rebuilds'
    : `${s.rebuilds.length} rebuild${s.rebuilds.length === 1 ? '' : 's'}: ${s.rebuilds.slice(-3).map(r => `${clock(r.at)} ${fmtTokens(r.tokens)} ${r.cause}`).join('; ')}`
  sections.push({
    title: 'This session',
    lines: [
      `${s.model} · ctx ${s.tokens === undefined ? '–' : fmtTokens(s.tokens)}/${fmtTokens(s.limit)}${s.usd === undefined ? '' : ` · $${s.usd.toFixed(2)} (est.)`}`,
      `cache hits ${pct(s.hitRatio)} · ${rebuilds}`,
      `compactions ${s.compactions} · agents ${s.agentsRunning} running, $${s.agentsUsd.toFixed(2)} · background $${s.backgroundUsd.toFixed(2)}`,
    ],
  })

  const v = d.savings
  sections.push({
    title: 'Guard savings (est.)',
    lines: [
      `junk guard (${v.junkMode}): ${v.junkEvents} event${v.junkEvents === 1 ? '' : 's'} this month, ${junkSavedText(v.junkMode, v.junkTokens)}`,
      `snapshot compactions ${v.snapshots} (no summary tokens) · keep-warm spent $${v.keepWarmSpent.toFixed(2)}, saved $${v.keepWarmSaved.toFixed(2)}`,
    ],
  })

  const m = d.month
  sections.push({
    title: 'Month to date (this machine, est.)',
    lines: [
      `$${m.mtd.toFixed(2)}${m.budget > 0 ? ` of $${m.budget.toFixed(0)}` : ''} · ~$${m.projected.toFixed(0)} at this pace · budget mode ${m.isBudget ? 'on' : 'off'}` +
        (m.isMetered ? '' : ' (list-price estimate; window billing)'),
    ],
  })

  const hogLine = (h: { tool: string; target: string; tokens: number }) => `${fmtTokens(h.tokens)} ${h.tool}${h.target === '' ? '' : ` ${h.target}`}`
  sections.push({
    title: 'Context hogs',
    lines: [
      `this session: ${d.hogs.session.length === 0 ? 'none' : d.hogs.session.slice(0, 3).map(hogLine).join(' · ')}`,
      `this month: ${d.hogs.month.length === 0 ? 'none' : d.hogs.month.slice(0, 3).map(hogLine).join(' · ')}`,
    ],
  })

  if (d.week !== undefined) {
    const w = d.week
    const causes = Object.entries(w.causes).sort((a, b) => b[1] - a[1])
    sections.push({
      title: `Last 7 days (${w.sessions.length} session${w.sessions.length === 1 ? '' : 's'} in this project)`,
      lines: [
        ...w.sessions.slice(0, 5).map(x => `${x.id.slice(0, 8)}  ${day(x.lastTs)}  ${x.requests} reqs  hit ${pct(x.hitRatio)}  ${x.rebuilds} rebuild${x.rebuilds === 1 ? '' : 's'}`),
        `re-cached: ${causes.length === 0 ? 'nothing, the cache never broke' : causes.map(([c, t]) => `${c} ${fmtTokens(t)}`).join(', ')}`,
        `TTL: ${w.verdict}`,
      ],
    })
  }
  return sections
}

/** The whole dashboard as plain text, for Copy report. */
export function dashboardText(d: CcwardenDashboard): string {
  const head = `ccwarden report, ${new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  return [head, ...dashboardSections(d).map(s => `\n${s.title}\n${s.lines.map(l => `  ${l}`).join('\n')}`)].join('\n')
}

function pct(ratio: number | undefined): string {
  return ratio === undefined ? '–' : `${Math.round(ratio * 100)}%`
}

/** HH:MM UTC of a transcript timestamp (seconds). */
function clock(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(11, 16)
}

function day(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(5, 16).replace('T', ' ')
}
