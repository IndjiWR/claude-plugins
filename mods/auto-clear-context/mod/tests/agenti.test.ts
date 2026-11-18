import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Il file dal punto in cui comincia la cartella dell'handoff, qualunque sia la radice.
const fileKey = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  const at = slashed.indexOf('.claude/handoff')
  return at < 0 ? slashed : slashed.slice(at)
}

// Un tool qualsiasi della principale o di un agente: le note durante il turno arrivano nel suo `context`.
const bash = (agentId?: string) => ({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) }) as never

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
const world = (
  on: On,
  agents: readonly object[] = [{ id: 'a1', type: 'general-purpose', description: 'x', status: 'running' }],
  store: Record<string, unknown> = {},
) => {
  mock.store(on, store)
  const clock = mock.clock(on, { now: 1_000_000 })
  const state = {
    clock,
    commands: [] as string[],
    toasts: [] as string[],
    tokens: 0 as number | null,
    files: new Map<string, string>(),
    // Ora di modifica di ogni file (fs.list): cresce a ogni scrittura.
    mtimes: new Map<string, number>(),
    writes: 0,
    // Il motore di prova non dà id né teammateId dello spawn: il rilancio ($.agent.spawn con name) compare
    // in agent.list, come teammate se isSpawnTeammate, altrimenti senza teammateId.
    isSpawnTeammate: true,
    spawnedAgents: [] as object[],
    // L'id della principale (cambia col /clear) e un'azione da fare alla prossima lettura di un file.
    session: 's1',
    beforeRead: undefined as { key: string; action: () => Promise<unknown> } | undefined,
    spawns: [] as { subagentType?: string; prompt: string; name?: string; description?: string; model?: string }[],
    logs: [] as string[],
    throws: new Set<string>(),
    // Se impostato, la risposta del fondo di tool.call di Agent (un teammate avviato dal modello).
    agentRecord: undefined as object | undefined,
    agentCalls: 0,
    sends: [] as { to: unknown; text: string }[],
    // Ogni tool.call che arriva al fondo, in ordine; `denied` rifiuta il tool con quel motivo.
    toolCalls: [] as Record<string, unknown>[],
    denied: new Map<string, string>(),
    // Se impostato, il context che il fondo di tool.call restituisce già.
    bottomContext: undefined as string[] | undefined,
    // Tool che finiscono con isError (senza deny).
    errored: new Set<string>(),
    // Letture di ogni file: tryClear rilegge l'handoff della principale a ogni controllo.
    reads: new Map<string, number>(),
    prompts: [] as string[],
  }
  on('session.id', () => ({ value: state.session }))
  on('session.root', () => ({ value: 'C:/progetto' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 0, percent: 0 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: [...agents, ...state.spawnedAgents] as never }))
  on('fs.read', async (_, e) => {
    const hook = state.beforeRead
    if (hook?.key === fileKey(e.path)) {
      state.beforeRead = undefined
      await hook.action()
    }
    state.reads.set(fileKey(e.path), (state.reads.get(fileKey(e.path)) ?? 0) + 1)
    // I file del plugin (chiave «plugin:/skills/…»): letti sotto la sua radice, qualunque sia.
    const own = [...state.files.entries()].find(([key]) => key.startsWith('plugin:') && e.path.replace(/\\/g, '/').endsWith(key.slice('plugin:'.length)))
    const text = state.files.get(fileKey(e.path)) ?? own?.[1]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    state.files.set(fileKey(e.path), e.text)
    state.mtimes.set(fileKey(e.path), ++state.writes)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = `${fileKey(e.path).replace(/\/+$/, '')}/`
    const entries = [...state.files.entries()]
      .filter(([key]) => key.startsWith(dir) && !key.slice(dir.length).includes('/'))
      .map(([key, text]) => ({ name: key.slice(dir.length), kind: 'file', size: text.length, mtimeMs: state.mtimes.get(key) ?? 0, isLink: false }))
    return { value: entries as never }
  })
  // $.agent.spawn della mod: l'input arriva nella forma del tool Agent (subagent_type). Il motore di prova
  // non dà l'id dell'agente avviato: la mod lo trova in agent.list, dove stanno i validatori v1 e v2.
  on('agent.spawn', (_, e) => {
    const call = e as unknown as { prompt: string; subagent_type?: string; name?: string; description?: string; model?: string }
    const refusal = state.denied.get('agent.spawn')
    if (refusal !== undefined) return { deny: refusal } as never
    state.spawns.push({ subagentType: call.subagent_type, prompt: call.prompt, name: call.name, description: call.description, model: call.model })
    if (call.name !== undefined) {
      const listed = { id: `n${state.spawns.length}`, name: call.name, type: 'general-purpose', description: 'r', status: 'running' }
      state.spawnedAgents.push(state.isSpawnTeammate ? { ...listed, teammateId: `${call.name}@t` } : listed)
    }
    return { model: 'm' }
  })
  // Il fondo di tool.call di Agent: la risposta di un teammate avviato dal modello, se impostata.
  on('tool.call', (_, e) => {
    state.agentCalls++
    state.toolCalls.push(e as unknown as Record<string, unknown>)
    if (state.throws.has(e.tool)) throw new Error(`${e.tool} è esploso`)
    const denial = state.denied.get(e.tool)
    if (denial !== undefined) return { deny: denial } as never
    if (state.errored.has(e.tool)) return { result: undefined, isError: true, text: 'spawn fallito' } as never
    const answer = { result: state.agentRecord, text: 'ok' }
    return (state.bottomContext === undefined ? answer : { ...answer, context: state.bottomContext }) as never
  })
  on('prompt.submit', (_, e) => {
    state.prompts.push(e.text)
    return { text: e.text } as never
  })
  on('session.send', (_, e) => {
    state.sends.push({ to: e.to, text: e.text })
    return { isDelivered: true } as never
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
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', (_, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => {
    if (e.agentId === undefined && state.throws.has('turn.complete')) throw new Error('fine turno esplosa')
    return { text: e.answer }
  })
  on('turn.step', async function* () {
    return stepResult(state.tokens === null ? null : usageOf(state.tokens))
  })
  return state
}

