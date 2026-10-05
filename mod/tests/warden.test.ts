import { describe, expect, test } from 'claude-code/testing'
import { readConfig } from '../src/config'
import { formatStatus, statusSegments } from '../src/status'
import type { StatusFacts } from '../src/status'
import { DEFAULT_COLOR, HEAT, HEAT_EMPTY, HEAT_MARK, heatColumns, heatPixels, rasterCells, textCells, wardenPixels } from '../src/sprite'
import { WARDEN_SVG } from '../src/wardenSvg'
import { AMBER, bandView, fmtClock, GREEN, RED } from '../src/band'
import type { BandFacts } from '../src/band'

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

describe('F16 bandView', () => {
  const base: BandFacts = {
    billing: 'metered', model: 'claude-sonnet-5-5', tokens: 140_000, limit: 300_000, compactAt: 55,
    cache: { kind: 'warm', msLeft: 30 * 60_000 }, ttl: '1h', rebuildUsd: 3.3, usd: 1.84, now: 0, isAlerted: false,
    coldMinTokens: 50_000, isColdAnswered: false,
  }
  const cold: BandFacts = { ...base, cache: { kind: 'cold', msCold: 5 * 60_000 } }
  const alert = "⚠ You've spent $5.00 in this conversation (est.). Continuing."
  const row = (f: BandFacts) => bandView(f, 140).message?.row

  test('calm: one row, the status segments in colour', () => {
    const v = bandView(base, 140)
    expect(v.message).toBeUndefined()
    expect(v.pct).toBe(47)
    expect(v.segments.map(s => s.kind)).toEqual(['model', 'ctx', 'cache', 'chat'])
    expect(v.segments[0]!.isBold).toBe(true)
    expect(v.segments[1]).toMatchObject({ text: 'ctx 47% 140k/300k', color: GREEN })
    expect(v.segments[2]).toMatchObject({ text: 'cache ● 30m', color: GREEN })
    expect(bandView({ ...base, tokens: 200_000 }, 140).segments[1]!.color).toBe(AMBER)
    expect(bandView({ ...base, tokens: 240_000 }, 140).segments[1]!.color).toBe(RED)
  })

  test('row 1: a cold cache over a big context; gone once answered or when the context is small', () => {
    expect(bandView(cold, 140).message).toEqual({
      row: 1, mood: 'cold', color: '#ff5a5a', facts: 'ctx 47% 140k/300k', buttons: ['handoff', 'clear', 'send'], isAnimated: true,
      text: 'Warden: The cache is cold. Your next prompt re-reads 140k tokens (≈ $3.30).',
    })
    expect(bandView(cold, 140).segments[2]!.color).toBe(RED)
    expect(row({ ...cold, isColdAnswered: true })).toBeUndefined()
    expect(row({ ...cold, tokens: 40_000 })).toBeUndefined()
  })

  test('the priority order: cold, spend alert, nearly full, last minute, past 80%, promotion, held note', () => {
    expect(row({ ...cold, spendAlert: alert })).toBe(1)
    expect(bandView({ ...base, spendAlert: alert }, 140).message).toMatchObject({ row: 2, text: "Warden: You've spent $5.00 in this conversation (est.). Continuing.", buttons: ['cw', 'ok'] })
    expect(bandView({ ...base, tokens: 288_000 }, 140).message).toMatchObject({ row: 3, mood: 'full', text: 'Warden: Context is nearly full (96%). Compact now, or ccwarden compacts at the limit.' })
    expect(row({ ...base, tokens: 288_000, spendAlert: alert })).toBe(2)
    const lastMinute = { ...base, cache: { kind: 'warm' as const, msLeft: 47_200 } }
    expect(bandView(lastMinute, 140).message).toMatchObject({
      row: 4, mood: 'lastMinute', isAnimated: true, facts: 'ctx 47% 140k/300k · rebuild after that ≈ $3.30',
      text: 'Warden: The cache goes cold in 0:48. Send your next prompt before then to keep it warm.',
    })
    expect(bandView(lastMinute, 140).segments[2]!.color).toBe(AMBER)
    expect(row({ ...lastMinute, tokens: 40_000 })).toBeUndefined()
    expect(bandView({ ...base, tokens: 255_000 }, 140).message).toMatchObject({ row: 5, text: 'Warden: Context is at 85%. Compact at a break soon.' })
    const promoted = { ...base, promotion: 'Promoted to Sergeant. $5.00 saved so far.', heldNote: 'ccwarden: a held note' }
    expect(bandView(promoted, 140).message).toMatchObject({ row: 6, color: GREEN, text: 'Warden: Promoted to Sergeant. $5.00 saved so far.', buttons: ['ok'] })
    expect(bandView({ ...base, heldNote: 'ccwarden: a held note' }, 140).message).toMatchObject({ row: 7, text: 'Warden: a held note', buttons: ['ok'] })
  })

  test('a holdout session: facts and holdout, never a warden row', () => {
    const v = bandView({ ...cold, isHoldout: true, spendAlert: alert }, 140)
    expect(v.message).toBeUndefined()
    expect(v.segments.map(s => s.kind)).toContain('holdout')
  })

  test('narrow: 5h goes below 90 columns, this chat below 70', () => {
    const window: BandFacts = { ...base, billing: 'window', chatPct: 9, fiveHour: { kind: 'five_hour', percentUsed: 30 } }
    const kinds = (cols: number) => bandView(window, cols).segments.map(s => s.kind)
    expect(kinds(90)).toEqual(['model', 'ctx', 'cache', 'chat', 'fiveHour'])
    expect(kinds(89)).toEqual(['model', 'ctx', 'cache', 'chat'])
    expect(kinds(69)).toEqual(['model', 'ctx', 'cache'])
  })

  test('fmtClock: whole seconds rounded up', () => {
    expect([fmtClock(47_200), fmtClock(60_000), fmtClock(0)]).toEqual(['0:48', '1:00', '0:00'])
  })
})
