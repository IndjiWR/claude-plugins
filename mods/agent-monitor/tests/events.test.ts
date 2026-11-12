import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { textSummary } from '../hooks/register'
import { buildTree, totals } from '../hooks/ledger'

const summary = async ($: { command: { run: (i: never) => Promise<unknown> } }) =>
  ((await $.command.run({ command: 'agenti', args: '' } as never)) as { text: string }).text

const world = (on: On, agents: unknown[] = []) => {
  mock.store(on)
  sets = []
  failSet = false
  on('state.set', (_, e, next) => {
    if (failSet) throw new Error('boom')
    sets.push(e as never)
    return next(e)
  })
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  const st = { failList: false, t: 1000, step: 10, toasts: [] as string[], views: [] as unknown[], registered: [] as unknown[], spawnId: 'new1' }
  on('clock.now', () => ({ value: (st.t += st.step) }) as never)
  on('agent.list', () => {
    if (st.failList) throw new Error('giù')
    return { value: agents } as never
  })
  on('ui.toast', (_, e) => {
    st.toasts.push((e as unknown as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.view', (_, e) => {
    st.views.push(e)
    return { value: {} } as never
  })
  on('command.register', (_, e) => {
    st.registered.push(e)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }) as never)
  on('agent.spawn', () => ({ model: 'm', agentId: st.spawnId }) as never)
  return st
}

const turn = (agentId: string | undefined, input: number, output = 0) =>
  ({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn', agentId, usage: { model: 'sonnet', input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as never

test('turn.complete di un subagent aggiorna usage; senza agentId va in main', async ($, on) => {
  world(on)
  await $.turn.complete(turn('a1', 10, 5))
  await $.turn.complete(turn(undefined, 7))
  const t = await summary($)
  expect(t).toContain('in 10 / out 5')
  expect(t).toContain('Sessione principale')
  expect(t).toContain('in 7 / out 0')
})

test('toast una sola volta oltre soglia', async ($, on) => {
  const st = world(on)
  await $.turn.complete(turn('a1', 150000, 60000))
  await $.turn.complete(turn('a1', 1000))
  expect(st.toasts).toEqual(['Agente a1 oltre 200,0k token'])
})

test('alertTokens 0 nessun toast', { options: { alertTokens: 0 } }, async ($, on) => {
  const st = world(on)
  await $.turn.complete(turn('a1', 900000))
  expect(st.toasts).toEqual([])
})

test('agent.spawn con modello lo registra', async ($, on) => {
  world(on)
  await $.agent.spawn({ prompt: 'x', model: 'haiku' } as never)
  expect(await summary($)).toContain('new1 · haiku')
})

test('session.start registra agenti', async ($, on) => {
  const st = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  expect((st.registered[0] as { name: string }).name).toBe('agenti')
})

test('/agenti risponde con albero e totale', async ($, on) => {
  world(on, [{ id: 'a1', status: 'running', description: 'Cerca file', type: 't' }])
  await $.turn.complete(turn('a1', 1500, 500))
  const r = await $.command.run({ command: 'agenti', args: '' } as never)
  const text = (r as unknown as { text: string }).text
  expect(text).toContain('Sessione principale')
  expect(text).toContain('  running Cerca file · sonnet · in 1,5k / out 500 / cache 0+0')
  expect(text).toContain('Totale:')
})

test('toast usa l etichetta delle righe: descrizione troncata, altrimenti nome', async ($, on) => {
  const st = world(on, [{ id: 'a1', status: 'running', description: 'D'.repeat(50), type: 't' }, { id: 'a2', status: 'running', name: 'Nome', description: '', type: 't' }])
  await $.turn.complete(turn('a1', 250000))
  await $.turn.complete(turn('a2', 250000))
  expect(st.toasts).toEqual([
    `Agente ${'D'.repeat(40)}… oltre 200,0k token`,
    'Agente Nome oltre 200,0k token',
  ])
})

test('/agenti chat apre la vista', async ($, on) => {
  const st = world(on)
  await $.command.run({ command: 'agenti', args: 'chat' } as never)
  expect(st.views).toEqual([{}])
})

test('valori pre-esistenti compaiono nel riepilogo', async ($, on) => {
  world(on)
  const old = { old: { input: 42, output: 0, cacheRead: 0, cacheWrite: 0, turns: 3, firstAt: 0, lastAt: 0 } }
  on('state.get', (_, e) =>
    ({ value: e.key === 'usage' ? { value: { shape: 'usage-1', value: old }, version: 1 } : { value: undefined, version: 0 } }) as never)
  const r = await $.command.run({ command: 'agenti', args: '' } as never)
  expect((r as unknown as { text: string }).text).toContain('in 42')
})

test('textSummary', () => {
  const u = { a: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 5, firstAt: 0, lastAt: 0 } }
  const t = textSummary(buildTree([], u, 0), totals(u))
  expect(t.split('\n').pop()).toBe('Totale: in 1 / out 2 / cache 3+4 · 5 turni')
})

test('durata: spawn a t0, turno a t1 -> riga completata dura t1 - t0', async ($, on) => {
  const st = world(on, [{ id: 'new1', status: 'completed', description: 'Job', type: 't' }])
  st.step = 0
  st.t = 1000
  await $.agent.spawn({ prompt: 'x' } as never)
  st.t = 6000
  await $.turn.complete(turn('new1', 1))
  st.t = 90000
  expect(await summary($)).toContain('completed Job · sonnet · in 1 / out 0 / cache 0+0 · 5s')
})

test('due turn.complete concorrenti oltre soglia: un solo toast', async ($, on) => {
  const st = world(on)
  await Promise.all([$.turn.complete(turn('a1', 250000)), $.turn.complete(turn('a1', 1000))])
  expect(st.toasts.length).toBe(1)
})

test('/agenti testo: agent.list rifiuta -> ultimo elenco e nota', async ($, on) => {
  const st = world(on)
  st.failList = true
  const r = (await $.command.run({ command: 'agenti', args: '' } as never)) as { text: string }
  expect(r.text).toContain('Sessione principale')
  expect(r.text).toContain('elenco non aggiornato')
})

const stepUsage = (input: number, model: string, cr = 0, cc = 0) => ({ model, input_tokens: input, output_tokens: 1, cache_read_input_tokens: cr, cache_creation_input_tokens: cc })
const stepRes = (usage: unknown) => ({ turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage }) as never
const stepIn = (agentId?: string) => ({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId }) as never

// Stato letto passando dal comando /agenti non basta (il contesto non è ancora mostrato): si intercettano le scritture.
const usageOf = async (_$: unknown) => lastUsage()
let failSet = false
let sets: Array<{ key: string; value: unknown }> = []
const lastUsage = () => {
  const w = [...sets].reverse().find((x) => x.key === 'usage')
  const v = w?.value as { value?: unknown } | undefined
  return (v && typeof v === 'object' && 'value' in v ? v.value : v) ?? {}
}

async function runStep($: { turn: { step: (i: never) => AsyncGenerator<unknown, unknown> } }, input: never) {
  const it = $.turn.step(input)
  for (;;) {
    const r = await it.next()
    if (r.done) return r.value
  }
}

test('turn.step di un subagent salva il contesto dell ultima richiesta', async ($, on) => {
  world(on)
  let u: unknown = stepUsage(100, 'sonnet', 50, 20)
  on('turn.step', async function* () {
    return stepRes(u)
  })
  await runStep($ as never, stepIn('a1'))
  u = stepUsage(300, 'haiku', 1000, 200)
  await runStep($ as never, stepIn('a1'))
  const usage = (await usageOf($)) as Record<string, { ctxTokens: number; ctxModel: string }>
  expect(usage.a1.ctxTokens).toBe(1500)
  expect(usage.a1.ctxModel).toBe('haiku')
})

test('turn.step con usage null: nessun aggiornamento e risultato invariato', async ($, on) => {
  world(on)
  const res = stepRes(null)
  on('turn.step', async function* () {
    return res
  })
  const r = await runStep($ as never, stepIn('a1'))
  expect(r).toEqual(res)
  const usage = (await usageOf($)) as Record<string, unknown>
  expect(usage.a1).toBeUndefined()
})

test('turn.step: il risultato di next torna identico', async ($, on) => {
  world(on)
  const res = stepRes(stepUsage(5, 'sonnet'))
  on('turn.step', async function* () {
    return res
  })
  expect(await runStep($ as never, stepIn('a1'))).toEqual(res)
})

test('turn.step senza agentId: salva il modello sotto MAIN', async ($, on) => {
  world(on)
  on('turn.step', async function* () {
    return stepRes(stepUsage(10, 'opus', 5))
  })
  await runStep($ as never, stepIn(undefined))
  const usage = (await usageOf($)) as Record<string, { ctxModel: string; ctxTokens: number }>
  expect(usage.main.ctxModel).toBe('opus')
  expect(usage.main.ctxTokens).toBe(15)
})

// Task 3: pubblicazione del contesto della sessione principale
const ctxWorld = (on: On, opts: { cfg?: boolean; failWrite?: boolean; jobDir?: string } = {}) => {
  world(on)
  const writes: { path: string; text: string }[] = []
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'CLAUDE_JOB_DIR' ? opts.jobDir : '/home/u' }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.usage', () => ({ value: { context: { tokens: 470, window: 1000, percent: 47 } } }) as never)
  on('config.list', () =>
    ({ value: opts.cfg === false ? [] : [{ key: 'auto-clear-context.threshold', value: 40 }, { key: 'auto-clear-context.hardThreshold', value: 60 }] }) as never)
  on('fs.write', (_, e) => {
    writes.push({ path: (e as { path: string }).path, text: (e as { text: string }).text })
    if (opts.failWrite) throw new Error('disco pieno')
    return { value: undefined } as never
  })
  return writes
}
const flush = () => new Promise((r) => setTimeout(r, 20))

test('turn.complete della principale scrive il file di contesto', async ($, on) => {
  const writes = ctxWorld(on)
  await $.turn.complete(turn(undefined, 1))
  await flush()
  expect(writes.length).toBe(1)
  expect(writes[0].path).toBe('/home/u/.claude/agent-monitor/contesto/s1.json')
  const j = JSON.parse(writes[0].text)
  expect(j).toMatchObject({ percent: 47, zone: 1, window: 1000, tokens: 470 })
  expect(typeof j.at).toBe('number')
})

test('turn.complete con CLAUDE_JOB_DIR scrive nel file dell id del job', async ($, on) => {
  const writes = ctxWorld(on, { jobDir: '/Users/u/.claude/jobs/741af455' })
  await $.turn.complete(turn(undefined, 1))
  await flush()
  expect(writes[0].path).toBe('/home/u/.claude/agent-monitor/contesto/741af455.json')
})

test('turn.complete di un subagent non scrive', async ($, on) => {
  const writes = ctxWorld(on)
  await $.turn.complete(turn('a1', 1))
  await flush()
  expect(writes.length).toBe(0)
})

test('fs.write che rifiuta: turn.complete risponde comunque', async ($, on) => {
  const writes = ctxWorld(on, { failWrite: true })
  const r = (await $.turn.complete({ ...(turn(undefined, 1) as object), answer: 'ciao' } as never)) as { text: string }
  await flush()
  expect(writes.length).toBe(1)
  expect(r.text).toBe('ciao')
})

test('turn.step: un errore di contabilità non tocca il risultato', async ($, on) => {
  world(on)
  failSet = true
  const res = stepRes(stepUsage(5, 'sonnet'))
  on('turn.step', async function* () {
    return res
  })
  expect(await runStep($ as never, stepIn('a1'))).toEqual(res)
  await flush()
})

test('senza auto-clear-context: zone null', async ($, on) => {
  const writes = ctxWorld(on, { cfg: false })
  await $.turn.complete(turn(undefined, 1))
  await flush()
  expect(JSON.parse(writes[0].text).zone).toBeNull()
})

// Task 5: contesto nel testo di fallback di /agenti
test('/agenti testo: ctx sulla riga principale e sulla riga della sessione', async ($, on) => {
  world(on)
  on('session.usage', () => ({ value: { context: { tokens: 470, window: 1000, percent: 47 } } }) as never)
  on('config.list', () =>
    ({ value: [{ key: 'auto-clear-context.threshold', value: 40 }, { key: 'auto-clear-context.hardThreshold', value: 60 }] }) as never)
  on('env.get', () => ({ value: '/h' }) as never)
  on('process.run', () =>
    ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify([{ id: 's1', name: 'a', kind: 'background', cwd: '/p/a', state: 'working', sessionId: 'x-a' }]) } }) as never)
  on('fs.read', (_, e) => {
    if ((e as { path: string }).path.includes('/contesto/')) return { value: JSON.stringify({ tokens: 470, window: 1000, percent: 47, zone: 1, at: 5 }) } as never
    throw new Error('ENOENT')
  })
  await $.turn.complete(turn(undefined, 7))
  const lines = (await summary($)).split('\n')
  expect(lines.find((l) => l.includes('Sessione principale'))).toContain('· ctx 47% (zona morbida)')
  expect(lines.find((l) => l.includes('lav'))).toContain('ctx 47% (zona morbida)')
})

test('textSummary con ctxOf aggiunge ctx solo se non vuoto', () => {
  const u = { a: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 5, firstAt: 0, lastAt: 0 } }
  const rows = buildTree([], u, 0)
  expect(textSummary(rows, totals(u), () => ({ percent: 30, zone: 0 }))).toContain('· ctx 30% (zona normale)')
  expect(textSummary(rows, totals(u), () => ({}))).not.toContain('ctx')
})