// Un passo dell'agente con `tokens` di contesto, poi un suo tool: le note che porta.
const step = async ($: Engine, state: { tokens: number | null }, tokens: number | null, agentId = 'a1') => {
  state.tokens = tokens
  const it = $.turn.step(stepInput(agentId))
  while (!(await it.next()).done);
  return (await $.tool.call(bash(agentId))).context ?? []
}

test('subagent: una nota per zona, col percorso dell handoff', async ($, on) => {
  const state = world(on)
  const [soft, ...rest] = await step($, state, 125_000)
  expect(rest.length).toBe(0)
  expect(soft).toContain('s1--a1.md')
  expect(soft).toContain('Zona morbida')
  expect(soft).toContain('general-purpose')
  expect((await step($, state, 130_000)).length).toBe(0)
  const [hard] = await step($, state, 155_000)
  expect(hard).toContain('Zona dura')
})

test('teammate: la nota chiede status ready e non lancia il validatore', async ($, on) => {
  const state = world(on, [{ id: 'a1', teammateId: 'pose@t', type: 'general-purpose', description: 'x', status: 'running' }])
  const [note] = await step($, state, 125_000)
  expect(note).toContain('s1--a1.md')
  expect(note).toContain('status: ready')
  expect(note).toContain('Non lanciare il validatore')
  expect(note).toContain('mode: pausa')
})

const skillSrc = ['## Formato', '', 'Ogni sezione è obbligatoria.', '', '```markdown', '---', 'status: draft', 'session: x', '---', '## Prossimo passo immediato', '<una sola azione>', '```'].join('\n')
const validatorSrc = ['Controlla questi punti:', '', '1. **Prossimo passo immediato**: una sola azione concreta.', '', 'Rispondi esattamente con queste sezioni:'].join('\n')

test('teammate: la nota porta il modello letto da skill e validatore del plugin', async ($, on) => {
  const state = world(on, [{ id: 'a1', teammateId: 'pose@t', type: 'general-purpose', description: 'x', status: 'running' }])
  state.files.set('plugin:/skills/handoff/SKILL.md', skillSrc)
  state.files.set('plugin:/agents/handoff-validator.md', validatorSrc)
  const [note] = await step($, state, 125_000)
  expect(note).toContain('modello qui sotto')
  expect(note).toContain('## Prossimo passo immediato\n<una sola azione>')
  expect(note).toContain('agent: a1')
  expect(note).toContain('1. **Prossimo passo immediato**: una sola azione concreta.')
})

test('teammate: senza le fonti del plugin la nota rimanda alla skill', async ($, on) => {
  const state = world(on, [{ id: 'a1', teammateId: 'pose@t', type: 'general-purpose', description: 'x', status: 'running' }])
  const [note] = await step($, state, 125_000)
  expect(note).toContain('nel formato della skill auto-clear-context:handoff')
})

test('dopo un /clear della principale (id nuovo) l agente tiene percorso e zone già segnalate', async ($, on) => {
  const state = world(on)
  const [first] = await step($, state, 125_000)
  expect(first).toContain('.claude/handoff/pending/s1--a1.md')
  state.session = 's2'
  expect((await step($, state, 125_000)).length).toBe(0)
  const [hard] = await step($, state, 155_000)
  expect(hard).toContain('.claude/handoff/pending/s1--a1.md')
})

test('subagent breve: sotto la morbida nessuna nota', async ($, on) => {
  const state = world(on)
  expect((await step($, state, 100_000)).length).toBe(0)
})

test('agente assente da agent.list: nessuna nota', async ($, on) => {
  const state = world(on)
  expect((await step($, state, 125_000, 'zz')).length).toBe(0)
})

test('turn.step senza usage: nessuna nota, nessun errore', async ($, on) => {
  const state = world(on)
  expect((await step($, state, null)).length).toBe(0)
})

test('opzione agents false: nessuna nota', { options: { agents: false } }, async ($, on) => {
  const state = world(on)
  expect((await step($, state, 125_000)).length).toBe(0)
})

test('soglie di default in token: 119k niente, 125k zona morbida', async ($, on) => {
  const state = world(on)
  expect((await step($, state, 119_000)).length).toBe(0)
  const [note] = await step($, state, 125_000)
  expect(note).toContain('Zona morbida')
})

test('soglie degli agenti indipendenti dalla principale', { options: { threshold: 20 } }, async ($, on) => {
  const state = world(on)
  const [note] = await step($, state, 160_000)
  expect(note).toContain('Zona dura')
})

test('agentSoftTokens/agentHardTokens: soglie proprie', { options: { agentSoftTokens: 50000, agentHardTokens: 80000 } }, async ($, on) => {
  const state = world(on)
  const [note] = await step($, state, 60_000)
  expect(note).toContain('soglie 50k/80k')
})

test('monitor spento (morbida 0): nessuna nota agli agenti', { options: { threshold: 0 } }, async ($, on) => {
  const state = world(on)
  expect((await step($, state, 125_000)).length).toBe(0)
})

