import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
  const state = { tokens: 0 as number | null }
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: 'C:/progetto' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 0, percent: 0 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: agents as never }))
  on('fs.read', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
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
