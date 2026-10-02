'use strict';
// Run: node --test test/
// Every script runs as a real child process with HOME pointed at a temp dir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NOW = Math.floor(Date.now() / 1000);

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccwarden-test-'));
}

function run(script, { home, input = '', args = [], env = {} }) {
  const res = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '', ...env },
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const stateFile = (home, id) => path.join(home, '.claude', 'ccwarden', 'state', `${id}.json`);

function statusInput(overrides = {}) {
  return {
    session_id: 'sess1',
    model: { display_name: 'Haiku 4.5' },
    context_window: { total_input_tokens: 68000, context_window_size: 200000 },
    prompt_cache: {
      warm: true,
      caching_observed: true,
      ttl: '1h',
      expires_at: NOW + 47 * 60 + 10,
      requests: 14,
      misses: 2,
      hit_ratio: 0.91,
      last_miss_cause: { causes: ['tools_changed'] },
      recache_tokens_if_cold: 68000,
    },
    ...overrides,
  };
}

// ---- statusline ------------------------------------------------------------

test('statusline: warm cache shows TTL left, hit ratio and last miss cause', () => {
  const home = tmpHome();
  const r = run('statusline.js', { home, input: statusInput() });
  const line = stripAnsi(r.out);
  assert.match(line, /Haiku 4\.5/);
  assert.match(line, /ctx ▓{3}░{7} 34% 68k\/200k/);
  assert.match(line, /● warm 1h · 47m left/);
  assert.match(line, /hit 91%/);
  assert.match(line, /miss 2: tools changed/);
  assert.doesNotMatch(line, /compact at next break/);
  const state = JSON.parse(fs.readFileSync(stateFile(home, 'sess1'), 'utf8'));
  assert.equal(state.expires_at, NOW + 47 * 60 + 10);
  assert.equal(state.recache_tokens_if_cold, 68000);
});