test('subagent: la nota si aggiunge al context già restituito dal fondo', async ($, on) => {
  const state = world(on)
  state.bottomContext = ['dal fondo']
  const [first, note, ...rest] = await step($, state, 125_000)
  expect(first).toBe('dal fondo')
  expect(note).toContain('s1--a1.md')
  expect(rest.length).toBe(0)
})

test('subagent: tool rifiutato, il deny passa intatto e la nota resta per il tool dopo', async ($, on) => {
  const state = world(on)
  state.tokens = 125_000
  const it = $.turn.step(stepInput('a1'))
  while (!(await it.next()).done);
  state.denied.set('Bash', 'vietato')
  const result = await $.tool.call(bash('a1'))
  expect(result.deny).toBe('vietato')
  expect(result.context).toBe(undefined)
  state.denied.delete('Bash')
  expect((await $.tool.call(bash('a1'))).context?.join(' ') ?? '').toContain('s1--a1.md')
})

test('la principale senza agent_id non riceve note dai passi degli agenti', async ($, on) => {
  const state = world(on)
  state.tokens = 125_000
  const it = $.turn.step(stepInput('a1'))
  while (!(await it.next()).done);
  const result = await $.tool.call(bash())
  expect(result.context ?? []).toEqual([])
})

// Validazione dell'handoff di un teammate.
const FILE = '.claude/handoff/pending/s1--a1.md'
const validator = (id: string) => ({ id, type: 'auto-clear-context:handoff-validator', description: 'v', status: 'running' })
const teammate = [{ id: 'a1', teammateId: 'pose@t', type: 'general-purpose', description: 'x', status: 'running' }, validator('v1'), validator('v2')]
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
  // Modello esplicito: senza, il validatore eredita quello del lead (Opus).
  expect(state.spawns[0]?.model).toBe('sonnet')
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

test('handoff riscritto durante la validazione: nuova validazione subito', async ($, on) => {
  const state = world(on, teammate)
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  expect(state.spawns.length).toBe(1)
  // il teammate riscrive l'handoff mentre v1 lavora; il suo fine turno è bloccato da `checking`
  state.files.set(FILE, ready().replace('Fare x.', 'Fare y.'))
  await turnEnd($, 'a1')
  expect(state.spawns.length).toBe(1)
  await turnEnd($, 'v1', 'LACUNE: nessuna\nVERDETTO: completo')
  expect(state.files.get(FILE)).not.toContain('status: validated')
  expect(state.spawns.length).toBe(2)
  expect(state.toolCalls.filter(c => c.tool === 'TaskStop').length).toBe(0)
})

test('handoff cancellato durante la validazione: nessun rilancio', async ($, on) => {
  const state = world(on, teammate)
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  state.files.delete(FILE)
  await turnEnd($, 'v1', 'LACUNE: nessuna\nVERDETTO: completo')
  expect(state.spawns.length).toBe(1)
  expect(state.toolCalls.filter(c => c.tool === 'TaskStop').length).toBe(0)
  expect(state.logs.join('\n')).toContain('handoff del teammate a1 rimosso durante la validazione: nessun rilancio')
})

test('il validatore non riceve note di zona: sta in ownAgents', async ($, on) => {
  const state = world(on, teammate)
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  expect((await step($, state, 125_000, 'v1')).length).toBe(0)
})

test('validatore annullato: il turno successivo del teammate rilancia la validazione, stesso giro', async ($, on) => {
  const state = world(on, teammate)
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  expect(state.spawns.length).toBe(1)
  await $.turn.complete({ ...(done('v1') as object), isAborted: true, reason: 'aborted' } as never)
  expect(state.files.get(FILE)).toContain('status: ready')
  await turnEnd($, 'a1')
  expect(state.spawns.length).toBe(2)
  await turnEnd($, 'v2', 'LACUNE: nessuna\nVERDETTO: completo')
  expect(state.files.get(FILE)).toContain('status: validated')
  expect(state.files.get(FILE)).toContain('rounds: 1')
})

test('tool.call di Agent: se $.state.set lancia, il risultato passa e il teammate non è lanciato due volte', async ($, on) => {
  const state = world(on)
  state.agentRecord = { status: 'teammate_spawned', agentId: 'a1', agent_id: 'a1', teammate_id: 'pose@t', name: 'pose', prompt: 'x' }
  on('state.set', () => {
    throw new Error('stato non scrivibile')
  })
  const result = await $.tool.call({ tool: 'Agent', name: 'pose', description: 'posa', prompt: 'x' } as never)
  expect(result.deny).toBeUndefined()
  expect(state.agentCalls).toBe(1)
})

// Stop e rilancio del teammate. Il motore non lascia a un plugin il tool Agent via $.tool.call:
// il rilancio passa da TaskStop (tool.call) e da $.agent.spawn.
const idleMate = () => [
  { id: 'a1', teammateId: 'pose@t', type: 'general-purpose', description: 'x', status: 'idle' },
  validator('v1'),
  validator('v2'),
]
// Lascia correre le promesse non attese (il prompt alla principale parte senza await).
const pause = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}
const toolsCalled = (state: { toolCalls: Record<string, unknown>[] }) => state.toolCalls.map(call => call.tool)
const archived = (state: { files: Map<string, string> }) => [...state.files.keys()].filter(key => key.startsWith('.claude/handoff/archive/'))
// I rilanci: gli spawn che non sono validatori.
const restarted = (state: { spawns: { subagentType?: string; prompt: string; name?: string; description?: string }[] }) =>
  state.spawns.filter(spawn => spawn.subagentType !== 'auto-clear-context:handoff-validator')

