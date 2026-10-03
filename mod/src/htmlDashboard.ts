import type { Coverage, EfficiencyData, Measured, Range, RangeData, SavingRow, View } from './efficiency'
import { RANGES, UNATTRIBUTED } from './efficiency'
import { fmtTokens } from './status'
import type { Feature } from './metrics'
import { MIN_HOLDOUT, MIN_PROTECTED, proofClaim, selfCheck } from './proof'
import type { ProofResult } from './proof'

// F14: the efficiency dashboard as one self-contained HTML page: inline CSS,
// SVG charts, and a few lines of JS for the range and project filters.
// Nothing external is loaded, and every path and text is escaped. Each
// range × project block is drawn here and the script only shows one, so
// no figure is worked out twice. Pure.

const RANGE_LABEL: Record<Range, string> = { '7d': '7 days', '30d': '30 days', install: 'Since install' }
/** Chart slots in fixed order (the dataviz reference palette); projects past the 7th fold into "Other". */
const SLOTS = 7
const W = 720
const H = 160

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** "92 of 102 transcripts read; 10 over 4 MiB skipped", plus failed and not-yet-read counts when there are any. */
export function coverageLine(c: Coverage): string {
  const parts = [`${c.read} of ${c.total} transcripts read`]
  if (c.skippedBig > 0) parts.push(`${c.skippedBig} over 4 MiB skipped`)
  if (c.failed > 0) parts.push(`${c.failed} could not be read`)
  if (c.pending > 0) parts.push(`${c.pending} not read yet`)
  return parts.join('; ')
}

