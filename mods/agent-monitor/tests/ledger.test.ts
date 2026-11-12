import { expect, test } from 'claude-code/testing'

import { addTurn, buildTree, formatDuration, formatTokens, overThreshold, seedAgent, setModel, totals } from '../hooks/ledger'
import type { AgentLike } from '../hooks/ledger'
import type { UsageMap } from '../types'

const u = (o: Partial<UsageMap[string]> = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, firstAt: 0, lastAt: 0, ...o })
const ag = (o: Partial<AgentLike> & { id: string }): AgentLike => ({ status: 'running', description: 'd', type: 't', ...o })

test('addTurn somma su due turni', () => {
  let m = addTurn({}, 'a', { model: 'm', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, 100)
  m = addTurn(m, 'a', { model: 'm2', input_tokens: 1, output_tokens: 1 }, 200)
  expect(m.a).toEqual({ input: 11, output: 6, cacheRead: 2, cacheWrite: 1, model: 'm2', turns: 2, firstAt: 100, lastAt: 200 })
})

test('addTurn senza agentId scrive in main', () => {
  expect(Object.keys(addTurn({}, undefined, { input_tokens: 1 }, 5))).toEqual(['main'])
})

test('addTurn senza usage conta il turno', () => {
  const m = addTurn(addTurn({}, 'a', { input_tokens: 7 }, 1), 'a', undefined, 2)
  expect(m.a.turns).toBe(2)
  expect(m.a.input).toBe(7)
  expect(m.a.lastAt).toBe(2)
})

test('setModel', () => {
  const m = setModel({}, 'a', 'opus', 9)
  expect(m.a.model).toBe('opus')
  expect(m.a.turns).toBe(0)
  expect(m.a.firstAt).toBe(9)
  expect(setModel(m, 'a', 'x', 20).a.firstAt).toBe(9)
})

test('buildTree con radice, figlio, nipote, ordine e padre sconosciuto', () => {
  const usage: UsageMap = { main: u({ firstAt: 0 }), c: u({ firstAt: 20 }), b: u({ firstAt: 10 }), g: u({ firstAt: 30 }), o: u({ firstAt: 40 }) }
  const rows = buildTree(
    [ag({ id: 'c', parentId: 'main' }), ag({ id: 'b', name: 'B' }), ag({ id: 'g', parentId: 'c' }), ag({ id: 'o', parentId: 'zzz' })],
    usage,
    100,
  )
  expect(rows.map((r) => [r.id, r.depth])).toEqual([['main', 0], ['b', 1], ['c', 1], ['g', 2], ['o', 1]])
  expect(rows[0].label).toBe('Sessione principale')
  expect(rows[1].label).toBe('B')
  expect(rows[2].label).toBe('d')
  expect(rows[1].durationMs).toBe(90)
})

test('label troncata a 40 con ellissi', () => {
  const rows = buildTree([ag({ id: 'a', description: 'x'.repeat(60) })], {}, 0)
  expect(rows[1].label).toBe('x'.repeat(40) + '…')
})

test('label: nome vuoto ricade sulla descrizione', () => {
  const rows = buildTree([ag({ id: 'a', name: '', description: 'Desc' })], {}, 0)
  expect(rows[1].label).toBe('Desc')
})

test('seedAgent fissa firstAt una volta; addTurn lo mantiene', () => {
  const s = seedAgent({}, 'a', 5)
  expect(s.a.firstAt).toBe(5)
  expect(seedAgent(s, 'a', 99)).toBe(s)
  expect(seedAgent({}, 'b', 5, 'opus').b.model).toBe('opus')
  expect(addTurn(s, 'a', { input_tokens: 1 }, 50).a.firstAt).toBe(5)
})

test("agente rimosso dall'elenco diventa completed", () => {
  const rows = buildTree([], { main: u(), gone: u({ firstAt: 10, lastAt: 50, turns: 3 }) }, 1000)
  const r = rows.find((x) => x.id === 'gone')!
  expect(r.status).toBe('completed')
  expect(r.durationMs).toBe(40)
  expect(r.turns).toBe(3)
})

test('totals', () => {
  expect(totals({ a: u({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 2 }), b: u({ input: 1 }) })).toEqual({ input: 2, output: 2, cacheRead: 3, cacheWrite: 4, turns: 3 })
})

test('overThreshold', () => {
  const usage: UsageMap = { main: u({ input: 999 }), a: u({ input: 100, output: 50 }), b: u({ input: 10 }), c: u({ input: 500 }) }
  expect(overThreshold(usage, {}, 120)).toEqual(['a', 'c'])
  expect(overThreshold(usage, { a: true }, 120)).toEqual(['c'])
  expect(overThreshold(usage, {}, 1000)).toEqual([])
  expect(overThreshold(usage, {}, 0)).toEqual([])
})

test('formatTokens', () => {
  expect(formatTokens(850)).toBe('850')
  expect(formatTokens(12345)).toBe('12,3k')
  expect(formatTokens(1234567)).toBe('1,2M')
})

test('formatDuration', () => {
  expect(formatDuration(45000)).toBe('45s')
  expect(formatDuration(185000)).toBe('3m 05s')
  expect(formatDuration(3720000)).toBe('1h 02m')
})
