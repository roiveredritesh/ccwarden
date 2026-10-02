import type { PluginOptions } from 'claude-code'

// The mod's options (SPEC §5), read from what `register(on, options)` gets:
// the manifest's `userConfig` with defaults filled in by the engine. Each
// value is checked again here, so a hand-edited settings file can't hand a
// feature a string where it expects a number.

export type Billing = 'metered' | 'window'

export type Config = {
  /** undefined until the first-run question is answered (stored as `ask`). */
  billing: Billing | undefined
  sessionAlertUsd: number
  sessionAlertPct: number
  sessionAlertRepeat: boolean
  coldMinTokens: number
  limitHaiku: number
  limitOther: number
  compactMode: 'snapshot' | 'summary'
  compactAt: number
  junkGuard: 'observe' | 'enforce' | 'off'
  readMaxLines: number
  bashMaxChars: number
  junkAllowlist: string
  subagentGuard: boolean
  subagentModel: string
  subagentAllowlist: string[]
  maxParallelAgents: number
  keepWarm: boolean
  keepWarmMaxMin: number
  keepWarmCapUsd: number
  budgetModeAt: number
  alertTiming: 'immediate' | 'turnEnd'
}

export const DEFAULTS: Config = {
  billing: undefined,
  sessionAlertUsd: 5,
  sessionAlertPct: 20,
  sessionAlertRepeat: true,
  coldMinTokens: 50_000,
  limitHaiku: 120_000,
  limitOther: 300_000,
  compactMode: 'snapshot',
  compactAt: 55,
  junkGuard: 'observe',
  readMaxLines: 2_000,
  bashMaxChars: 30_000,
  junkAllowlist: '',
  subagentGuard: true,
  subagentModel: 'haiku',
  subagentAllowlist: [],
  maxParallelAgents: 3,
  keepWarm: false, // until Q2 confirms a fork refreshes the main cache
  keepWarmMaxMin: 30,
  keepWarmCapUsd: 0.5,
  budgetModeAt: 80,
  alertTiming: 'immediate',
}

export function readConfig(options: PluginOptions): Config {
  const num = (key: keyof Config): number => {
    const v = options[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : (DEFAULTS[key] as number)
  }
  // For steps and limits, where 0 would divide by zero or compact every turn.
  const pos = (key: keyof Config): number => (num(key) > 0 ? num(key) : (DEFAULTS[key] as number))
  const bool = (key: keyof Config): boolean => {
    const v = options[key]
    return typeof v === 'boolean' ? v : (DEFAULTS[key] as boolean)
  }
  const pick = <T extends string>(key: keyof Config, allowed: readonly T[], fallback: T): T => {
    const v = options[key]
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  }
  const billing = options.billing
  const allowlist = options.subagentAllowlist

  return {
    billing: billing === 'metered' || billing === 'window' ? billing : undefined,
    sessionAlertUsd: pos('sessionAlertUsd'),
    sessionAlertPct: pos('sessionAlertPct'),
    sessionAlertRepeat: bool('sessionAlertRepeat'),
    coldMinTokens: num('coldMinTokens'),
    limitHaiku: pos('limitHaiku'),
    limitOther: pos('limitOther'),
    compactMode: pick('compactMode', ['snapshot', 'summary'], DEFAULTS.compactMode),
    compactAt: num('compactAt'),
    junkGuard: pick('junkGuard', ['observe', 'enforce', 'off'], DEFAULTS.junkGuard),
    readMaxLines: pos('readMaxLines'),
    bashMaxChars: pos('bashMaxChars'),
    junkAllowlist: typeof options.junkAllowlist === 'string' ? options.junkAllowlist : '',
    subagentGuard: bool('subagentGuard'),
    subagentModel: typeof options.subagentModel === 'string' && options.subagentModel !== '' ? options.subagentModel : DEFAULTS.subagentModel,
    subagentAllowlist: (typeof allowlist === 'string' ? allowlist.split(',') : Array.isArray(allowlist) ? allowlist : [])
      .map(s => s.trim())
      .filter(s => s !== ''),
    maxParallelAgents: num('maxParallelAgents'),
    keepWarm: bool('keepWarm'),
    keepWarmMaxMin: num('keepWarmMaxMin'),
    keepWarmCapUsd: num('keepWarmCapUsd'),
    budgetModeAt: num('budgetModeAt'),
    alertTiming: pick('alertTiming', ['immediate', 'turnEnd'], DEFAULTS.alertTiming),
  }
}

/** The per-model context limit (F3): Haiku's, or the one for every other family. */
export function limitFor(model: string, config: Config): number {
  return /haiku/i.test(model) ? config.limitHaiku : config.limitOther
}