// Il teammate `a1` avviato dal modello (input registrato in $.state).
const launched = async ($: Engine, state: ReturnType<typeof world>) => {
  state.agentRecord = { status: 'teammate_spawned', agentId: 'a1', agent_id: 'a1', teammate_id: 'pose@t', name: 'pose', prompt: 'x' }
  await $.tool.call({ tool: 'Agent', name: 'pose', subagent_type: 'general-purpose', model: 'haiku', description: 'posa', prompt: 'x' } as never)
  state.toolCalls.length = 0
}
// Un handoff pronto e il verdetto "completo" del validatore.
const validate = async ($: Engine, state: ReturnType<typeof world>, text = ready(), validatorId = 'v1') => {
  state.files.set(FILE, text)
  await turnEnd($, 'a1')
  await turnEnd($, validatorId, 'LACUNE: nessuna\nVERDETTO: completo')
}

test('handoff validato, teammate idle: TaskStop, poi rilancio con l input originale e l handoff; pending vuoto, copia in archive', async ($, on) => {
  const state = world(on, idleMate())
  await launched($, state)
  await validate($, state)
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(state.toolCalls[0]).toMatchObject({ task_id: 'a1' })
  const [call, ...others] = restarted(state)
  expect(others.length).toBe(0)
  expect(call).toMatchObject({ name: 'pose', subagentType: 'general-purpose', description: 'posa' })
  expect(call?.prompt).toContain('Fare x.')
  expect(state.files.get(FILE)).toBe('')
  const [copy, ...rest] = archived(state)
  expect(rest.length).toBe(0)
  expect(state.files.get(copy ?? '')).toContain('status: validated')
  expect(call?.prompt).toContain(copy ?? 'nessuna copia')
  expect(state.prompts.length).toBe(0)
})

test('handoff di pausa validato, teammate idle: TaskStop e copia in archive, nessun rilancio né prompt al lead', async ($, on) => {
  const state = world(on, idleMate())
  await launched($, state)
  await validate($, state, ready('mode: pausa\n'))
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(state.toolCalls[0]).toMatchObject({ task_id: 'a1' })
  expect(restarted(state).length).toBe(0)
  expect(state.files.get(FILE)).toBe('')
  const [copy, ...rest] = archived(state)
  expect(rest.length).toBe(0)
  expect(state.files.get(copy ?? '')).toContain('mode: pausa')
  await pause()
  expect(state.prompts.length).toBe(0)
  // Un altro fine turno non rilancia: il file è vuoto.
  await turnEnd($, 'a1')
  expect(restarted(state).length).toBe(0)
})

test('senza input registrato: spawn con name, tipo e description della lista', async ($, on) => {
  const state = world(on, idleMate())
  await validate($, state)
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  const [call, ...others] = restarted(state)
  expect(others.length).toBe(0)
  expect(call).toMatchObject({ name: 'pose', subagentType: 'general-purpose', description: 'x' })
  expect(call?.prompt).toContain('Fare x.')
  expect(state.files.get(FILE)).toBe('')
})

test('il teammate rilanciato torna sotto il monitor, il validatore no; le mappe del vecchio id sono ripulite', async ($, on) => {
  const list: object[] = idleMate()
  const state = world(on, list)
  await launched($, state)
  // Contesto alto di a1 registrato dal turn.step, senza che la nota sia ancora uscita.
  state.tokens = 125_000
  const it = $.turn.step(stepInput('a1'))
  while (!(await it.next()).done);
  await validate($, state)
  expect(restarted(state).length).toBe(1)
  // a1 è fermato: il suo contesto è stato dimenticato, nessuna nota.
  expect((await $.tool.call(bash('a1'))).context ?? []).toEqual([])
  // Il nuovo teammate è in elenco e viene misurato; il validatore resta escluso.
  list.push({ id: 'a2', teammateId: 'pose@t', type: 'general-purpose', description: 'posa', status: 'running' })
  const [note] = await step($, state, 125_000, 'a2')
  expect(note).toContain('s1--a2.md')
  expect((await step($, state, 125_000, 'v1')).length).toBe(0)
})

test('lo stesso handoff non si rilancia due volte', async ($, on) => {
  const state = world(on, idleMate())
  await launched($, state)
  await validate($, state)
  expect(restarted(state).length).toBe(1)
  // Il teammate (ancora in elenco) riscrive lo stesso identico file validato.
  state.files.set(FILE, state.files.get(archived(state)[0] ?? '') ?? '')
  await turnEnd($, 'a1')
  expect(restarted(state).length).toBe(1)
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(state.logs.some(line => line.includes('ha già avuto il suo rilancio'))).toBe(true)
})

test('oltre maxClearsPerHour rilanci di a1 nell ora: nessun rilancio e una riga di log', { options: { maxClearsPerHour: 1 } }, async ($, on) => {
  const state = world(on, idleMate())
  await launched($, state)
  await validate($, state)
  expect(restarted(state).length).toBe(1)
  await validate($, state, ready('extra: 1\n'), 'v2')
  expect(restarted(state).length).toBe(1)
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(state.files.get(FILE)).toContain('status: validated')
  expect(state.logs.some(line => line.includes('limite di 1 rilanci'))).toBe(true)
})