export function dashboardHtml(d: EfficiencyData): string {
  const money = d.billing === 'window' ? '$ is a list-price equivalent' : '$ at list price'
  const index = new Map(d.projects.map((p, i) => [p, String(i)]))
  const colors = colorsOf(d)
  const updated = new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccwarden efficiency</title><style>${CSS}</style></head><body>
<header><h1>ccwarden efficiency</h1>
<p class="dim">Updated ${updated} UTC · billing ${escapeHtml(d.billing ?? 'not set')} · tokens first, ${money}${d.installDay === undefined ? '' : ` · installed ${escapeHtml(d.installDay)}`}</p>
<nav><span class="seg">${RANGES.map(r => `<button data-set-range="${r}">${RANGE_LABEL[r]}</button>`).join('')}</span><button data-set-project="">All projects</button><button data-copy>Copy summary</button><button data-download>Download raw JSON</button></nav></header>
${proofHtml(d.proof)}
${RANGES.map(r => rangeHtml(r, d.ranges[r], index, colors, d.hiddenProjects, d.proof)).join('\n')}
${sessionsHtml(d)}
${eventsHtml(d)}
<pre id="cw-summary" hidden>${escapeHtml(summaryMarkdown(d))}</pre>
<pre id="cw-raw" hidden>${escapeHtml(JSON.stringify({ sessions: d.sessions, events: d.events }))}</pre>
<div id="tip" role="tooltip" hidden></div>
<footer class="dim">${escapeHtml(coverageLine(d.coverage))}. Transcripts over 4 MiB are left out before and after alike, so the longest sessions are not in the measured figures.</footer>
<script>${SCRIPT}</script></body></html>
`
}

function rangeHtml(range: Range, r: RangeData, index: Map<string, string>, colors: Map<string, number>, unused: number, proof: ProofResult): string {
  const views = (part: (v: View) => string) => Object.entries(r.views)
    .map(([p, v]) => `<div class="view" data-project="${p === '' ? '' : index.get(p)}">${p === '' ? '' : `<p class="filter">Project: ${escapeHtml(p)}</p>`}${part(v)}</div>`)
    .join('')
  return `<main class="range" data-range="${range}">
${views(v => verdictHtml(RANGE_LABEL[range], v, proof) + cardsHtml(v))}
${actionsHtml(r.actions)}
${views(v => savingsHtml(v) + realityHtml(v) + activityHtml(v))}
${projectsHtml(r, index, unused)}
${views(v => spendHtml(v, colors))}
</main>`
}

/** "~12k tokens", or undefined when the savings are $ only (F5 pins save price, not tokens). */
function savedTokens(v: View): string | undefined {
  const t = Math.round(v.totalTokens)
  return t > 0 ? `~${fmtTokens(t)} tokens` : undefined
}

function usd(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
}

function pct(n: number | undefined): string {
  return n === undefined ? '–' : `${Math.round(n)}%`
}

/** The last path segment, the bit a person recognises. */
function shortName(project: string): string {
  return project.split('/').filter(Boolean).at(-1) ?? project
}

/** "▼ 30% better": the arrow and the word carry it, the colour only repeats it. `unit` '%' is relative, else an absolute difference. */
function change(before: number, after: number, lowerIsBetter: boolean, unit: '%' | 'pts' | ''): string {
  const diff = unit === '%' ? (before === 0 ? 0 : ((after - before) / before) * 100) : after - before
  if (Math.abs(diff) < (unit === '' ? 0.05 : 0.5)) return '<span class="dim">no change</span>'
  const good = diff < 0 === lowerIsBetter
  const size = unit === '' ? Math.abs(diff).toFixed(1) : `${Math.round(Math.abs(diff))}${unit === '%' ? '%' : ' pts'}`
  return `<span class="${good ? 'good' : 'bad'}">${diff < 0 ? '▼' : '▲'} ${size} ${good ? 'better' : 'worse'}</span>`
}

function card(label: string, value: string, note: string): string {
  return `<div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`
}

/** The headline: what ccwarden counted, how prompt size and cost per request moved, and spend in the range. */
function cardsHtml(v: View): string {
  const counted = v.savings.filter(r => r.isInTotal)
  const saved = v.totalTokens > 0 || v.totalUsd !== 0
    ? card('Saved by ccwarden (est.)', savedTokens(v) ?? `~${usd(v.totalUsd)}`, `${savedTokens(v) === undefined ? '' : `~${usd(v.totalUsd)} `}est. from ${counted.reduce((s, r) => s + r.count, 0)} actions`)
    : card('Saved by ccwarden (est.)', 'Nothing counted yet', escapeHtml(whyNothing(v)))
  const { before: b, after: a } = v
  const both = b !== undefined && a !== undefined
  const smaller = both ? (b.avgContext - a.avgContext) * a.requests : 0
  const prompt = both
    ? card('Average prompt (measured)', `${fmtTokens(Math.round(b.avgContext))} → ${fmtTokens(Math.round(a.avgContext))}`,
      `${change(b.avgContext, a.avgContext, true, '%')} · ≈ ${fmtTokens(Math.round(Math.abs(smaller)))} ${smaller >= 0 ? 'fewer' : 'more'} tokens sent over ${a.requests} requests. A trend, not all from ccwarden.`)
    : card('Average prompt (measured)', '–', 'Needs transcripts from both before and after install.')
  const cost = both
    ? card('Cost per request (measured)', `$${b.usdPerRequest.toFixed(3)} → $${a.usdPerRequest.toFixed(3)}`, `${change(b.usdPerRequest, a.usdPerRequest, true, '%')} · cache hit ${pct(a.hitPct)}`)
    : card('Cost per request (measured)', '–', 'Needs transcripts from both before and after install.')
  const spent = v.spend.reduce((s, d) => s + Object.values(d.usd).reduce((t, x) => t + x, 0), 0)
  return `<section class="cards">${saved}${prompt}${cost}${card('Spend in range', `${usd(spent)} <small>est.</small>`, `over ${v.spend.length} days, all projects in view`)}</section>`
}

/** Why the total is empty: which features count, and what the junk guard in observe would have done. */
function whyNothing(v: View): string {
  const observe = v.savings.find(r => r.feature === 'Junk guard (observe)')
  const why = 'A saving is counted when the junk guard (in enforce), keep-warm or a snapshot compaction acts; none did here.'
  return observe === undefined || observe.tokens === 0
    ? why
    : `${why} In observe, the junk guard would have kept out ~${fmtTokens(Math.round(observe.tokens))} tokens (${observe.count} times).`
}

function savedCell(s: SavingRow): string {
  if (s.confidence === 'count only') return '–'
  const prefix = s.isInTotal ? '' : 'would save '
  const tokens = `${prefix}~${fmtTokens(Math.round(s.tokens))} tokens`
  // ponytail: an event with no price still kept its tokens out once; showing $0.00 for it would read as "saved nothing"
  if (s.unpriced === s.count) return `${tokens} (est.)`
  return Math.round(s.tokens) > 0 ? `${tokens} · ~${usd(s.usd)} est.` : `${prefix}~${usd(s.usd)} est.` // a pin saves price, not tokens
}

function savingsHtml(v: View): string {
  const priced = v.savings.filter(s => s.usd !== 0)
  const max = Math.max(0, ...priced.map(s => Math.abs(s.usd)))
  const bars = priced.map(s => `<div class="hbar" tabindex="0" data-tip="${escapeHtml(`${s.feature}: ${s.did}, ${s.count} times`)}"><span>${escapeHtml(s.feature)}${s.isInTotal ? '' : ' <span class="tag">not in total</span>'}</span><i class="${s.usd < 0 ? 'neg' : 'pos'}" style="width:${((Math.abs(s.usd) / max) * 100).toFixed(0)}%"></i><b>${usd(s.usd)} est.</b></div>`).join('')
  const rows = v.savings.map(s => {
    const unpriced = s.unpriced > 0 ? ` <span class="tag">${s.unpriced} not priced</span>` : ''
    return `<tr><td>${escapeHtml(s.feature)}${s.isInTotal ? '' : ' <span class="tag">not in total</span>'}<br><code>${escapeHtml(s.formula)}</code></td><td>${escapeHtml(s.did)}</td><td class="num">${s.count}</td><td class="saved">${savedCell(s)}${unpriced}</td><td>${s.confidence}</td></tr>`
  }).join('')
  const table = rows === ''
    ? '<p class="dim">Nothing yet in this range.</p>'
    : `<details><summary>How it's computed</summary><table><tr><th>Feature and formula</th><th>What it did</th><th class="num">Times</th><th>Saved</th><th>Confidence</th></tr>${rows}</table></details>`
  return `<section><h2>Est. savings by feature</h2><p class="dim">${savedTokens(v) === undefined ? '' : `${savedTokens(v)} / `}~${usd(v.totalUsd)} saved (est.). Rows marked "not in total" are what a feature would have done.</p>${bars}${table}</section>`
}

