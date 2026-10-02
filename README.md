# ccwarden

**A cost and context guard for [Claude Code](https://code.claude.com).** It shows what the current conversation is costing you. It warns before money is wasted, keeps compaction cheap, and tells you when to compact, `/clear` or hand off to a fresh session.

> **Status: pre-alpha.** The [hooks edition](#hooks-edition-v01-works-today) works today. The **mod** (CLI + Desktop) is in development; see [`docs/SPEC.md`](docs/SPEC.md) and the [roadmap](#roadmap). The mod is built on Claude Code's function-hook plugin API, which is marked *early access* and may change between releases.

Not affiliated with or endorsed by Anthropic.

## Why

Every Claude Code request re-sends the whole conversation. Cost and rate-limit burn are driven by a few things you rarely see:

- **Context size.** It is re-read on every request; cheap while the prompt cache is warm, expensive when it's cold.
- **Cache misses.** A break longer than the cache TTL (5 minutes on billed usage) means the next request re-processes everything.
- **Junk in context.** Huge file reads and command outputs are paid again on every later turn.
- **Compaction itself.** The summary is written in output tokens, the most expensive kind.
- **Subagents.** Each pays its own context, and its report lands in yours.

ccwarden makes these visible as they happen, and steps in where it can without breaking the prompt cache.

## How it compares

| | [ccstatusline](https://github.com/sirmalloc/ccstatusline) | ccwarden |
|---|---|---|
| Rich, configurable status line | ✅ many widgets | minimal: this conversation's cost, context, cache |
| Shows cache and context figures | ✅ | ✅ |
| **Acts**: spend alerts, cold-cache guard, junk guard, subagent guard | — | ✅ |
| **Cheaper compaction** (snapshot compaction, no summary tokens) | — | ✅ (mod) |
| **Advisor**: continue / compact / clear / hand off, with the cost of each | — | ✅ (mod) |
| History report: cache rebuilds and their causes, TTL verdict | — | ✅ |

They complement each other: use ccstatusline for the status line and ccwarden for the guarding.

## Hooks edition (v0.1, works today)

Plain Node scripts on Claude Code's documented hooks and status line. No dependencies.

| Piece | What it does |
|---|---|
| `statusline.js` | Context vs. the auto-compact window, cache warm/cold, TTL left, hit %, last miss cause |
| `hooks/prompt-guard.js` | On the first prompt after the cache expired: "this turn re-processes ~N tokens; `/clear` is cheaper for unrelated work" (warn or block once) |
| `hooks/session-start.js` | After compaction, restores your first request, recent requests (verbatim), open todos and edited files |
| `report.js` | Per-session cache report over your transcripts: hit %, every rebuild and its cause, and whether a 1h TTL would pay off |

```bash
cd hooks-edition
node install.js --compact-window 120000   # merges into ~/.claude/settings.json (backup first)
node ~/.claude/ccwarden/report.js --days 7
node install.js --uninstall
```

Tests: `cd hooks-edition && node --test test/*.test.js`.

## The mod (in development)

One plugin for the Claude Code CLI and the Desktop app's Code tab. Planned first milestone:

1. **This conversation's spend in the status line**, with a toast every $5 (or a share of your 5-hour window on subscription plans). *(first slice in [`mod/`](mod/))*
2. **Per-model context limits** (e.g. Haiku 120K, Sonnet/Opus 300K) with **snapshot compaction**: the mod hands the engine its own compacted conversation, so no summary is generated.
3. **Junk guard**: oversized reads and outputs are redirected to `Grep`/ranged reads; full outputs are saved to a file.
4. **Subagent guard**: pins subagents to a cheaper model, caps their report size and how many run at once.
5. **Cold-cache guard + keep-warm** for the active session only.

Try the first slice:

```bash
claude --plugin-dir ./mod
```

## Privacy

Everything runs locally. ccwarden reads your local transcripts and Claude Code's own usage figures. It sends nothing anywhere and makes no model calls unless a feature says so and you turn it on.

## Roadmap

- **M1:** the five features above, tested on the terminal and Desktop surfaces
- **M2:** handoff command (`/handoff`) and pickup in a new session, model/effort advisor
- **M3:** `/cw` dashboard, monthly projection, TTL advisor
- **M4:** plugin marketplace packaging

## License

[MIT](LICENSE)
