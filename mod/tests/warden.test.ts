import { describe, expect, test } from 'claude-code/testing'
import { readConfig } from '../src/config'
import { formatStatus, statusSegments } from '../src/status'
import type { StatusFacts } from '../src/status'
import { DEFAULT_COLOR, HEAT, HEAT_EMPTY, HEAT_MARK, heatColumns, heatPixels, rasterCells, textCells, wardenPixels } from '../src/sprite'
import { WARDEN_SVG } from '../src/wardenSvg'

describe('F16 config', () => {
  test('warden is on and its chime off by default; both can be switched', () => {
    expect(readConfig({}).warden).toBe(true)
    expect(readConfig({}).wardenChime).toBe(false)
    expect(readConfig({ warden: false, wardenChime: true })).toMatchObject({ warden: false, wardenChime: true })
  })
})

describe('F16 status segments', () => {
  const facts: StatusFacts = {
    billing: 'window', model: 'claude-opus-5-5', tokens: 168_000, limit: 300_000, compactAt: 55,
    cache: { kind: 'warm', msLeft: 52 * 60_000 }, ttl: '1h', chatPct: 24,
    fiveHour: { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(14 * 60_000).toISOString() },
    now: 0, isAlerted: false, isHoldout: true,
  }
  test('one segment per fact, in the status line order; formatStatus joins them', () => {
    expect(statusSegments(facts).map(s => s.kind)).toEqual(['model', 'ctx', 'compact', 'cache', 'chat', 'fiveHour', 'holdout'])
    expect(statusSegments(facts)[0]).toEqual({ kind: 'model', text: 'Opus' })
    expect(formatStatus(facts)).toBe('Opus · ctx ▓▓▓▓▓▓░░░░ 56% 168k/300k · /compact at a break · cache ● 52m · this chat 24% of 5h · 5h 30% (resets 14m) · holdout')
  })
})

describe('F16 pixels', () => {
  test('rasterCells: ▀ with top and bottom, ▄ for bottom only, space for none; base64 of u32 triplets', () => {
    expect(DEFAULT_COLOR).toBe(0x01000000)
    expect(rasterCells([[0xff0000], [null]])).toEqual({ cells: 'gCUAAAAA/wAAAAAB', columns: 1, rows: 1 })
    expect(rasterCells([[null, null], [0x00ff00, null]])).toEqual({ cells: 'hCUAAAD/AAAAAAABIAAAAAAAAAEAAAAB', columns: 2, rows: 1 })
  })

  test('textCells: the same cells as coloured text for the desktop', () => {
    expect(textCells([[0xff0000, null, null], [0x0000ff, 0x00ff00, null]])).toEqual([[
      { char: '▀', color: '#ff0000', backgroundColor: '#0000ff' }, { char: '▄', color: '#00ff00' }, { char: ' ' },
    ]])
  })

  test('heatPixels: fills column by column, bottom up; coloured by position along the limit; the compactAt column marked', () => {
    const [greens, ambers, reds] = HEAT
    const empty = heatPixels(0, 12, 2, 55)
    expect(empty.flat().every(p => p === HEAT_EMPTY || p === HEAT_MARK)).toBe(true)
    expect(empty[0]![7]).toBe(HEAT_MARK) // round(0.55 × 12)
    const one = heatPixels(100 / 24, 12, 2)
    expect(greens).toContain(one[1]![0])
    expect(one[0]![0]).toBe(HEAT_EMPTY)
    const half = heatPixels(50, 12, 2, 55)
    expect(greens).toContain(half[0]![5])
    expect(half[1]![6]).toBe(HEAT_EMPTY)
    const full = heatPixels(100, 12, 2, 55)
    expect(greens).toContain(full[1]![5])
    expect(ambers).toContain(full[1]![6])
    expect(ambers).toContain(full[1]![9])
    expect(reds).toContain(full[1]![10])
    expect(heatPixels(150, 12, 2).flat().includes(HEAT_EMPTY)).toBe(false)
    expect([heatColumns(80), heatColumns(110), heatColumns(200)]).toEqual([10, 13, 24])
  })

  test('wardenPixels: 16 × 4; lantern lit or out; the flag only when cold, blinking; rank stars on the shoulders', () => {
    const warm = wardenPixels('warm', 0, 0)
    expect(warm).toHaveLength(4)
    expect(warm.every(r => r.length === 16)).toBe(true)
    expect(warm.flatMap(r => r.slice(14)).every(p => p === null)).toBe(true)
    expect(warm[2]![11]).toBe(0xffb000)
    expect(wardenPixels('cold', 0, 0)[2]![11]).toBe(0x2a2a2a)
    expect(wardenPixels('cold', 0, 0)[0]![15]).toBe(0x6a0000)
    expect(wardenPixels('cold', 1, 0)[0]![15]).toBe(0xff2a2a)
    expect(warm[3]![2]).toBe(0x2f5fd0)
    expect(wardenPixels('warm', 0, 2)[3]![2]).toBe(0xf5c518)
    expect(wardenPixels('warm', 0, 2)[3]![7]).toBe(0xf5c518)
  })

  test('the desktop warden is one still SVG', () => {
    expect(WARDEN_SVG.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(WARDEN_SVG).not.toContain('<animate')
  })
})
