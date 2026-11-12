import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { SessionsSnapshot } from '../types'

const PANE = {
  plugin: 'agent-monitor',
  component: 'Pane',
  requestId: 'agenti',
  props: { title: 'Agenti', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const AGENTS = [
  { id: 'a1', status: 'running', description: 'Cerca file', type: 't' },
  { id: 'a2', parentId: 'a1', status: 'completed', name: 'Figlio', description: 'Figlio desc', type: 't' },
]

type Cfg = { agents?: unknown[]; placed?: boolean; answer?: string; dismiss?: boolean; failList?: boolean; failStop?: boolean; agentsJson?: string; failAgentsCmd?: boolean; rejectAgentsCmd?: boolean; registry?: string | null; copy?: unknown; failOsascript?: boolean; home?: string; ctxFiles?: Record<string, string> }
const world = (on: On, cfg: Cfg = {}) => {
  mock.store(on)
  // serve a $.turn.complete(...) nei test che riempiono usage: senza handler terminale la chiamata non risolve
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  const clock = mock.clock(on, { now: 1000 })
  const st = {
    cfg: { placed: true, answer: 'Ferma', ...cfg },
    opens: [] as unknown[],
    views: [] as unknown[],
    toasts: [] as string[],
    asks: [] as string[],
    stops: [] as unknown[],
    lists: 0,
    runs: [] as { argv: readonly string[]; timeoutMs?: number }[],
    reads: [] as string[],
    copies: [] as { text: string; surface?: string }[],
    scripts: [] as (readonly string[])[],
    sessions: undefined as SessionsSnapshot | undefined,
    clock,
  }
  on('agent.list', () => {
    st.lists++
    if (st.cfg.failList) throw new Error('giù')
    return { value: st.cfg.agents ?? AGENTS } as never
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'osascript') {
      st.scripts.push(e.argv)
      if (st.cfg.failOsascript) throw new Error('negato')
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    if (e.argv[0] !== 'claude') return { value: { exitCode: 1, stdout: '', stderr: 'no' } } as never
    st.runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    if (st.cfg.rejectAgentsCmd) throw new Error('timeout')
    if (st.cfg.failAgentsCmd) return { value: { exitCode: 1, stdout: '', stderr: 'boom' } } as never
    return { value: { exitCode: 0, stdout: st.cfg.agentsJson ?? '[]', stderr: '' } } as never
  })
  on('env.get', () => ({ value: st.cfg.home }) as never)
  on('fs.read', (_, e) => {
    st.reads.push(e.path)
    if (st.cfg.ctxFiles && e.path.includes('/agent-monitor/contesto/')) {
      const f = st.cfg.ctxFiles[e.path.split('/').pop()!.replace('.json', '')]
      if (f === undefined) throw new Error('ENOENT')
      return { value: f } as never
    }
    if (st.cfg.registry == null) throw new Error('ENOENT')
    return { value: st.cfg.registry } as never
  })
  // ultimo valore scritto nell'atomo delle sessioni (il $ del test non legge lo stato)
  on('state.set', async (_, e, next) => {
    const w = e as unknown as { key: string; value: unknown }
    if (w.key === 'sessions') st.sessions = (w.value as { value?: SessionsSnapshot }).value ?? (w.value as SessionsSnapshot)
    return next(e)
  })
  on('ui.open', (_, e) => {
    st.opens.push(e)
    return { value: st.cfg.placed ? { isPlaced: true } : { isPlaced: false, reason: 'troppo stretto' } } as never
  })
  on('ui.copy', (_, e) => {
    st.copies.push({ text: e.text, surface: e.surface })
    return { value: st.cfg.copy ?? { isCopied: true } } as never
  })
  on('ui.view', (_, e) => {
    st.views.push(e)
    return { value: {} } as never
  })
  on('ui.toast', (_, e) => {
    st.toasts.push((e as unknown as { text: string }).text)
    return { value: undefined } as never
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
      st.asks.push(q)
      if (st.cfg.dismiss) throw new Error('chiusa')
      return { result: { questions: [], answers: { [q]: st.cfg.answer } } } as never
    }
    st.stops.push(e)
    if (st.cfg.failStop) throw new Error('no')
    return { result: {} } as never
  })
  return st
}

type Mounted = { find: (q: { key?: string; type?: string; text?: RegExp }) => Promise<{ type: string; props: Record<string, unknown>; text: string; children: unknown[] } | undefined> }
// I Text non portano la key: la key sta sul Box che li avvolge, il Text è il primo figlio.
const tx = async (ui: Mounted, key: string) => {
  const box = await ui.find({ key })
  const c = box?.children[0] as { props?: Record<string, unknown>; children?: string[] } | undefined
  return c ? { text: (c.children ?? []).join(''), props: c.props ?? {} } : undefined
}

const run = ($: { command: { run: (i: never) => Promise<unknown> } }) => $.command.run({ command: 'agenti', args: '' } as never)

test('/agenti apre il pannello', async ($, on) => {
  const st = world(on)
  expect(await run($)).toEqual({})
  expect(st.opens).toEqual([{ id: 'agenti', title: 'Agenti', focus: true }])
})

test('pannello non piazzato: testo con riepilogo', async ($, on) => {
  world(on, { placed: false })
  const r = (await run($)) as { text: string }
  expect(r.text).toContain("Il pannello non si apre qui (troppo stretto).\n")
  expect(r.text).toContain('Sessione principale')
  expect(r.text).toContain('Totale:')
})

test('render: radice, figlio con prefisso albero, riepilogo', async ($, on) => {
  world(on)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'label-main'))?.text).toContain('Sessione principale')
  expect((await tx(ui, 'label-a1'))?.text).toMatch(/^└ Cerca file|^├ Cerca file/)
  expect((await tx(ui, 'label-a2'))?.text).toMatch(/^ {2}└ Figlio desc/)
  expect((await tx(ui, 'status-a1'))?.text).toContain('● run')
  expect((await tx(ui, 'status-a2'))?.text).toContain('✓ fin')
  expect((await tx(ui, 'head'))?.text).toMatch(/STATO.*AGENTE.*MODELLO.*TOKEN.*CTX.*DUR.*TURNI/)
  expect(await ui.find({ type: 'Text', text: /elenco non aggiornato/ })).toBeUndefined()
  await ui.unmount()
})

