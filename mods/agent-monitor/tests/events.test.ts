import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { textSummary } from '../hooks/register'
import { buildTree, totals } from '../hooks/ledger'

const summary = async ($: { command: { run: (i: never) => Promise<unknown> } }) =>
  ((await $.command.run({ command: 'agenti', args: '' } as never)) as { text: string }).text

const world = (on: On, agents: unknown[] = []) => {
  mock.store(on)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  let t = 1000
  on('clock.now', () => ({ value: (t += 10) }) as never)
  const st = { toasts: [] as string[], views: [] as unknown[], registered: [] as unknown[], spawnId: 'new1' }
  on('agent.list', () => ({ value: agents }) as never)
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
