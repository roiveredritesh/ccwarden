import type { HostOs } from './efficiency'

// F16: the cold-cache chime. `$.audio.play` resolves but plays nothing on the Windows terminal and the
// desktop (Q28), so the mod plays its own wav with a local program; on macOS `$.audio.play` uses afplay.

export const CHIME_ASSET = 'sounds/chime.wav'

/** The players to try, in order; none on macOS, where `$.audio.play` plays the asset. */
export function chimeCommands(os: HostOs, wav: string): string[][] {
  if (os === 'windows') return [['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${wav.replace(/'/g, "''")}').PlaySync()`]]
  if (os === 'linux') return [['paplay', wav], ['aplay', '-q', wav]]
  return []
}
