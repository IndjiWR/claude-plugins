import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Il file dal punto in cui comincia la cartella dell'handoff, qualunque sia la radice.
const fileKey = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  const at = slashed.indexOf('.claude/handoff')
  return at < 0 ? slashed : slashed.slice(at)
}

const after = { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'u1' } as const
const agentAfter = (agentId: string) => ({ ...after, agent_id: agentId, agent_type: 'general-purpose' }) as never

const usageOf = (tokens: number) => ({
  model: 'm',
  input_tokens: tokens,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})
const stepResult = (usage: unknown) => ({ turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage }) as never
const stepInput = (agentId?: string) => ({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId }) as never

// Il mondo sotto il monitor: una principale con finestra da 1M, l'elenco degli
// agenti e il fondo di turn.step che risponde con l'usage di `state.tokens`.
const world = (on: On, agents: readonly object[] = [{ id: 'a1', type: 'general-purpose', description: 'x', status: 'running' }]) => {
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  const state = {
    tokens: 0 as number | null,
    files: new Map<string, string>(),
    spawns: [] as { subagentType?: string; prompt: string }[],
    // Se impostato, la risposta del fondo di tool.call di Agent (un teammate avviato dal modello).
    agentRecord: undefined as object | undefined,
    sends: [] as { to: unknown; text: string }[],
  }
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: 'C:/progetto' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 0, percent: 0 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: agents as never }))
  on('fs.read', (_, e) => {
    const text = state.files.get(fileKey(e.path))
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    state.files.set(fileKey(e.path), e.text)
    return { value: undefined }
  })
  // $.agent.spawn della mod: l'input arriva nella forma del tool Agent (subagent_type). Il motore di prova
  // non dà l'id dell'agente avviato: la mod lo trova in agent.list, dove stanno i validatori v1 e v2.
  on('agent.spawn', (_, e) => {
    const call = e as unknown as { prompt: string; subagent_type?: string }
    state.spawns.push({ subagentType: call.subagent_type, prompt: call.prompt })
    return { model: 'm' }
  })
  // Il fondo di tool.call di Agent: la risposta di un teammate avviato dal modello, se impostata.
  on('tool.call', () => ({ result: state.agentRecord, text: 'ok' }) as never)
  on('session.send', (_, e) => {
    state.sends.push({ to: e.to, text: e.text })
    return { isDelivered: true } as never
  })
  on('fs.stat', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.PostToolUse', () => ({}))
  on('turn.step', async function* () {
    return stepResult(state.tokens === null ? null : usageOf(state.tokens))
  })
  return state
}

// Un passo dell'agente con `tokens` di contesto, poi il suo PostToolUse: le note che porta.
const step = async ($: Engine, state: { tokens: number | null }, tokens: number | null, agentId = 'a1') => {
  state.tokens = tokens
  const it = $.turn.step(stepInput(agentId))
  while (!(await it.next()).done);
  return (await $.classic.PostToolUse(agentAfter(agentId))).additionalContext ?? []
}

test('subagent: una nota per zona, col percorso dell handoff', async ($, on) => {
  const state = world(on)
  const [soft, ...rest] = await step($, state, 450_000)
  expect(rest.length).toBe(0)
  expect(soft).toContain('s1--a1.md')
  expect(soft).toContain('Zona morbida')
  expect(soft).toContain('general-purpose')
  expect((await step($, state, 460_000)).length).toBe(0)
  const [hard] = await step($, state, 650_000)
  expect(hard).toContain('Zona dura')
})

test('teammate: la nota chiede status ready e non lancia il validatore', async ($, on) => {
  const state = world(on, [{ id: 'a1', teammateId: 'pose@t', type: 'general-purpose', description: 'x', status: 'running' }])
  const [note] = await step($, state, 450_000)
  expect(note).toContain('s1--a1.md')
  expect(note).toContain('status: ready')
  expect(note).toContain('Non lanciare il validatore')
})

test('subagent breve: sotto la morbida nessuna nota', async ($, on) => {
  const state = world(on)
  expect((await step($, state, 300_000)).length).toBe(0)
})

test('agente assente da agent.list: nessuna nota', async ($, on) => {
  const state = world(on)
  expect((await step($, state, 450_000, 'zz')).length).toBe(0)
})

test('turn.step senza usage: nessuna nota, nessun errore', async ($, on) => {
  const state = world(on)
  expect((await step($, state, null)).length).toBe(0)
})

test('opzione agents false: nessuna nota', { options: { agents: false } }, async ($, on) => {
  const state = world(on)
  expect((await step($, state, 450_000)).length).toBe(0)
})

test('agentThreshold: la morbida degli agenti è la loro', { options: { agentThreshold: 15 } }, async ($, on) => {
  const state = world(on)
  const [note] = await step($, state, 160_000)
  expect(note).toContain('Zona morbida')
  expect(note).toContain('soglie 15/35%')
})

test('monitor spento (morbida 0): nessuna nota agli agenti', { options: { threshold: 0 } }, async ($, on) => {
  const state = world(on)
  expect((await step($, state, 450_000)).length).toBe(0)
})

