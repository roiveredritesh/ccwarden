#!/usr/bin/env node
'use strict';
// ccwarden setup profile (SPEC F12): loads the mod in the CLI and the Desktop
// app's Code tab, and writes the settings it relies on into
// ~/.claude/settings.json, saying why for each. A timestamped backup is
// written first, and every value it replaces is recorded in
// ~/.claude/ccwarden/setup.json so --uninstall puts the old ones back.
//
//   node setup/setup.js [--compact-window 300000] [--project <dir>]
//                       [--subagent-model haiku] [--cache-ttl 5m|1h]
//                       [--no-prompt-suggestions] [--dry-run]
//   node setup/setup.js --uninstall [--dry-run]
//
// Defaults touch only documented settings. The opt-in flags name settings
// present in Claude Code 2.1.287 but not yet confirmed in its docs (SPEC §9).

const fs = require('fs');
const path = require('path');
const os = require('os');

const MOD_DIR = path.resolve(__dirname, '..', 'mod');

const COMPACT_TEMPLATE = [
  '# Compact instructions',
  '',
  'When summarizing this conversation, keep verbatim: the user\'s requests, decisions and why, files changed,',
  'the current task and its next step, and any error still open. Drop file contents and command output that',
  'can be read again.',
  '',
].join('\n');

function parseArgs(argv) {
  const a = { uninstall: false, dryRun: false, compactWindow: 300000, project: null, subagentModel: null, cacheTtl: null, noPromptSuggestions: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--uninstall') a.uninstall = true;
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--compact-window') a.compactWindow = Number(argv[++i]);
    else if (arg === '--project') a.project = argv[++i];
    else if (arg === '--subagent-model') a.subagentModel = argv[++i];
    else if (arg === '--cache-ttl') a.cacheTtl = argv[++i];
    else if (arg === '--no-prompt-suggestions') a.noPromptSuggestions = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(a.compactWindow) || a.compactWindow < 100000 || a.compactWindow > 1000000) {
    throw new Error('--compact-window must be a whole number from 100000 to 1000000');
  }
  if (a.cacheTtl != null && !['5m', '1h'].includes(a.cacheTtl)) throw new Error('--cache-ttl must be 5m or 1h');
  if (a.subagentModel != null && !/^[a-z0-9.-]+$/i.test(a.subagentModel)) throw new Error('--subagent-model takes a model alias or id');
  if (a.project != null && !fs.existsSync(a.project)) throw new Error(`--project ${a.project} does not exist`);
  return a;
}

/** The plugin-dirs list with the mod in it once (path-list separated, as the env var takes it). */
function withModDir(current, modDir, delimiter) {
  const dirs = (current || '').split(delimiter).filter((d) => d !== '');
  return dirs.some((d) => path.resolve(d) === path.resolve(modDir)) ? current : [...dirs, modDir].join(delimiter);
}

/**
 * The settings after setup, and each change with why. `changes[].from` is the
 * value replaced (undefined: there was none), which --uninstall restores.
 */
function plan(settings, args, ctx) {
  const next = JSON.parse(JSON.stringify(settings));
  const changes = [];
  const set = (where, key, value, why) => {
    const obj = where === 'env' ? (next.env = next.env || {}) : next;
    const from = obj[key];
    if (from === value) return;
    obj[key] = value;
    changes.push({ where, key, from, to: value, why });
  };

  set('env', 'CLAUDE_CODE_PLUGIN_DIRS', withModDir(next.env && next.env.CLAUDE_CODE_PLUGIN_DIRS, ctx.modDir, ctx.delimiter),
    'loads the ccwarden mod in every CLI session and in the Desktop app\'s Code tab (which reads this env block)');
  set('env', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', String(args.compactWindow),
    'the engine\'s own compaction window, as a safety net: the mod compacts at turn end against per-model limits, but can\'t mid-turn');
  if (args.subagentModel) {
    set('env', 'CLAUDE_CODE_SUBAGENT_MODEL', args.subagentModel,
      'subagents run on this model even with the mod off (the mod\'s subagent guard pins them too) [unverified in docs: SPEC §9]');
  }
  if (args.cacheTtl) {
    set('settings', 'promptCacheTtl', args.cacheTtl,
      args.cacheTtl === '1h'
        ? 'a 1h prompt-cache TTL: every cache write costs 2x instead of 1.25x, so only worth it when your breaks often pass 5 minutes'
        : 'the 5m prompt-cache TTL (billed usage\'s default)');
  }
  if (args.noPromptSuggestions) {
    set('settings', 'promptSuggestionEnabled', false,
      'no prompt suggestions: each one is a small extra model request [unverified in docs: SPEC §9]');
  }
  return { next, changes };
}

