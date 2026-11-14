import { expect, test } from 'claude-code/testing'
import { agentHandoffPath, agentLimits, agentResume, agentZoneNote, agentZoneOf, appendGaps, isStale, leadFallback, parseVerdict, pauseNote, resumedHandoff, setFront } from '../hooks/agents'

const main = agentLimits(true, 120_000, 150_000)
const path = '.claude/handoff/pending/s1--a7.md'

test('agentLimits: token propri, indipendenti dalla principale', () => {
  expect(agentLimits(true, 120_000, 150_000)).toEqual({ soft: 120_000, hard: 150_000, margin: 180_000 })
  expect(agentLimits(true, 120_000, 100_000)).toEqual({ soft: 120_000, hard: 150_000, margin: 180_000 })
  expect(agentLimits(false, 120_000, 150_000)).toEqual({ soft: 0, hard: 0, margin: 0 })
  expect(agentLimits(true, 0, 150_000)).toEqual({ soft: 0, hard: 0, margin: 0 })
})

test('agentZoneOf: zone in token', () => {
  const l = agentLimits(true, 120_000, 150_000)
  expect([119_999, 120_000, 150_000, 180_000].map(t => agentZoneOf(t, l))).toEqual([0, 1, 2, 3])
})

test('agentZoneNote: token e soglie in k', () => {
  expect(agentZoneNote('teammate', 1, 196_526, main, path, 'general-purpose')).toContain(
    '~197k token (soglie 120k/150k, margine di sicurezza a 180k)',
  )
})

test('agentHandoffPath: un file per sessione e agente', () => {
  expect(agentHandoffPath('s1', 'a7')).toBe(path)
})

test('agentZoneNote: teammate', () => {
  const note = agentZoneNote('teammate', 1, 125_000, main, path, 'general-purpose')
  expect(note).toContain(path)
  expect(note).toContain('status: ready')
  expect(note).toContain('agent: a7')
  expect(note).toContain('Non lanciare il validatore: lo fa la mod.')
  expect(agentZoneNote('teammate', 3, 190_000, main, path, 'general-purpose')).toContain('subito')
})

test('agentZoneNote: subagent', () => {
  const note = agentZoneNote('subagent', 2, 160_000, main, path, 'Explore')
  expect(note).toContain(`HANDOFF ${path}`)
  expect(note).toContain('Explore')
  expect(note).toContain('status: ready')
  expect(agentZoneNote('subagent', 3, 190_000, main, path, 'Explore')).toContain('subito')
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

test("agentZoneNote: commit dei propri file prima dell'handoff", () => {
  for (const kind of ['teammate', 'subagent'] as const) {
    const note = agentZoneNote(kind, 1, 130_000, main, path, 'general-purpose')
    expect(note).toContain('git add <file>')
    expect(note).toContain('mai git add -A')
    expect(note).toContain('non committati')
  }
  expect(agentZoneNote('teammate', 1, 130_000, main, path, 'x')).toContain(`HANDOFF ${path}: la mod valida e rilancia questo teammate, non riprendere da solo`)
})

test('isStale: scadenza in minuti, 0 la spegne', () => {
  expect(isStale(0, 30 * 60_000, 30)).toBe(true)
  expect(isStale(0, 30 * 60_000 - 1, 30)).toBe(false)
  expect(isStale(0, 1e12, 0)).toBe(false)
})

test("resumedHandoff: percorso dell'handoff di un subagent ripreso", () => {
  const found = { path: '.claude/handoff/pending/s1--a7.md', agentId: 'a7' }
  expect(resumedHandoff("Riprendi dall'handoff .claude/handoff/pending/s1--a7.md (repo /x)")).toEqual(found)
  expect(resumedHandoff("Riprendi dall'handoff /Users/x/p/.claude/handoff/pending/s1--a7.md (repo /x)")).toEqual(found)
  expect(resumedHandoff("Riprendi dall'handoff .claude/handoff/pending/s1.md")).toBe(undefined)
  expect(resumedHandoff('Fai qualcosa di diverso')).toBe(undefined)
})
