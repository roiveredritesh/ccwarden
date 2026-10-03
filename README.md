# ccwarden

**A cost and context guard for [Claude Code](https://code.claude.com).** It shows what the current conversation is costing you, warns before money is wasted, compacts without paying for a summary, and tells you when to compact, `/clear` or hand off to a fresh session.

> **Status: alpha.** It comes in two editions:
> - The **plugin** (`mod/`): the full feature set, for the Claude Code CLI and the Desktop app's Code tab.
> - The **hooks edition** (`hooks-edition/`): a smaller, stable set of plain Node hooks.
>
> The plugin is built on Claude Code's function-hook plugin API, which is *early access* and may change between releases.

Not affiliated with or endorsed by Anthropic.

## Why

Every Claude Code request re-sends the whole conversation. A few things drive cost and rate-limit burn, and you rarely see them:

- **Context size.** It's re-read on every request. That's cheap while the prompt cache is warm and expensive when it's cold.
- **Cache misses.** A break longer than the cache TTL (5 minutes on billed usage) means the next request re-processes everything.
- **Junk in context.** Huge file reads and command outputs are paid for again on every later turn.
- **Compaction itself.** The summary is written in output tokens, the most expensive kind.
- **Subagents.** Each one pays for its own context, and its report lands in yours.

ccwarden shows these as they happen. Where it can do so without breaking the prompt cache, it also steps in.

## Quick start

### Requirements

- **Claude Code 2.1.287 or later** (check with `claude --version`). The plugin is built and tested against the function-hook API as it ships in 2.1.287. That API is early access, so a later release can break it; if one does, please [open an issue](https://github.com/roiveredritesh/ccwarden/issues).
- **Function hooks switched on.** Claude Code loads function-hook plugins only when `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set. Add it to the `env` block of `~/.claude/settings.json` so it applies to the CLI and the Desktop app:

  ```json
  {
    "env": {
      "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
    }
  }
  ```

  For a one-off try, setting it in your shell is enough: `export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (PowerShell: `$env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1"`).
- **Node 18+**, for the setup script only.

The hooks edition (below) doesn't need the env var: it uses only documented hooks and the status line.

### Install

```bash
claude plugin marketplace add roiveredritesh/ccwarden
claude plugin install ccwarden@ccwarden
```

Update later with `claude plugin marketplace update ccwarden`. The install covers the CLI and the Desktop Code tab.

Optional: the setup script sets the engine's compaction window as a safety net, plus a few opt-ins (see [Setup](#setup-setupsetupjs)). It sees the marketplace install and doesn't load the plugin a second time.

```bash
git clone https://github.com/roiveredritesh/ccwarden && cd ccwarden
node setup/setup.js --dry-run     # shows each change and why
node setup/setup.js
```

To try it for one session from a clone instead, with nothing installed: `claude --plugin-dir ./mod`. If you ran the setup script before the marketplace existed, run `node setup/setup.js --uninstall` first, then install from the marketplace and run the setup script again, so the plugin isn't loaded twice.

To check that it loaded, run `claude plugin list`: `ccwarden` should show `Status: ✔ loaded`.

On the first start, the plugin asks once how this machine is billed: **metered** (API key or usage-billed, shown in $) or **window** (Pro/Max/Team, shown as a % of the 5-hour window).

## What it does

| Feature | What you get |
|---|---|
| **Status line** | Model, context against its limit, cache warm/cold (time left and rebuild cost), and this conversation's spend ($ or % of the 5h window). A cache miss names its likely cause. |
| **Spend alerts** | A toast every $5 (metered) or 20% of the window. Alerts never block. |
| **Snapshot compaction** | Per-model limits (Haiku 120K, others 300K). Past the limit, the plugin builds the compacted conversation itself, so no summary tokens are spent. |
| **Cold-cache guard** | Before a big prompt goes out over an expired cache, you choose: continue, hand off, or cancel. |
| **Junk guard** | Oversized `Read`s go to `Grep` or a ranged read. Long Bash output is trimmed, and the full output is saved to a file Claude can grep. Ships in `observe` mode. |
| **Subagent guard** | Subagents are pinned to a cheaper model, with a ~300-word report cap and a limit on parallel runs. |
| **Handoffs** | `/handoff` writes a note for a fresh session, and the next session offers to continue from it. |
| **Background watcher** | Names turns you didn't type (scheduled tasks, `/loop`, channels) with their cost and the setting that stops them. |
| **Model advice** | At a fresh start, when switching is still free, it suggests a cheaper model. It never switches for you. |
| **Month tracking** | Month-to-date estimate, budget toasts at 50/80/100%, and a stricter budget mode. |
| **`/cw` dashboard** | This session, guard savings, month to date, context hogs and a 7-day cache report. |
| **Efficiency dashboard** | `/cw open`: what ccwarden saved (est.), a measured before/after per project, and spend over time, in your browser. Nothing leaves the machine. |
| **Keep-warm** *(experimental, off)* | Before the active session's cache expires, one tiny fork keeps it warm, within a $ cap. |

On the efficiency dashboard, every number marked *est.* is an estimate, with its formula and a confidence label shown on the page. The reality check is different: it is measured from your transcripts (those under 4 MiB), at list price, and is a trend rather than a saving, because how you work changed too.

Every guard action is also written, raw, to `~/.claude/ccwarden/metrics/<session id>.jsonl`, and the page shows them as an event log you can filter, copy or download. To prove the savings rather than estimate them, turn on **Proof mode** (`measureHoldout` in `/config`): about 1 in 10 new sessions then run with the guards off (the status line says `holdout`), and once there are 10 such sessions and 30 protected ones the page shows how much less a protected session costs per prompt, with a 90% range. Holdout sessions get no protection, so it is off by default.

## Commands

### In Claude Code

| Command | What it does |
|---|---|
| `/cw` | Opens the dashboard and logs this month's spend, your pace and the budget mode |
| `/cw open` | Writes the efficiency dashboard to `~/.claude/ccwarden/dashboard.html` and opens it; it refreshes itself while you work |
| `/cw spent <amount>` | Calibrates the month estimate with the real figure from your billing page, e.g. `/cw spent 42.50` |
| `/cw budget on\|off\|auto` | Turns budget mode on or off by hand, or lets the budget decide (`auto`) |
| `/handoff` | Writes a full handoff note (one fork of the conversation, best while the cache is warm) |
| `/handoff quick` | Writes a zero-token handoff from the transcript |
| `/ccwarden-junk` | Shows what the junk guard did, or would have done in `observe` mode |

### Setup (`setup/setup.js`)

| Flag | What it does |
|---|---|
| *(none)* | Sets the engine's compaction window to 300000 as a safety net, and loads the plugin in the CLI and the Desktop app unless it's installed from the marketplace |
| `--dry-run` | Shows what it would change, and why, without writing anything |
| `--project <dir>` | Also adds `# Compact instructions` to that repo's `CLAUDE.md` |
| `--compact-window <n>` | Engine compaction window (100000–1000000) |
| `--subagent-model <alias>` | Opt-in: the default model for subagents, e.g. `haiku` |
| `--cache-ttl 5m\|1h` | Opt-in: the prompt-cache TTL (use `1h` only if your breaks often run past 5 minutes) |
| `--no-prompt-suggestions` | Opt-in: turns off prompt suggestions |
| `--uninstall` | Restores your old values from the backup |

Every setting is explained as it's written, and a backup is kept.

## Settings

Change them in `/config` under the ccwarden plugin. These are the ones you're most likely to touch:

| Setting | Default | |
|---|---|---|
| `billing` | `ask` | `metered`, `window`, or ask on the next start |
| `sessionAlertUsd` / `sessionAlertPct` | `5` / `20` | Spend alert step |
| `limitHaiku` / `limitOther` | `120000` / `300000` | Per-model context limits |
| `compactMode` | `snapshot` | `summary` switches back to the engine's summary |
| `junkGuard` | `observe` | `enforce` once `/ccwarden-junk` shows no false positives |
| `subagentModel` | `haiku` | `subagentAllowlist` lists agent types that keep their own model |
| `monthlyBudgetUsd` | `0` (off) | Turns on month tracking and budget toasts |
| `handoffDir` | `.claude/handoffs` | Point it at a synced folder to continue on another machine |
| `keepWarm` | `false` | Experimental, metered only |
| `topicShiftHint` | `false` | Experimental: before a prompt that looks like new work in a long session, offer to `/clear` first |
| `measureHoldout` | `false` | Proof mode: about 1 in 10 new sessions run unprotected so `/cw open` can measure the savings |

The full list, with descriptions, is in [`mod/.claude-plugin/plugin.json`](mod/.claude-plugin/plugin.json).

## Hooks edition (v0.1)

Plain Node scripts on Claude Code's documented hooks and status line, with no dependencies. Use it if you'd rather not run an early-access plugin.

| Piece | What it does |
|---|---|
| `statusline.js` | Context against the auto-compact window, cache warm/cold, TTL left, hit %, and the cause of the last miss |
| `hooks/prompt-guard.js` | On the first prompt after the cache expires, it shows a warning (or blocks once): "this turn re-processes ~N tokens" |
| `hooks/session-start.js` | After compaction, restores your first request, recent requests (verbatim), open todos and edited files |
| `report.js` | Per-session cache report: hit %, every rebuild and its cause, and whether a 1h TTL would pay off |

```bash
cd hooks-edition
node install.js --dry-run                    # preview
node install.js --compact-window 120000      # merges into ~/.claude/settings.json (backup first)
node install.js --cold-guard warn|block|off  # prompt-guard mode
node install.js --force-statusline           # replace an existing status line
node install.js --uninstall

node ~/.claude/ccwarden/report.js --days 7 [--project <dir>]
```

## How it compares

| | [ccstatusline](https://github.com/sirmalloc/ccstatusline) | ccwarden |
|---|---|---|
| Rich, configurable status line | ✅ many widgets | Minimal: this conversation's cost, context and cache |
| Shows cache and context figures | ✅ | ✅ |
| **Acts**: spend alerts, cold-cache guard, junk guard, subagent guard | — | ✅ |
| **Cheaper compaction** (snapshot, no summary tokens) | — | ✅ (plugin) |
| Handoffs, month tracking, `/cw` dashboard | — | ✅ (plugin) |
| History report: cache rebuilds and their causes, TTL verdict | — | ✅ |

The two work together: ccstatusline for the status line, ccwarden for the guarding.

## Privacy

Everything runs locally. ccwarden reads your local transcripts and Claude Code's own usage figures. It sends nothing anywhere, and it makes no model calls unless a feature says it does and you turn it on (full handoff, keep-warm), each within a $ cap.

## Contributing

Bug reports and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules and the test commands.

## License

[MIT](LICENSE)