test('teammate tornato running: nessun rilancio ora, al suo prossimo turn.complete sì', async ($, on) => {
  const list = idleMate()
  const state = world(on, list)
  await launched($, state)
  Object.assign(list[0] ?? {}, { status: 'running' })
  await validate($, state)
  expect(toolsCalled(state)).toEqual([])
  expect(restarted(state).length).toBe(0)
  expect(state.files.get(FILE)).toContain('status: validated')
  Object.assign(list[0] ?? {}, { status: 'idle' })
  await turnEnd($, 'a1')
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(restarted(state).length).toBe(1)
  expect(state.files.get(FILE)).toBe('')
})

test('teammate ancora running in lista al suo turn.complete: è fermo, il rilancio parte', async ($, on) => {
  const list = idleMate()
  const state = world(on, list)
  await launched($, state)
  Object.assign(list[0] ?? {}, { status: 'running' })
  // Il validatore finisce mentre il teammate lavora: rilancio rimandato (stato letto da un altro evento).
  await validate($, state)
  expect(restarted(state).length).toBe(0)
  // Il turn.complete del teammate: la lista dice ancora running, ma il turno è finito.
  await turnEnd($, 'a1')
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(restarted(state).length).toBe(1)
  expect(state.files.get(FILE)).toBe('')
})

test('handoff già validated al turn.complete del teammate ancora running in lista: rilancio subito', async ($, on) => {
  const list = idleMate()
  const state = world(on, list)
  await launched($, state)
  Object.assign(list[0] ?? {}, { status: 'running' })
  state.files.set(FILE, ready().replace('status: ready', 'status: validated'))
  await turnEnd($, 'a1')
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(restarted(state).length).toBe(1)
})

test('handoff scritto col percorso di una principale precedente (prima del /clear): validato e rilanciato', async ($, on) => {
  const state = world(on, idleMate())
  await launched($, state)
  const old = '.claude/handoff/pending/s0--a1.md'
  state.files.set(old, ready())
  await turnEnd($, 'a1')
  expect(state.spawns[0]?.prompt).toContain('s0--a1.md')
  await turnEnd($, 'v1', 'LACUNE: nessuna\nVERDETTO: completo')
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(restarted(state).length).toBe(1)
  expect(state.files.get(old)).toBe('')
})

test('rilanciato fuori dal team (nessun teammateId): log, toast e un solo prompt alla principale', async ($, on) => {
  const state = world(on, idleMate())
  await launched($, state)
  state.isSpawnTeammate = false
  await validate($, state)
  await pause()
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(restarted(state).length).toBe(1)
  expect(state.prompts.length).toBe(1)
  expect(state.prompts[0]).toContain('non risulta un teammate')
  expect(state.prompts[0]).toContain('s1--a1.md')
  expect(state.toasts.some(toast => toast.includes('fuori dal team'))).toBe(true)
  expect(state.logs.some(line => line.includes('non risulta un teammate'))).toBe(true)
  expect(state.files.get(FILE)).toContain('status: validated')
  await turnEnd($, 'a1')
  await pause()
  expect(state.prompts.length).toBe(1)
  expect(restarted(state).length).toBe(1)
})

test('TaskStop rifiutato: nessun rilancio, un prompt alla principale, un secondo turn.complete non ne manda altri', async ($, on) => {
  const state = world(on, idleMate())
  await launched($, state)
  state.denied.set('TaskStop', 'permesso negato')
  await validate($, state)
  await pause()
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(restarted(state).length).toBe(0)
  expect(state.prompts.length).toBe(1)
  expect(state.prompts[0]).toContain('pose')
  expect(state.prompts[0]).toContain('permesso negato')
  expect(state.prompts[0]).toContain('s1--a1.md')
  expect(state.files.get(FILE)).toContain('status: validated')
  await turnEnd($, 'a1')
  await pause()
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(state.prompts.length).toBe(1)
})

test('spawn del rilancio rifiutato: un solo prompt alla principale, il file resta validated', async ($, on) => {
  const state = world(on, idleMate())
  await launched($, state)
  state.files.set(FILE, ready())
  await turnEnd($, 'a1')
  state.denied.set('agent.spawn', 'limite di agenti')
  await turnEnd($, 'v1', 'LACUNE: nessuna\nVERDETTO: completo')
  await pause()
  expect(toolsCalled(state)).toEqual(['TaskStop'])
  expect(state.prompts.length).toBe(1)
  expect(state.prompts[0]).toContain('limite di agenti')
  expect(state.files.get(FILE)).toContain('status: validated')
  await turnEnd($, 'a1')
  await pause()
  expect(state.prompts.length).toBe(1)
})

test('TaskStop che lancia: un solo prompt alla principale, nessun rilancio', async ($, on) => {
  const state = world(on, idleMate())
  await launched($, state)
  state.throws.add('TaskStop')
  await validate($, state)
  await pause()
  expect(restarted(state).length).toBe(0)
  expect(state.prompts.length).toBe(1)
  expect(state.files.get(FILE)).toContain('status: validated')
})