function realityHtml(v: View): string {
  const lines: [string, (m: Measured) => string, ((b: Measured, a: Measured) => string) | undefined][] = [
    ['Requests', m => String(m.requests), undefined],
    ['Cost per request', m => `$${m.usdPerRequest.toFixed(3)}`, (b, a) => change(b.usdPerRequest, a.usdPerRequest, true, '%')],
    ['Cache hit', m => pct(m.hitPct), (b, a) => change(b.hitPct, a.hitPct, false, 'pts')],
    ['Rebuilds per 100 requests', m => m.rebuildsPer100.toFixed(1), (b, a) => change(b.rebuildsPer100, a.rebuildsPer100, true, '')],
    ['Average context', m => `${fmtTokens(Math.round(m.avgContext))} tokens`, (b, a) => change(b.avgContext, a.avgContext, true, '%')],
  ]
  const cell = (m: Measured | undefined, f: (m: Measured) => string) => (m === undefined ? '–' : f(m))
  const { before: b, after: a } = v
  const body = b === undefined && a === undefined
    ? '<p class="dim">No transcripts read yet.</p>'
    : `<table><tr><th></th><th class="num">Before install</th><th class="num">After install</th><th>Change</th></tr>${lines.map(([label, f, c]) => `<tr><td>${label}</td><td class="num">${cell(b, f)}</td><td class="num">${cell(a, f)}</td><td>${c === undefined || b === undefined || a === undefined ? '' : c(b, a)}</td></tr>`).join('')}</table>`
  return `<section><h2>Reality check (measured)</h2><p class="dim">From the transcripts, at list price. A trend, not a saving: how you worked changed too.</p>${body}</section>`
}

