import type { Coverage, EfficiencyData, Measured, Range, RangeData, View } from './efficiency'
import { RANGES, UNATTRIBUTED } from './efficiency'
import { fmtTokens } from './status'

// F14: the efficiency dashboard as one self-contained HTML page: inline CSS,
// SVG charts, and a few lines of JS for the range and project filters.
// Nothing external is loaded, and every path and text is escaped. Each
// range × project block is drawn here and the script only shows one, so
// no figure is worked out twice. Pure.

const RANGE_LABEL: Record<Range, string> = { '7d': '7 days', '30d': '30 days', install: 'Since install' }
const COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f']
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
  const updated = new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccwarden efficiency</title><style>${CSS}</style></head><body>
<header><h1>ccwarden efficiency</h1>
<p class="dim">Updated ${updated} UTC · billing ${escapeHtml(d.billing ?? 'not set')} · tokens first, ${money}${d.installDay === undefined ? '' : ` · installed ${escapeHtml(d.installDay)}`}</p>
<nav>${RANGES.map(r => `<button data-set-range="${r}">${RANGE_LABEL[r]}</button>`).join('')}<button data-set-project="">All projects</button></nav></header>
${RANGES.map(r => rangeHtml(r, d.ranges[r], index, d.installDay)).join('\n')}
<footer class="dim">${escapeHtml(coverageLine(d.coverage))}. Transcripts over 4 MiB are left out before and after alike, so the longest sessions are not in the measured figures.</footer>
<script>${SCRIPT}</script></body></html>
`
}

function rangeHtml(range: Range, r: RangeData, index: Map<string, string>, install: string | undefined): string {
  const views = (part: (v: View) => string) => Object.entries(r.views)
    .map(([p, v]) => `<div class="view" data-project="${p === '' ? '' : index.get(p)}">${p === '' ? '' : `<p class="filter">Project: ${escapeHtml(p)}</p>`}${part(v)}</div>`)
    .join('')
  return `<main class="range" data-range="${range}">
