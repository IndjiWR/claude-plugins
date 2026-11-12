import { expect, test } from 'claude-code/testing'

import { agentValue, contextFilePath, contextTokens, ctxCell, ctxText, limitsFrom, mainValue, parseContextFile, zoneOf } from '../hooks/context'
import { formatCompact } from '../hooks/ledger'

const rows = (s: unknown, h: unknown) => [
  { key: 'auto-clear-context.threshold', value: s },
  { key: 'auto-clear-context.hardThreshold', value: h },
]
const L = { soft: 40, hard: 60, margin: 75 }

test('limitsFrom deriva hard e margine come auto-clear-context', () => {
  expect(limitsFrom(rows(40, 60))).toEqual({ soft: 40, hard: 60, margin: 75 })
  expect(limitsFrom(rows(50, 55))).toEqual({ soft: 50, hard: 60, margin: 75 })
  expect(limitsFrom(rows(85, 95))).toEqual({ soft: 85, hard: 95, margin: 95 })
})

test('limitsFrom restituisce undefined se spento, assente o non numerico', () => {
  expect(limitsFrom(rows(0, 60))).toBeUndefined()
  expect(limitsFrom([])).toBeUndefined()
  expect(limitsFrom(rows('40', 60))).toBeUndefined()
})

test('zoneOf', () => {
  expect([39, 40, 59, 60, 74, 75, 104].map(p => zoneOf(p, L))).toEqual([0, 1, 1, 2, 2, 3, 3])
})

test('contextTokens somma input e cache, ignora campi extra', () => {
  expect(contextTokens({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7, model: 'm' })).toBe(115)
})

test('mainValue', () => {
  expect(mainValue(undefined, L)).toEqual({})
  expect(mainValue({ window: 1000 }, L)).toEqual({})
  expect(mainValue({ tokens: 470, window: 1000, percent: 47 }, L)).toEqual({ percent: 47, tokens: 470, zone: 1 })
  expect(mainValue({ tokens: 470, window: 1000, percent: 47 }, undefined)).toEqual({ percent: 47, tokens: 470 })
})

test('agentValue', () => {
  const u = (o: object) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, firstAt: 0, lastAt: 0, ...o })
  expect(agentValue(u({ ctxTokens: 500, ctxModel: 'a' }), 1000, 'a', L)).toEqual({ percent: 50, tokens: 500, zone: 1 })
  expect(agentValue(u({ ctxTokens: 333, ctxModel: 'a' }), 1000, 'a', L)).toEqual({ percent: 33, tokens: 333, zone: 0 })
  expect(agentValue(u({ ctxTokens: 500, ctxModel: 'b' }), 1000, 'a', L)).toEqual({ tokens: 500 })
  expect(agentValue(u({}), 1000, 'a', L)).toEqual({})
  expect(agentValue(undefined, 1000, 'a', L)).toEqual({})
})

test('ctxCell e ctxText', () => {
  expect(ctxCell({ percent: 47, zone: 1 })).toBe('47% mor')
  expect(ctxCell({ percent: 47 })).toBe('47%')
  expect(ctxCell({ tokens: 85000 })).toBe(formatCompact(85000))
  expect(ctxCell({})).toBe('—')
  expect(ctxCell({ percent: 104, zone: 3 })).toBe('104% mar')
  expect(ctxText({ percent: 47, zone: 1 })).toBe('ctx 47% (zona morbida)')
  expect(ctxText({ percent: 47 })).toBe('ctx 47%')
  expect(ctxText({ tokens: 85000 })).toBe(`ctx ${formatCompact(85000)}`)
  expect(ctxText({})).toBe('')
})

test('parseContextFile', () => {
  expect(parseContextFile('{"tokens":5,"window":10,"percent":50,"zone":1,"at":9}')).toEqual({ tokens: 5, window: 10, percent: 50, zone: 1, at: 9 })
  expect(parseContextFile('{"zone":null,"at":1}')).toEqual({ zone: null, at: 1 })
  expect(parseContextFile('{rotto')).toBeUndefined()
  expect(parseContextFile('[1]')).toBeUndefined()
  expect(parseContextFile('{"zone":1}')).toBeUndefined()
  expect(parseContextFile('{"zone":7,"at":1}')).toBeUndefined()
})

test('contextFilePath', () => {
  expect(contextFilePath('/home/u', 'abc')).toBe('/home/u/.claude/agent-monitor/contesto/abc.json')
})