function projectsHtml(r: RangeData, index: Map<string, string>, unused: number): string {
  const active = r.projects.filter(p => p.requests > 0 || p.usd >= 0.005)
  const left = unused === 0 ? '' : ` ${unused} project${unused === 1 ? '' : 's'} with no session since install not shown.`
  if (active.length === 0) return `<section><h2>Projects</h2><p class="dim">No projects yet.${left}</p></section>`
  const max = Math.max(...active.map(p => p.usd))
  const rows = active.map(p => {
    const hog = p.topHog === undefined ? '–' : escapeHtml(`${p.topHog.tool} ${shortName(p.topHog.target.replace(/\\/g, '/'))} (${fmtTokens(p.topHog.tokens)})`)
    const name = shortName(p.project)
    const bar = max > 0 ? `<span class="bar"><i style="width:${((p.usd / max) * 100).toFixed(0)}%"></i></span>` : ''
    return `<tr data-set-project="${index.get(p.project)}"><td><b>${escapeHtml(name)}</b>${p.project === UNATTRIBUTED ? '<span class="path">spend the ledger counted that no read transcript explains: sessions over 4 MiB and subagents</span>' : name === p.project ? '' : `<span class="path">${escapeHtml(p.project)}</span>`}</td><td class="num">${usd(p.usd)} est.${bar}</td><td class="num">${p.sessions}</td><td class="num">${p.requests}</td><td class="num">${pct(p.hitPct)}</td><td class="num">${p.rebuilds}</td><td>${hog}</td><td class="num">${Math.abs(p.savedUsd) < 0.005 ? '–' : `${usd(p.savedUsd)} est.`}</td></tr>`
  }).join('')
  const hidden = r.projects.length - active.length
  const note = (hidden === 0 ? '' : ` ${hidden} folder${hidden === 1 ? '' : 's'} with no activity in this range not shown.`) + left
  return `<section><h2>Projects</h2><p class="dim">Click a row to filter the page.${note}</p><table><tr><th>Project</th><th class="num">Spend</th><th class="num">Sessions</th><th class="num">Requests</th><th class="num">Cache hit</th><th class="num">Rebuilds</th><th>Top context hog</th><th class="num">Saved</th></tr>${rows}</table></section>`
}

/** Colour slot per project, fixed by all-time spend so a filter never repaints one; unattributed and the rest are "Other". */
function colorsOf(d: EfficiencyData): Map<string, number> {
  const total = new Map<string, number>()
  const seen = new Set<string>()
  for (const r of RANGES) {
    for (const day of d.ranges[r].views['']?.spend ?? []) {
      if (seen.has(day.day)) continue
      seen.add(day.day)
      for (const [p, x] of Object.entries(day.usd)) total.set(p, (total.get(p) ?? 0) + x)
    }
  }
  const top = [...total].filter(([p]) => p !== UNATTRIBUTED).sort((a, b) => b[1] - a[1]).slice(0, SLOTS)
  return new Map(top.map(([p], i) => [p, i + 1]))
}

function spendHtml(v: View, colors: Map<string, number>): string {
  const OTHER = 'Other'
  const days = v.spend.map(d => {
    const by: Record<string, number> = {}
    for (const [p, x] of Object.entries(d.usd)) {
      const k = colors.has(p) ? p : OTHER
      by[k] = (by[k] ?? 0) + x
    }
    return { day: d.day, by }
  })
  const total = (u: Record<string, number>) => Object.values(u).reduce((s, x) => s + x, 0)
  const max = Math.max(0, ...days.map(d => total(d.by)))
  if (max === 0) return '<section><h2>Spend over time</h2><p class="dim">No spend recorded in this range.</p></section>'
  const fill = (p: string) => (p === OTHER ? 'var(--other)' : `var(--s${colors.get(p)})`)
  const order = (by: Record<string, number>) => Object.entries(by).sort(([a], [b]) => (colors.get(a) ?? 99) - (colors.get(b) ?? 99))
  const bw = W / days.length
  const bars = days.map((d, i) => {
    let y = H
    return order(d.by).map(([p, x]) => {
      const h = (x / max) * H
      y -= h
      return `<rect x="${(i * bw).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill(p)}" stroke="var(--bg)" stroke-width="1" tabindex="0" data-tip="${escapeHtml(`${d.day} · ${p}: ${usd(x)} est. (day total ${usd(total(d.by))})`)}"/>`
    }).join('')
  }).join('')
  const ticks = [0, days.length - 1].filter((i, n, a) => a.indexOf(i) === n)
    .map(i => `<text class="axis" x="${(i * bw + (i === 0 ? 0 : bw)).toFixed(1)}" y="${H + 14}" text-anchor="${i === 0 ? 'start' : 'end'}">${days[i]!.day.slice(5)}</text>`).join('')
  const shown = [...new Set(days.flatMap(d => Object.keys(d.by)))].sort((a, b) => (colors.get(a) ?? 99) - (colors.get(b) ?? 99))
  const legend = shown.map(p => `<span title="${escapeHtml(p)}"><i style="background:${fill(p)}"></i>${escapeHtml(p === OTHER ? OTHER : shortName(p))}</span>`).join('')
  return `<section><h2>Spend over time</h2><p class="dim">Est. $ per day; the tallest bar is ${usd(max)}. Hover a bar for its project.</p><svg viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="Spend per day">${bars}${ticks}</svg>${shown.length > 1 ? `<p class="legend">${legend}</p>` : ''}</section>`
}

