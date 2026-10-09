#!/usr/bin/env node
'use strict';
// SessionStart hook (matcher "compact|resume").
//
// compact: Claude Code already re-injects CLAUDE.md, the plan, invoked skills and up
//   to five recently touched files. What the summary can blur is what you asked for.
//   This restores, verbatim from the transcript, your first request, your last few
//   requests, every file edited this session, and any unfinished todos.
// resume:  warns when the resumed session's cache has expired, so the first turn
//   re-caches the whole history.

const {
  EDIT_TOOLS,
  cleanupOldState,
  fmtTokens,
  loadConfig,
  readState,
  readStdinJson,
  readTranscript,
  toolUses,
  truncate,
  userPromptText,
  writeState,
} = require('../lib');

function collect(entries) {
  const prompts = [];
  const edited = new Map(); // path -> order of last edit
  let todos = null;
  let order = 0;
  for (const entry of entries) {
    const text = userPromptText(entry);
    if (text && text !== prompts[prompts.length - 1]) prompts.push(text);
    for (const use of toolUses(entry)) {
      const input = use.input || {};
      if (EDIT_TOOLS.has(use.name)) {
        const file = input.file_path || input.notebook_path;
        if (file) edited.set(file, order++);
      } else if (use.name === 'TodoWrite' && Array.isArray(input.todos)) {
        todos = input.todos;
      }
    }
  }
  const files = [...edited.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  return { prompts, files, todos };
}

function buildRestoreContext(entries, cwd, cfg) {
  const { prompts, files, todos } = collect(entries);
  const open = (todos || []).filter((t) => t && t.status !== 'completed');
  if (!prompts.length && !files.length && !open.length) return null;

  const budget = cfg.maxRestoreChars;
  const sections = [];
  if (prompts.length) {
    sections.push(`## Session goal (first request)\n${truncate(prompts[0], Math.floor(budget * 0.3))}`);
  }
  const recent = prompts.slice(1).slice(-cfg.recentPrompts);
  if (recent.length) {
    const each = Math.floor((budget * 0.4) / recent.length);
    sections.push(
      `## Most recent requests (oldest first)\n${recent.map((p, i) => `${i + 1}. ${truncate(p, each)}`).join('\n')}`,
    );
  }
  if (open.length) {
    sections.push(`## Unfinished todos\n${open.map((t) => `- [${t.status}] ${t.content}`).join('\n')}`);
  }
  if (files.length) {
    // Shown with forward slashes, relative to cwd when under it. Windows paths may come
    // with either separator and any drive-letter case.
    const slash = (p) => p.replace(/\\/g, '/');
    const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const base = cwd ? `${slash(cwd).replace(/\/+$/, '')}/` : '';
    const rel = files.map((f) => (base && key(slash(f)).startsWith(key(base)) ? slash(f).slice(base.length) : f));
    const shown = rel.slice(0, 40);
    const more = rel.length > shown.length ? `\n- …and ${rel.length - shown.length} more` : '';
    sections.push(`## Files edited this session (most recent first)\n${shown.map((f) => `- ${f}`).join('\n')}${more}`);
  }

  const header =
    'Restored by ccwarden after compaction, quoted from the session transcript. ' +
    "The user's words below are verbatim; prefer them over the summary where they differ.";
  return truncate(`${header}\n\n${sections.join('\n\n')}`, budget);
}

function handle(input, cfg) {
  if (input.source === 'compact') {
    const context = buildRestoreContext(readTranscript(input.transcript_path), input.cwd, cfg);
    if (context) return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
    return null;
  }
  if (input.source === 'resume' && input.prompt_cache_likely_expired && input.context_tokens >= cfg.coldGuardMinTokens) {
    // prompt-guard would otherwise repeat this on the first prompt.
    const state = readState(input.session_id);
    if (state && state.expires_at) writeState(input.session_id, { ...state, warned_for: state.expires_at });
    const cost = input.estimated_cache_write_usd != null ? ` (~$${input.estimated_cache_write_usd.toFixed(2)})` : '';
    return {
      systemMessage:
        `ccwarden: this session's prompt cache has expired. The first turn re-caches ` +
        `~${fmtTokens(input.context_tokens)} tokens${cost}. For unrelated work, /clear is cheaper.`,
    };
  }
  return null;
}

if (require.main === module) {
  const cfg = loadConfig();
  const output = handle(readStdinJson(), cfg);
  if (output) process.stdout.write(JSON.stringify(output));
  cleanupOldState(cfg.stateMaxAgeDays);
}

module.exports = { buildRestoreContext, collect, handle };
