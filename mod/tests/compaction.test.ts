import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { callLine, doneSteps, filesRead, isPrompt, lastCallOf, mergeSteps, runningTurn, shapeOf, turnsOf, turnStarts } from '../src/turns'
import { cleanWorklog, cutResult, digest, loopAction, nextStepOf, WORKLOG_SYSTEM } from '../src/worklog'
import { parseNumstat, resumeText, snapshotText } from '../src/snapshot'

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

describe('F3b work log', () => {
  const bigLog = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\n') + '\nFAILED: 2 tests'

  test('the digest: prompts, Claude\'s text, one line per call, results under their call', () => {
    const d = digest(convo())
    expect(d).toContain('User: Fix the login timeout bug')
    expect(d).toContain('Claude: Reading the config first.')
    expect(d).toContain('→ Read(/p/e2e.config.ts:10-49)\n  ⎿ cfg')
    expect(d).toContain('→ Bash(npm run e2e) (failed)\n  ⎿ 2 failing')
    expect(d).toContain('User: use the staging URL') // added during the turn
    expect(d.indexOf('Fix the login')).toBeLessThan(d.indexOf('npm run e2e')) // oldest first
    expect(digest([])).toBe('')
    expect(digest([msg('user', '[ccwarden snapshot] facts')])).toBe('')
  })

  test('results fill newest first: whole while they fit, then cut by tool', () => {
    const messages = [
      msg('user', 'go'),
      msg('assistant', '', { toolUses: [use('b0', 'Bash', { command: 'old' }, bigLog)] }),
      results('b0', bigLog),
      msg('assistant', '', { toolUses: [use('b1', 'Bash', { command: 'new' }, bigLog)] }),
      results('b1', bigLog),
    ]
    const d = digest(messages, bigLog.length + 3_000)
    expect(d).toContain(`→ Bash(new)\n  ⎿ ${bigLog}`) // the newest, whole
    expect(d).toContain('characters cut]') // the older one, head and tail
    expect(d).toContain('FAILED: 2 tests\n→ Bash(new)') // the cut keeps the tail
    expect(d.length).toBeLessThanOrEqual(bigLog.length + 3_000)
  })

  test('one huge result never takes the digest past its budget', () => {
    const huge = 'x'.repeat(2_000_000)
    const d = digest([msg('user', 'read it'), msg('assistant', '', { toolUses: [use('r', 'Read', { file_path: '/p/huge.log' }, huge)] })], 10_000)
    expect(d.length).toBeLessThanOrEqual(10_000)
    expect(d).toContain('User: read it')
  })

  test('the oldest turns go when even the skeleton is too big; the last turn stays', () => {
    const turns = Array.from({ length: 50 }, (_, i) => [msg('user', `ask ${i} ${'w'.repeat(200)}`), msg('assistant', `answer ${i}`)]).flat()
    const d = digest(turns, 2_000)
    expect(d).toMatch(/^\(\d+ earlier turns left out\)/)
    expect(d).toContain('answer 49')
    expect(d.length).toBeLessThanOrEqual(2_000)
  })

  test('cut rules by tool', () => {
    expect(cutResult(use('a', 'Bash', { command: 'x' }, bigLog))).toMatch(/^line 0[\s\S]*characters cut[\s\S]*FAILED: 2 tests$/)
    expect(cutResult(use('a', 'Bash', { command: 'x' }, bigLog, true)).length).toBeLessThanOrEqual(2_100)
    expect(cutResult(use('a', 'Grep', { pattern: 'p' }, bigLog))).toMatch(/^line 0\nline 1[\s\S]*\n…\[more cut\]$/)
    expect(cutResult(use('a', 'Read', { file_path: '/p/a' }, bigLog))).toBe('')
    expect(cutResult(use('a', 'Edit', { file_path: '/p/a', new_string: 'const timeout = 30' }, 'ok'))).toBe('changed: const timeout = 30')
  })

  test('the system prompt names the sections; the reply is demoted under ours and capped', () => {
    for (const s of ['## Done', '## In progress', '## Pending', '## Key findings', '## Next step']) expect(WORKLOG_SYSTEM).toContain(s)
    expect(cleanWorklog('\n## Done\n- a\n## Next step\n- b\n')).toBe('### Done\n- a\n### Next step\n- b')
    expect(cleanWorklog('z'.repeat(10_000)).length).toBeLessThanOrEqual(6_000)
  })

  test('the next step: its lines without bullets; none or missing is undefined', () => {
    expect(nextStepOf('### Done\n- a\n### Next step\n- fix the 2 failing tests in src/x.ts\n')).toBe('fix the 2 failing tests in src/x.ts')
    expect(nextStepOf('### Next step\n- run npm test\n- then commit\n### Notes\n- n')).toBe('run npm test; then commit')
    expect(nextStepOf('### Next step\n- none')).toBeUndefined()
    expect(nextStepOf('no headings at all')).toBeUndefined()
  })

  test('the loop rule: warn from the 2nd compaction, stop at the max, 0 never stops', () => {
    expect(loopAction(1, 3)).toBe('none')
    expect(loopAction(2, 3)).toBe('warn')
    expect(loopAction(3, 3)).toBe('stop')
    expect(loopAction(9, 0)).toBe('warn')
  })

  test('a failed edit shows its error, not the change it did not make', () => {
    const failed = [msg('assistant', '', { toolUses: [use('e1', 'Edit', { file_path: '/p/a.ts', new_string: 'const x = 1' }, 'old_string not found', true)] })]
    expect(digest(failed)).toBe('→ Edit(/p/a.ts) (failed)\n  ⎿ old_string not found')
    expect(cutResult(use('e1', 'Edit', { file_path: '/p/a.ts', new_string: 'const x = 1' }, 'old_string not found', true))).toBe('old_string not found')
  })

  test('a turn bigger than the budget keeps its prompt and the end of its calls', () => {
    const turn = [msg('user', 'Refactor the parser'), msg('assistant', '', { toolUses: Array.from({ length: 2_000 }, (_, i) => use(`c${i}`, 'Bash', { command: `step ${i}` }, 'ok')) })]
    const d = digest(turn, 5_000)
    expect(d.length).toBeLessThanOrEqual(5_000)
    expect(d).toMatch(/^User: Refactor the parser\n/)
    expect(d).toContain('[earlier steps of this turn cut]')
    expect(d.endsWith('→ Bash(step 1999)')).toBe(true)
  })
})