function proofHtml(p: ProofResult): string {
  const claim = escapeHtml(proofClaim(p))
  if (p.kind === 'off') return `<section class="proof"><h2>Proof (holdout)</h2><p>${claim}</p></section>`
  if (p.kind === 'collecting') {
    const bar = (n: number, of: number) => `<span class="bar"><i style="width:${Math.min(100, (n / of) * 100).toFixed(0)}%"></i></span>`
    return `<section class="proof"><h2>Proof (holdout)</h2><p>${claim}</p><p class="dim">Holdout ${p.holdout}/${MIN_HOLDOUT}${bar(p.holdout, MIN_HOLDOUT)}Protected ${p.protected}/${MIN_PROTECTED}${bar(p.protected, MIN_PROTECTED)}</p></section>`
  }
  const lo = Math.min(-20, p.lowPct - 5)
  const hi = Math.max(40, p.highPct + 5)
  const x = (v: number) => (((v - lo) / (hi - lo)) * 600 + 60).toFixed(1)
  const svg = `<svg viewBox="0 0 720 60" role="img" aria-label="${claim}"><line class="axis" x1="60" x2="660" y1="30" y2="30"/><line class="zero" x1="${x(0)}" x2="${x(0)}" y1="12" y2="48"/><text class="axis" x="${x(0)}" y="58" text-anchor="middle">0%</text><line class="range" x1="${x(p.lowPct)}" x2="${x(p.highPct)}" y1="30" y2="30" data-tip="${escapeHtml(`90% range ${Math.round(p.lowPct)}% to ${Math.round(p.highPct)}%`)}"/><circle class="point" cx="${x(p.lessPct)}" cy="30" r="6" data-tip="${escapeHtml(`${Math.round(p.lessPct)}% less per prompt`)}"/><text class="axis" x="60" y="12">more per prompt</text><text class="axis" x="660" y="12" text-anchor="end">less per prompt</text></svg>`
  const check = selfCheck(p)
  return `<section class="proof"><h2>Proof (holdout)</h2><p class="total">${claim}</p>${svg}<p class="dim">Median per prompt: holdout $${p.holdoutMedian.toFixed(3)}, protected $${p.protectedMedian.toFixed(3)}.${check === undefined ? '' : ` ${escapeHtml(check)}`}</p></section>`
}

/** F15: the logged features in a fixed order, which is also their chart colour slot; Handoffs fold to "Other". */
const FEATURES: readonly Feature[] = ['subagent', 'cold', 'topic', 'junk', 'snapshot', 'keepwarm', 'limit', 'handoff']
const FEATURE_LABEL: Record<Feature, string> = {
  subagent: 'Subagent guard', cold: 'Cold-cache guard', topic: 'Unrelated-prompt hint', junk: 'Junk guard',
  snapshot: 'Snapshot compaction', keepwarm: 'Keep-warm', limit: 'Limit hints', handoff: 'Handoffs',
}
/** Events the page lists; the raw JSON holds up to RECENT_EVENTS. */
const EVENTS_SHOWN = 100
const SESSIONS_SHOWN = 200

function featureFill(f: Feature): string {
  const i = FEATURES.indexOf(f)
  return i >= 0 && i < SLOTS ? `var(--s${i + 1})` : 'var(--other)'
}

/** The first and last day under a day chart. */
function dayTicks(days: readonly string[], bw: number): string {
  return [0, days.length - 1].filter((i, n, a) => a.indexOf(i) === n)
    .map(i => `<text class="axis" x="${(i * bw + (i === 0 ? 0 : bw)).toFixed(1)}" y="${H + 14}" text-anchor="${i === 0 ? 'start' : 'end'}">${days[i]!.slice(5)}</text>`).join('')
}