${views(v => savingsHtml(v) + realityHtml(v))}
${projectsHtml(r, index)}
${views(v => spendHtml(v, index, install))}
${actionsHtml(r.actions)}
</main>`
}

function usd(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
}

function pct(n: number | undefined): string {
  return n === undefined ? '–' : `${Math.round(n)}%`
}

function savingsHtml(v: View): string {
  const rows = v.savings.map(s => {
    const saved = s.confidence === 'count only' ? '–' : `${s.isInTotal ? '' : 'would save '}~${fmtTokens(Math.round(s.tokens))} tokens · ~${usd(s.usd)} est.`
    const unpriced = s.unpriced > 0 ? ` <span class="tag">${s.unpriced} not priced</span>` : ''
    return `<tr><td>${escapeHtml(s.feature)}${s.isInTotal ? '' : ' <span class="tag">not in total</span>'}</td><td>${escapeHtml(s.did)}</td><td>${s.count}</td><td class="saved">${saved}${unpriced}</td><td><code>${escapeHtml(s.formula)}</code></td><td>${s.confidence}</td></tr>`
  }).join('')
  const table = rows === ''
    ? '<p class="dim">Nothing yet in this range.</p>'
    : `<table><tr><th>Feature</th><th>What it did</th><th>Times</th><th>Saved</th><th>Formula</th><th>Confidence</th></tr>${rows}</table>`
  return `<section><h2>1. Est. savings</h2><p class="total">~${fmtTokens(Math.round(v.totalTokens))} tokens / ~${usd(v.totalUsd)} saved (est.)</p>${table}</section>`
}

function realityHtml(v: View): string {
  const lines: [string, (m: Measured) => string][] = [
    ['Requests', m => String(m.requests)],
    ['Cost per request', m => `$${m.usdPerRequest.toFixed(3)}`],
    ['Cache hit', m => pct(m.hitPct)],
    ['Rebuilds per 100 requests', m => m.rebuildsPer100.toFixed(1)],
    ['Average context', m => `${fmtTokens(Math.round(m.avgContext))} tokens`],
  ]
  const cell = (m: Measured | undefined, f: (m: Measured) => string) => (m === undefined ? '–' : f(m))
  const body = v.before === undefined && v.after === undefined
    ? '<p class="dim">No transcripts read yet.</p>'
    : `<table><tr><th></th><th>Before install</th><th>After install</th></tr>${lines.map(([label, f]) => `<tr><td>${label}</td><td>${cell(v.before, f)}</td><td>${cell(v.after, f)}</td></tr>`).join('')}</table>`
  return `<section><h2>2. Reality check (measured)</h2><p class="dim">From the transcripts, at list price. A trend, not a saving: how you worked changed too.</p>${body}</section>`
}

function projectsHtml(r: RangeData, index: Map<string, string>): string {
  if (r.projects.length === 0) return '<section><h2>3. Projects</h2><p class="dim">No projects yet.</p></section>'
  const rows = r.projects.map(p => {
    const hog = p.topHog === undefined ? '–' : escapeHtml(`${p.topHog.tool} ${p.topHog.target} (${fmtTokens(p.topHog.tokens)})`)
    return `<tr data-set-project="${index.get(p.project)}"><td>${escapeHtml(p.project)}</td><td>${usd(p.usd)} est.</td><td>${p.sessions}</td><td>${p.requests}</td><td>${pct(p.hitPct)}</td><td>${p.rebuilds}</td><td>${hog}</td><td>${usd(p.savedUsd)} est.</td></tr>`
  }).join('')
  return `<section><h2>3. Projects</h2><p class="dim">Click a row to filter sections 1, 2 and 4.</p><table><tr><th>Project</th><th>Spend</th><th>Sessions</th><th>Requests</th><th>Cache hit</th><th>Rebuilds</th><th>Top context hog</th><th>Saved</th></tr>${rows}</table></section>`
}

function spendHtml(v: View, index: Map<string, string>, install: string | undefined): string {
  const total = (u: Record<string, number>) => Object.values(u).reduce((s, x) => s + x, 0)
  const max = Math.max(0, ...v.spend.map(d => total(d.usd)))
  if (max === 0) return '<section><h2>4. Spend over time</h2><p class="dim">No spend recorded in this range.</p></section>'
  const color = (p: string) => (p === UNATTRIBUTED ? '#999' : COLORS[Number(index.get(p) ?? 0) % COLORS.length]!)
  const bw = W / v.spend.length
  const bars = v.spend.map((d, i) => {
    let y = H
    return Object.entries(d.usd).map(([p, x]) => {
      const h = (x / max) * H
      y -= h
      return `<rect x="${(i * bw).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${color(p)}"><title>${escapeHtml(`${d.day} ${p}: ${usd(x)} est.`)}</title></rect>`
    }).join('')
  }).join('')
  const at = install === undefined ? -1 : v.spend.findIndex(d => d.day === install)
  const mark = at === -1 ? '' : `<line class="install" x1="${(at * bw).toFixed(1)}" x2="${(at * bw).toFixed(1)}" y1="0" y2="${H}"/><text class="install" x="${(at * bw + 3).toFixed(1)}" y="12">install</text>`
  const shown = [...new Set(v.spend.flatMap(d => Object.keys(d.usd)))]
  const legend = shown.map(p => `<span><i style="background:${color(p)}"></i>${escapeHtml(p)}</span>`).join('')
  return `<section><h2>4. Spend over time</h2><p class="dim">Est. $ per day, up to ${usd(max)}.</p><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spend per day">${bars}${mark}</svg><p class="legend">${legend}</p></section>`
}

function actionsHtml(actions: readonly string[]): string {
  const body = actions.length === 0 ? '<p class="dim">Nothing stands out.</p>' : `<ul>${actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
  return `<section><h2>5. What to do</h2>${body}</section>`
}

const CSS = `
:root{color-scheme:light dark;--fg:#1d1d1f;--dim:#6e6e73;--bg:#fff;--line:#d2d2d7;--on:#0a66c2}
@media(prefers-color-scheme:dark){:root{--fg:#f5f5f7;--dim:#a1a1a6;--bg:#1c1c1e;--line:#3a3a3c;--on:#4ea1ff}}
body{font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:20px 0 6px}
.dim{color:var(--dim)}.total{font-size:18px;font-weight:600}.filter{font-weight:600}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
tr[data-set-project]{cursor:pointer}tr.on{outline:2px solid var(--on)}
.tag{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 4px}
nav{margin:10px 0;display:flex;gap:6px;flex-wrap:wrap}button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:none;color:inherit;cursor:pointer}button.on{border-color:var(--on);color:var(--on)}
svg{width:100%;height:auto}line.install{stroke:var(--on);stroke-dasharray:4 3}text.install{fill:var(--on);font-size:11px}
.legend span{margin-right:12px;white-space:nowrap}.legend i{display:inline-block;width:10px;height:10px;margin-right:4px}
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
`