describe('F3b snapshot', () => {
  const facts = {
    asks: ['Fix the login timeout bug', 'Ha', 'now run the e2e suite', 'an ask from before the last compaction'],
    todos: null,
    files: ['/p/src/auth.ts'],
    diff: parseNumstat('12\t3\tsrc/auth.ts\n'),
    turns: turnsOf(convo(), 'mid-turn'),
    reads: filesRead(convo()),
  }
  const midTurn = { shape: 'mid-turn' as const, task: 'now run the e2e suite', added: ['use the staging URL'], done: ['Read e2e.config.ts:10-49', 'Ran: npm run e2e → failed'], next: { text: 'fix the 2 failing e2e tests', isHaiku: true }, loopCount: 0 }

  test('order: header, Haiku\'s state of work, the facts, the Resume block last', () => {
    const text = snapshotText(facts, { cwd: '/p', keptTurns: 0, isPartialTail: true, worklog: '### Next step\n- fix the 2 failing e2e tests', resume: resumeText(midTurn) })
    const at = (s: string) => text.indexOf(s)
    expect(text.startsWith('[ccwarden snapshot]')).toBe(true)
    expect(at('## State of work (written by Haiku from the transcript; verify before relying on it)')).toBeGreaterThan(0)
    expect(at('## State of work')).toBeLessThan(at('## Goal (first request)'))
    expect(at('## Goal (first request)')).toBeLessThan(at('## Resume: you were in the middle of this task'))
    expect(text.endsWith("check it cheaply (git diff, or the one file range) instead of redoing it.")).toBe(true)
  })

  test('recent turns: user and Claude with status; the question a short reply answered; earlier asks apart', () => {
    const text = snapshotText(facts, { cwd: '/p', keptTurns: 1 })
    expect(text).toContain('## Recent turns (oldest first)\n1. User: "Fix the login timeout bug"\n   Claude (done): "Edited auth.ts. Shall I also keep the old cookie name?"')
    expect(text).toContain('2. User: "Ha"\n   (answering: "…Edited auth.ts. Shall I also keep the old cookie name?")\n   Claude (done): "Kept it."')
    expect(text).toContain('3. User: "now run the e2e suite"\n   Claude (in progress): "Reading the config first."')
    expect(text).toContain('## Earlier requests (done)\n1. an ask from before the last compaction')
    expect(text).toContain('## Files read (most recent first; re-read only the range you need)\n- e2e.config.ts:10-49')
  })

  test('recent turns fill from the newest within their share', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ask: `ask ${i} ${'w'.repeat(100)}`, reply: 'ok', status: 'done' as const }))
    const text = snapshotText({ ...facts, turns: many, asks: [] }, { keptTurns: 0 })
    expect(text).toContain('60. User: "ask 59')
    expect(text).not.toContain('1. User: "ask 0 ')
    expect(text.length).toBeLessThanOrEqual(10_000)
  })

  test('the Resume block: mid-turn names the task, added prompts, done steps and the next step', () => {
    const r = resumeText(midTurn)
    expect(r).toBe([
      '## Resume: you were in the middle of this task',
      "Current task (the user's request, verbatim):",
      '  "now run the e2e suite"',
      'Added by the user during the task:',
      '  - "use the staging URL"',
      '',
      'Already done in this task (from the transcript, not a guess):',
      '  - Read e2e.config.ts:10-49',
      '  - Ran: npm run e2e → failed',
      "Next step (Haiku's reading of the transcript): fix the 2 failing e2e tests",
      '',
      "Resume this task now from the next step. Don't start it over, don't redo the steps above, and don't work on any other request. Don't ask the user whether to continue. If unsure whether a step is done, check it cheaply (git diff, or the one file range) instead of redoing it.",
    ].join('\n'))
  })

  test('the Resume block without Haiku, without the task, at a boundary, and in a loop', () => {
    const noHaiku = resumeText({ ...midTurn, task: undefined, added: [], done: [], next: { text: 'Bash(npm run e2e) → 2 failing', isHaiku: false } })
    expect(noHaiku).toContain('  "(not in the kept messages; see Recent turns)"')
    expect(noHaiku).toContain('  (none recorded)')
    expect(noHaiku).toContain('Next step: continue after the last step: Bash(npm run e2e) → 2 failing')
    expect(noHaiku).not.toContain('Added by the user')
    expect(resumeText({ ...midTurn, next: undefined })).not.toContain('Next step')
    expect(resumeText({ shape: 'boundary', added: [], done: [], loopCount: 0 })).toBe("## Resume\nAll requests above are answered and done; work only on the user's message that follows.")
    expect(resumeText({ ...midTurn, loopCount: 2 })).toMatch(/instead of redoing it\.\nThis task was compacted 2 times; the context refills because of re-reading\. Read only the ranges you need, prefer Grep, and don't re-read the files listed above\.$/)
  })
})
