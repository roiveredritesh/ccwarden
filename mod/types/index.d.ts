// ccwarden's $.state contract: session values that survive a hot reload.
// Values that must outlive the session go to $.store as well (SPEC §6).

/** A note the toast budget held back; the band (T2+) shows the latest. */
export type CcwardenNote = { text: string; priority: 'spend' | 'cold' | 'advisor'; at: number }

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
    }
  }
}