/** One sentence per range: what was saved (est.), and where the proof stands. */
function verdictHtml(label: string, v: View, p: ProofResult): string {
  return `<p class="verdict">${label}: ccwarden saved ${savedTokens(v) === undefined ? `~${usd(v.totalUsd)} (est.)` : `${savedTokens(v)} (~${usd(v.totalUsd)} est.)`} ${escapeHtml(proofClaim(p))}</p>`
}

/** F15: events per day by feature, from the metrics log. */
function activityHtml(v: View): string {
  const total = (c: Partial<Record<Feature, number>>) => Object.values(c).reduce((s: number, n) => s + (n ?? 0), 0)
  const max = Math.max(0, ...v.activity.map(d => total(d.counts)))
  if (max === 0) return '<section><h2>What ccwarden did</h2><p class="dim">No ccwarden activity logged in this range.</p></section>'
  const bw = W / v.activity.length
  const bars = v.activity.map((d, i) => {
    let y = H
    return FEATURES.filter(f => (d.counts[f] ?? 0) > 0).map(f => {
      const n = d.counts[f]!
      const h = (n / max) * H
      y -= h
      return `<rect x="${(i * bw).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${featureFill(f)}" stroke="var(--bg)" stroke-width="1" tabindex="0" data-tip="${escapeHtml(`${d.day} · ${FEATURE_LABEL[f]}: ${n}`)}"/>`
    }).join('')
  }).join('')
  const shown = FEATURES.filter(f => v.activity.some(d => (d.counts[f] ?? 0) > 0))
  const legend = shown.map(f => `<span><i style="background:${featureFill(f)}"></i>${FEATURE_LABEL[f]}</span>`).join('')
  return `<section><h2>What ccwarden did</h2><p class="dim">Events per day by feature, from the metrics log; the busiest day had ${max}.</p><svg viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="ccwarden events per day">${bars}${dayTicks(v.activity.map(d => d.day), bw)}</svg>${shown.length > 1 ? `<p class="legend">${legend}</p>` : ''}</section>`
}

/** F15: the last 30 days' sessions; a click shows only that session's events. */
function sessionsHtml(d: EfficiencyData): string {
  if (d.sessions.length === 0) return '<section><h2>Sessions</h2><p class="dim">No sessions in the metrics log yet.</p></section>'
  const rows = d.sessions.slice(0, SESSIONS_SHOWN).map(s => `<tr data-session="${escapeHtml(s.session)}"><td>${new Date(s.startedAt).toISOString().slice(0, 16).replace('T', ' ')}</td><td title="${escapeHtml(s.project)}">${escapeHtml(shortName(s.project))}</td><td>${s.family ?? '–'}</td><td>${s.holdout ? '<span class="tag">holdout</span>' : '–'}</td><td class="num">${s.prompts}</td><td class="num">${s.usdPerPrompt === undefined ? '–' : `$${s.usdPerPrompt.toFixed(3)}`}</td><td class="num">${Math.abs(s.estUsd) < 0.005 ? '–' : `${usd(s.estUsd)} est.`}</td></tr>`).join('')
  return `<section><h2>Sessions (last 30 days)</h2><p class="dim">Click a session to show only its events below; click it again for all.</p><table><tr><th>Started (UTC)</th><th>Project</th><th>Model</th><th>Holdout</th><th class="num">Prompts</th><th class="num">$ per prompt</th><th class="num">Saved</th></tr>${rows}</table></section>`
}

/** F15: the newest events, filterable by feature and by session; the files' folder named. */
function eventsHtml(d: EfficiencyData): string {
  const shown = d.events.slice(0, EVENTS_SHOWN)
  const where = d.metricsDir === undefined ? '' : ` Raw files: <code>${escapeHtml(d.metricsDir)}</code>.`
  if (shown.length === 0) return `<section><h2>Event log</h2><p class="dim">No events logged yet.${where}</p></section>`
  const label = (f: string) => escapeHtml(FEATURE_LABEL[f as Feature] ?? f)
  const options = [...new Set(shown.map(e => e.feature))].map(f => `<option value="${escapeHtml(f)}">${label(f)}</option>`).join('')
  const rows = shown.map(e => `<tr data-feature="${escapeHtml(e.feature)}" data-session="${escapeHtml(e.session)}"><td>${new Date(e.at).toISOString().slice(0, 19).replace('T', ' ')}</td><td>${escapeHtml(e.session.slice(0, 8))}</td><td>${label(e.feature)}</td><td>${escapeHtml(e.action)}${e.would ? ' <span class="tag">would</span>' : ''}</td><td class="num">${e.est === undefined ? '–' : `${usd(e.est.usd)} est.`}</td><td><code>${escapeHtml(Object.entries(e.measured).map(([k, x]) => `${k}=${String(x)}`).join(' '))}</code></td></tr>`).join('')
  return `<section><h2>Event log</h2><p class="dim">The latest ${shown.length} of ${d.events.length} events in the last 30 days.${where}</p><select data-filter-feature><option value="">All features</option>${options}</select><table><tr><th>Time (UTC)</th><th>Session</th><th>Feature</th><th>Action</th><th class="num">Saved</th><th>Measured</th></tr>${rows}</table></section>`
}

