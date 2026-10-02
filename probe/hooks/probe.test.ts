import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import { snapshot, TRIM_KEEP_CHARS, TRIM_MARKER } from './register'

const SURFACES = ['terminal', 'desktop'] as const

// Stands in for the engine beneath the probe: the clock, the store, and the
// display calls it makes, each line kept so a test reads what was shown.
function world(on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  const shown = { log: [] as string[], status: [] as (string | undefined)[], commands: [] as string[] }
  on('ui.log', (_$, e) => { shown.log.push(e.text); return { value: undefined } })
  on('ui.status', (_$, e) => { shown.status.push(e.text); return { value: undefined } })
  on('command.register', (_$, e) => { shown.commands.push(e.name); return { value: { command: e.name } } })
  return { ...shown, clock }
}

describe('Q9: PreModelSwitch reaches a mod', () => {
  test('the hook sees the switch and its re-cache cost before it happens', async ($, on) => {
    const shown = world(on)
    on('classic.PreModelSwitch', () => ({ permissionDecision: 'allow' }))

    const result = await $.classic.PreModelSwitch({
      from_model: 'claude-haiku-4-5-20251001',
      to_model: 'claude-opus-5-5',
      requested_model: 'opus',
      source: 'command',
      context_tokens: 80_000,
      prompt_cache_warm: true,
      cache_ttl: '5m',
      estimated_cache_write_usd: 0.5,
      pricing: 'catalog',
    })

    expect(result.permissionDecision).toBe('allow')
    expect(shown.log).toHaveLength(1)
    expect(shown.log[0]).toContain('cw-probe Q9:')
    expect(shown.log[0]).toContain('"prompt_cache_warm":true')
    expect(shown.log[0]).toContain('"cache_ttl":"5m"')
  })
})

describe('Q6: a trimmed Bash result', () => {
  const ran = (stdout: string) => ({ result: { stdout, stderr: '', interrupted: false } })

  test('marked output is trimmed (the schema check itself is live-only: the test kit skips it)', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'Bash' }, () => ran('x'.repeat(10_000)))

    const out = await $.tool.call({ tool: 'Bash', command: `seq 1 100000 ${TRIM_MARKER}` })

    expect(out.deny).toBeUndefined()
    expect(out.isError).toBeUndefined()
    const stdout = (out.result as { stdout: string }).stdout
    expect(stdout.startsWith('x'.repeat(TRIM_KEEP_CHARS))).toBe(true)
    expect(stdout).toContain('[cw-probe: trimmed 8000 chars]')
  })

  test('unmarked output is left alone', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'Bash' }, () => ran('x'.repeat(10_000)))

    const out = await $.tool.call({ tool: 'Bash', command: 'seq 1 100000' })

    expect((out.result as { stdout: string }).stdout.length).toBe(10_000)
  })
})

describe('/cw-probe', () => {
  for (const surface of SURFACES) {
    test(`registers and answers without adding to the context (${surface})`, async ($, on) => {
      const shown = world(on)
      on('session.start', (_$, e) => ({ cwd: e.cwd }))

      await $.session.start({ cwd: '/', surface, isInteractive: true })
      expect(shown.commands).toEqual(['cw-probe'])
      expect(shown.status).toEqual(['ccwarden-probe loaded'])

      const out = await $.command.run({
        command: 'cw-probe',
        args: 'help',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 100 },
      })
      expect(out.text).toBeUndefined()
      expect(out.context).toBeUndefined()
      expect(shown.log.at(-1)).toContain('/cw-probe <check>')
    })
  }
})

describe('Q4: /clear from the mod', () => {
  for (const surface of SURFACES) {
    test(`newchat runs /clear, then prefills the prompt box (${surface})`, async ($, on) => {
      const shown = world(on)
      const ran: string[] = []
      const fills: string[] = []
      on('session.start', (_$, e) => ({ cwd: e.cwd }))
      on('command.run', { command: 'clear' }, (_$, e) => { ran.push(e.command); return {} })
      on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
      on('prompt.fill', (_$, e) => { fills.push(e.text); return { isFilled: true } })

      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await $.command.run({ command: 'cw-probe', args: 'newchat', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
      await shown.clock.advance(0)
      // What the engine does on /clear: the session ends with reason `clear`.
      await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
      await shown.clock.advance(1_000)

      expect(ran).toEqual(['clear'])
      expect(fills).toEqual(['cw-probe Q4: prefilled after /clear'])
      expect(shown.log.some(l => l.includes('"clearedByMod":true'))).toBe(true)
    })
  }
})

describe('snapshot()', () => {
  const msg = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
    ({ role, text, toolUses: [], handle: `h-${text}`, ...extra })

  test('keeps the last real prompt onward, by handle, after one note', () => {
    const toolResult = { tool_use_id: 't1', text: 'ok', isError: false, result: null }
    const messages = [
      msg('user', 'first ask'),
      msg('assistant', 'done'),
      msg('user', 'second ask'),
      msg('assistant', 'reading'),
      msg('user', '', { toolResults: [toolResult] as never }),
      msg('assistant', 'answer'),
    ]

    const out = snapshot(messages)

    expect(out.map(m => m.handle)).toEqual([undefined, 'h-second ask', 'h-reading', 'h-', 'h-answer'])
    expect(out[0]!.text).toContain('2 earlier messages')
  })
})
