# ccwarden-probe (dev only)

A throwaway plugin for the M1 day-one checks (SPEC §9, HANDOFF §6). It is not part of the mod and never ships. Run it once on each machine, then paste the findings into SPEC §9.

The answers that the v2.1.287 API types give without a live session are already in SPEC §9. This probe covers the rest, which need a real session on the `metered` and `window` machines.

## Load it

From the repo root, next to the mod:

```bash
claude --plugin-dir ./mod --plugin-dir ./probe
```

For the Desktop Code tab, add both absolute paths to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (separated by `:` on macOS/Linux, `;` on Windows), then restart the app.

## Run the checks

Findings show as dim transcript lines that the model never reads. They are also kept in the probe's `$.store`, so they survive restarts and `/clear`. `/cw-probe report` writes them all to `~/.claude/ccwarden-probe.jsonl`.

| Order | Check | What to do | What answers it |
|---|---|---|---|
| 1 | **Q10** managed machine | Start the session as above | The status shows `ccwarden-probe loaded` and the mod's `this chat $…` after the first reply. If neither shows, run `claude --debug` and look for a refused plugin. `/cw-probe info` lists the plugin-related keys of the managed (`policy`) settings. |
| 2 | **Q1, Q7, Q11, Q12** | Send 2–3 prompts, then `/cw-probe info` | Q1: `ttl` from the transcript's 5m/1h cache-write split. Q7: `rateLimits` (empty on `metered`; `five_hour`/`seven_day` expected on `window`). Q11: `$.agent.list()`, plus any `background_tasks` a turn ended with. Q12: `cost`, and a `spend_limit` reading if a gateway reports one. |
| 3 | **Q8** surfaces | `/cw-probe ui`, in the terminal and again in the Desktop Code tab | A toast, a status line and an ask dialog. Your answer is recorded with the surface. |
| 4 | **Q9** model switch | `/model sonnet`, then switch back | A Q9 line with `prompt_cache_warm`, `cache_ttl` and `estimated_cache_write_usd`, logged before the switch happens |
| 5 | **Q6** Bash trim | Ask Claude: "Run `seq 1 4000 # cw-probe-trim` and tell me the last line you see" | Pass: Claude sees the `[cw-probe: trimmed …]` marker. (Keep it under 30k chars: a bigger output is persisted by the engine and shown as a file preview, so the trim is not what Claude sees.) Fail: a refusal line in the transcript, or `claude --debug` showing the result refused. The offline test can't check this, because `claude plugin test` doesn't run the engine's output-schema check. |
| 6 | **Q5** live env | `/cw-probe env 150000` | `compactWindowAfter` vs `compactWindowBefore`. If it hasn't changed, send a prompt and run `/cw-probe info` again to compare `compactWindow`. |
| 7 | **Q2** keep-warm (metered machine) | Run the **control** first: `/cw-probe wait`, stay idle until the toast (~4 min), then send a real prompt about 4 min later (~8 min idle in total). Then repeat with `/cw-probe fork`. | The Q2 line's `nextTurnUsage`. Without the fork, expect a high `cache_creation_input_tokens` (the cache lapsed). With the fork, expect a high `cache_read_input_tokens` and little creation. The fork's own usage is logged as `Q2-fork`. |
| 8 | **Q3, Q13** snapshot compaction | In a session with several turns that read files, run `/cw-probe compact` (it runs `/compact`), then send a prompt | The Q3 lines: the compaction (`before` → `after` messages), every non-assistant row the engine appends afterwards (re-read files show as `attachment` rows), and the next turn's usage. Also check `/usage` for a summary request; there should be none. Q13: a Q3 `answered: snapshot` line means a mod-run `/compact` reaches the mod's own hook. |
| 9 | **Q4** `/clear` from a mod | `/cw-probe newchat` (this **clears the conversation**) | `clearedByMod: true`, and the prompt box prefilled with `cw-probe Q4: …` |
| 10 | Wrap up | `/cw-probe report` on each machine | Paste `~/.claude/ccwarden-probe.jsonl` into SPEC §9 (or share it) |

`/cw-probe clear` forgets the stored findings. Only `fork` makes a model call: one tiny reply over a cached prefix. On the metered machine, expect that call to cost about the prefix's cache-read price (or a re-cache, if the entry has lapsed).

## Tests

```bash
claude plugin validate probe
claude plugin test probe
```

The tests run on both `terminal` and `desktop`. They cover the trimming logic (Q6), the PreModelSwitch hook (Q9), `/clear` plus prefill (Q4) as the engine's stand-in plays it, and the snapshot shape (Q3).