test('statusline: cold cache, compact hint measured against CLAUDE_CODE_AUTO_COMPACT_WINDOW', () => {
  const home = tmpHome();
  const input = statusInput({
    prompt_cache: { warm: false, caching_observed: true, ttl: '1h', expires_at: NOW - 60, recache_tokens_if_cold: 68000 },
  });
  const line = stripAnsi(run('statusline.js', { home, input, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000' } }).out);
  assert.match(line, /57% 68k\/120k/);
  assert.match(line, /○ cold · next turn re-caches 68k/);
  assert.match(line, /⚑ \/compact at next break/);
});

test('statusline: before the first response and with caching off', () => {
  const home = tmpHome();
  const before = stripAnsi(run('statusline.js', { home, input: { session_id: 's', model: { display_name: 'X' } } }).out);
  assert.match(before, /cache –/);
  assert.equal(fs.existsSync(stateFile(home, 's')), false);
  const off = stripAnsi(run('statusline.js', { home, input: statusInput({ prompt_cache: { caching_observed: false } }) }).out);
  assert.match(off, /cache off/);
});

test('statusline: survives empty or broken stdin', () => {
  const home = tmpHome();
  assert.equal(run('statusline.js', { home, input: '' }).code, 0);
  assert.equal(run('statusline.js', { home, input: '{not json' }).code, 0);
});

// ---- prompt-guard ----------------------------------------------------------

function seedState(home, id, state) {
  fs.mkdirSync(path.dirname(stateFile(home, id)), { recursive: true });
  fs.writeFileSync(stateFile(home, id), JSON.stringify(state));
}

function writeConfig(home, cfg) {
  // prompt-guard reads config.json next to the scripts; run a copy under HOME.
  const dir = path.join(home, 'tool');
  fs.cpSync(ROOT, dir, { recursive: true, filter: (p) => !p.includes(`${path.sep}test`) });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  return dir;
}

test('prompt-guard: silent while the cache is warm', () => {
  const home = tmpHome();
  seedState(home, 's', { ttl: '1h', expires_at: NOW + 600, recache_tokens_if_cold: 90000 });
  const r = run('hooks/prompt-guard.js', { home, input: { session_id: 's', user_input: 'hi' } });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('prompt-guard: warns once per cold period, never adds context', () => {
  const home = tmpHome();
  seedState(home, 's', { ttl: '1h', expires_at: NOW - 1200, recache_tokens_if_cold: 90000 });
  const first = run('hooks/prompt-guard.js', { home, input: { session_id: 's', user_input: 'hi' } });
  const out = JSON.parse(first.out);
  assert.match(out.systemMessage, /expired 20m ago .*~90k tokens/);
  assert.equal(out.additionalContext, undefined);
  assert.equal(out.decision, undefined);
  const second = run('hooks/prompt-guard.js', { home, input: { session_id: 's', user_input: 'again' } });
  assert.equal(second.out, '');
});

test('prompt-guard: block mode blocks once, then lets the resent prompt through', () => {
  const home = tmpHome();
  const dir = writeConfig(home, { coldGuard: 'block' });
  seedState(home, 's', { ttl: '5m', expires_at: NOW - 400, recache_tokens_if_cold: 120000 });
  const script = path.relative(ROOT, path.join(dir, 'hooks', 'prompt-guard.js'));
  const first = JSON.parse(run(script, { home, input: { session_id: 's', user_input: 'x' } }).out);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /Send the prompt again/);
  assert.equal(run(script, { home, input: { session_id: 's', user_input: 'x' } }).out, '');
});

test('prompt-guard: ignores small contexts, continuations and unknown sessions', () => {
  const home = tmpHome();
  seedState(home, 'small', { expires_at: NOW - 999, recache_tokens_if_cold: 4000 });
  seedState(home, 'big', { expires_at: NOW - 999, recache_tokens_if_cold: 90000 });
  assert.equal(run('hooks/prompt-guard.js', { home, input: { session_id: 'small' } }).out, '');
  assert.equal(run('hooks/prompt-guard.js', { home, input: { session_id: 'big', is_continuation: true } }).out, '');
  assert.equal(run('hooks/prompt-guard.js', { home, input: { session_id: 'nope' } }).out, '');
  assert.equal(run('hooks/prompt-guard.js', { home, input: '' }).code, 0);
});

// ---- session-start ---------------------------------------------------------

function line(obj) {
  return JSON.stringify(obj);
}

function writeTranscript(dir) {
  const user = (content, extra = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra });
  const tool = (id, name, input) =>
    line({ type: 'assistant', message: { id, model: 'm', content: [{ type: 'tool_use', name, input }], usage: {} } });
  const lines = [
    user('Fix the login timeout bug in the auth service'),
    user('<command-name>/model</command-name>'),
    user('Caveat: local command output', { isMeta: true }),
    tool('a1', 'Edit', { file_path: path.join(dir, 'src/auth.ts') }),
    user([{ type: 'tool_result', content: 'ok' }]),
    tool('a2', 'TodoWrite', {
      todos: [
        { content: 'Reproduce timeout', status: 'completed' },
        { content: 'Add retry to refresh call', status: 'in_progress' },
        { content: 'Write regression test', status: 'pending' },
      ],
    }),
    user('This session is being continued... summary', { isCompactSummary: true }),
    user('also keep the old cookie name for backwards compat'),
    tool('a3', 'Write', { file_path: path.join(dir, 'test/auth.test.ts') }),
    tool('a4', 'Edit', { file_path: path.join(dir, 'src/auth.ts') }),
    user([{ type: 'text', text: 'see screenshot, the spinner never stops' }, { type: 'image', source: {} }]),
    line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'skip the docs change', humanTurn: true } }),
    line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'from a hook', origin: { kind: 'hook' } } }),
    line({ type: 'attachment', attachment: { type: 'total_tokens_reminder' } }),
    user('subagent chatter', { isSidechain: true }),
    '{"truncated',
  ];
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