const turn = (agentId: string | undefined, model: string, input: number, output = 0) =>
  ({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn', agentId, usage: { model, input_tokens: input, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }) as never

const MANY = [
  { id: 'r', status: 'running', description: 'run', type: 't' },
  { id: 'w', status: 'waiting', description: 'wait', type: 't' },
  { id: 'p', status: 'pending', description: 'pend', type: 't' },
  { id: 'f', status: 'failed', description: 'fail', type: 't' },
  { id: 'k', status: 'killed', description: 'kill', type: 't' },
]

test('riepilogo: conteggi solo non zero, colori, riga modelli', async ($, on) => {
  world(on, { agents: [MANY[0], MANY[1], MANY[3]] })
  await $.turn.complete(turn('r', 'claude-sonnet-5', 200000, 80000))
  await $.turn.complete(turn('w', 'claude-haiku-4-5', 90000, 5000))
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'count-active'))?.text).toBe('● 1 attivi')
  expect((await tx(ui, 'count-active'))?.props.color).toBe('success')
  expect((await tx(ui, 'count-waiting'))?.props.color).toBe('warning')
  expect((await tx(ui, 'count-failed'))?.text).toBe('✗ 1 errori')
  expect((await tx(ui, 'count-failed'))?.props.color).toBe('error')
  expect(await ui.find({ key: 'count-pending' })).toBeUndefined()
  expect(await ui.find({ key: 'count-done' })).toBeUndefined()
  expect((await tx(ui, 'models'))?.text).toBe('Sonnet 280k · Haiku 95k')
  expect((await tx(ui, 'models'))?.props.dimColor).toBe(true)
  expect((await ui.find({ key: 'summary' }))?.props.borderStyle).toBe('round')
  await ui.unmount()
})

test('sessionBudget 0: solo totale, niente barra', async ($, on) => {
  world(on)
  await $.turn.complete(turn('a1', 'sonnet', 1000, 500))
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'budget'))?.text).toBe('Token 1,5k')
  await ui.unmount()
})

test('sessionBudget > 0: barra e colore per livello', { options: { sessionBudget: 2000 } }, async ($, on) => {
  world(on)
  await $.turn.complete(turn('a1', 'sonnet', 1000, 500))
  await run($)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = await tx(ui, 'budget')
  expect(t?.text).toBe('Token ▕███████████████     ▏ 1,5k / 2k')
  expect(t?.props.color).toBe('warning')
  await ui.unmount()
  await $.turn.complete(turn('a1', 'sonnet', 1000, 0))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'budget'))?.props.color).toBe('error')
  await ui.unmount()
})

test('token di riga colorati per usageLevel di alertTokens', { options: { alertTokens: 1000 } }, async ($, on) => {
  world(on, { agents: [MANY[0], MANY[1], MANY[2]] })
  await $.turn.complete(turn('r', 'sonnet', 500, 0))
  await $.turn.complete(turn('w', 'sonnet', 800, 0))
  await $.turn.complete(turn('p', 'sonnet', 1200, 0))
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'tokens-r'))?.props.color).toBe('success')
  expect((await tx(ui, 'tokens-w'))?.props.color).toBe('warning')
  expect((await tx(ui, 'tokens-p'))?.props.color).toBe('error')
  expect((await tx(ui, 'tokens-r'))?.text).toContain('500')
  expect((await tx(ui, 'status-w'))?.text).toContain('◐ att')
  expect((await tx(ui, 'status-p'))?.text).toContain('○ pend')
  await ui.unmount()
})