test('la principale senza agent_id non riceve note dai passi degli agenti', async ($, on) => {
  const state = world(on)
  state.tokens = 450_000
  const it = $.turn.step(stepInput('a1'))
  while (!(await it.next()).done);
  const result = await $.classic.PostToolUse(after)
  expect(result.additionalContext ?? []).toEqual([])
})

// Validazione dell'handoff di un teammate.
const FILE = '.claude/handoff/pending/s1--a1.md'
const validator = (id: string) => ({ id, type: 'auto-clear-context:handoff-validator', description: 'v', status: 'running' })
const teammate = [{ id: 'a1', teammateId: 'pose@t', type: 'general-purpose', description: 'x', status: 'idle' }, validator('v1'), validator('v2')]
const ready = (extra = '') => `---\nstatus: ready\nagent: a1\n${extra}---\n# Handoff\n\n## Prossimo passo immediato\nFare x.\n`
const done = (agentId: string, answer = 'ok') =>
  ({ answer, durationMs: 1, isAborted: false, turnId: `t-${agentId}`, reason: 'answer', agentId }) as never
const turnEnd = async ($: Engine, agentId: string, answer?: string) => {
  await $.turn.complete(done(agentId, answer))
}

test('tool.call di Agent: il teammate avviato registra il suo input in $.state', async ($, on) => {
  const state = world(on)
  const written: { key: string; id?: string; value: unknown }[] = []
  on('state.set', (_, e, next) => {
    written.push({ key: e.key, id: (e as { id?: string }).id, value: e.value })
    return next(e)
  })
  state.agentRecord = { status: 'teammate_spawned', agentId: 'a1', agent_id: 'a1', teammate_id: 'pose@t', name: 'pose', prompt: 'x' }
  await $.tool.call({ tool: 'Agent', name: 'pose', subagent_type: 'general-purpose', description: 'posa', prompt: 'x' } as never)
  const input = written.find(w => w.key === 'agentInputs')
  expect(input?.id).toBe('a1')
  expect(input?.value).toMatchObject({ name: 'pose', subagent_type: 'general-purpose', description: 'posa' })
})

test('teammate con handoff ready: un solo validatore, anche al secondo turn.complete', async ($, on) => {
  const state = world(on, teammate)
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  expect(state.spawns.length).toBe(1)
  expect(state.spawns[0]?.subagentType).toBe('auto-clear-context:handoff-validator')
  expect(state.spawns[0]?.prompt).toContain(FILE)
  await turnEnd($, 'a1')
  expect(state.spawns.length).toBe(1)
})

test('due turn.complete ravvicinati del teammate: un solo validatore', async ($, on) => {
  const state = world(on, teammate)
  state.files.set(FILE, ready())
  await Promise.all([turnEnd($, 'a1'), turnEnd($, 'a1')])
  expect(state.spawns.length).toBe(1)
})

test('subagent con handoff ready: nessun validatore', async ($, on) => {
  const state = world(on, [{ id: 'a1', type: 'general-purpose', description: 'x', status: 'idle' }, validator('v1')])
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  expect(state.spawns.length).toBe(0)
})

test('handoff non ready o assente: nessun validatore', async ($, on) => {
  const state = world(on, teammate)
  await turnEnd($, 'a1')
  state.files.set(FILE, ready().replace('ready', 'draft'))
  await turnEnd($, 'a1')
  expect(state.spawns.length).toBe(0)
})

test('verdetto completo: validated con rounds 1', async ($, on) => {
  const state = world(on, teammate)
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  await turnEnd($, 'v1', 'LACUNE: nessuna\nVERDETTO: completo')
  const text = state.files.get(FILE) ?? ''
  expect(text).toContain('status: validated')
  expect(text).toContain('rounds: 1')
  expect(state.sends.length).toBe(0)
})

test('da integrare: giro 1 manda le lacune al teammate, giro 2 accetta e le annota', async ($, on) => {
  const state = world(on, teammate)
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  await turnEnd($, 'v1', 'LACUNE: manca la verifica\nVERDETTO: da integrare')
  expect(state.sends.length).toBe(1)
  // Nell'evento l'indirizzo {agentId} arriva come id.
  expect(state.sends[0]?.to).toBe('a1')
  expect(state.sends[0]?.text).toContain('manca la verifica')
  expect(state.files.get(FILE)).toContain('status: ready')
  expect(state.files.get(FILE)).toContain('rounds: 1')
  // il teammate corregge (e rimette ready senza il contatore): secondo giro
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  expect(state.spawns.length).toBe(2)
  await turnEnd($, 'v2', 'LACUNE: manca ancora il file\nVERDETTO: da integrare')
  const text = state.files.get(FILE) ?? ''
  expect(text).toContain('status: validated')
  expect(text).toContain('rounds: 2')
  expect(text).toContain('## Lacune segnalate dal validatore')
  expect(text).toContain('manca ancora il file')
  expect(state.sends.length).toBe(1)
})

test('il validatore non riceve note di zona: sta in ownAgents', async ($, on) => {
  const state = world(on, teammate)
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  expect((await step($, state, 450_000, 'v1')).length).toBe(0)
})
