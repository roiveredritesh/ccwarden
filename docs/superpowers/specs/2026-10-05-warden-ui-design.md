# F16: the warden UI (design)

Status: design, 2026-10-05 (M6). Every point marked "live" below was checked in a throwaway spike mod on the maintainer's Windows machine (terminal, CLI 2.1.289; Desktop Code tab, bundled 2.1.286) before this spec was written; §14 lists what is still open.

## 1. Why

ccwarden works, but almost nothing it does is visible. Its savings sit in a status line drawn as one plain notice (`⚠ ccwarden: Opus · ctx ▓▓▓░░ …`; the engine adds the `⚠ ccwarden:` prefix and draws no colour), in toasts, and in `/cw`. The maintainer wants the tool to be pleasant to use every day and good to show: a character that reacts to the cache and the context, a heatmap that fills as the context grows, a sound when the cache goes cold, and a running bill, on the terminal and the Desktop Code tab.

## 2. Out of scope

- Anthropic's mascot (Clawd) or any other company's character. The [trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines) need prior approval and forbid alterations; the warden is ccwarden's own.
- Changing what any guard does. F16 shows what ccwarden already measures and decides.
- An animated warden on the Desktop. The Desktop does not redraw a plugin's `Svg` when its source changes (live, §14 Q27), so the Desktop warden is one still picture.
- A turn bill on the Desktop: it has no turn line to hook (`TurnDuration` is terminal only).
- Spoken alerts (`$.audio.speak`).

## 3. Rules check (SPEC §2)

| Rule | How F16 keeps it |
|---|---|
| 1. No cache-breaking hooks | Only `ui.render` (`AbovePrompt`, `Spinner`, `TurnDuration`, `Pane`) and hooks the mod already has. No `prompt.*`, `tool.describe`, `skill.prompt`. |
| 2. Nothing added to context | Render hooks change what is drawn, never what the model reads. |
| 3. Every block says why; toasts ≤ 3/hour | The band says why it is red or amber in words. Spend alerts move from toasts into the band; a toast is only the fallback where no band is drawn, still under R9 (§6). |
| 4. No network | The chime is a file shipped with the mod, played by a local program. |
| 5. One codebase, both surfaces | One band tree, with a different face element per surface; hooks tests on terminal and desktop × metered and window. |
| 6. Only documented behaviour | Built on the types and on the spike's live results; what is unverified is in §14. |

## 4. The warden

An original character: a police warden in a blue uniform with a navy cap and gold badge, a mustache, and a lantern. **The lantern's flame is the cache**: lit while warm, flickering in its last minute, out when cold.

### Terminal: pixel sprite

12 × 4 pixels drawn as one `Raster` of 12 columns × 2 rows, each cell a `▀` half-block (foreground = top pixel, background = bottom; `▄` when only the bottom is set). Colours are 24-bit.

| Mood | Shown when | Sprite |
|---|---|---|
| calm | 1-row band | not drawn |
| warm | (2-row band for a promotion or held note) | flame lit (2-frame flicker) |
| last minute | cache ≤ 60 s from cold | flame flickers dim/bright, sweat drop |
| cold | cache cold | flame out, red flag beside him blinking |
| full | context ≥ 80 % of the limit, cache warm | sweat drop, flame lit |

Rank stars (§9) are gold pixels on the shoulders.

### Desktop: one still SVG

One neutral smooth SVG of the same character (`<Svg source width={59} height={40} />`, no `isInteractive`: an interactive Svg in the band draws only its `alt`, live). It never changes. The mood is carried by the band's coloured text, and in the cold mood by a `⚑` Text beside the picture that blinks red/dark at 2 fps (Text redraws on the Desktop, live).

### Animation

A `$.clock.every(500)` tick runs only while the 2-row band shows an animated mood (last minute, cold) and stops when the band goes back to one row. The 1-row band redraws when its facts change and once a minute for the cache countdown, as the status line does today.

## 5. The band (`AbovePrompt`)

The band replaces the `$.ui.status` line wherever it can be drawn: when `$.session.surfaces()` includes `terminal` or `desktop` (`AbovePrompt` is raised on those two). Otherwise (`-p`, VS Code, mobile) the status line is set exactly as today. With `warden: false` the band is not drawn and nothing changes from today.

### One row (normal)

The status line's segments, in the same order and with the same rules (`formatStatus`), coloured, with a small heatmap after the model:

`Opus ▄▄▄▄▄░░ ctx 56% 168k/300k · ● cache 52m · this chat 24% of 5h · 5h 30% (resets 14m)`

