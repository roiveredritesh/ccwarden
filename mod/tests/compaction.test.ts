import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { callLine, doneSteps, filesRead, isPrompt, lastCallOf, mergeSteps, runningTurn, shapeOf, turnsOf, turnStarts } from '../src/turns'

const msg = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
  ({ role, text, toolUses: [], handle: `h-${role}-${text}`, ...extra })
const use = (id: string, tool: string, input: Record<string, unknown>, text?: string, isError?: true) =>
  ({ tool_use_id: id, tool, input, ...(text === undefined ? {} : { text }), ...(isError === undefined ? {} : { isError }) })
const results = (id: string, text: string) => msg('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] })

// A finished turn, then a running one with a prompt the user queued mid-turn.
const convo = (): SessionMessage[] => [
  msg('user', 'Fix the login timeout bug'),
  msg('assistant', 'Edited auth.ts. Shall I also keep the old cookie name?', { toolUses: [use('e1', 'Edit', { file_path: '/p/src/auth.ts', new_string: 'x' }, 'ok')] }),
  msg('user', 'Ha'),
  msg('assistant', 'Kept it.'),
  msg('user', 'now run the e2e suite'),
  msg('assistant', 'Reading the config first.', { toolUses: [use('r1', 'Read', { file_path: '/p/e2e.config.ts', offset: 10, limit: 40 }, 'cfg')] }),
  results('r1', 'cfg'),
  msg('user', 'use the staging URL'), // queued during the turn
  msg('assistant', '', { toolUses: [use('b1', 'Bash', { command: 'npm run e2e' }, '2 failing', true)] }),
  results('b1', '2 failing'),
]

describe('F3b turns', () => {
  test('a prompt after a tool result, or after a call with no result yet, is added during a turn', () => {
    expect(turnStarts(convo())).toEqual([0, 2, 4])
    // (a) in flight: the call has no text and no isError yet
    const inFlight = [msg('user', 'ask'), msg('assistant', '', { toolUses: [use('w1', 'Write', { file_path: '/p/x.ts' })] }), msg('user', 'queued')]
    expect(turnStarts(inFlight)).toEqual([0])
    // (b) right after a user tool-result message
    const answered = [msg('user', 'ask'), msg('assistant', '', { toolUses: [use('r1', 'Read', { file_path: '/p/a.ts' }, 'x')] }), results('r1', 'x'), msg('user', 'queued')]
    expect(turnStarts(answered)).toEqual([0])
    expect(isPrompt(msg('user', '[ccwarden snapshot] facts'))).toBe(false)
    expect(isPrompt(msg('user', '<command-name>/model</command-name>'))).toBe(false)
  })

  test('shape: mid-turn when the last message is a tool call or a tool result, else a boundary', () => {
    expect(shapeOf(convo())).toBe('mid-turn')
    expect(shapeOf(convo().slice(0, 4))).toBe('boundary')
    expect(shapeOf([...convo().slice(0, 4), msg('user', 'next ask')])).toBe('boundary')
    expect(shapeOf([])).toBe('boundary')
  })

  test('turns: the reply and status; a short reply carries the question it answered', () => {
    const turns = turnsOf(convo(), 'mid-turn')
    expect(turns).toHaveLength(3)
    expect(turns[0]).toEqual({ ask: 'Fix the login timeout bug', reply: 'Edited auth.ts. Shall I also keep the old cookie name?', status: 'done' })
    expect(turns[1]).toEqual({ ask: 'Ha', reply: 'Kept it.', question: 'Edited auth.ts. Shall I also keep the old cookie name?', status: 'done' })
    expect(turns[2]).toMatchObject({ ask: 'now run the e2e suite', reply: 'Reading the config first.', status: 'in progress' })
    expect(turnsOf(convo().slice(0, 4), 'boundary').every(t => t.status === 'done')).toBe(true)
  })

  test('the running turn: its prompt, prompts added during it, its messages', () => {
    const r = runningTurn(convo())
    expect(r.task).toBe('now run the e2e suite')
    expect(r.added).toEqual(['use the staging URL'])
    expect(r.body).toHaveLength(5)
    // After a compaction that kept only the end of a turn, no prompt is left.
    expect(runningTurn([msg('user', '[ccwarden snapshot] facts'), msg('assistant', 'More.')]).task).toBeUndefined()
  })

  test('call lines', () => {
    expect(callLine('Read', { file_path: '/p/a.ts' })).toBe('Read(/p/a.ts)')
    expect(callLine('Read', { file_path: '/p/a.ts', offset: 120, limit: 60 })).toBe('Read(/p/a.ts:120-179)')
    expect(callLine('Read', { file_path: '/p/a.ts', offset: 120 })).toBe('Read(/p/a.ts:120-)')
    expect(callLine('Bash', { command: 'git status\n  --short' })).toBe('Bash(git status --short)')
    expect(callLine('Grep', { pattern: 'isPrompt', path: 'mod/src' })).toBe('Grep(isPrompt in mod/src)')
    expect(callLine('Edit', { file_path: '/p/a.ts' })).toBe('Edit(/p/a.ts)')
    expect(callLine('Agent', { description: 'Find the tests' })).toBe('Agent(Find the tests)')
    expect(callLine('mcp__x__y', { q: 1 })).toBe('mcp__x__y({"q":1})')
  })

  test('done steps: only calls with a result, deduped, relative paths, failures named', () => {
    const steps = doneSteps(runningTurn(convo()).body, '/p')
    expect(steps).toEqual(['Read e2e.config.ts:10-49', 'Ran: npm run e2e → failed'])
    const inFlight = [msg('assistant', '', { toolUses: [use('w1', 'Write', { file_path: '/p/new.ts', content: 'x' })] })]
    expect(doneSteps(inFlight, '/p')).toEqual([]) // no result yet: not done
    const edits = [msg('assistant', '', { toolUses: [use('e1', 'Edit', { file_path: '/p/a.ts' }, 'ok'), use('e2', 'Edit', { file_path: '/p/a.ts' }, 'ok'), use('w1', 'Write', { file_path: 'C:\\p\\b.ts' }, 'ok')] })]
    expect(doneSteps(edits, '/p')).toEqual(['Edited a.ts', 'Wrote C:/p/b.ts'])
  })

  test('steps are capped at 25, newest kept; merging keeps earlier steps first', () => {
    const many = [msg('assistant', '', { toolUses: Array.from({ length: 30 }, (_, i) => use(`b${i}`, 'Bash', { command: `step ${i}` }, 'ok')) })]
    const steps = doneSteps(many)
    expect(steps).toHaveLength(25)
    expect(steps[0]).toBe('…and 6 earlier steps')
    expect(steps.at(-1)).toBe('Ran: step 29 → ok')
    expect(mergeSteps(['A', 'B'], ['B', 'C'])).toEqual(['A', 'B', 'C'])
    // A capped list merged with new steps: the marker counts the 6 dropped before and the 3 this merge pushes out.
    const merged = mergeSteps(steps, ['new 1', 'new 2', 'new 3'])
    expect(merged).toHaveLength(25)
    expect(merged[0]).toBe('…and 9 earlier steps')
    expect(merged[1]).toBe('Ran: step 9 → ok')
    expect(merged.at(-1)).toBe('new 3')
  })

  test('merging with a capped later list keeps one marker counting every step left out', () => {
    const capped = (prefix: string) => doneSteps([msg('assistant', '', { toolUses: Array.from({ length: 30 }, (_, i) => use(`${prefix}${i}`, 'Bash', { command: `${prefix} ${i}` }, 'ok')) })])
    // A carried list of 2 steps, then this pass capped at 25 with 6 omitted: 6 + the 2 carried steps pushed out.
    const one = mergeSteps(['A', 'B'], capped('step'))
    expect(one).toHaveLength(25)
    expect(one[0]).toBe('…and 8 earlier steps')
    expect(one[1]).toBe('Ran: step 6 → ok')
    expect(one.at(-1)).toBe('Ran: step 29 → ok')
    // Both lists capped: 6 + 6 from before, plus the 24 of the earlier list that this merge pushes out.
    const both = mergeSteps(capped('old'), capped('new'))
    expect(both).toHaveLength(25)
    expect(both[0]).toBe('…and 36 earlier steps')
    expect(both[1]).toBe('Ran: new 6 → ok')
    expect(both.at(-1)).toBe('Ran: new 29 → ok')
  })

  test('the last call, and files read newest first', () => {
    expect(lastCallOf(convo())).toBe('Bash(npm run e2e) → 2 failing')
    expect(lastCallOf([msg('assistant', 'no tools')])).toBeUndefined()
    const reads = filesRead([
      msg('assistant', '', { toolUses: [use('r1', 'Read', { file_path: '/p/a.ts' }, 'x'), use('r2', 'Read', { file_path: '/p/b.ts', offset: 1, limit: 80 }, 'y')] }),
      msg('assistant', '', { toolUses: [use('r3', 'Read', { file_path: '/p/a.ts' }, 'x')] }),
    ])
    expect(reads).toEqual([{ path: '/p/a.ts', range: '' }, { path: '/p/b.ts', range: ':1-80' }])
  })
})
