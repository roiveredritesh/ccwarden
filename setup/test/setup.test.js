'use strict';
// Tests for the ccwarden setup profile. Run: node --test "setup/test/*.test.js"

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, plan, unplan, withModDir, withCompactInstructions, mcpServers, run } = require('../setup');

const ctx = { modDir: '/repo/mod', delimiter: ':' };
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccwarden-setup-'));
const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
};

test('args: defaults and checks', () => {
  assert.deepEqual(parseArgs([]), { uninstall: false, dryRun: false, compactWindow: 300000, project: null, subagentModel: null, cacheTtl: null, noPromptSuggestions: false });
  assert.equal(parseArgs(['--compact-window', '120000']).compactWindow, 120000);
  assert.throws(() => parseArgs(['--compact-window', '50000']), /100000 to 1000000/);
  assert.throws(() => parseArgs(['--cache-ttl', '30m']), /5m or 1h/);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('plugin dirs: the mod is added once, other dirs kept', () => {
  assert.equal(withModDir(undefined, '/repo/mod', ':'), '/repo/mod');
  assert.equal(withModDir('/other', '/repo/mod', ':'), '/other:/repo/mod');
  assert.equal(withModDir('/other:/repo/mod/', '/repo/mod', ':'), '/other:/repo/mod/');
});

test('plan: documented settings by default, each with why; opt-ins only when asked', () => {
  const { next, changes } = plan({ env: { KEEP: '1' }, model: 'opus' }, parseArgs([]), ctx);
  assert.deepEqual(next, { env: { KEEP: '1', CLAUDE_CODE_PLUGIN_DIRS: '/repo/mod', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }, model: 'opus' });
  assert.deepEqual(changes.map((c) => c.key), ['CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW']);
  assert.ok(changes.every((c) => c.why.length > 20));

  const all = plan({}, parseArgs(['--subagent-model', 'haiku', '--cache-ttl', '1h', '--no-prompt-suggestions']), ctx);
  assert.equal(all.next.env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
  assert.equal(all.next.promptCacheTtl, '1h');
  assert.equal(all.next.promptSuggestionEnabled, false);
  assert.match(all.changes.find((c) => c.key === 'promptCacheTtl').why, /2x instead of 1\.25x/);
});

test('plan is idempotent', () => {
  const once = plan({}, parseArgs([]), ctx).next;
  assert.deepEqual(plan(once, parseArgs([]), ctx).changes, []);
});

test('unplan restores what was there, and leaves hand edits alone', () => {
  const before = { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' } };
  const { next, changes } = plan(before, parseArgs([]), ctx);
  assert.deepEqual(unplan(next, { changes }), before);
  const edited = { ...next, env: { ...next.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } };
  assert.equal(unplan(edited, { changes }).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '500000');
});

test('compact instructions: appended once', () => {
  const added = withCompactInstructions('# Project\n');
  assert.match(added, /^# Project\n\n# Compact instructions\n/);
  assert.equal(withCompactInstructions(added), null);
  assert.match(withCompactInstructions(''), /^# Compact instructions/);
});

test('mcp servers from ~/.claude.json and the project .mcp.json', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: {}, slack: {} } }));
  const project = tmpHome();
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { db: {} } }));
  assert.deepEqual(mcpServers(home, project), ['db', 'github', 'slack']);
  assert.deepEqual(mcpServers(tmpHome(), null), []);
});

test('run: writes with a backup and a record; --uninstall puts everything back', () => {
  const home = tmpHome();
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const original = { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', OTHER: 'x' }, theme: 'dark' };
  fs.writeFileSync(settingsFile, JSON.stringify(original));
  const project = tmpHome();

  const out = quiet();
  run(['--project', project], { home, log: out.log });
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(after.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '300000');
  assert.match(after.env.CLAUDE_CODE_PLUGIN_DIRS, /mod$/);
  assert.equal(after.theme, 'dark');
  assert.ok(fs.readdirSync(path.dirname(settingsFile)).some((f) => f.startsWith('settings.json.bak-')));
  assert.match(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8'), /# Compact instructions/);
  assert.ok(out.lines.some((l) => l.startsWith('set env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "300000": ')));

  run(['--cache-ttl', '1h'], { home, log: () => {} }); // a second run adds to the record
  run(['--uninstall'], { home, log: () => {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), original);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'ccwarden', 'setup.json')), false);
});

test('run --dry-run changes nothing', () => {
  const home = tmpHome();
  const out = quiet();
  run(['--dry-run'], { home, log: out.log });
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false);
  assert.ok(out.lines.some((l) => l.startsWith('(dry run) set env.CLAUDE_CODE_PLUGIN_DIRS')));
});

test('run refuses settings that are not JSON, changing nothing', () => {
  const home = tmpHome();
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, '{ nope');
  assert.throws(() => run([], { home, log: () => {} }), /not valid JSON/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ nope');
});