test('selezione: default primo attivo, il selettore sposta azioni e barra', async ($, on) => {
  const st = world(on, { agents: [MANY[0], MANY[1]] })
  await run($)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'sel-r' }))?.props.label).toBe('▸')
  expect((await ui.find({ key: 'sel-w' }))?.props.label).toBe('○')
  expect((await tx(ui, 'actions'))?.text).toContain('run:')
  expect((await ui.find({ key: 'row-r' }))?.type).toBe('Box')
  expect((await tx(ui, 'status-r'))?.props.inverse).toBe(true)
  expect((await tx(ui, 'status-w'))?.props.inverse).toBeUndefined()
  await ui.press({ key: 'sel-w' })
  expect((await ui.find({ key: 'sel-w' }))?.props.label).toBe('▸')
  expect((await ui.find({ key: 'sel-r' }))?.props.label).toBe('○')
  expect(await ui.find({ key: 'transcript-r' })).toBeUndefined()
  await ui.press({ key: 'transcript-w' })
  expect(st.views).toEqual([{ agentId: 'w' }])
  await ui.press({ key: 'stop-w' })
  expect(st.asks).toEqual(["Fermo l'agente wait?"])
  expect(st.stops[0]).toMatchObject({ tool: 'TaskStop', task_id: 'w' })
  await ui.unmount()
})

test('agente finito selezionato: Transcript sì, Ferma no, dettaglio token', async ($, on) => {
  world(on)
  await $.turn.complete(turn('a2', 'sonnet', 10, 5))
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sel-a2' })
  expect(await ui.find({ key: 'transcript-a2' })).toBeDefined()
  expect(await ui.find({ key: 'stop-a2' })).toBeUndefined()
  expect((await tx(ui, 'detail'))?.text).toBe('id a2 · in 10 · out 5 · cache 3+4')
  expect((await tx(ui, 'status-a2'))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('agente sparito dall elenco: etichetta e stato conservati finché ha consumi', async ($, on) => {
  const st = world(on)
  await $.turn.complete(turn('a1', 'sonnet', 10, 5))
  await run($)
  st.cfg.agents = []
  await st.clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Cerca file/ })).toBeDefined()
  await ui.press({ key: 'sel-a1' })
  expect((await tx(ui, 'detail'))?.text).toContain('id a1')
  expect(await ui.find({ key: 'stop-a1' })).toBeUndefined()
  await ui.unmount()
})

test('main selezionato: nessuna azione, solo il suggerimento', async ($, on) => {
  world(on)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sel-main' })
  expect((await tx(ui, 'actions'))?.text).toContain('Seleziona un agente')
  expect(await ui.find({ key: 'transcript-main' })).toBeUndefined()
  expect(await ui.find({ key: 'stop-main' })).toBeUndefined()
  await ui.unmount()
})

test('nessun agente attivo: nessuna selezione di default', async ($, on) => {
  world(on, { agents: [MANY[3]] })
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'actions'))?.text).toContain('Seleziona un agente')
  expect((await ui.find({ key: 'sel-f' }))?.props.label).toBe('○')
  await ui.unmount()
})

test('colonne: 120 tutto, 65 senza TURNI e barra, 45 solo glifo, nome e token', async ($, on) => {
  world(on)
  await $.turn.complete(turn('a1', 'sonnet', 100000, 0))
  await run($)
  const at = async (cols: number) => $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols }, surface: 'terminal' })
  let ui = await at(120)
  expect((await tx(ui, 'head'))?.text).toContain('TURNI')
  expect((await tx(ui, 'head'))?.text).toContain('CTX')
  expect((await tx(ui, 'tokens-a1'))?.text).toMatch(/█/)
  await ui.unmount()
  ui = await at(53)
  expect((await tx(ui, 'head'))?.text).toContain('CTX')
  await ui.unmount()
  ui = await at(52)
  expect((await tx(ui, 'head'))?.text).not.toContain('CTX')
  await ui.unmount()
  ui = await at(65)
  expect((await tx(ui, 'head'))?.text).toContain('CTX')
  expect((await tx(ui, 'head'))?.text).not.toContain('TURNI')
  expect((await tx(ui, 'head'))?.text).toContain('DUR')
  expect((await tx(ui, 'tokens-a1'))?.text).not.toMatch(/█/)
  expect((await tx(ui, 'tokens-a1'))?.text).toContain('100k')
  expect(await ui.find({ key: 'turns-a1' })).toBeUndefined()
  await ui.unmount()
  ui = await at(45)
  const head = (await tx(ui, 'head'))?.text ?? ''
  expect(head).not.toContain('MODELLO')
  expect(head).not.toContain('DUR')
  expect(head).not.toContain('CTX')
  expect(head).toContain('TOKEN')
  expect(await ui.find({ key: 'dur-a1' })).toBeUndefined()
  expect((await tx(ui, 'status-a1'))?.text.trim()).toBe('●')
  await ui.unmount()
})

