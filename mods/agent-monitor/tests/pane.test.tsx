import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'agent-monitor',
  component: 'Pane',
  requestId: 'agenti',
  props: { title: 'Agenti', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const AGENTS = [
  { id: 'a1', status: 'running', description: 'Cerca file', type: 't' },
  { id: 'a2', parentId: 'a1', status: 'completed', name: 'Figlio', description: 'x', type: 't' },
]

type Cfg = { agents?: unknown[]; placed?: boolean; answer?: string; dismiss?: boolean; failList?: boolean; failStop?: boolean }
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
    clock,
  }
  on('agent.list', () => {
    st.lists++
    if (st.cfg.failList) throw new Error('giù')
    return { value: st.cfg.agents ?? AGENTS } as never
  })
  on('ui.open', (_, e) => {
    st.opens.push(e)
    return { value: st.cfg.placed ? { isPlaced: true } : { isPlaced: false, reason: 'troppo stretto' } } as never
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
  expect((await tx(ui, 'label-a2'))?.text).toMatch(/^ {2}└ Figlio/)
  expect((await tx(ui, 'status-a1'))?.text).toContain('● run')
  expect((await tx(ui, 'status-a2'))?.text).toContain('✓ fin')
  expect((await tx(ui, 'head'))?.text).toMatch(/STATO.*AGENTE.*MODELLO.*TOKEN.*DUR.*TURNI/)
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
  expect((await tx(ui, 'detail'))?.text).toBe('in 10 · out 5 · cache 3+4')
  expect((await tx(ui, 'status-a2'))?.props.dimColor).toBe(true)
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
  expect((await tx(ui, 'tokens-a1'))?.text).toMatch(/█/)
  await ui.unmount()
  ui = await at(65)
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
    const dur = head.indexOf('DUR')
    if (dur >= 0) expect(dur - 2).toBe(st.length + lb.length + 9 + tk.length)
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
