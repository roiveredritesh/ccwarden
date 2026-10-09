#!/usr/bin/env node
'use strict';
// Installs ccwarden into ~/.claude/ccwarden and merges its statusline and hooks
// into ~/.claude/settings.json. Existing settings are kept (a timestamped backup is
// written first), and re-running replaces ccwarden's own entries instead of
// duplicating them.
//
//   node install.js [--compact-window 120000] [--cold-guard warn|block|off]
//                   [--force-statusline] [--dry-run]
//   node install.js --uninstall

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TARGET = path.join(CLAUDE_DIR, 'ccwarden');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const FILES = ['lib.js', 'statusline.js', 'report.js', 'hooks/session-start.js', 'hooks/prompt-guard.js'];
const MARK = '/ccwarden/';

function parseArgs(argv) {
  const a = { uninstall: false, dryRun: false, forceStatusline: false, compactWindow: null, coldGuard: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--uninstall') a.uninstall = true;
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--force-statusline') a.forceStatusline = true;
    else if (arg === '--compact-window') a.compactWindow = parseInt(argv[++i], 10);
    else if (arg === '--cold-guard') a.coldGuard = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (a.compactWindow != null && !(a.compactWindow >= 100000 && a.compactWindow <= 1000000)) {
    throw new Error('--compact-window must be a plain integer from 100000 to 1000000');
  }
  if (a.coldGuard != null && !['warn', 'block', 'off'].includes(a.coldGuard)) {
    throw new Error('--cold-guard must be warn, block or off');
  }
  return a;
}

// Forward slashes on every OS: node and every Windows shell take them, and quoting a
// backslash path with JSON.stringify would double each backslash.
const cmd = (file) => `node "${path.join(TARGET, file).split(path.sep).join('/')}"`;
// Matches our commands whatever their separators, including older Windows installs
// whose paths were written with doubled backslashes.
const isOurs = (command) => typeof command === 'string' && command.replace(/\\+/g, '/').includes(MARK);

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    throw new Error(`${SETTINGS} is not valid JSON (${e.message}); fix it first, nothing was changed`);
  }
}

// Drop ccwarden's handlers from every event, and any matcher group left empty.
function removeOurHooks(settings) {
  if (!settings.hooks) return;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

function merge(settings, args, notes) {
  const next = JSON.parse(JSON.stringify(settings));
  removeOurHooks(next);
  next.hooks = next.hooks || {};
  (next.hooks.SessionStart = next.hooks.SessionStart || []).push({
    matcher: 'compact|resume',
    hooks: [{ type: 'command', command: cmd('hooks/session-start.js'), timeout: 10 }],
  });
  (next.hooks.UserPromptSubmit = next.hooks.UserPromptSubmit || []).push({
    hooks: [{ type: 'command', command: cmd('hooks/prompt-guard.js'), timeout: 5 }],
  });

  const current = next.statusLine && next.statusLine.command;
  if (!current || isOurs(current) || args.forceStatusline) {
    next.statusLine = { type: 'command', command: cmd('statusline.js'), refreshInterval: 30 };
  } else {
    notes.push(`kept your existing statusLine (${current}); pass --force-statusline to replace it`);
    notes.push('without the ccwarden statusline, prompt-guard has no cache expiry to check');
  }

  if (args.compactWindow) {
    next.env = { ...(next.env || {}), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(args.compactWindow) };
  }
  for (const stale of ['ENABLE_PROMPT_CACHING_1H', 'ANTHROPIC_BETAS']) {
    if (next.env && stale in next.env) notes.push(`note: env.${stale} is set; see README "TTL" before keeping it`);
  }
  return next;
}

function unmerge(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  removeOurHooks(next);
  if (next.statusLine && isOurs(next.statusLine.command)) delete next.statusLine;
  return next;
}

function writeSettings(next, dryRun) {
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (dryRun) {
    console.log(`--- ${SETTINGS} (dry run) ---\n${text}`);
    return;
  }
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(SETTINGS, backup);
    console.log(`backup: ${backup}`);
  }
  fs.writeFileSync(SETTINGS, text);
  console.log(`updated: ${SETTINGS}`);
}

function copyFiles(args) {
  const src = __dirname;
  if (path.resolve(src) !== path.resolve(TARGET)) {
    for (const f of [...FILES, 'install.js']) {
      fs.mkdirSync(path.dirname(path.join(TARGET, f)), { recursive: true });
      fs.copyFileSync(path.join(src, f), path.join(TARGET, f));
    }
  }
  const cfgPath = path.join(TARGET, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(src, 'config.json'), 'utf8'));
    } catch {
      // defaults live in lib.js
    }
  }
  if (args.coldGuard) cfg.coldGuard = args.coldGuard;
  if (args.compactWindow) cfg.compactWindow = args.compactWindow;
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`installed: ${TARGET}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = readSettings();
  if (args.uninstall) {
    writeSettings(unmerge(settings), args.dryRun);
    if (!args.dryRun) fs.rmSync(TARGET, { recursive: true, force: true });
    console.log('ccwarden removed. Restart Claude Code.');
    return;
  }
  const notes = [];
  const next = merge(settings, args, notes);
  if (!args.dryRun) copyFiles(args);
  writeSettings(next, args.dryRun);
  for (const n of notes) console.log(n);
  console.log('Done. Restart Claude Code (hooks and statusline load at startup).');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`ccwarden install: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { merge, unmerge };