test('rifiuto di agent.list: nota e ultimo elenco tenuto', async ($, on) => {
  const st = world(on)
  await run($)
  st.cfg.failList = true
  await st.clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /elenco non aggiornato/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Cerca file/ })).toBeDefined()
  await ui.unmount()
})

test('il timer rilegge l elenco e si ferma se il pannello non viene più disegnato', async ($, on) => {
  const st = world(on)
  await run($)
  const before = st.lists
  await st.clock.advance(2000)
  expect(st.lists).toBe(before + 1)
  await st.clock.advance(10000)
  const after = st.lists
  await st.clock.advance(10000)
  expect(st.lists).toBe(after)
})

test('Transcript apre la vista dell agente', async ($, on) => {
  const st = world(on)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'transcript-a1' })
  expect(st.views).toEqual([{ agentId: 'a1' }])
  await ui.unmount()
})

test('Ferma con Annulla non chiama TaskStop', async ($, on) => {
  const st = world(on, { answer: 'Annulla' })
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'stop-a1' })
  expect(st.asks).toEqual(["Fermo l'agente Cerca file?"])
  expect(st.stops).toEqual([])
  await ui.unmount()
})

test('Ferma conferma: TaskStop e toast', async ($, on) => {
  const st = world(on)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'stop-a1' })
  expect(st.stops.length).toBe(1)
  expect(st.stops[0]).toMatchObject({ tool: 'TaskStop', task_id: 'a1' })
  expect(st.toasts.length).toBe(1)
  await ui.unmount()
})

test('errore di TaskStop: toast', async ($, on) => {
  const st = world(on, { failStop: true })
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'stop-a1' })
  expect(st.toasts[0]).toContain('Cerca file')
  await ui.unmount()
})

test('azioni solo per l agente selezionato', async ($, on) => {
  world(on)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'transcript-a1' })).toBeDefined()
  expect(await ui.find({ key: 'stop-a1' })).toBeDefined()
  expect(await ui.find({ key: 'transcript-a2' })).toBeUndefined()
  expect(await ui.find({ key: 'transcript-main' })).toBeUndefined()
  await ui.unmount()
})

test('conferma chiusa senza risposta: niente TaskStop né toast', async ($, on) => {
  const st = world(on, { dismiss: true })
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'stop-a1' })
  expect(st.stops).toEqual([])
  expect(st.toasts).toEqual([])
  await ui.unmount()
})

test('con agent.list che fallisce a lungo il timer resta vivo e poi azzera stale', async ($, on) => {
  const st = world(on)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  st.cfg.failList = true
  await st.clock.advance(2000 * 6)
  const during = st.lists
  await st.clock.advance(2000)
  expect(st.lists).toBe(during + 1)
  expect(await ui.find({ type: 'Text', text: /elenco non aggiornato/ })).toBeDefined()
  st.cfg.failList = false
  await st.clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /elenco non aggiornato/ })).toBeUndefined()
  await ui.unmount()
})

test('agente attivo visto dal refresh senza turni: durata cresce', async ($, on) => {
  const st = world(on)
  await run($)
  await st.clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'dur-a1'))?.text.trim()).toMatch(/^(0|1|2|3)s$/)
  expect((await tx(ui, 'turns-a1'))?.text.trim()).toBe('0')
  await st.clock.advance(20000)
  await ui.unmount()
  const ui2 = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui2, 'dur-a1'))?.text.trim()).toMatch(/^(1[0-9]|2[0-9])s$/)
  await ui2.unmount()
})

test('intestazione e righe allineate: stesso offset di MODELLO e TOKEN', async ($, on) => {
  world(on)
  await $.turn.complete(turn('a1', 'sonnet', 100000, 0))
  await run($)
  for (const cols of [120, 65]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols }, surface: 'terminal' })
    const head = (await tx(ui, 'head'))?.text ?? ''
    const st = (await tx(ui, 'status-a1'))?.text ?? ''
    const lb = (await tx(ui, 'label-a1'))?.text ?? ''
    // la riga parte con selettore + spazio (2 colonne), come l'intestazione
    expect(head.indexOf('MODELLO') - 2).toBe(st.length + lb.length)
    expect(head.indexOf('TOKEN') - 2).toBe(st.length + lb.length + 9)
    expect(head.indexOf('AGENTE') - 2).toBe(st.length)
    const tk = (await tx(ui, 'tokens-a1'))?.text ?? ''
    const ctx = (await tx(ui, 'ctx-a1'))?.text ?? ''
    expect(head.indexOf('CTX') - 2).toBe(st.length + lb.length + 9 + tk.length)
    const dur = head.indexOf('DUR')
    if (dur >= 0) expect(dur - 2).toBe(st.length + lb.length + 9 + tk.length + ctx.length)
    await ui.unmount()
  }
})

