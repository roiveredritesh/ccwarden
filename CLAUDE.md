# ccwarden

Cost and context guard for Claude Code. Two editions:

- `hooks-edition/`: v0.1, plain Node on documented hooks and the status line. It works today; changes here are maintenance only.
- `mod/`: the real product, a Claude Code function-hook plugin for the CLI and the Desktop Code tab. Active work happens here.

**Start every work session by reading `docs/HANDOFF.md`** (current state, decisions, next tasks). `docs/SPEC.md` is the product spec.

## Commands

- Hooks edition tests: `cd hooks-edition && node --test "test/*.test.js"`
- Setup profile (F12): `node setup/setup.js --dry-run` · tests: `node --test "setup/test/*.test.js"`
- Mod: `claude plugin validate mod` · `claude plugin test mod` · run with `claude --plugin-dir ./mod`
- Day-one probe (dev only, T0): `claude plugin validate probe` · `claude plugin test probe` · run with `claude --plugin-dir ./mod --plugin-dir ./probe`, then `/cw-probe`
- Mod API reference: load the `plugin-authoring` skill. Once the mod has loaded, its types are in `mod/.claude-plugin/types/` (gitignored, written by the engine).

## Rules (from SPEC §2; never break them)

1. Never hook `prompt.compose`, `prompt.context`, `tool.describe` or `skill.prompt`: they invalidate the prompt cache.
2. Add nothing to Claude's context unless a feature that does it is switched on.
3. Every block or rewrite says why. Toasts are rate-limited (max 3/hour).
4. No network calls. Model calls only in features that say so, within a $ cap.
5. One codebase for the `terminal` and `desktop` surfaces; tests cover both.
6. Rely only on behaviour the docs or the plugin API types state. List anything unverified in SPEC §9 / HANDOFF §6.

## Conventions

- The mod runs in its own environment: no Node, no `require`, no dynamic `import()`. Use `$.fs`, `$.process`, `$.clock` and `$.store`.
- `$.env.get/set` take string-literal names only.
- Every hook and `$` call lives in `mod/hooks/register.tsx`, because `claude plugin validate` doesn't follow `$` across imports. `mod/src/` holds pure logic with its tests in `mod/tests/`.
- The maintainer talks in Hinglish; reply in Hinglish. Code, comments, commits and docs are in English.
- Work on a branch per milestone task, open a PR to `main`, and keep CI green.
