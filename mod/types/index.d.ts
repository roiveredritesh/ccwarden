// ccwarden's $.state contract: session values that survive a hot reload.
// Values that must outlive the session go to $.store as well (SPEC §6).

/** A note the toast budget held back; the band (T2+) shows the latest. */
export type CcwardenNote = { text: string; priority: 'spend' | 'cold' | 'advisor'; at: number }

/**
 * This conversation's figures; reset on /clear. Kept in $.state so a reload
 * doesn't alert a step twice or lose the cache clock.
 */
export type CcwardenConversation = {
  /** Highest alert step reached (F1b). */
  alerted: number
  /** A turnEnd alert waiting for the turn to end. */
  pendingAlert?: string
  /** $.clock time of the main loop's last response: the cache's last use. */
  lastResponseAt?: number
  /** When the user last typed a prompt (F6 runs only within keepWarmMaxMin of it). */
  lastPromptAt?: number
  /** When a keep-warm ping last read the cache (F6). */
  keepWarmAt?: number
  /** The cache use a ping found already lapsed; no retry until the cache is used again. */
  keepWarmMissedFor?: number
  /** Keep-warm's pings, their cost and the rebuilds they avoided (est.). */
  keepWarm?: { pings: number; spentUsd: number; savedUsd: number }
  /** The TTL of the latest cache write in the transcript. */
  observedTtl?: '5m' | '1h'
  ttlCheckedAt?: number
  /** The billing/TTL mismatch toast was shown (SPEC §1). */
  ttlWarned?: boolean
  /** The cold spell (its lastResponseAt) the cold-cache guard already asked about (F2). */
  coldAskedFor?: number
  /** The conversation's first ask, kept across snapshot compactions (F3). */
  goal?: string
  /** Subagents (F5): what each cost so far (est.), and which were warned about. */
  agents?: { byId: Record<string, number>; warned: string[] }
  /** Turns the user didn't type (F8): their cost (est.) and the kinds already named in a toast. */
  background?: { usd: number; toasted: string[] }
  /** Window billing: this conversation's share of the 5h window. */
  window?: { chatPct: number; lastPct: number; resetsAt?: string }
}

declare module 'claude-code' {
  interface PluginState {
    ccwarden: {
      /** When each toast of the last hour was shown, oldest first (R9). */
      toastTimes: number[]
      /** The latest note held back by the toast budget. */
      heldNote: CcwardenNote | null
      /** The transcript file, from classic.SessionStart; changes on /clear. */
      transcriptPath: string
      /** The first-run billing question was asked in this session. */
      billingAsked: boolean
      /** This conversation's figures (F1, F1b). */
      conversation: CcwardenConversation
    }
  }
}