test('riga main: token senza colore di soglia', { options: { alertTokens: 1000 } }, async ($, on) => {
  world(on)
  await $.turn.complete(turn(undefined, 'sonnet', 5000, 0))
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'tokens-main'))?.props.color).toBeUndefined()
  await ui.unmount()
})

// Avanza di 2 s alla volta ridisegnando il pannello, così il timer non si ferma per inattività.
const advanceDrawn = async ($: Parameters<typeof run>[0] & { ui: { mount: (i: never) => Promise<{ unmount: () => Promise<void> }> } }, st: { clock: { advance: (ms: number) => Promise<unknown> } }, ms: number) => {
  for (let t = 0; t < ms; t += 2000) {
    await st.clock.advance(2000)
    await (await $.ui.mount({ ...PANE, surface: 'terminal' } as never)).unmount()
  }
}
const LIVE = JSON.stringify([{ id: 's1', name: 'indji-x', kind: 'background', cwd: '/p/x', state: 'working' }])
const REG_DEFAULT = '/Users/indji/Documents/Lavoro/Claude/Projects/Indji/coordinatrice/sessioni.json'

test('sessions refresh: legge claude agents --json e il registro', async ($, on) => {
  const st = world(on, { agentsJson: LIVE, registry: '{}' })
  await run($)
  expect(st.runs[0]).toEqual({ argv: ['claude', 'agents', '--json'], timeoutMs: 5000 })
  expect(st.reads).toEqual([REG_DEFAULT])
  const snap = st.sessions!
  expect(snap.stale).toBe(false)
  expect(snap.list.find((s) => s.id === 's1')?.state).toBe('working')
})

test('sessions refresh: comando fallito tiene la lista e segna stale', async ($, on) => {
  const st = world(on, { agentsJson: LIVE, registry: '{}' })
  await run($)
  const before = (st.sessions!).list
  expect(before.length).toBe(1)
  st.cfg.failAgentsCmd = true
  await advanceDrawn($, st, 10_000)
  const snap = st.sessions!
  expect(snap.list).toEqual(before)
  expect(snap.stale).toBe(true)
})

test('sessions refresh: registro illeggibile', async ($, on) => {
  const st = world(on, { agentsJson: LIVE, registry: null })
  await run($)
  const snap = st.sessions!
  expect(snap.stale).toBe(false)
  expect(snap.list.map((s) => s.id)).toEqual(['s1'])
})

test('sessions refresh: opzione vuota', { options: { sessionsRegistry: '' } }, async ($, on) => {
  const st = world(on, { agentsJson: LIVE, registry: '{}' })
  await run($)
  expect(st.reads).toEqual([])
  expect((st.sessions!).list.length).toBe(1)
})

test('sessions refresh: process.run che rifiuta tiene la lista e segna stale', async ($, on) => {
  const st = world(on, { agentsJson: LIVE, registry: '{}' })
  await run($)
  const before = st.sessions!.list
  st.cfg.rejectAgentsCmd = true
  await advanceDrawn($, st, 10_000)
  expect(st.sessions!.list).toEqual(before)
  expect(st.sessions!.stale).toBe(true)
})

test('sessions refresh: al più una lettura ogni 10 s', async ($, on) => {
  const st = world(on, { agentsJson: LIVE, registry: '{}' })
  await run($)
  expect(st.runs.length).toBe(1)
  await advanceDrawn($, st, 2000)
  expect(st.runs.length).toBe(1)
  expect(st.lists).toBeGreaterThan(1)
  await advanceDrawn($, st, 8000)
  expect(st.runs.length).toBe(2)
})

