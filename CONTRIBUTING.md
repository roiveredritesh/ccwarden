# Contributing

Thanks for helping. A few ground rules keep ccwarden trustworthy:

1. **Never break the prompt cache.** Don't change the system prompt, tool list or CLAUDE.md layer mid-session (no `prompt.compose`, `prompt.context`, `tool.describe`, `skill.prompt` hooks). See `docs/SPEC.md` §2.
2. **Nothing enters Claude's context unless a feature that does it is switched on.** Every injected token is paid on every later turn.
3. **Every block or rewrite says why**, to the user and to Claude.
4. **No network or model calls by default.**
5. **Facts over guesses.** Cite the Claude Code docs or the plugin API types for any behaviour you rely on; mark anything unverified in `docs/SPEC.md` §9.

## Development

- Hooks edition: `cd hooks-edition && node --test test/*.test.js`
- Mod: `claude plugin validate mod` and `claude --plugin-dir ./mod`

Open an issue before large changes.
