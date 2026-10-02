import type { ConfigRow } from 'claude-code'
import type { Billing } from './config'

// First run (SPEC §1): one question, saved with $.config.set into this
// machine's settings. The plugin API exposes no plan or account type, so
// the mode can't be detected. Pure: `askBilling` in hooks/register.ts asks.

export const BILLING_QUESTION = 'ccwarden: how is Claude Code billed on this machine?'
export const BILLING_HEADER = 'Billing'
const CHOICES: Record<string, Billing> = {
  'Metered (usage, API key)': 'metered',
  'Window (Pro/Max/Team plan)': 'window',
}
export const BILLING_OPTIONS = [...Object.keys(CHOICES), 'Not now']

/** The billing an answer picks; undefined for "Not now", free text or a dismissal. */
export function billingFrom(answer: string | undefined): Billing | undefined {
  return answer === undefined ? undefined : CHOICES[answer]
}

/** The `/config` row of this plugin's `billing` field: its key is `<plugin>.billing` as the load names it. */
export function billingRow(rows: readonly ConfigRow[], plugin: string): ConfigRow | undefined {
  return rows.find(r => r.provider.plugin === plugin && r.key.endsWith('.billing'))
}
