// F16: the warden and the context heatmap as pixels, and their two drawings: Raster cells on the terminal
// (two pixels per cell, `▀` with foreground = top, background = bottom) and the same cells as coloured
// `▀` Text on the desktop, where a Svg given a new source keeps its first picture (Q27). Pure.

export type Px = (number | null)[][]
export type Mood = 'warm' | 'lastMinute' | 'cold' | 'full'

/** Bit 24 alone: the terminal's default colour (RasterProps). */
export const DEFAULT_COLOR = 0x01000000

// The warden, 12 × 4: H cap, Y gold, S skin, E eyes, M mustache, B uniform, F lantern, O the flame (the cache).
const SPRITE = ['..HHYHH...F', '..SESES..FFF', '.MMMMMMM.FOF', 'BBBBYBBBSFFF']
const PAL: Record<string, number> = {
  H: 0x1f3a8a, Y: 0xf5c518, S: 0xe0a878, E: 0x1b1b1b, M: 0x2b1a10, B: 0x2f5fd0, F: 0x9aa4b2,
  D: 0x7cc7ff, P: 0xc9c9c9, X: 0xff2a2a, x: 0x6a0000,
}
const FLAME: Record<Mood, [number, number]> = {
  warm: [0xffb000, 0xffd24a], full: [0xffb000, 0xffd24a], lastMinute: [0xff8a00, 0x4a3000], cold: [0x2a2a2a, 0x2a2a2a],
}
/** Shoulder columns lit gold, per rank (Cadet, Sergeant, Inspector, Chief Warden). */
export const STARS: readonly (readonly number[])[] = [[], [1], [1, 6], [0, 1, 6, 7]]

/** 16 × 4 px: a margin, the warden, a margin, and 2 px for the cold flag (P pole, X/x the flag blinking). */
export function wardenPixels(mood: Mood, frame: number, rank: number): Px {
  const rows = SPRITE.map(r => r.padEnd(12, '.').split(''))
  for (const c of STARS[rank] ?? []) rows[3]![c] = 'Y'
  if (mood === 'lastMinute' || mood === 'full') rows[frame % 2 ? 0 : 1]![7] = 'D' // a sweat drop
  return rows.map((r, i) => {
    const flag = mood !== 'cold' ? '..' : i === 0 ? (frame % 2 ? 'PX' : 'Px') : i < 3 ? 'P.' : '..'
    return `.${r.join('')}.${flag}`.split('').map(ch => (ch === '.' ? null : ch === 'O' ? FLAME[mood][frame % 2]! : PAL[ch]!))
  })
}

/** Three shades each of green, amber, red. */
export const HEAT: readonly (readonly number[])[] = [
  [0x1f6f3a, 0x2ea043, 0x3fb950], [0x9a6700, 0xd29922, 0xe3b341], [0xb62324, 0xf85149, 0xff7b72],
]
export const HEAT_EMPTY = 0x1e2329
export const HEAT_MARK = 0x3a4048

/**
 * `columns` × `height` px, filled column by column, bottom up, `pct` of the way (of the per-model limit).
 * A column's colour is its position along the limit: green below 50 %, amber below 80 %, red from 80 %.
 */
export function heatPixels(pct: number, columns: number, height: number, compactAt?: number): Px {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * columns * height)
  const mark = compactAt === undefined ? -1 : Math.round((compactAt / 100) * columns)
  const px: Px = Array.from({ length: height }, () => Array<number | null>(columns).fill(null))
  for (let c = 0; c < columns; c++) {
    const x = c / columns
    const shades = HEAT[x < 0.5 ? 0 : x < 0.8 ? 1 : 2]!
    for (let r = height - 1; r >= 0; r--) {
      const k = c * height + (height - 1 - r)
      px[r]![c] = k < filled ? shades[(c * 7 + r * 13) % 3]! : c === mark ? HEAT_MARK : HEAT_EMPTY
    }
  }
  return px
}

/** The two-row band's heatmap width: what the band's text leaves, 10 to 24 cells. */
export function heatColumns(bodyColumns: number): number {
  return Math.max(10, Math.min(24, bodyColumns - 97))
}

/** Raster props: two pixel rows per cell; `▀` (fg top, bg bottom), `▄` when only the bottom is set. */
export function rasterCells(px: Px): { cells: string; columns: number; rows: number } {
  const columns = px[0]?.length ?? 0
  const rows = Math.ceil(px.length / 2)
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const top = px[2 * r]![c] ?? null
      const bottom = px[2 * r + 1]?.[c] ?? null
      const i = (r * columns + c) * 3
      if (top === null && bottom === null) words.set([0x20, DEFAULT_COLOR, DEFAULT_COLOR], i)
      else if (top === null) words.set([0x2584, bottom!, DEFAULT_COLOR], i)
      else words.set([0x2580, top, bottom ?? DEFAULT_COLOR], i)
    }
  }
  // The engine's runtime has Uint8Array.prototype.toBase64 (RasterProps doc); es2023's lib doesn't declare it.
  return { cells: (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64(), columns, rows }
}

export type TextCell = { char: '▀' | '▄' | ' '; color?: string; backgroundColor?: string }

/** The same cells as Text for a surface without Raster: per cell a character and CSS colours. */
export function textCells(px: Px): TextCell[][] {
  const hex = (n: number | null | undefined) => (n === null || n === undefined ? undefined : `#${n.toString(16).padStart(6, '0')}`)
  const out: TextCell[][] = []
  for (let r = 0; r < px.length; r += 2) {
    out.push(px[r]!.map((t, c): TextCell => {
      const top = hex(t)
      const bottom = hex(px[r + 1]?.[c])
      if (top === undefined) return bottom === undefined ? { char: ' ' } : { char: '▄', color: bottom }
      return bottom === undefined ? { char: '▀', color: top } : { char: '▀', color: top, backgroundColor: bottom }
    }))
  }
  return out
}