- Model in blue; ctx % green below 50 %, amber below 80 %, red from 80 %; cache `●` green, amber in its last minute, red `○ cold`.
- All other segments the status line has today stay (`/compact at a break`, `miss: …`, `budget mode`, `holdout`, `background $`, `keep-warm`, `agents`), dim.
- Narrow terminals: below 90 columns (`e.props.bodyColumns`) the `5h …` segment is dropped, below 70 `this chat` too; the last text is `truncate-end`. The band stays one row.

### Heatmap

`columns × height` pixels, filled column by column, bottom up, up to the conversation's **per-model limit** (the % the status line shows, not the model's window). Colour by position along the limit: green below 50 %, amber below 80 %, red from 80 %, three shades each; empty cells dark; the `compactAt` column marked. One row: 12 × 2 px. Two rows: `clamp(bodyColumns − 97, 10, 24)` × 4 px. Terminal: a `Raster`. Desktop: the same pixels as coloured `▀` Text cells (`color` = top, `backgroundColor` = bottom), because a Desktop `Svg` given a new source keeps its first picture (live).

### Two rows (when there is something to say)

Face, heatmap, and two lines: what the warden says (bold, coloured), then the facts and buttons. One message at a time, by priority:

| # | When | Line 1 (colour) | Line 2 / buttons |
|---|---|---|---|
| 1 | Cache cold, context ≥ `coldMinTokens` | `Warden: The cache is cold. Your next prompt re-reads 140k tokens (≈ $3.30).` (red) | ctx facts · `[Handoff] [Clear] [Send anyway]` |
| 2 | Spend alert due (F1b) | `Warden: This chat has spent $5.00 (est.). Next alert at $10.00.` / window: `… used 20% of your 5h window (est.)` (red) | `[/cw] [OK]` |
| 3 | Context ≥ 95 % of the limit, cache warm | `Warden: Context is nearly full (96%). Compact now, or ccwarden compacts at the limit.` (red) | ctx facts |
| 4 | Cache ≤ 60 s from cold, context ≥ `coldMinTokens` | `Warden: The cache goes cold in 0:48. Send your next prompt before then to keep it warm.` (amber) | ctx facts · `rebuild after that ≈ $3.30` |
| 5 | Context ≥ 80 % of the limit, cache warm | `Warden: Context is at 85%. Compact at a break soon.` (amber) | ctx facts |
| 6 | A promotion (§9), once | `Warden: Promoted to Sergeant. $5.00 saved so far.` (green) | `[OK]` |
| 7 | A held note (R9 `heldNote`) | the note's text (amber) | `[OK]` |

- Rows 1, 3, 4 and 5 clear themselves when their condition ends; rows 2, 6 and 7 stay until `OK` or the next prompt.
- **Handoff** runs the existing quick handoff (F7, no model call). **Clear** runs `$.command.run({ command: 'clear' })` (it clears: live, Q4). **Send anyway** dismisses. Any of the three marks the cold spell as answered, so F2's cold-cache ask does not ask again for the same spell.
- F2's ask at `prompt.submit` is unchanged: the band warns before, F2 still guards the send.
- Buttons work by click and by hotkey once the band has focus (live, terminal).
- In a holdout session (F15) the band shows the facts and `holdout`, as the status line does.

## 6. Alerts move into the band

- **Spend alerts (F1b)** draw row 2 instead of a toast. In the band an alert is not a toast, so it uses none of R9's budget; where no band is drawn it is a toast under R9, as today. `sessionAlertUsd/Pct/Repeat` and `alertTiming` decide when, unchanged.
- **Held notes:** a toast R9 holds back is kept in `heldNote` today "for the band". Row 7 is that band.
- Other `$.ui.log` lines and the F2/F13 `$.ui.ask` questions do not change.

## 7. The chime

Off by default (`wardenChime`). When on, it plays once per cold spell, when the band enters the cold row.

`$.audio.play` is silent on the Windows terminal and the Desktop (it resolves and plays nothing; the types say a Windows or Linux terminal has no player), so the mod plays its own `sounds/chime.wav` (0.45 s, two tones, ~20 KB, made by a script in the repo) with a local program through `$.process.run`, chosen by OS:

| OS | argv | Status |
|---|---|---|
| Windows | `powershell -NoProfile -NonInteractive -Command "(New-Object Media.SoundPlayer '<wav>').PlaySync()"` | live: plays, terminal and Desktop |
| macOS | `$.audio.play({ asset })` (the types: `afplay` plays it) | unverified (Q28) |
| Linux | `paplay <wav>`, else `aplay -q <wav>` | unverified (Q28) |

