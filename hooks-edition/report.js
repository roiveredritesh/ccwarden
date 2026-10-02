#!/usr/bin/env node
'use strict';
// Cache report over your Claude Code transcripts (~/.claude/projects/*/*.jsonl).
// Per session: hit ratio, cache writes by TTL, and every cache rebuild with its likely
// cause. Ends with a rough answer to "is the 1h TTL worth it for how I work?".
//
//   node report.js [--days 7] [--project <substring>] [file.jsonl ...]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fmtDuration, fmtTokens, readTranscript } = require('./lib');

// API price multipliers relative to base input tokens.
const WRITE_5M = 1.25;
const WRITE_1H = 2.0;
const READ = 0.1;
const MIN_PREFIX = 10000; // ignore rebuilds of tiny prefixes

function parseArgs(argv) {
  const args = { days: 7, project: null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--project') args.project = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') args.help = true;
    else args.files.push(argv[i]);
  }
  return args;
}

function findTranscripts(days, project) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const cutoff = Date.now() - days * 86400 * 1000;
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (project && !dir.name.includes(project)) continue;
    const full = path.join(root, dir.name);
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.jsonl')) continue;
      const p = path.join(full, name);
      if (fs.statSync(p).mtimeMs >= cutoff) out.push(p);
    }
  }
  return out;
}

// One record per API response of the main conversation, in order. Transcripts write
// one line per content block, all carrying the same message id and usage.
function requestsOf(entries) {
  const seen = new Set();
  const requests = [];
  let compactedSince = false;
  for (const e of entries) {
    if ((e.type === 'system' && e.subtype === 'compact_boundary') || (e.type === 'user' && e.isCompactSummary)) {
      compactedSince = true;
      continue;
    }
    if (e.type !== 'assistant' || e.isSidechain || !e.message || !e.message.usage) continue;
    const id = e.message.id || e.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = e.message.usage;
    const cc = u.cache_creation || {};
    const write = u.cache_creation_input_tokens || 0;
    const write1h = cc.ephemeral_1h_input_tokens || 0;
    requests.push({
      ts: Date.parse(e.timestamp) / 1000,
      model: e.message.model,
      input: u.input_tokens || 0,
      read: u.cache_read_input_tokens || 0,
      write,
      write1h,
      write5m: cc.ephemeral_5m_input_tokens ?? write - write1h,
      afterCompact: compactedSince,
    });
    compactedSince = false;
  }
  return requests.filter((r) => !Number.isNaN(r.ts));
}

function analyze(requests) {
  const s = { requests: requests.length, input: 0, read: 0, write5m: 0, write1h: 0, models: new Set(), rebuilds: [], gapSavings: 0 };
  let ttl1h = false;
  requests.forEach((r, i) => {
    s.input += r.input;
    s.read += r.read;
    s.write5m += r.write5m;
    s.write1h += r.write1h;
    if (r.model) s.models.add(r.model);
    if (r.write1h) ttl1h = true;
    if (i === 0) return;

    const prev = requests[i - 1];
    const prefix = prev.input + prev.read + prev.write;
    const gap = r.ts - prev.ts;
    // An idle gap a 5m cache would not survive but a 1h one would.
    if (gap > 300 && gap <= 3600 && prefix >= MIN_PREFIX) s.gapSavings += prefix * (WRITE_5M - READ);

    if (prefix < MIN_PREFIX || r.read >= prefix * 0.5) return;
    let cause = 'prefix changed';
    if (r.afterCompact) cause = 'compaction';
    else if (prev.model && r.model && prev.model !== r.model) cause = 'model switch';
    else if (gap > (ttl1h ? 3600 : 300)) cause = `expired (idle ${fmtDuration(gap)})`;
    s.rebuilds.push({ at: r.ts, tokens: r.write + r.input, cause });
  });
  const total = s.input + s.read + s.write5m + s.write1h;
  s.hitRatio = total ? s.read / total : null;
  s.lastTs = requests.length ? requests[requests.length - 1].ts : 0;
  return s;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node report.js [--days N] [--project <substring>] [transcript.jsonl ...]');
    return;
  }
  const files = args.files.length ? args.files : findTranscripts(args.days, args.project);
  const sessions = files
    .map((f) => ({ file: f, s: analyze(requestsOf(readTranscript(f))) }))
    .filter((x) => x.s.requests > 0)
    .sort((a, b) => a.s.lastTs - b.s.lastTs);
  if (!sessions.length) {
    console.log('No transcripts with API usage found.');
    return;
  }

  console.log(
    `${pad('session', 10)} ${pad('last active', 17)} ${pad('reqs', 5)} ${pad('hit', 5)} ${pad('write 5m', 9)} ${pad('write 1h', 9)} rebuilds`,
  );
  const totals = { write5m: 0, write1h: 0, gapSavings: 0, rebuildTokens: 0, causes: {} };
  for (const { file, s } of sessions) {
    const when = new Date(s.lastTs * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const hit = s.hitRatio == null ? '-' : `${Math.round(s.hitRatio * 100)}%`;
    console.log(
      `${pad(path.basename(file, '.jsonl').slice(0, 8), 10)} ${pad(when, 17)} ${pad(s.requests, 5)} ${pad(hit, 5)} ` +
        `${pad(fmtTokens(s.write5m), 9)} ${pad(fmtTokens(s.write1h), 9)} ${s.rebuilds.length}`,
    );
    for (const r of s.rebuilds) {
      console.log(`             ↳ ${new Date(r.at * 1000).toISOString().slice(11, 16)} re-cached ${fmtTokens(r.tokens)}: ${r.cause}`);
      totals.rebuildTokens += r.tokens;
      const key = r.cause.startsWith('expired') ? 'expired' : r.cause;
      totals.causes[key] = (totals.causes[key] || 0) + r.tokens;
    }
    totals.write5m += s.write5m;
    totals.write1h += s.write1h;
    totals.gapSavings += s.gapSavings;
  }

  console.log('\nRe-cached tokens by cause:');
  const causes = Object.entries(totals.causes).sort((a, b) => b[1] - a[1]);
  if (!causes.length) console.log('  none — the cache never broke');
  for (const [cause, tokens] of causes) console.log(`  ${pad(cause, 16)} ${fmtTokens(tokens)}`);

  // Rough TTL verdict, in base-input-token equivalents.
  const writes = totals.write5m + totals.write1h;
  const premium = writes * (WRITE_1H - WRITE_5M);
  console.log('\n1h vs 5m TTL (rough estimate, in base input-token equivalents):');
  console.log(`  extra cost of writing at the 1h rate: ${fmtTokens(premium)}`);
  console.log(`  saved on idle gaps of 5–60 min:       ${fmtTokens(totals.gapSavings)}`);
  console.log(
    totals.gapSavings > premium
      ? '  → 1h pays off for how you work (API key: CLAUDE_CODE_PROMPT_CACHE_TTL=1h).'
      : '  → 5m would be cheaper for how you work (API key: keep the 5m default).',
  );
  console.log('  On Pro/Max within plan usage, Claude Code picks 1h itself and you are not billed per token.');
}

if (require.main === module) main();

module.exports = { analyze, requestsOf };