test('catena di rilanci a1, a2, a3 dello stesso teammate: oltre maxClearsPerHour il successivo non parte', { options: { maxClearsPerHour: 2 } }, async ($, on) => {
  const list: object[] = [...idleMate(), validator('v3')]
  const state = world(on, list)
  const mate = (id: string) => ({ id, teammateId: 'pose@t', type: 'general-purpose', description: 'x', status: 'idle' })
  // Ogni rilancio dà un id nuovo (qui messo in elenco a mano) ma lo stesso name: il conteggio è del teammate.
  const hop = async (from: string, text: string) => {
    state.files.set(`.claude/handoff/pending/s1--${from}.md`, text)
    await turnEnd($, from)
    await turnEnd($, `v${from.slice(1)}`, 'LACUNE: nessuna\nVERDETTO: completo')
  }
  await hop('a1', ready('n: 1\n'))
  expect(restarted(state).length).toBe(1)
  list.push(mate('a2'))
  await hop('a2', ready('n: 2\n').replace('agent: a1', 'agent: a2'))
  expect(restarted(state).length).toBe(2)
  list.push(mate('a3'))
  state.spawns.length = 0
  state.toolCalls.length = 0
  await hop('a3', ready('n: 3\n').replace('agent: a1', 'agent: a3'))
  expect(restarted(state).length).toBe(0)
  expect(toolsCalled(state)).toEqual([])
  expect(state.files.get('.claude/handoff/pending/s1--a3.md')).toContain('status: validated')
  expect(state.logs.some(line => line.includes('limite di 2 rilanci'))).toBe(true)
})

