#!/usr/bin/env node
'use strict';
// UserPromptSubmit hook. When you come back to a session whose prompt cache has
// expired, the next turn re-processes the whole conversation at full price. This
// hook tells you before (block mode) or as (warn mode) that happens, once per cold
// period, so you can /clear instead if the new prompt is unrelated work.
// It never adds anything to Claude's context, so it can't change the cached prefix.

const { fmtDuration, fmtTokens, loadConfig, readState, readStdinJson, writeState } = require('../lib');

function decide(input, state, cfg, nowSec) {
  if (cfg.coldGuard === 'off' || input.is_continuation || !state || !state.expires_at) return null;
  if (nowSec <= state.expires_at) return null;
  const tokens = state.recache_tokens_if_cold ?? state.ctx_tokens ?? 0;
  if (tokens < cfg.coldGuardMinTokens) return null;
  // One notice per cold period: re-sending the prompt goes through.
  if (state.warned_for === state.expires_at) return null;

  const msg =
    `ccwarden: prompt cache expired ${fmtDuration(nowSec - state.expires_at)} ago ` +
    `(TTL ${state.ttl || '?'}). This turn re-processes ~${fmtTokens(tokens)} tokens. ` +
    'If this is unrelated work, /clear is cheaper.';
  if (cfg.coldGuard === 'block') {
    return { output: { decision: 'block', reason: `${msg} Send the prompt again to continue anyway.` } };
  }
  return { output: { systemMessage: msg } };
}

if (require.main === module) {
  const input = readStdinJson();
  const state = readState(input.session_id);
  const result = decide(input, state, loadConfig(), Math.floor(Date.now() / 1000));
  if (result) {
    writeState(input.session_id, { ...state, warned_for: state.expires_at });
    process.stdout.write(JSON.stringify(result.output));
  }
}

module.exports = { decide };