The OS is found as the F14 opener finds it. A failure is logged to debug once per session and never retried in that session. Timeout 5 s.

## 8. Spinner and turn bill

### Spinner (terminal and Desktop)

The engine's own word stays; the suffix becomes `… · $0.07`: this turn's spend so far, `usage().cost.usd` now minus at the turn's start. The start figure is kept in the conversation's `$.state` (set at `prompt.submit`, reset by `/clear`) so a reload mid-turn keeps it; when it is unknown the suffix is left as the engine's. Redrawn on `session.measure` with `cost` in `changed` (`$.ui.invalidate('ui.render')`). Live: the figure rises during a turn on both surfaces.

### Turn bill (terminal only)

The line that closes a turn becomes `✻ Baked for 42s · $0.18 · 96% cached` (+ `· re-cached 111k` when the turn wrote more than 20k tokens to the cache). At `turn.complete` (main loop only) the bill is stored in `$.state` by the turn's `durationMs`; the `TurnDuration` hook draws it for the line with the same `durationMs` (live: they are equal), and leaves the engine's line where none matches. The store keeps the last 50 bills. Window billing shows the same `$` (est., list price): a turn's share of the 5h window is below the 1 % the engine reports.

## 9. Ranks and badges

### Ranks

Lifetime estimated savings, from the F15 metrics log: the sum of `est.usd` of every event that is not `would`, in protected sessions only (holdout sessions save nothing by design).

| Rank | From | Sprite |
|---|---|---|
| Cadet | $0 | no stars |
| Sergeant | $5 | one star |
| Inspector | $20 | two stars |
| Chief Warden | $50 | four stars |

On the maintainer's machine the log shows $1.33 saved over 3 days (≈ $0.44/day): Sergeant in about 11 days, Chief Warden in about 4 months.