// --- sezione sessioni di progetto ---
const SLIVE = JSON.stringify([
  { id: 'e003551f', name: 'pf', kind: 'background', cwd: '/p/pf', state: 'working' },
  { id: 'abc12345', name: 'tw', kind: 'background', cwd: '/p/tw', state: 'blocked', waitingFor: 'permesso Bash' },
])
const SREG = JSON.stringify({
  pf: { nome: 'pf', id: 'e003551f', stato: 'avviata', esito: 'fatto il task 2', esito_ora: '2026-11-12T14:00:00' },
  gone: { nome: 'old', id: 'cccccc01', stato: 'avviata', ora: '2026-11-12T10:00:00', esito: 'finita' },
})
const openPane = async ($: Parameters<typeof run>[0] & { ui: { mount: (i: never) => Promise<Mounted & { press: (q: { key: string }) => Promise<unknown>; unmount: () => Promise<void> }> } }, surface: 'terminal' | 'desktop' = 'terminal', cols = 120) => {
  await run($)
  return $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols }, surface } as never)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`sessioni (${surface}): sezione con bloccata prima, nome, progetto ed esito`, async ($, on) => {
    world(on, { agentsJson: SLIVE, registry: SREG })
    const ui = await openPane($, surface)
    expect(await ui.find({ type: 'Text', text: /SESSIONI DI PROGETTO/ })).toBeDefined()
    const blocked = await ui.find({ type: 'Text', text: /◐ blocc.*tw/ })
    const working = await ui.find({ type: 'Text', text: /● lav.*pf.*fatto il task 2/ })
    expect(blocked).toBeDefined()
    expect(working).toBeDefined()
    expect(blocked!.props.color).toBe('warning')
    expect(working!.props.color).toBe('success')
    const keys = (await ui.find({ key: 'sess-row-abc12345' }))!
    expect(keys).toBeDefined()
    const closed = await ui.find({ type: 'Text', text: /■ chiusa.*old/ })
    expect(closed?.props.dimColor).toBe(true)
    await ui.unmount()
  })

  test(`sessioni (${surface}): nessuna sessione, nessuna intestazione`, async ($, on) => {
    world(on, { agentsJson: '[]', registry: '{}' })
    const ui = await openPane($, surface)
    expect(await ui.find({ type: 'Text', text: /SESSIONI DI PROGETTO/ })).toBeUndefined()
    await ui.unmount()
  })

  test(`sessioni (${surface}): prima lettura fallita, lista vuota: riga "sessioni non aggiornate" senza intestazione`, async ($, on) => {
    world(on, { failAgentsCmd: true, registry: '{}' })
    const ui = await openPane($, surface)
    expect(await ui.find({ type: 'Text', text: /sessioni non aggiornate/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /SESSIONI DI PROGETTO/ })).toBeUndefined()
    await ui.unmount()
  })

  test(`sessioni (${surface}): Copia attach e toast, anche in caso di errore`, async ($, on) => {
    const st = world(on, { agentsJson: SLIVE, registry: SREG })
    const ui = await openPane($, surface)
    await ui.press({ key: 'sess-sel-e003551f' })
    await ui.press({ key: 'attach-copy-e003551f' })
    expect(st.copies).toEqual([{ text: 'claude attach e003551f', surface }])
    expect(st.toasts).toContain('Copiato: claude attach e003551f')
    st.cfg.copy = { isCopied: false, reason: 'no-clipboard' }
    await ui.press({ key: 'attach-copy-e003551f' })
    expect(st.toasts).toContain('Copia non riuscita (no-clipboard)')
    await ui.unmount()
  })

  test(`sessioni (${surface}): id non valido, nessuna copia né osascript`, async ($, on) => {
    const st = world(on, { agentsJson: JSON.stringify([{ id: 'x"; rm', name: 'bad', kind: 'background', cwd: '/p/bad', state: 'working' }]), registry: '{}' })
    const ui = await openPane($, surface)
    await ui.press({ key: 'sess-sel-x"; rm' })
    expect(await ui.find({ key: 'attach-copy-x"; rm' })).toBeDefined()
    await ui.press({ key: 'attach-copy-x"; rm' })
    if (surface === 'terminal') await ui.press({ key: 'attach-open-x"; rm' })
    expect(st.toasts.filter((t) => t === 'Id non valido: x"; rm').length).toBe(surface === 'terminal' ? 2 : 1)
    expect(st.copies).toEqual([])
    expect(st.scripts).toEqual([])
    await ui.unmount()
  })
}

test('sessioni: Apri nel Terminale solo su terminal, con osascript', async ($, on) => {
  const st = world(on, { agentsJson: SLIVE, registry: SREG })
  let ui = await openPane($, 'desktop')
  await ui.press({ key: 'sess-sel-e003551f' })
  expect(await ui.find({ key: 'attach-open-e003551f' })).toBeUndefined()
  await ui.unmount()
  ui = await openPane($, 'terminal')
  await ui.press({ key: 'sess-sel-e003551f' })
  await ui.press({ key: 'attach-open-e003551f' })
  expect(st.scripts).toEqual([['osascript', '-e', 'tell application "Terminal" to do script "claude attach e003551f"', '-e', 'tell application "Terminal" to activate']])
  expect(st.copies).toEqual([])
  await ui.unmount()
})

