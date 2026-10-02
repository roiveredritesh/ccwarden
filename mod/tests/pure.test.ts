import { describe, expect, test } from 'claude-code/testing'
import type { ConfigRow, SessionMessage } from 'claude-code'
import { billingFrom, billingRow, BILLING_OPTIONS } from '../src/billing'
import { DEFAULTS, limitFor, readConfig } from '../src/config'
import { admit } from '../src/toasts'
import { collectFromMessages, collectFromTranscript, parseJsonl } from '../src/transcript'

describe('config', () => {
  test('empty options read as the defaults, billing unset', () => {
    expect(readConfig({})).toEqual(DEFAULTS)
    expect(readConfig({ billing: 'ask' }).billing).toBeUndefined()
  })

  test('bad values fall back; steps and limits must be positive', () => {
    const c = readConfig({ billing: 'window', sessionAlertUsd: 0, limitHaiku: -1, coldMinTokens: 0, junkGuard: 'loud', keepWarm: 'yes' })
    expect(c.billing).toBe('window')
    expect(c.sessionAlertUsd).toBe(5)
    expect(c.limitHaiku).toBe(120_000)
    expect(c.coldMinTokens).toBe(0)
    expect(c.junkGuard).toBe('observe')
    expect(c.keepWarm).toBe(true)
  })

  test('the subagent allowlist is a comma list', () => {
    expect(readConfig({ subagentAllowlist: ' Plan, code-reviewer ,,' }).subagentAllowlist).toEqual(['Plan', 'code-reviewer'])
  })

  test('limits per model family', () => {
    expect(limitFor('claude-haiku-4-5-20251001', DEFAULTS)).toBe(120_000)
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) expect(limitFor(model, DEFAULTS)).toBe(300_000)
  })
})

describe('toast budget (R9)', () => {
  const MIN = 60_000

  test('three per hour; a slot frees an hour after its toast', () => {
    let times: number[] = []
    const shown = [0, 1, 2, 3].map(i => {
      const v = admit(times, i * MIN, 'spend')
      times = v.times
      return v.isShown
    })
    expect(shown).toEqual([true, true, true, false])
    expect(admit(times, 60 * MIN, 'spend').isShown).toBe(true)
  })

  test('lower priorities leave room for the spend alert', () => {
    const one = admit([], 0, 'advisor')
    expect(one.isShown).toBe(true)
    expect(admit(one.times, MIN, 'advisor').isShown).toBe(false)
    const two = admit(one.times, MIN, 'cold')
    expect(two.isShown).toBe(true)
    expect(admit(two.times, 2 * MIN, 'cold').isShown).toBe(false)
    expect(admit(two.times, 2 * MIN, 'spend').isShown).toBe(true)
  })
})

describe('billing answers', () => {
  test('choices map to a mode; anything else is unset', () => {
    expect(billingFrom(BILLING_OPTIONS[0])).toBe('metered')
    expect(billingFrom(BILLING_OPTIONS[1])).toBe('window')
    expect(billingFrom('Not now')).toBeUndefined()
    expect(billingFrom('metered please')).toBeUndefined()
    expect(billingFrom(undefined)).toBeUndefined()
  })

  test("the row is this plugin's own, by whatever name the load gave it", () => {
    const row = (key: string, plugin: string) => ({ key, provider: { plugin } }) as unknown as ConfigRow
    const rows = [row('other.billing', 'other'), row('ccwarden@inline.billing', 'ccwarden@inline')]
    expect(billingRow(rows, 'ccwarden@inline')?.key).toBe('ccwarden@inline.billing')
    expect(billingRow(rows, 'ccwarden')).toBeUndefined()
  })
})

describe('transcript facts', () => {
  const line = (o: unknown) => JSON.stringify(o)
  const user = (content: unknown, extra = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra })
  const tool = (id: string, name: string, input: unknown) =>
    line({ type: 'assistant', message: { id, content: [{ type: 'tool_use', name, input }] } })
  const TODOS = [
    { content: 'Reproduce timeout', status: 'completed' },
    { content: 'Add retry to refresh call', status: 'in_progress' },
  ]
  // The hooks edition's fixture (hooks-edition/test/ccwarden.test.js).
  const JSONL = [
    user('Fix the login timeout bug in the auth service'),
    user('<command-name>/model</command-name>'),
    user('Caveat: local command output', { isMeta: true }),
    tool('a1', 'Edit', { file_path: '/p/src/auth.ts' }),
    user([{ type: 'tool_result', content: 'ok' }]),
    tool('a2', 'TodoWrite', { todos: TODOS }),
    user('This session is being continued... summary', { isCompactSummary: true }),
    user('also keep the old cookie name for backwards compat'),
    tool('a3', 'Write', { file_path: '/p/test/auth.test.ts' }),
    tool('a4', 'Edit', { file_path: '/p/src/auth.ts' }),
    user([{ type: 'text', text: 'see screenshot, the spinner never stops' }, { type: 'image', source: {} }]),
    line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'skip the docs change', humanTurn: true } }),
    line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'from a hook', origin: { kind: 'hook' } } }),
    line({ type: 'attachment', attachment: { type: 'total_tokens_reminder' } }),
    user('subagent chatter', { isSidechain: true }),
    '{"truncated',
  ].join('\n')

  test('from the JSONL: verbatim asks incl. queued ones, files most recent first, latest todos', () => {
    const facts = collectFromTranscript(parseJsonl(JSONL))
    expect(facts.asks).toEqual([
      'Fix the login timeout bug in the auth service',
      'also keep the old cookie name for backwards compat',
      'see screenshot, the spinner never stops',
      'skip the docs change',
    ])
    expect(facts.files).toEqual(['/p/src/auth.ts', '/p/test/auth.test.ts'])
    expect(facts.todos).toEqual(TODOS)
  })

  test('from $.session.messages(): the same facts where they are present', () => {
    const msg = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
      ({ role, text, toolUses: [], ...extra })
    const use = (tool: string, input: Record<string, unknown>) => ({ tool_use_id: tool, tool, input })
    const facts = collectFromMessages([
      msg('user', 'Fix the login timeout bug'),
      msg('user', 'Fix the login timeout bug'),
      msg('assistant', '', { toolUses: [use('Edit', { file_path: '/p/a.ts' }), use('TodoWrite', { todos: TODOS })] }),
      msg('user', 'ok', { toolResults: [{ tool_use_id: 'Edit', text: 'ok' }] as never }),
      msg('user', '<command-name>/model</command-name>'),
      msg('assistant', '', { toolUses: [use('NotebookEdit', { notebook_path: '/p/n.ipynb' })] }),
      msg('user', 'now the tests'),
    ])
    expect(facts.asks).toEqual(['Fix the login timeout bug', 'now the tests'])
    expect(facts.files).toEqual(['/p/n.ipynb', '/p/a.ts'])
    expect(facts.todos).toEqual(TODOS)
  })
})