/** A short Markdown report to paste into an issue or a chat; built from the page's own figures. */
export function summaryMarkdown(d: EfficiencyData): string {
  const v = d.ranges['30d'].views['']!
  const top = v.savings.filter(r => r.isInTotal && r.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 3)
  return [
    `## ccwarden report (${new Date(d.at).toISOString().slice(0, 10)})`,
    `- Saved (est., 30 days): ${savedTokens(v) === undefined ? '' : `${savedTokens(v)} / `}~${usd(v.totalUsd)}`,
    `- Proof: ${proofClaim(d.proof)}`,
    ...(top.length === 0 ? [] : [`- Top savings: ${top.map(r => `${r.feature} ~${usd(r.usd)}`).join(', ')}`]),
    `- Coverage: ${coverageLine(d.coverage)}; ${d.sessions.length} sessions in the metrics log`,
  ].join('\n')
}

function actionsHtml(actions: readonly string[]): string {
  const body = actions.length === 0 ? '<p class="dim">Nothing stands out.</p>' : `<ul>${actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
  return `<section class="actions"><h2>What to do</h2>${body}</section>`
}

const CSS = `
:root{color-scheme:light;--fg:#0b0b0b;--dim:#52514e;--bg:#fcfcfb;--card:#f3f2ef;--line:#e0dfdb;--on:#2a78d6;--good:#008300;--bad:#c62f2e;--other:#a3a29d;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--fg:#fff;--dim:#c3c2b7;--bg:#1a1a19;--card:#252523;--line:#383835;--on:#3987e5;--good:#3fb43f;--bad:#e66767;--other:#6b6a65;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9}}
body{font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:24px 0 6px}
header{position:sticky;top:0;background:var(--bg);padding-bottom:4px;border-bottom:1px solid var(--line);z-index:1}
.dim{color:var(--dim)}.filter{font-weight:600;margin:12px 0 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}
.card{background:var(--card);border-radius:10px;padding:12px 14px}
.card .label{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
.card .value{font-size:24px;font-weight:650;margin:4px 0;font-variant-numeric:tabular-nums}.card .value small{font-size:13px;font-weight:400;color:var(--dim)}
.card .note{font-size:13px;color:var(--dim)}
.actions{border-left:3px solid var(--on);padding-left:12px}.actions ul{margin:4px 0;padding-left:18px}
.good{color:var(--good);font-weight:600}.bad{color:var(--bad);font-weight:600}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-variant-numeric:tabular-nums}
td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{font-size:12px;color:var(--dim);font-weight:600}
.num{text-align:right;white-space:nowrap}
td code{font-size:11px;color:var(--dim)}
.path{display:block;font-size:11px;color:var(--dim)}
.bar{display:block;height:4px;background:var(--line);border-radius:2px;margin-top:4px}.bar i{display:block;height:4px;background:var(--on);border-radius:2px}
tr[data-set-project]{cursor:pointer}tr[data-set-project]:hover{background:var(--card)}tr.on{outline:2px solid var(--on)}
.tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 4px}
nav{margin:10px 0;display:flex;gap:8px;flex-wrap:wrap}.seg{display:inline-flex}.seg button{border-radius:0}.seg button:first-child{border-radius:6px 0 0 6px}.seg button:last-child{border-radius:0 6px 6px 0}.seg button+button{border-left:none}
button{font:inherit;padding:4px 12px;border:1px solid var(--line);border-radius:6px;background:none;color:inherit;cursor:pointer}button.on{background:var(--on);border-color:var(--on);color:#fff}
svg{width:100%;height:auto}text.axis{fill:var(--dim);font-size:11px}
.legend span{margin-right:14px;white-space:nowrap}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}
footer{margin-top:24px;font-size:12px}
.verdict{font-size:16px;font-weight:600;margin:16px 0 0}
.hbar{display:grid;grid-template-columns:minmax(90px,30%) 1fr auto;gap:8px;align-items:center;margin:4px 0}.hbar i{display:block;height:10px;border-radius:2px}.hbar i.pos{background:var(--good)}.hbar i.neg{background:var(--bad)}.hbar b{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
#tip{position:absolute;background:var(--fg);color:var(--bg);font-size:12px;padding:2px 6px;border-radius:4px;pointer-events:none;z-index:2}
tr[data-session]{cursor:pointer}tr[data-session].on{outline:2px solid var(--on)}details summary{cursor:pointer;color:var(--dim);margin:8px 0}select{font:inherit;margin:4px 0 8px;padding:2px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
.proof{border-left:3px solid var(--on);padding-left:12px}.proof .total{font-size:16px;font-weight:600}
line.axis{stroke:var(--line)}line.zero{stroke:var(--dim);stroke-dasharray:3 3}line.range{stroke:var(--on);stroke-width:4;stroke-linecap:round}circle.point{fill:var(--on);stroke:var(--bg);stroke-width:2}
`

// Shows one range and one project; kept in the URL's hash so the minute refresh keeps them.
const SCRIPT = `
const st={range:'30d',project:''};
const h=decodeURIComponent(location.hash.slice(1)).split('|');
if(['7d','30d','install'].includes(h[0]))st.range=h[0];
if(h.length>1)st.project=h[1];
function show(){
  if(!document.querySelector('.view[data-project="'+CSS.escape(st.project)+'"]'))st.project='';
  for(const el of document.querySelectorAll('.range'))el.hidden=el.dataset.range!==st.range;
  for(const el of document.querySelectorAll('.view'))el.hidden=el.dataset.project!==st.project;
  for(const b of document.querySelectorAll('[data-set-range]'))b.classList.toggle('on',b.dataset.setRange===st.range);
  for(const b of document.querySelectorAll('button[data-set-project]'))b.classList.toggle('on',st.project==='');
  for(const r of document.querySelectorAll('tr[data-set-project]'))r.classList.toggle('on',r.dataset.setProject===st.project);
  history.replaceState(null,'','#'+encodeURIComponent(st.range+'|'+st.project));
}
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-set-range],[data-set-project]');
  if(!t)return;
  if(t.dataset.setRange)st.range=t.dataset.setRange;
  if(t.dataset.setProject!==undefined)st.project=t.dataset.setProject;
  show();
});
show();
const tip=document.getElementById('tip');
function showTip(t){const r=t.getBoundingClientRect();tip.textContent=t.dataset.tip;tip.hidden=false;tip.style.left=(r.left+window.scrollX)+'px';tip.style.top=(r.top+window.scrollY-28)+'px';}
document.addEventListener('mouseover',e=>{const t=e.target.closest('[data-tip]');if(t)showTip(t);else tip.hidden=true;});
document.addEventListener('focusin',e=>{const t=e.target.closest('[data-tip]');if(t)showTip(t);});
let evFeature='',evSession='';
function filterEvents(){for(const r of document.querySelectorAll('tr[data-feature]'))r.hidden=(evFeature!==''&&r.dataset.feature!==evFeature)||(evSession!==''&&r.dataset.session!==evSession);for(const r of document.querySelectorAll('tr[data-session]:not([data-feature])'))r.classList.toggle('on',r.dataset.session===evSession);}
document.addEventListener('change',e=>{if(e.target.matches('[data-filter-feature]')){evFeature=e.target.value;filterEvents();}});
document.addEventListener('click',e=>{
  const s=e.target.closest('tr[data-session]:not([data-feature])');
  if(s){evSession=evSession===s.dataset.session?'':s.dataset.session;filterEvents();}
  const c=e.target.closest('[data-copy]');
  if(c){const p=document.getElementById('cw-summary');navigator.clipboard.writeText(p.textContent).then(()=>{c.textContent='Copied';},()=>{p.hidden=false;getSelection().selectAllChildren(p);});}
  if(e.target.closest('[data-download]')){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([document.getElementById('cw-raw').textContent],{type:'application/json'}));a.download='ccwarden-metrics.json';a.click();}
});
`
