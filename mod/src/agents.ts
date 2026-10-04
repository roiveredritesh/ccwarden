import type { Config } from './config'

// F5 subagent guard: pin subagents to a cheap model unless their type is
// allowlisted, cap the report they hand back (it lands in the parent's
// context at the parent model's price), and cap how many run at once. The
// cap goes in the subagent's own prompt, not the parent's, so the parent's
// cache is untouched. Pure: the agent.spawn hook in hooks/register.tsx applies it.

export const REPORT_CAP =
  '\n\n[ccwarden] Keep your final report to at most ~300 words: findings and file paths ' +
  '(with line numbers where useful). No file dumps or long code blocks; the caller can open the files.'

export const AGENT_WARN_USD = 1

export type SpawnFacts = {
  subagentType: string
  model?: string
  prompt: string
  fork: boolean
}

export type SpawnPlan =
  | { deny: string }
  | { model?: string; prompt: string; notes: string[] }

export function planSpawn(e: SpawnFacts, config: Config, running: number): SpawnPlan {
  if (running >= config.maxParallelAgents) {
    return {
      deny:
        `ccwarden: ${running} subagents are already running (maxParallelAgents is ${config.maxParallelAgents}). ` +
        'Wait for one to finish, or do this step yourself.',
    }
  }
  const notes: string[] = []
  let model: string | undefined
  if (e.fork) {
    notes.push('a fork keeps the parent model and context')
  } else if (!config.subagentAllowlist.includes(e.subagentType) && e.model !== config.subagentModel) {
    model = config.subagentModel
    notes.push(`model ${config.subagentModel}${e.model === undefined ? '' : ` (asked: ${e.model})`}`)
  }
  const prompt = e.prompt.includes(REPORT_CAP) ? e.prompt : `${e.prompt}${REPORT_CAP}`
  notes.push('report capped at ~300 words')
  return { model, prompt, notes }
}

/** The running count among `$.agent.list()` statuses. */
export function runningCount(agents: readonly { status: string }[]): number {
  return agents.filter(a => a.status === 'running').length
}
