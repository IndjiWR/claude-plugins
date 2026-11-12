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

type Cfg = { placed?: boolean; answer?: string; failList?: boolean; failStop?: boolean }
const world = (on: On, cfg: Cfg = {}) => {
  mock.store(on)
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
    return { value: AGENTS } as never
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
      return { result: { questions: [], answers: { [q]: st.cfg.answer } } } as never
    }
    st.stops.push(e)
    if (st.cfg.failStop) throw new Error('no')
    return { result: {} } as never
  })
  return st
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

test('render: radice, figlio indentato, totale', async ($, on) => {
  world(on)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Sessione principale/ }))?.text).toContain('running Sessione principale')
  expect((await ui.find({ type: 'Text', text: /^ {2}running Cerca file/ }))?.text).toContain('Cerca file')
  expect((await ui.find({ type: 'Text', text: /^ {4}completed Figlio/ }))?.text).toContain('Figlio')
  expect(await ui.find({ type: 'Text', text: /Totale:/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /elenco non aggiornato/ })).toBeUndefined()
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

test('agente completed: Transcript sì, Ferma no; main senza pulsanti', async ($, on) => {
  world(on)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'transcript-a2' })).toBeDefined()
  expect(await ui.find({ key: 'stop-a2' })).toBeUndefined()
  expect(await ui.find({ key: 'stop-a1' })).toBeDefined()
  expect(await ui.find({ key: 'transcript-main' })).toBeUndefined()
  await ui.unmount()
})
