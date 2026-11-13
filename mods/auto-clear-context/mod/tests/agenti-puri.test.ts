import { expect, test } from 'claude-code/testing'
import { agentHandoffPath, agentLimits, agentResume, agentZoneNote, appendGaps, leadFallback, parseVerdict, pauseNote, setFront } from '../hooks/agents'

const main = { soft: 40, hard: 60, margin: 75 }
const path = '.claude/handoff/pending/s1--a7.md'

test('agentLimits: soglie degli agenti dalla principale', () => {
  expect(agentLimits(main, 0)).toEqual({ soft: 40, hard: 60, margin: 75 })
  expect(agentLimits(main, 15)).toEqual({ soft: 15, hard: 35, margin: 50 })
  expect(agentLimits({ soft: 0, hard: 60, margin: 75 }, 15)).toEqual({ soft: 0, hard: 0, margin: 0 })
  expect(agentLimits({ soft: 80, hard: 90, margin: 95 }, 0).margin).toBe(95)
})

test('agentHandoffPath: un file per sessione e agente', () => {
  expect(agentHandoffPath('s1', 'a7')).toBe(path)
})

test('agentZoneNote: teammate', () => {
  const note = agentZoneNote('teammate', 1, 45, main, path, 'general-purpose')
  expect(note).toContain(path)
  expect(note).toContain('status: ready')
  expect(note).toContain('agent: a7')
  expect(note).toContain('Non lanciare il validatore: lo fa la mod.')
  expect(agentZoneNote('teammate', 3, 80, main, path, 'general-purpose')).toContain('subito')
})

test('agentZoneNote: subagent', () => {
  const note = agentZoneNote('subagent', 2, 65, main, path, 'Explore')
  expect(note).toContain(`HANDOFF ${path}`)
  expect(note).toContain('Explore')
  expect(note).toContain('status: ready')
  expect(agentZoneNote('subagent', 3, 80, main, path, 'Explore')).toContain('subito')
})

test('pauseNote: la principale riparte', () => {
  expect(pauseNote()).toContain('riparte')
})

test('parseVerdict', () => {
  expect(parseVerdict('LACUNE:\n- manca X\nVERDETTO: da integrare')).toEqual({ isComplete: false, gaps: '- manca X' })
  expect(parseVerdict('LACUNE: nessuna\nVERDETTO: completo').isComplete).toBe(true)
  expect(parseVerdict('LACUNE: x\nVERDETTO: incompleto').isComplete).toBe(false)
  expect(parseVerdict('niente').isComplete).toBe(false)
})

test('setFront e appendGaps', () => {
  const out = setFront('---\nstatus: ready\n---\n# H', { status: 'validated', rounds: '1' })
  expect(out).toContain('status: validated')
  expect(out).toContain('rounds: 1')
  expect(out.match(/status:/g)?.length).toBe(1)
  expect(out).toContain('# H')
  expect(setFront('# H', { status: 'x' }).startsWith('---\nstatus: x\n---')).toBe(true)
  expect(appendGaps('# H', '- manca X')).toBe('# H\n\n## Lacune segnalate dal validatore\n- manca X\n')
})

test('agentResume e leadFallback', () => {
  const resume = agentResume('# Handoff\nstato', '.claude/handoff/archive/x.md')
  expect(resume).toContain('Sei un teammate rilanciato dalla mod auto-clear-context')
  expect(resume).toContain('# Handoff\nstato')
  const fb = leadFallback('worker', path, 'TaskStop rifiutato')
  expect(fb).toContain('TaskStop')
  expect(fb).toContain('worker')
  expect(fb).toContain(`Riprendi dall'handoff ${path}`)
})
