import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Il repo principale e il worktree in cui gira la sessione.
const MAIN = '/repo'
const WT = '/repo/.worktrees/wt-1'
const PENDING = `${MAIN}/.claude/handoff/pending`
const WT_PENDING = `${WT}/.claude/handoff/pending`

const norm = (path: string) => path.replace(/\\/g, '/')
const bash = (agentId?: string) => ({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) }) as never
const usageOf = (tokens: number) => ({ model: 'm', input_tokens: tokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const stepInput = (agentId: string) => ({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId }) as never
const pause = () => new Promise(resolve => setTimeout(resolve, 0))
const settled = async () => {
  for (let turn = 0; turn < 5; turn++) await pause()
}

// La sessione gira nel worktree WT; git dice che la common dir è quella del principale.
// I file sono per percorso assoluto: il principale e il worktree restano distinti.
const world = (on: On, agents: object[] = []) => {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const state = {
    clock,
    percent: 0,
    tokens: 0,
    files: new Map<string, string>(),
    logs: [] as string[],
    sends: [] as { to: unknown; text: string }[],
    commands: [] as string[],
    runs: [] as { argv: readonly string[]; cwd?: string }[],
    gitDir: `${MAIN}/.git`,
    // Esiti delle prossime chiamate a git: un exit code o 'throw' (errore o timeout); poi exit 0.
    gitExits: [] as (number | 'throw')[],
  }
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: WT }))
  on('session.cwd', () => ({ value: WT }))
  on('process.run', (_, e) => {
    state.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const exit = state.gitExits.shift() ?? 0
    if (exit === 'throw') return { deny: 'timeout' }
    if (exit !== 0) return { value: { exitCode: exit, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: `${state.gitDir}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: state.percent * 10_000, percent: state.percent }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: agents as never }))
  on('fs.read', (_, e) => {
    const text = state.files.get(norm(e.path))
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    state.files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path).replace(/\/+$/, '')}/`
    const entries = [...state.files.entries()]
      .filter(([key]) => key.startsWith(dir) && !key.slice(dir.length).includes('/'))
      .map(([key, text]) => ({ name: key.slice(dir.length), kind: 'file', size: text.length, mtimeMs: 1, isLink: false }))
    return { value: entries as never }
  })
  on('fs.stat', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('ui.log', (_, e) => {
    state.logs.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('command.run', (_, e) => {
    state.commands.push(e.command)
    return { text: `/${e.command}` }
  })
  on('session.send', (_, e) => {
    state.sends.push({ to: e.to, text: e.text })
    return { isDelivered: true } as never
  })
  on('agent.spawn', () => ({ model: 'm' }))
  on('tool.call', () => ({ result: undefined, text: 'ok' }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usageOf(state.tokens) } as never
  })
  return state
}

// La nota di zona alla principale, nel context di un suo tool.
const mainNote = async ($: Engine, state: { percent: number }) => {
  state.percent = 45
  return (await $.tool.call(bash())).context ?? []
}

// La nota di zona a un agente, dopo un suo passo con `tokens` di contesto.
const agentNote = async ($: Engine, state: { tokens: number }, agentId = 'a1') => {
  state.tokens = 125_000
  const it = $.turn.step(stepInput(agentId))
  while (!(await it.next()).done);
  return (await $.tool.call(bash(agentId))).context ?? []
}

const mainDone = (answer = 'ok') => ({ answer, durationMs: 1, isAborted: false, turnId: 'm1', reason: 'answer' }) as never
const agentDone = (agentId: string, answer = 'ok') => ({ answer, durationMs: 1, isAborted: false, turnId: `t-${agentId}`, reason: 'answer', agentId }) as never
const VALIDATED = '---\nstatus: validated\nsession: s1\nrounds: 1\n---\n# Handoff\n\n## Prossimo passo immediato\nFare y.\n'
const teammate = (cwd = WT) => [{ id: 'a1', teammateId: 'pose@t', type: 'general-purpose', description: 'x', status: 'running', cwd }]

test('worktree: la nota alla principale porta il percorso assoluto nel repo principale', async ($, on) => {
  const state = world(on)
  const [note] = await mainNote($, state)
  expect(note).toContain(`${PENDING}/s1.md`)
  expect(state.runs[0]?.argv).toEqual(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  expect(state.runs[0]?.cwd).toBe(WT)
})

test('worktree: la nota a un agente porta il percorso assoluto nel repo principale', async ($, on) => {
  const state = world(on, teammate())
  const [note] = await agentNote($, state)
  expect(note).toContain(`HANDOFF ${PENDING}/s1--a1.md`)
})

test('worktree: l handoff validato nel principale fa il /clear', async ($, on) => {
  const state = world(on)
  state.files.set(`${PENDING}/s1.md`, VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  expect(state.commands).toEqual(['clear'])
})

test('worktree: l handoff scritto nel worktree si recupera, con una riga di log', async ($, on) => {
  const state = world(on)
  state.files.set(`${WT_PENDING}/s1.md`, VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  expect(state.commands).toEqual(['clear'])
  expect(state.logs.some(line => line.includes('fuori dal repo principale'))).toBe(true)
})

test('worktree: l handoff ready di un teammate nel suo cwd si recupera e si valida', async ($, on) => {
  const agents = [...teammate(`${MAIN}/.worktrees/wt-2`), { id: 'v1', type: 'auto-clear-context:handoff-validator', description: 'v', status: 'running' }]
  const state = world(on, agents)
  state.files.set(`${MAIN}/.worktrees/wt-2/.claude/handoff/pending/s1--a1.md`, '---\nstatus: ready\nagent: a1\n---\n# Handoff\n')
  await $.turn.complete(agentDone('a1'))
  await settled()
  expect(state.logs.some(line => line.includes('fuori dal repo principale'))).toBe(true)
})

test('fuori da git (process.run fallisce): resta la root della sessione', async ($, on) => {
  const state = world(on)
  state.gitDir = 'fatal: not a git repository'
  const [note] = await mainNote($, state)
  expect(note).toContain(`${WT_PENDING}/s1.md`)
})

test('pending mancante: avviso alla principale a fine turno con HANDOFF, una sola volta', async ($, on) => {
  const state = world(on)
  await mainNote($, state)
  await $.turn.complete(mainDone(`HANDOFF ${PENDING}/s1.md`))
  await settled()
  const [warning, ...rest] = (await $.tool.call(bash())).context ?? []
  expect(rest.length).toBe(0)
  expect(warning).toContain(`${PENDING}/s1.md`)
  expect(warning).toContain("il file non c'è")
  expect(warning).toContain(`test -s ${PENDING}/s1.md`)
  expect(state.logs.some(line => line.includes('handoff atteso'))).toBe(true)
  await $.turn.complete(mainDone(`HANDOFF ${PENDING}/s1.md`))
  await state.clock.advance(200_000)
  await settled()
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
})

test('pending vuoto: avviso al teammate a fine turno con HANDOFF', async ($, on) => {
  const state = world(on, teammate())
  await agentNote($, state)
  state.files.set(`${PENDING}/s1--a1.md`, '  \n')
  await $.turn.complete(agentDone('a1', `HANDOFF ${PENDING}/s1--a1.md: la mod valida`))
  await settled()
  expect(state.sends.length).toBe(1)
  expect(state.sends[0]?.to).toBe('a1')
  expect(state.sends[0]?.text).toContain('è vuoto')
  expect(state.sends[0]?.text).toContain(`test -s ${PENDING}/s1--a1.md`)
})

test('pending presente e non vuoto: nessun avviso, né a fine turno né al timer', async ($, on) => {
  const state = world(on)
  await mainNote($, state)
  state.files.set(`${PENDING}/s1.md`, '---\nstatus: draft\nsession: s1\n---\n# Handoff\n')
  await $.turn.complete(mainDone(`HANDOFF ${PENDING}/s1.md`))
  await state.clock.advance(200_000)
  await settled()
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
  expect(state.logs.some(line => line.includes('handoff atteso'))).toBe(false)
})

test('timer: allo scadere di handoffWaitSeconds avviso una volta, con la principale ferma', async ($, on) => {
  const state = world(on)
  await mainNote($, state)
  await $.turn.complete(mainDone())
  await settled()
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
  await state.clock.advance(181_000)
  await settled()
  const [warning, ...rest] = (await $.tool.call(bash())).context ?? []
  expect(rest.length).toBe(0)
  expect(warning).toContain("il file non c'è")
  await state.clock.advance(400_000)
  await settled()
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
})

test('timer: pending vuoto al teammate fermo, avviso con session.send', async ($, on) => {
  const state = world(on, teammate())
  await agentNote($, state)
  await $.turn.complete(agentDone('a1'))
  state.files.set(`${PENDING}/s1--a1.md`, '')
  await state.clock.advance(181_000)
  await settled()
  expect(state.sends.length).toBe(1)
  expect(state.sends[0]?.text).toContain('è vuoto')
})

test('timer spento con handoffWaitSeconds 0', { options: { handoffWaitSeconds: 0 } }, async ($, on) => {
  const state = world(on)
  await mainNote($, state)
  await $.turn.complete(mainDone())
  await state.clock.advance(400_000)
  await settled()
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
})

test('git in errore: il ripiego non resta in cache, la chiamata dopo rilegge git', async ($, on) => {
  const state = world(on)
  state.gitExits = ['throw']
  const [note] = await mainNote($, state)
  expect(state.runs.length).toBeGreaterThan(1)
  expect(note).toContain(`${PENDING}/s1.md`)
  state.files.set(`${PENDING}/s1.md`, VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  expect(state.commands).toEqual(['clear'])
})

test('git con exit 128 (non è un repo): il ripiego resta in cache', async ($, on) => {
  const state = world(on)
  state.gitExits = [128]
  const [note] = await mainNote($, state)
  expect(note).toContain(`${WT_PENDING}/s1.md`)
  await $.turn.complete(mainDone())
  await settled()
  expect(state.runs.length).toBe(1)
})

const subagent = () => [{ id: 'a1', type: 'Explore', description: 'x', status: 'running', cwd: WT }]

test('subagent che finisce senza HANDOFF dopo la nota: nessun avviso al timer', async ($, on) => {
  const state = world(on, subagent())
  await agentNote($, state)
  await $.turn.complete(agentDone('a1', 'fatto, ecco il report'))
  await state.clock.advance(181_000)
  await settled()
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
  expect(state.sends).toEqual([])
  expect(state.logs.some(line => line.includes('handoff atteso'))).toBe(false)
})

test('agente non più in elenco allo scadere del timer: nessun avviso', async ($, on) => {
  const agents = teammate()
  const state = world(on, agents)
  await agentNote($, state)
  await $.turn.complete(agentDone('a1'))
  agents.splice(0)
  await state.clock.advance(181_000)
  await settled()
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
  expect(state.sends).toEqual([])
  expect(state.logs.some(line => line.includes('handoff atteso'))).toBe(false)
})

test('session.end non clear: annulla l attesa della principale', async ($, on) => {
  const state = world(on)
  await mainNote($, state)
  await $.turn.complete(mainDone())
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  await state.clock.advance(181_000)
  await settled()
  expect(state.logs.some(line => line.includes('handoff atteso'))).toBe(false)
})

const READY_A7 = '---\nstatus: ready\nagent: a7\n---\n# Handoff\n\nFare x.\n'
const resume = (path: string) => ({ tool: 'Agent', subagent_type: 'general-purpose', description: 'ripresa', prompt: `Riprendi dall'handoff ${path}` }) as never

test('ripresa da percorso assoluto nel worktree: segnato resumed', async ($, on) => {
  const state = world(on)
  state.files.set(`${WT_PENDING}/s1--a7.md`, READY_A7)
  await $.tool.call(resume(`${WT_PENDING}/s1--a7.md`))
  await settled()
  expect(state.files.get(`${WT_PENDING}/s1--a7.md`)).toContain('status: resumed')
})

test('ripresa da percorso relativo con il file solo nel worktree: segnato resumed', async ($, on) => {
  const state = world(on)
  state.files.set(`${WT_PENDING}/s1--a7.md`, READY_A7)
  await $.tool.call(resume('.claude/handoff/pending/s1--a7.md'))
  await settled()
  expect(state.files.get(`${WT_PENDING}/s1--a7.md`)).toContain('status: resumed')
})
