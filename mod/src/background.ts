import type { PromptOrigin } from 'claude-code'

// F8 background spend watcher: a turn that starts without the user's prompt
// (a scheduled task or /loop, another session's message, a channel, a
// background task's notification, a plugin) still costs a full request over
// the whole context. Each kind is named once per conversation in a toast,
// with what it cost and the setting that stops it; the running total stays
// in the status line. Pure: the turn hooks in hooks/register.ts track it.

export type BackgroundSource = { kind: string; label: string; stop: string }

/** What started a turn the user didn't type, or undefined for the user's own. */
export function backgroundSource(origin: PromptOrigin): BackgroundSource | undefined {
  switch (origin.kind) {
    case 'composer':
    case 'bridge': // the user's own message from a phone
    case 'sdk': // the host's own turn
    case 'auto-continuation': // a follow-up to the user's own action
      return undefined
    case 'scheduled-trigger':
      return { kind: 'scheduled', label: 'a scheduled task or /loop', stop: 'delete the scheduled tasks or loops you no longer need' }
    case 'peer':
    case 'peer-send-message':
    case 'projects-relay':
    case 'coordinator':
      return { kind: 'peer', label: "another Claude session's message", stop: 'set "crossSessionInbound": "hold" in settings to hold them until you ask' }
    case 'channel':
      return { kind: 'channel', label: 'a channel message (an MCP server relaying Slack, Telegram, …)', stop: "disconnect the channel's MCP server when you don't need it" }
    case 'task-notification':
      return { kind: 'task', label: "a background task's notification", stop: 'stop the background tasks you no longer need' }
    case 'plugin':
      return { kind: `plugin:${origin.name}`, label: `the ${origin.name} plugin`, stop: `turn the ${origin.name} feature off, or disable the plugin` }
    default:
      return { kind: 'other', label: 'something other than your prompt', stop: 'check scheduled tasks, goal check-ins (CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0) and observers' }
  }
}

export function backgroundToast(source: BackgroundSource, usd: number): string {
  return `ccwarden: a turn started by ${source.label} cost ~$${usd.toFixed(2)} (est.). To stop these, ${source.stop}.`
}