// Clear della principale con agenti attivi.
const MAIN_FILE = '.claude/handoff/pending/s1.md'
const MAIN_VALIDATED = '---\nstatus: validated\nsession: s1\nrounds: 1\n---\n# Handoff\n\n## Prossimo passo immediato\nFare y.\n'
const mainDone = (turnId = 'm1') => ({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as never
const mainStart = (turnId = 'm1') => ({ text: 'x', turnId }) as never
const running = () => [{ id: 'a1', type: 'general-purpose', description: 'x', status: 'running' }, validator('v1')]
const settled = async () => {
  for (let turn = 0; turn < 5; turn++) await pause()
}

test('principale con handoff validato e agente running: niente clear, una nota di pausa; poi l agente si ferma e il clear parte', async ($, on) => {
  const list = running()
  const state = world(on, list)
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  expect(state.commands).toEqual([])
  const [first, ...rest] = (await $.tool.call(bash('a1'))).context ?? []
  expect(rest.length).toBe(0)
  expect(first).toContain('la sessione principale riparte')
  expect((await $.tool.call(bash('a1'))).context ?? []).toEqual([])
  Object.assign(list[0] ?? {}, { status: 'idle' })
  await $.turn.complete(done('a1'))
  await settled()
  expect(state.commands).toEqual(['clear'])
  await $.turn.complete(done('a1'))
  await settled()
  expect(state.commands).toEqual(['clear'])
})

test('l ultimo agente risulta ancora running al suo turn.complete: il clear parte lo stesso', async ($, on) => {
  const state = world(on, running())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  expect(state.commands).toEqual([])
  await $.turn.complete(done('a1'))
  await settled()
  expect(state.commands).toEqual(['clear'])
})

test('principale ripartita durante il controllo del clear: nessun /clear, parte alla sua fine turno', async ($, on) => {
  const list = running()
  const state = world(on, list)
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  // Un prompt dell'utente fa ripartire la principale mentre tryClear legge l'handoff (dopo il controllo iniziale).
  let isFired = false
  state.beforeRead = {
    key: MAIN_FILE,
    action: async () => {
      isFired = true
      await $.turn.start(mainStart('m2'))
    },
  }
  await $.turn.complete(done('a1'))
  await settled()
  expect(isFired).toBe(true)
  expect(state.commands).toEqual([])
  expect(state.logs.some(line => line.includes('eseguo /clear'))).toBe(false)
  Object.assign(list[0] ?? {}, { status: 'idle' })
  await $.turn.complete(mainDone('m2'))
  await settled()
  expect(state.commands).toEqual(['clear'])
})

test('fine turno della principale che lancia: la principale non resta in un turno, il clear parte dall agente', async ($, on) => {
  const list = running()
  const state = world(on, list)
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.start(mainStart())
  state.throws.add('turn.complete')
  let error: unknown
  await $.turn.complete(mainDone()).catch((caught: unknown) => (error = caught))
  expect(error).toBeDefined()
  state.throws.delete('turn.complete')
  await $.turn.complete(done('a1'))
  await settled()
  expect(state.commands).toEqual(['clear'])
})

test('handoff della principale con agent: nel frontmatter (scritto da un agente): nessun clear', async ($, on) => {
  const state = world(on, idleMate())
  state.files.set(MAIN_FILE, MAIN_VALIDATED.replace('session: s1\n', 'session: s1\nagent: a1\n'))
  await $.turn.complete(mainDone())
  await settled()
  expect(state.commands).toEqual([])
  expect(state.logs.some(line => line.includes("è l'handoff di un agente"))).toBe(true)
})

test('il teammate idle e il validatore della mod non fanno rimandare il clear', async ($, on) => {
  const state = world(on, [...idleMate(), { id: 'v9', type: 'auto-clear-context:handoff-validator', description: 'v', status: 'running' }])
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  expect(state.commands).toEqual(['clear'])
})

test('principale in un turno: il turn.complete di un agente non avvia il clear', async ($, on) => {
  const list = running()
  const state = world(on, list)
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await $.turn.start(mainStart('m2'))
  Object.assign(list[0] ?? {}, { status: 'idle' })
  await $.turn.complete(done('a1'))
  await settled()
  expect(state.commands).toEqual([])
  await $.turn.complete(mainDone('m2'))
  await settled()
  expect(state.commands).toEqual(['clear'])
})

test('turn.complete di un agente senza handoff della principale: nessun clear', async ($, on) => {
  const state = world(on, idleMate())
  await $.turn.complete(done('a1'))
  await settled()
  expect(state.commands).toEqual([])
})

test('dopo 20 minuti di rinvio un solo avviso, senza forzare il clear', async ($, on) => {
  // a2 resta running: il turn.complete di a1 alla fine non libera il clear.
  const state = world(on, [...running(), { id: 'a2', type: 'general-purpose', description: 'y', status: 'running' }])
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await $.tool.call(bash('a1'))
  expect(state.toasts).toEqual([])
  await state.clock.advance(19 * 60_000)
  await $.tool.call(bash('a1'))
  expect(state.toasts).toEqual([])
  await state.clock.advance(2 * 60_000)
  await $.tool.call(bash('a1'))
  await settled()
  expect(state.toasts.length).toBe(1)
  expect(state.toasts[0]).toContain('clear rimandato da 21 minuti')
  expect(state.logs.filter(line => line.includes('clear rimandato da 21 minuti')).length).toBe(1)
  await $.tool.call(bash('a1'))
  await $.turn.complete(done('a1'))
  await settled()
  expect(state.toasts.length).toBe(1)
  expect(state.commands).toEqual([])
})

test('opzione agents false: gli agenti non ricevono la nota di pausa', { options: { agents: false } }, async ($, on) => {
  const state = world(on, running())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  expect((await $.tool.call(bash('a1'))).context ?? []).toEqual([])
})

// Agenti dati attivi ma senza attività: non trattengono il clear oltre agentStaleMinutes.
const staleLogs = (state: { logs: string[] }) => state.logs.filter(line => line.includes('senza attività da'))

test('agente running senza attività da 30 minuti: log una volta e il clear parte dal timer, senza fini turno', async ($, on) => {
  const state = world(on, running())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  expect(state.commands).toEqual([])
  await state.clock.advance(30 * 60_000)
  await settled()
  expect(state.commands).toEqual(['clear'])
  const lines = staleLogs(state)
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain('senza attività da 30 minuti')
})

test('agente con attività recente non è stantio', async ($, on) => {
  const state = world(on, running())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  await state.clock.advance(25 * 60_000)
  const it = $.turn.step(stepInput('a1'))
  while (!(await it.next()).done);
  await state.clock.advance(10 * 60_000)
  await settled()
  expect(state.commands).toEqual([])
  expect(staleLogs(state)).toEqual([])
})

test('agentStaleMinutes 0: nessuna scadenza', { options: { agentStaleMinutes: 0 } }, async ($, on) => {
  const state = world(on, running())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  await state.clock.advance(60 * 60_000)
  await settled()
  expect(state.commands).toEqual([])
  expect(staleLogs(state)).toEqual([])
})

test('timer con la principale in un turno: niente clear, parte alla sua fine turno', async ($, on) => {
  const state = world(on, running())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await $.turn.start(mainStart('m2'))
  await state.clock.advance(30 * 60_000)
  await settled()
  expect(state.commands).toEqual([])
  await $.turn.complete(mainDone('m2'))
  await settled()
  expect(state.commands).toEqual(['clear'])
})

// Handoff di un subagent ripreso dalla principale con un nuovo Agent.
const SUB_FILE = '.claude/handoff/pending/s1--a7.md'
const resumeCall = (path: string) =>
  ({ tool: 'Agent', subagent_type: 'general-purpose', description: 'ripresa', prompt: `Riprendi dall'handoff ${path} (repo C:/progetto)` }) as never
const resumedLogs = (state: { logs: string[] }) => state.logs.filter(line => line.includes('ripreso: segnato resumed'))

// Il file in pending/ resta leggibile (il subagent ripreso può leggerlo dopo che next si risolve), segnato resumed.
test("Agent con «Riprendi dall'handoff» di un subagent: pending segnato resumed col suo testo, copia in archive, una riga di log", async ($, on) => {
  const state = world(on)
  state.files.set(SUB_FILE, ready().replace('agent: a1', 'agent: a7'))
  const result = await $.tool.call(resumeCall(SUB_FILE))
  await settled()
  expect(result.deny).toBeUndefined()
  expect(state.agentCalls).toBe(1)
  expect(state.files.get(SUB_FILE)).toContain('status: resumed')
  expect(state.files.get(SUB_FILE)).toContain('Fare x.')
  const [copy, ...rest] = archived(state)
  expect(rest.length).toBe(0)
  expect(state.files.get(copy ?? '')).toContain('status: resumed')
  expect(state.files.get(copy ?? '')).toContain('Fare x.')
  const lines = resumedLogs(state)
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain(`handoff dell'agente a7 ripreso: segnato resumed, copia in ${copy}`)
})

test("Agent rifiutato (deny): l'handoff resta in pending", async ($, on) => {
  const state = world(on)
  const text = ready().replace('agent: a1', 'agent: a7')
  state.files.set(SUB_FILE, text)
  state.denied.set('Agent', 'no')
  const result = await $.tool.call(resumeCall(SUB_FILE))
  await settled()
  expect(result.deny).toBeDefined()
  expect(state.agentCalls).toBe(1)
  expect(state.files.get(SUB_FILE)).toBe(text)
  expect(archived(state)).toEqual([])
  expect(resumedLogs(state)).toEqual([])
})

test('prompt con handoff della principale o file inesistente: nessuna archiviazione, nessun errore', async ($, on) => {
  const state = world(on)
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  const main = await $.tool.call(resumeCall(MAIN_FILE))
  const missing = await $.tool.call(resumeCall('.claude/handoff/pending/s1--zz.md'))
  await settled()
  expect(main.deny).toBeUndefined()
  expect(missing.deny).toBeUndefined()
  expect(state.agentCalls).toBe(2)
  expect(state.files.get(MAIN_FILE)).toBe(MAIN_VALIDATED)
  expect(archived(state)).toEqual([])
  expect(resumedLogs(state)).toEqual([])
})

test("Agent finito con isError: l'handoff resta in pending con status ready", async ($, on) => {
  const state = world(on)
  const text = ready().replace('agent: a1', 'agent: a7')
  state.files.set(SUB_FILE, text)
  state.errored.add('Agent')
  const result = await $.tool.call(resumeCall(SUB_FILE))
  await settled()
  expect(result.isError).toBe(true)
  expect(state.agentCalls).toBe(1)
  expect(state.files.get(SUB_FILE)).toBe(text)
  expect(archived(state)).toEqual([])
  expect(resumedLogs(state)).toEqual([])
})

// Timer della scadenza: i controlli che fa si vedono come letture dell'handoff della principale.
const mainReads = (state: { reads: Map<string, number> }) => state.reads.get(MAIN_FILE) ?? 0
const twoRunning = () => [...running(), { id: 'a2', type: 'general-purpose', description: 'y', status: 'running' }]
const agentStep = async ($: Engine, agentId: string) => {
  const it = $.turn.step(stepInput(agentId))
  while (!(await it.next()).done);
}

test('agente stantio che torna attivo trattiene di nuovo il clear e può essere riloggato', async ($, on) => {
  const state = world(on, twoRunning())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await state.clock.advance(20 * 60_000)
  await agentStep($, 'a2')
  // A 30 minuti a1 è stantio, a2 no.
  await state.clock.advance(10 * 60_000)
  await settled()
  const a1Logs = () => state.logs.filter(line => line.includes('agente a1 senza attività'))
  expect(a1Logs().length).toBe(1)
  expect(state.commands).toEqual([])
  // a1 torna attivo a 35: a 50 scade a2, a1 trattiene ancora il clear fino a 65.
  await state.clock.advance(5 * 60_000)
  await agentStep($, 'a1')
  await state.clock.advance(29 * 60_000)
  await settled()
  expect(state.commands).toEqual([])
  await state.clock.advance(60_000)
  await settled()
  expect(state.commands).toEqual(['clear'])
  expect(a1Logs().length).toBe(2)
})

test('più rinvii: un solo timer armato, il precedente non scatta', async ($, on) => {
  const state = world(on, twoRunning())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await state.clock.advance(10 * 60_000)
  await agentStep($, 'a1')
  // Un nuovo rinvio (fine turno di a2) riarma il timer: scadenza a 40, la vecchia a 30 non deve scattare.
  await $.turn.complete(done('a2'))
  await settled()
  const before = mainReads(state)
  await state.clock.advance(25 * 60_000)
  await settled()
  expect(mainReads(state)).toBe(before)
  expect(state.commands).toEqual([])
})

test('resetDeferral cancella il timer: handoff tolto e rimesso, nessun controllo alla vecchia scadenza', async ($, on) => {
  const state = world(on, twoRunning())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  state.files.set(MAIN_FILE, '')
  await $.turn.complete(done('a2'))
  await settled()
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  const before = mainReads(state)
  await state.clock.advance(31 * 60_000)
  await settled()
  expect(mainReads(state)).toBe(before)
  expect(state.commands).toEqual([])
})

test('dopo il clear e session.end il timer non resta armato', async ($, on) => {
  const list = running()
  const state = world(on, list)
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  Object.assign(list[0] ?? {}, { status: 'idle' })
  await $.turn.complete(done('a1'))
  await settled()
  expect(state.commands).toEqual(['clear'])
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await settled()
  const before = mainReads(state)
  await state.clock.advance(31 * 60_000)
  await settled()
  expect(mainReads(state)).toBe(before)
})

// L'id che la mod dà a un handoff (FNV-1a a 32 bit più la lunghezza, come fingerprint in register.tsx).
const handoffId = (text: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}${text.length.toString(16)}`
}

test("handoff che ha già avuto il suo clear durante il rinvio: il timer della scadenza è cancellato", async ($, on) => {
  // Il rinvio arma il timer con un handoff; poi la principale lo riscrive con uno che ha già avuto il suo clear.
  const other = MAIN_VALIDATED.replace('Fare y.', 'Fare z.')
  const state = world(on, twoRunning(), { clears: [{ at: 0, handoff: handoffId(other) }] })
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  expect(state.logs.some(line => line.includes('clear rimandato'))).toBe(true)
  state.files.set(MAIN_FILE, other)
  await $.turn.complete(done('a2'))
  await settled()
  expect(state.logs.filter(line => line.includes('ha già avuto il suo clear')).length).toBe(1)
  const before = mainReads(state)
  await state.clock.advance(31 * 60_000)
  await settled()
  expect(mainReads(state)).toBe(before)
})

test('teammate in pannello separato (id === teammateId), running senza eventi per 60 minuti: nessun clear', async ($, on) => {
  const state = world(on, [{ id: 'w@t', teammateId: 'w@t', type: 'teammate', description: 'x', status: 'running' }, validator('v1')])
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  await state.clock.advance(60 * 60_000)
  await settled()
  expect(state.commands).toEqual([])
  expect(staleLogs(state)).toEqual([])
})

test('agentStaleMinutes enorme: limitato a 1440 minuti', { options: { agentStaleMinutes: 100_000 } }, async ($, on) => {
  const state = world(on, running())
  state.files.set(MAIN_FILE, MAIN_VALIDATED)
  await $.turn.complete(mainDone())
  await settled()
  await state.clock.advance(1440 * 60_000)
  await settled()
  expect(state.commands).toEqual(['clear'])
})