test('session-start compact: restores goal, recent requests, todos and edited files verbatim', () => {
  const home = tmpHome();
  const transcript = writeTranscript(home);
  const r = run('hooks/session-start.js', {
    home,
    input: { session_id: 's', source: 'compact', transcript_path: transcript, cwd: home },
  });
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /## Session goal \(first request\)\nFix the login timeout bug/);
  assert.match(ctx, /1\. also keep the old cookie name/);
  assert.match(ctx, /2\. see screenshot, the spinner never stops/);
  assert.match(ctx, /3\. skip the docs change/);
  assert.doesNotMatch(ctx, /from a hook/);
  assert.match(ctx, /\[in_progress\] Add retry to refresh call/);
  assert.match(ctx, /\[pending\] Write regression test/);
  assert.doesNotMatch(ctx, /Reproduce timeout/);
  assert.match(ctx, /- src\/auth\.ts\n- test\/auth\.test\.ts/); // most recent first, relative to cwd
  for (const leaked of ['command-name', 'Caveat', 'being continued', 'subagent chatter', 'tool_result']) {
    assert.ok(!ctx.includes(leaked), `leaked: ${leaked}`);
  }
});

test('session-start compact: respects maxRestoreChars', () => {
  const home = tmpHome();
  const dir = writeConfig(home, { maxRestoreChars: 500 });
  const p = path.join(home, 't.jsonl');
  const long = 'x'.repeat(5000);
  fs.writeFileSync(p, [1, 2, 3, 4].map((i) => line({ type: 'user', message: { content: `${i} ${long}` } })).join('\n'));
  const script = path.relative(ROOT, path.join(dir, 'hooks', 'session-start.js'));
  const ctx = JSON.parse(run(script, { home, input: { source: 'compact', transcript_path: p } }).out).hookSpecificOutput
    .additionalContext;
  assert.ok(ctx.length <= 500, `length ${ctx.length}`);
});

test('session-start: nothing on startup or a missing transcript', () => {
  const home = tmpHome();
  assert.equal(run('hooks/session-start.js', { home, input: { source: 'startup' } }).out, '');
  assert.equal(run('hooks/session-start.js', { home, input: { source: 'compact', transcript_path: '/nope' } }).out, '');
});

test('session-start resume: warns on an expired cache and suppresses the prompt-guard repeat', () => {
  const home = tmpHome();
  seedState(home, 's', { ttl: '1h', expires_at: NOW - 7200, recache_tokens_if_cold: 150000 });
  const r = run('hooks/session-start.js', {
    home,
    input: { session_id: 's', source: 'resume', prompt_cache_likely_expired: true, context_tokens: 150000, estimated_cache_write_usd: 0.19 },
  });
  assert.match(JSON.parse(r.out).systemMessage, /re-caches ~150k tokens \(~\$0\.19\)/);
  assert.equal(run('hooks/prompt-guard.js', { home, input: { session_id: 's' } }).out, '');
  const warm = run('hooks/session-start.js', {
    home,
    input: { session_id: 's', source: 'resume', prompt_cache_likely_expired: false, context_tokens: 150000 },
  });
  assert.equal(warm.out, '');
});

// ---- report ----------------------------------------------------------------

test('report: dedupes content-block lines and classifies rebuilds', () => {
  const { analyze, requestsOf } = require('../report');
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  const at = (min) => new Date(t0 + min * 60000).toISOString();
  const asst = (id, min, model, u) => ({
    type: 'assistant',
    timestamp: at(min),
    message: {
      id,
      model,
      usage: {
        input_tokens: u.input || 0,
        cache_read_input_tokens: u.read || 0,
        cache_creation_input_tokens: u.write || 0,
        cache_creation: { ephemeral_1h_input_tokens: u.write || 0, ephemeral_5m_input_tokens: 0 },
      },
    },
  });
  const entries = [
    asst('m1', 0, 'haiku', { write: 50000 }),
    asst('m1', 0, 'haiku', { write: 50000 }), // same response, second content block
    asst('m2', 1, 'haiku', { read: 50000, write: 2000 }),
    asst('m3', 30, 'haiku', { read: 52000, write: 1000 }), // 29 min idle, 1h cache held
    asst('m4', 31, 'sonnet', { write: 53000 }), // model switch
    asst('m5', 120, 'sonnet', { write: 53500 }), // 89 min idle: expired
    { type: 'system', subtype: 'compact_boundary' },
    asst('m6', 121, 'sonnet', { write: 9000 }), // after compaction
    asst('m7', 122, 'sonnet', { read: 9000, write: 500, input: 3 }),
  ];
  const reqs = requestsOf(entries);
  assert.equal(reqs.length, 7);
  const s = analyze(reqs);
  assert.deepEqual(
    s.rebuilds.map((r) => r.cause),
    ['model switch', 'expired (idle 1h29m)', 'compaction'],
  );
  assert.ok(s.gapSavings > 0);
  assert.ok(s.hitRatio > 0 && s.hitRatio < 1);
});