The total is computed at `session.start` from the metrics files (through F14's cached summaries) and kept in `$.store` `warden: { savedUsd, rank, badges, at }`; this conversation's events are added as they are logged. A rise to a new rank draws band row 6 once.

### Badges

Earned once, from the same events:

| Badge | Earned when |
|---|---|
| First save | the first event with `est.usd > 0` |
| Cool head | 10 `cold/outcome` events whose choice was not to send into the cold cache |
| Lean team | 25 `subagent/pinned` events |
| Clean reads | 25 `junk/kept-out` events (enforce mode) |

## 10. `/cw` pane additions

No new pane: the existing `/cw` pane (F10) gets three sections above its current ones.

- **Rank:** the four sprites with names, the current one marked; `$12.40 saved · $7.60 to Inspector` with a progress bar.
- **Badges:** earned ones, then the rest dim with their progress (`Lean team 12/25`).
- **Patrol log (today):** up to 8 of today's events, newest first, one line each, an action event joined to its `outcome` by `ref` for the saving. Templates from the fields the log already has, e.g. `10:42  Blocked a whole Read of cw-enforce.txt (2,500 lines) · kept ~17k tokens out ($0.02)`, `10:31  Pinned a general-purpose subagent from Opus to Haiku · saved ~$0.12`, `09:58  Asked before a prompt on a cold cache (60k) · you chose handoff · saved ~$0.12`. Observe-mode events say `(observe)`.
- **Receipt:** this conversation, from its F15 session record and events, in a `Code` block (monospace on both surfaces): prompts, requests, cache reads, spent (est.), subagents, then "Warden saved" by feature, the rank line. `[Copy receipt]` uses `$.ui.copy`.

## 11. Configuration (`userConfig`)

| Field | Default | What |
|---|---|---|
| `warden` | `true` | The band (instead of the status line), spinner `$`, turn bill, and the `/cw` warden sections. `false`: exactly today's UI. |
| `wardenChime` | `false` | The cold-cache chime (§7). |

## 12. Modules and data flow

`src/` stays pure; every hook and `$` call is in `hooks/register.tsx`.

| Module | Does |
|---|---|
| `src/sprite.ts` | Sprite and palette, moods, rank stars; heatmap pixels; packing pixels into Raster cells (base64 u32 triplets) and into `▀` text cells |
| `src/wardenSvg.ts` | The Desktop SVG (one string) |
| `src/band.ts` | `bandView(facts)`: one row or two, the mood, both lines as coloured segments, the buttons, whether to animate; the priority table of §5 |
| `src/status.ts` | `formatStatus` split into `statusSegments` (text + colour + priority), so the band and the fallback status line come from one source |
| `src/chime.ts` | The player argv per OS |
| `src/ranks.ts` | Rank from savings, badges from events |
| `src/patrol.ts` | Patrol-log lines from events |
| `src/receipt.ts` | Receipt text from a session record and its events |
| `sounds/chime.wav` | The chime, made by `scripts/make-chime.js` |

Flow: `refreshStatus` already gathers the status facts. It now writes them to a `$.state` key the band reads (`read($, atom)`), and calls `$.ui.status` only when no band is drawn. The band's message state (spend alert pending, cold spell answered, promotion pending) is in the conversation's `$.state`. The spinner and turn bill read `turnStartUsd` and `bills` from `$.state`. Ranks read `$.store` `warden`.

## 13. Testing

- **Unit (`mod/tests/`):** Raster packing (`▀`/`▄`/space, colours), text cells, heatmap fill and colours at 0/49/50/79/80/100 %, the band priority table (each row and their order), narrow widths, chime argv per OS, rank thresholds and badges from fixture events, patrol templates for every action in the log today, receipt totals.
- **Hooks, on terminal and desktop × metered and window:** 1-row band with the status facts; `Raster` on the terminal, `Svg` + text cells on the desktop; each 2-row row and its buttons (Clear runs `/clear`, Handoff writes a quick handoff, Send anyway answers the spell and F2 does not ask again); spend alert in the band and as a toast with no surface; status fallback with no surface; spinner suffix from `turnStartUsd`, none when it is unknown; the turn bill on the matching line only; chime once per cold spell and never with `wardenChime` off; pane sections; promotion once.
- **No regressions:** with `warden: false`, the existing status, toast and pane tests pass unchanged.
- **Type-check** with `tsc` (CLAUDE.md, Commands).

## 14. Open questions (to SPEC §9)

Answered live by the spike (2026-10-05, Windows; terminal CLI 2.1.289, Desktop bundled 2.1.286):

| # | Question | Answer |
|---|---|---|
| Q4 | Can a mod run `/clear`? | **Yes:** a band Button's `$.command.run({ command: 'clear' })` cleared the conversation. |
| Q17 | `$.process.run` on the Desktop? | **Yes:** the PowerShell chime ran from the Desktop. |
| Q26 | Does a Desktop `isInteractive` Svg animate in the band? | **No:** it draws only its `alt`. A plain Svg draws. |
| Q27 | Does the Desktop redraw a band `Svg` when its source changes? | **No:** it keeps the first picture until the band's structure changes; the engine also drops a Svg's `key`. Text redraws. |
| Q28 | Does `$.audio.play` sound? | **Not on the Windows terminal or the Desktop** (resolves, silent; asset and base64). PowerShell's `SoundPlayer` plays. macOS (`afplay`) and Linux (`paplay`/`aplay`): open. |
| Q29 | Plugin commands on the Desktop? | Not in the `/` list, but typed they run in a new session. After a hot reload an open Desktop session may stop routing them (development only). |
| Q30 | Does `TurnDuration.durationMs` equal `turn.complete`'s? | **Yes**, exactly. |
| Q31 | Spinner suffix live? | **Yes**, on both surfaces. A module variable for the start cost broke across a reload, hence `$.state`. |

Still open:

| # | Question |
|---|---|
| Q32 | Do band Buttons press on the Desktop (click)? Terminal: yes. |
| Q33 | How does the `Raster` look in a terminal without 24-bit colour (macOS Terminal.app)? |
| Q34 | Linux and macOS chime players (Q28). |

## 15. Build order (M6)

One spec, four phases, a branch and a PR each, CI green.

1. **A. The band:** `sprite`, `wardenSvg`, `band`, `status` split; the 1-row band with the status fallback; the 2-row rows and buttons; spend alerts and held notes in the band; the chime (`chime`, `sounds/chime.wav`, `wardenChime`).
2. **B. Spinner and turn bill.**
3. **C. Ranks and badges** (`ranks`, `$.store` `warden`, promotion row, rank stars on the sprite).
4. **D. Patrol log and receipt** in the `/cw` pane.
5. **Docs and cleanup:** SPEC F16 "As built", §5 config rows, §9 rows from §14 above; HANDOFF; delete the spike mod and remove its folder from `CLAUDE_CODE_PLUGIN_DIRS` in the maintainer's `~/.claude/settings.json`.