/** The settings with every recorded change undone (a value later edited by hand is left alone). */
function unplan(settings, record) {
  const next = JSON.parse(JSON.stringify(settings));
  for (const c of [...record.changes].reverse()) {
    const obj = c.where === 'env' ? next.env : next;
    if (!obj || JSON.stringify(obj[c.key]) !== JSON.stringify(c.to)) continue;
    if (c.from === undefined) delete obj[c.key];
    else obj[c.key] = c.from;
  }
  if (next.env && Object.keys(next.env).length === 0) delete next.env;
  return next;
}

/** The project CLAUDE.md with the compact-instructions template appended, or null if it has one. */
function withCompactInstructions(text) {
  if (/^#\s*Compact instructions\b/im.test(text)) return null;
  return `${text}${text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'}${COMPACT_TEMPLATE}`;
}

/** MCP servers the user has configured: each one's tools ride along in every request. */
function mcpServers(home, project) {
  const names = new Set();
  const add = (file) => {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const name of Object.keys(json.mcpServers || {})) names.add(name);
    } catch {
      // absent or not JSON: nothing to report
    }
  };
  add(path.join(home, '.claude.json'));
  if (project) add(path.join(project, '.mcp.json'));
  return [...names].sort();
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix it first, nothing was changed`);
  }
}

function writeSettings(file, next, dryRun, log) {
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    log(`backup: ${backup}`);
  }
  fs.writeFileSync(file, text);
  log(`updated: ${file}`);
}

function run(argv, { home = os.homedir(), log = console.log } = {}) {
  const args = parseArgs(argv);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const recordFile = path.join(home, '.claude', 'ccwarden', 'setup.json');
  const settings = readJson(settingsFile);
  const prefix = args.dryRun ? '(dry run) ' : '';

  if (args.uninstall) {
    if (!fs.existsSync(recordFile)) {
      log('nothing to undo: no ccwarden setup record');
      return;
    }
    const record = readJson(recordFile);
    writeSettings(settingsFile, unplan(settings, record), args.dryRun, log);
    for (const c of record.changes) log(`${prefix}restored ${c.where === 'env' ? 'env.' : ''}${c.key}`);
    if (!args.dryRun) fs.rmSync(recordFile);
    log('Done. Restart Claude Code.');
    return;
  }

  const { next, changes } = plan(settings, args, { modDir: MOD_DIR, delimiter: path.delimiter });
  for (const c of changes) log(`${prefix}set ${c.where === 'env' ? 'env.' : ''}${c.key} = ${JSON.stringify(c.to)}: ${c.why}`);
  if (changes.length === 0) log('settings already in place');
  else {
    writeSettings(settingsFile, next, args.dryRun, log);
    if (!args.dryRun) {
      // Merge with an earlier record, so --uninstall goes back to before the first setup.
      const earlier = fs.existsSync(recordFile) ? readJson(recordFile).changes || [] : [];
      const firstFrom = new Map(earlier.map((c) => [`${c.where}:${c.key}`, c.from]));
      const merged = changes.map((c) => ({ ...c, from: firstFrom.has(`${c.where}:${c.key}`) ? firstFrom.get(`${c.where}:${c.key}`) : c.from }));
      const kept = earlier.filter((c) => !changes.some((n) => n.where === c.where && n.key === c.key));
      fs.mkdirSync(path.dirname(recordFile), { recursive: true });
      fs.writeFileSync(recordFile, `${JSON.stringify({ changes: [...kept, ...merged] }, null, 2)}\n`);
    }
  }

  if (args.project) {
    const file = path.join(args.project, 'CLAUDE.md');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const updated = withCompactInstructions(text);
    if (updated === null) log(`${file} already has # Compact instructions`);
    else {
      if (!args.dryRun) fs.writeFileSync(file, updated);
      log(`${prefix}added # Compact instructions to ${file}: steers the engine's summary when you run /compact <focus>`);
    }
  }

  const servers = mcpServers(home, args.project);
  if (servers.length > 0) {
    log(`MCP servers configured: ${servers.join(', ')}. Each one's tools are sent with every request; disable the ones you don't use (/mcp).`);
  }
  log(`Done. Restart Claude Code (CLI and Desktop) to load the mod from ${MOD_DIR}; it asks for your billing on the first session.`);
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (e) {
    console.error(`ccwarden setup: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, plan, unplan, withModDir, withCompactInstructions, mcpServers, run, COMPACT_TEMPLATE };