test('sessioni: osascript che rifiuta, toast e copia del comando', async ($, on) => {
  const st = world(on, { agentsJson: SLIVE, registry: SREG, failOsascript: true })
  const ui = await openPane($, 'terminal')
  await ui.press({ key: 'sess-sel-e003551f' })
  await ui.press({ key: 'attach-open-e003551f' })
  expect(st.toasts).toContain('Terminale non aperto: comando copiato')
  expect(st.copies).toEqual([{ text: 'claude attach e003551f', surface: 'terminal' }])
  await ui.unmount()
})

test('sessioni: osascript e copia falliscono, un solo toast di errore', async ($, on) => {
  const st = world(on, { agentsJson: SLIVE, registry: SREG, failOsascript: true, copy: { isCopied: false, reason: 'no-clipboard' } })
  const ui = await openPane($, 'terminal')
  await ui.press({ key: 'sess-sel-e003551f' })
  await ui.press({ key: 'attach-open-e003551f' })
  expect(st.toasts).toContain('Terminale non aperto: copia non riuscita')
  expect(st.toasts.filter((t) => /Copia non riuscita|Copiato|comando copiato/.test(t))).toEqual([])
  await ui.unmount()
})

test('sessioni: dettaglio con id, cwd, motivo ed esito; chiusa senza pulsanti', async ($, on) => {
  world(on, { agentsJson: SLIVE, registry: SREG })
  const ui = await openPane($, 'terminal')
  await ui.press({ key: 'sess-sel-abc12345' })
  expect(await ui.find({ type: 'Text', text: /id abc12345 · \/p\/tw/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /permesso Bash/ })).toBeDefined()
  expect(await ui.find({ key: 'attach-copy-abc12345' })).toBeDefined()
  await ui.press({ key: 'sess-sel-cccccc01' })
  expect(await ui.find({ key: 'sess-sel-cccccc01' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /finita/ })).toBeDefined()
  expect(await ui.find({ key: 'attach-copy-cccccc01' })).toBeUndefined()
  expect(await ui.find({ key: 'attach-open-cccccc01' })).toBeUndefined()
  await ui.unmount()
})

test('sessioni: bodyColumns 40, solo glifo e nome', async ($, on) => {
  world(on, { agentsJson: SLIVE, registry: SREG })
  const ui = await openPane($, 'terminal', 40)
  const row = await ui.find({ type: 'Text', text: /● pf/ })
  expect(row).toBeDefined()
  expect(row!.text).not.toContain('lav')
  expect(row!.text).not.toContain('fatto')
  await ui.unmount()
})

test('sessioni: stale mostra "sessioni non aggiornate"', async ($, on) => {
  const st = world(on, { agentsJson: SLIVE, registry: SREG })
  await run($)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /sessioni non aggiornate/ })).toBeUndefined()
  await ui.unmount()
  st.cfg.failAgentsCmd = true
  await advanceDrawn($, st, 10_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /sessioni non aggiornate/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● lav/ })).toBeDefined()
  await ui.unmount()
})

