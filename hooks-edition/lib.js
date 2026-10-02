'use strict';
// Shared helpers for ccwarden. No dependencies beyond Node's standard library.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'ccwarden', 'state');

const DEFAULTS = {
  // Statusline flags "compact at next break" once context reaches this % of the
  // window auto-compaction runs at.
  compactHintPct: 50,
  // "warn" | "block" | "off": what to do when you submit a prompt after the cache went cold.
  coldGuard: 'warn',
  // Ignore cold caches smaller than this; re-caching them is cheap.
  coldGuardMinTokens: 50000,
  // How many of your most recent requests to restore verbatim after a compaction.
  recentPrompts: 5,
  // Upper bound on the restored block, so it can never bloat the fresh context.
  maxRestoreChars: 6000,
  // Delete per-session state files untouched for this many days.
  stateMaxAgeDays: 7,
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function statePath(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? path.join(STATE_DIR, `${safe}.json`) : null;
}

function readState(sessionId) {
  const p = statePath(sessionId);
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(sessionId, state) {
  const p = statePath(sessionId);
  if (!p) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, p);
}

function cleanupOldState(maxAgeDays) {
  const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(STATE_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(STATE_DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {
      // another process removed it first
    }
  }
}

function fmtTokens(n) {
  if (n == null || Number.isNaN(n)) return '?';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function fmtDuration(seconds) {
  if (seconds < 60) return '<1m';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

// The window auto-compaction runs at: CLAUDE_CODE_AUTO_COMPACT_WINDOW when set, else
// the compactWindow install.js recorded in config.json, capped at the model's window.
function compactWindow(contextWindowSize, configured) {
  const size = contextWindowSize || 200000;
  const env = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '', 10);
  const window = env > 0 ? env : configured > 0 ? configured : size;
  return Math.min(window, size);
}

// ---- transcript parsing ----------------------------------------------------

function readTranscript(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // a partially written last line
    }
  }
  return entries;
}

// Text the user actually typed, or null for tool results, hook/system injections,
// slash-command wrappers, compaction summaries and subagent turns. Messages typed
// while Claude was mid-turn are recorded as queued_command attachments.
function userPromptText(entry) {
  if (!entry || entry.isSidechain) return null;
  if (entry.type === 'attachment') {
    const a = entry.attachment || {};
    const human = a.humanTurn || (a.origin && a.origin.kind === 'human');
    return a.type === 'queued_command' && human && typeof a.prompt === 'string' && a.prompt.trim()
      ? a.prompt.trim()
      : null;
  }
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary) return null;
  const content = entry.message && entry.message.content;
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content) && !content.some((b) => b && b.type === 'tool_result')) {
    text = content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  if (!text) return null;
  text = text.trim();
  if (!text || text.startsWith('<')) return null;
  return text;
}

function toolUses(entry) {
  if (!entry || entry.type !== 'assistant' || entry.isSidechain) return [];
  const content = entry.message && entry.message.content;
  return Array.isArray(content) ? content.filter((b) => b && b.type === 'tool_use') : [];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  DEFAULTS,
  EDIT_TOOLS,
  STATE_DIR,
  cleanupOldState,
  compactWindow,
  fmtDuration,
  fmtTokens,
  loadConfig,
  readState,
  readStdinJson,
  readTranscript,
  toolUses,
  truncate,
  userPromptText,
  writeState,
};
