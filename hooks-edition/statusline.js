#!/usr/bin/env node
'use strict';
// Statusline: context fill against the auto-compact window, plus prompt cache health
// (warm/cold, time left on the TTL, hit ratio, last miss cause). It also records the
// cache expiry per session so hooks/prompt-guard.js can tell when the cache went cold.

const { compactWindow, fmtDuration, fmtTokens, loadConfig, readState, readStdinJson, writeState } = require('./lib');

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};
const paint = (color, s) => `${C[color]}${s}${C.reset}`;
const SEP = paint('dim', ' │ ');

function bar(pct, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function contextSegment(input, cfg) {
  const cw = input.context_window || {};
  const used = cw.total_input_tokens || 0;
  const window = compactWindow(cw.context_window_size, cfg.compactWindow);
  const pct = window ? Math.round((used / window) * 100) : 0;
  const color = pct >= 85 ? 'red' : pct >= cfg.compactHintPct ? 'yellow' : 'green';
  const text = `ctx ${bar(pct)} ${pct}% ${fmtTokens(used)}/${fmtTokens(window)}`;
  return { text: paint(color, text), needsCompactHint: pct >= cfg.compactHintPct };
}

function cacheSegment(pc, nowSec) {
  if (!pc) return paint('dim', 'cache –');
  if (!pc.caching_observed) return paint('red', 'cache off');

  const parts = [];
  const left = pc.expires_at ? pc.expires_at - nowSec : -1;
  if (pc.warm && left > 0) {
    const color = left < 300 ? 'yellow' : 'green';
    parts.push(paint(color, `● warm ${pc.ttl || ''} · ${fmtDuration(left)} left`));
  } else {
    const recache = pc.recache_tokens_if_cold;
    parts.push(paint('red', `○ cold${recache ? ` · next turn re-caches ${fmtTokens(recache)}` : ''}`));
  }
  if (pc.hit_ratio != null) parts.push(`hit ${Math.round(pc.hit_ratio * 100)}%`);
  if (pc.misses) {
    const causes = pc.last_miss_cause && pc.last_miss_cause.causes;
    const why = causes && causes.length ? `: ${causes.join(', ').replace(/_/g, ' ')}` : '';
    parts.push(paint('yellow', `miss ${pc.misses}${why}`));
  }
  return `cache ${parts.join(' · ')}`;
}

// Persist what the hooks need, only when it changed (the statusline runs often).
function recordState(input, nowSec) {
  const pc = input.prompt_cache;
  if (!input.session_id || !pc) return;
  const prev = readState(input.session_id) || {};
  const next = {
    ...prev,
    ttl: pc.ttl || null,
    expires_at: pc.expires_at || null,
    recache_tokens_if_cold: pc.recache_tokens_if_cold ?? null,
    ctx_tokens: (input.context_window && input.context_window.total_input_tokens) || 0,
  };
  const changed = ['ttl', 'expires_at', 'recache_tokens_if_cold', 'ctx_tokens'].some((k) => prev[k] !== next[k]);
  if (changed) writeState(input.session_id, { ...next, updated_at: nowSec });
}

function render(input, cfg, nowSec) {
  const model = (input.model && input.model.display_name) || '';
  const ctx = contextSegment(input, cfg);
  const segments = [model, ctx.text, cacheSegment(input.prompt_cache, nowSec)].filter(Boolean);
  if (ctx.needsCompactHint) segments.push(paint('yellow', '⚑ /compact at next break'));
  return segments.join(SEP);
}

if (require.main === module) {
  const input = readStdinJson();
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    recordState(input, nowSec);
  } catch {
    // never let a state write break the statusline
  }
  process.stdout.write(render(input, loadConfig(), nowSec));
}

module.exports = { render };