test('sessioni: selezione di una sessione sparita torna al primo agente attivo', async ($, on) => {
  const st = world(on, { agentsJson: SLIVE, registry: '{}' })
  let ui = await openPane($, 'terminal')
  await ui.press({ key: 'sess-sel-e003551f' })
  expect(await ui.find({ key: 'attach-copy-e003551f' })).toBeDefined()
  expect((await ui.find({ key: 'sel-a1' }))?.props.label).toBe('○')
  await ui.unmount()
  st.cfg.agentsJson = '[]'
  await advanceDrawn($, st, 10_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect(await ui.find({ key: 'attach-copy-e003551f' })).toBeUndefined()
  expect((await ui.find({ key: 'sel-a1' }))?.props.label).toBe('▸')
  await ui.unmount()
})

test('fallback testuale: le sessioni vengono prima del riepilogo agenti', async ($, on) => {
  world(on, { placed: false, agentsJson: SLIVE, registry: SREG })
  const r = (await run($)) as { text: string }
  const lines = r.text.split('\n')
  expect(lines[0]).toContain('Il pannello non si apre qui')
  expect(lines[1]).toMatch(/^◐ blocc.*tw/)
  expect(lines[2]).toMatch(/^● lav.*pf/)
  expect(r.text.indexOf('tw')).toBeLessThan(r.text.indexOf('Sessione principale'))
})

const LIVE2 = JSON.stringify([
  { id: 's1', name: 'a', kind: 'background', cwd: '/p/a', state: 'working', sessionId: 'x-a' },
  { id: 's2', name: 'b', kind: 'background', cwd: '/p/b', state: 'working', sessionId: 'x-b' },
])
const CTX_OK = JSON.stringify({ tokens: 470, window: 1000, percent: 47, zone: 1, at: 5 })

test('sessions context: file valido finisce in context', async ($, on) => {
  const st = world(on, { agentsJson: LIVE2, registry: '{}', home: '/h', ctxFiles: { s1: CTX_OK } })
  await run($)
  expect(st.reads).toContain('/h/.claude/agent-monitor/contesto/s1.json')
  expect(st.sessions!.list.find((s) => s.id === 's1')?.context).toEqual({ percent: 47, tokens: 470, zone: 1 })
})

test('sessions context: file rotto per una, valido per l altra', async ($, on) => {
  const st = world(on, { agentsJson: LIVE2, registry: '{}', home: '/h', ctxFiles: { s1: '{rotto', s2: CTX_OK } })
  await run($)
  expect(st.sessions!.list.find((s) => s.id === 's1')?.context).toBeUndefined()
  expect(st.sessions!.list.find((s) => s.id === 's2')?.context).toEqual({ percent: 47, tokens: 470, zone: 1 })
})

test('sessions context: senza HOME nessuna lettura dei file di contesto', async ($, on) => {
  const st = world(on, { agentsJson: LIVE2, registry: '{}', ctxFiles: { s1: CTX_OK } })
  await run($)
  expect(st.reads.some((r) => r.includes('/contesto/'))).toBe(false)
  expect(st.sessions!.list.every((s) => s.context === undefined)).toBe(true)
})

// --- colonna CTX e contesto nelle sessioni ---
const step = (model: string, input: number) =>
  ({ turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model, input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as never
const ctxPane = async ($: never, on: On, percent: number, cfg: Cfg = {}) => {
  const cur = { percent }
  const st = { ...world(on, { agents: [...AGENTS, { id: 'a3', status: 'running', description: 'Muto', type: 't' }], ...cfg }), cur }
  on('session.usage', () => ({ value: { context: { tokens: cur.percent * 10, window: 1000, percent: cur.percent } } }) as never)
  on('config.list', () => ({ value: [{ key: 'auto-clear-context.threshold', value: 40 }, { key: 'auto-clear-context.hardThreshold', value: 60 }] }) as never)
  on('turn.step', async function* (_, e) {
    const id = (e as { agentId?: string }).agentId
    return id === 'a1' ? step('sonnet', 500) : id === 'a2' ? step('haiku', 1500) : step('sonnet', 470)
  })
  for (const id of [undefined, 'a1', 'a2']) {
    const it = ($ as { turn: { step: (i: never) => AsyncGenerator<unknown, unknown> } }).turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId: id } as never)
    while (!(await it.next()).done);
  }
  await run($ as never)
  return st
}

test('colonna CTX: principale, subagent stesso modello, altro modello, senza dato', async ($, on) => {
  await ctxPane($ as never, on, 47)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'ctx-main'))?.text.trim()).toBe('47% mor')
  expect((await tx(ui, 'ctx-main'))?.props.color).toBe('warning')
  expect((await tx(ui, 'ctx-a1'))?.text.trim()).toBe('50% mor')
  expect((await tx(ui, 'ctx-a2'))?.text.trim()).toBe('1,5k')
  expect((await tx(ui, 'ctx-a3'))?.text.trim()).toBe('—')
  await ui.unmount()
})

test('colonna CTX: zona 0 colore normale, zona 2 rossa, zona 3 rossa in grassetto', async ($, on) => {
  const st = await ctxPane($ as never, on, 30)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'ctx-main'))?.text.trim()).toBe('30% nor')
  expect((await tx(ui, 'ctx-main'))?.props.color).toBeUndefined()
  await ui.unmount()
  st.cur.percent = 65
  await st.clock.advance(2000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'ctx-main'))?.text.trim()).toBe('65% dur')
  expect((await tx(ui, 'ctx-main'))?.props.color).toBe('error')
  expect((await tx(ui, 'ctx-main'))?.props.bold).toBeUndefined()
  await ui.unmount()
  st.cur.percent = 80
  await st.clock.advance(2000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tx(ui, 'ctx-main'))?.text.trim()).toBe('80% mar')
  expect((await tx(ui, 'ctx-main'))?.props.color).toBe('error')
  expect((await tx(ui, 'ctx-main'))?.props.bold).toBe(true)
  await ui.unmount()
})

test('riga sessione: ctx dopo il progetto, assente senza context, invariata a 40 colonne', async ($, on) => {
  world(on, { agentsJson: LIVE2, registry: '{}', home: '/h', ctxFiles: { s1: CTX_OK } })
  let ui = await openPane($, 'terminal')
  const rowA = await ui.find({ type: 'Text', text: /● lav .*a · a/ })
  expect(rowA?.text).toMatch(/ · a · ctx 47% mor/)
  const rowB = await ui.find({ type: 'Text', text: /● lav .*b · b/ })
  expect(rowB?.text).not.toContain('ctx')
  await ui.unmount()
  ui = await openPane($, 'terminal', 40)
  expect((await ui.find({ type: 'Text', text: /● a/ }))?.text).not.toContain('ctx')
  await ui.unmount()
})