test('report: CLI prints a table for a transcript path', () => {
  const home = tmpHome();
  const p = path.join(home, 'abcdef123.jsonl');
  const asst = (id, ts, read, write) =>
    line({
      type: 'assistant',
      timestamp: ts,
      message: { id, model: 'm', usage: { input_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
    });
  fs.writeFileSync(p, [asst('a', '2026-10-01T10:00:00Z', 0, 20000), asst('b', '2026-10-01T10:01:00Z', 20000, 100)].join('\n'));
  const r = run('report.js', { home, args: [p] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /abcdef12 .* 2 +50%/);
  assert.match(r.out, /none — the cache never broke/);
  assert.equal(run('report.js', { home }).out.trim(), 'No transcripts with API usage found.');
});

// ---- install ---------------------------------------------------------------

test('install: merges into existing settings, is idempotent, and uninstalls cleanly', () => {
  const home = tmpHome();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const original = {
    model: 'haiku',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(original));

  for (let i = 0; i < 2; i++) {
    const r = run('install.js', { home, args: ['--compact-window', '120000', '--cold-guard', 'block'] });
    assert.equal(r.code, 0, r.err);
  }
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(s.model, 'haiku');
  assert.deepEqual(s.permissions, original.permissions);
  assert.equal(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '120000');
  assert.equal(s.hooks.SessionStart.length, 2, 'no duplicates after re-install');
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, 'echo mine');
  assert.equal(s.hooks.SessionStart[1].matcher, 'compact|resume');
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.match(s.statusLine.command, /ccwarden[\\/]+statusline\.js/);
  const installed = path.join(home, '.claude', 'ccwarden');
  for (const f of ['lib.js', 'statusline.js', 'report.js', 'hooks/session-start.js', 'hooks/prompt-guard.js']) {
    assert.ok(fs.existsSync(path.join(installed, f)), f);
  }
  const installedCfg = JSON.parse(fs.readFileSync(path.join(installed, 'config.json'), 'utf8'));
  assert.equal(installedCfg.coldGuard, 'block');
  assert.equal(installedCfg.compactWindow, 120000);
  const shown = spawnSync(s.statusLine.command, {
    shell: true,
    input: JSON.stringify(statusInput()),
    env: { ...process.env, HOME: home, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '' },
    encoding: 'utf8',
  });
  assert.match(stripAnsi(shown.stdout), /57% 68k\/120k/, 'window falls back to config.json');
  assert.ok(fs.readdirSync(path.dirname(settingsPath)).some((f) => f.startsWith('settings.json.bak-')));

  // the installed hook commands actually run
  const hookCmd = s.hooks.UserPromptSubmit[0].hooks[0].command;
  const res = spawnSync(hookCmd, { shell: true, input: '{}', env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  assert.equal(run('install.js', { home, args: ['--uninstall'] }).code, 0);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(after.hooks, original.hooks);
  assert.equal(after.statusLine, undefined);
  assert.equal(fs.existsSync(installed), false);
});

test('install: keeps a foreign statusline unless forced, refuses broken settings', () => {
  const home = tmpHome();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: '~/my-line.sh' } }));
  const r = run('install.js', { home });
  assert.match(r.out, /kept your existing statusLine/);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command, '~/my-line.sh');
  run('install.js', { home, args: ['--force-statusline'] });
  assert.match(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command, /ccwarden/);

  fs.writeFileSync(settingsPath, '{ broken');
  const bad = run('install.js', { home });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ broken');
  assert.equal(run('install.js', { home, args: ['--compact-window', '500k'] }).code, 1);
});
