import { describe, expect, test } from 'claude-code/testing'
import { readConfig } from '../src/config'
import { formatStatus, statusSegments } from '../src/status'
import type { StatusFacts } from '../src/status'

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
