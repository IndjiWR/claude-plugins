import { expect, test } from 'claude-code/testing'
import { agentHandoffPath, agentLimits, agentResume, agentZoneNote, agentZoneOf, appendGaps, capByTokens, handoffModel, isStale, leadFallback, parseVerdict, pauseNote, resumedHandoff, setFront } from '../hooks/agents'

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
  expect(note).toContain(`test -s ${path}`)
  expect(agentZoneNote('teammate', 3, 190_000, main, path, 'general-purpose')).toContain('subito')
})

test('agentZoneNote: subagent', () => {
  const note = agentZoneNote('subagent', 2, 160_000, main, path, 'Explore')
  expect(note).toContain(`HANDOFF ${path}`)
  expect(note).toContain('Explore')
  expect(note).toContain(`test -s ${path}`)
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
    // Sezione del modello della skill, non un nome che il validatore non trova.
    expect(note).toContain('in «Modifiche», alla riga «Non committato»')
    expect(note).not.toContain('File toccati')
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
  expect(resumedHandoff("Riprendi dall'handoff /Users/x/p/.claude/handoff/pending/s1--a7.md (repo /x)")).toEqual({ ...found, absolute: '/Users/x/p/.claude/handoff/pending/s1--a7.md' })
  expect(resumedHandoff("Riprendi dall'handoff C:/p/.claude/handoff/pending/s1--a7.md")?.absolute).toBe('C:/p/.claude/handoff/pending/s1--a7.md')
  expect(resumedHandoff("Riprendi dall'handoff .claude/handoff/pending/s1.md")).toBe(undefined)
  expect(resumedHandoff('Fai qualcosa di diverso')).toBe(undefined)
  expect(resumedHandoff('riprendi dall’handoff .claude/handoff/pending/s1--a7.md')).toEqual(found)
})

// Fonti minime con la stessa forma di skills/handoff/SKILL.md e agents/handoff-validator.md.
const skillSrc = [
  '# Handoff', '', '1. passi', '2. **Raccogli i fatti, non andare a memoria**: `git status --short` e i test.', '   Ciò che non hai verificato va in ipotesi.', '3. **Scrivi** il file.', '', '## Formato', '', 'Ogni sezione è obbligatoria; se non ha contenuto scrivi "nessuno".', '',
  '```markdown', '---', 'status: draft', 'session: ${CLAUDE_SESSION_ID}', 'rounds: 0', 'mode: <solo per una pausa>', '---', '# Handoff: <titolo>', '',
  '## Obiettivo', '- Fatto quando: <criterio>', '', '## Prossimo passo immediato', '<una sola azione concreta>', '```', '',
  '## Regole', '', '- Autosufficiente', '- Solo fatti verificati', '', '## Variante agente', '', '- File: quello della nota',
].join('\n')
const validatorSrc = [
  '---', 'name: handoff-validator', '---', '', 'Ricevi soltanto il percorso.', '',
  'Controlla questi punti; ogni punto che non passa va in LACUNE, con cosa aggiungere:', '',
  '1. **Autosufficiente**: niente rimandi.', '2. **Prossimo passo immediato**: una sola azione concreta.', '',
  'Rispondi esattamente con queste sezioni:', '', 'VERDETTO: completo | da integrare',
].join('\n')

test('handoffModel: modello della skill e punti del validatore, frontmatter da agente', () => {
  const model = handoffModel(skillSrc, validatorSrc, 'a7')
  expect(model).toContain('Ogni sezione è obbligatoria')
  expect(model).toContain('## Obiettivo')
  expect(model).toContain('## Prossimo passo immediato\n<una sola azione concreta>')
  expect(model).toContain('status: ready')
  expect(model).toContain('agent: a7')
  expect(model).not.toContain('status: draft')
  expect(model).not.toContain('CLAUDE_SESSION_ID')
  expect(model).not.toContain('mode:')
  expect(model).toContain('1. **Autosufficiente**: niente rimandi.')
  expect(model).toContain('2. **Prossimo passo immediato**: una sola azione concreta.')
  expect(model).not.toContain('VERDETTO')
  // Il passo «Raccogli i fatti» e le regole della skill, non la variante agente (la nota la riassume già).
  expect(model).toContain('**Raccogli i fatti, non andare a memoria**: `git status --short` e i test.\n   Ciò che non hai verificato va in ipotesi.')
  expect(model).not.toContain('**Scrivi** il file')
  expect(model).toContain('- Autosufficiente\n- Solo fatti verificati')
  expect(model).not.toContain('Variante agente')
  expect(model).not.toContain('quello della nota')
})

test('handoffModel: punti del validatore solo dal blocco numerato, anche con CRLF e senza «Rispondi esattamente»', () => {
  const tail = ['Controlla questi punti:', '', '1. **Uno**: a.', '2. **Due**: b.', '', 'Testo estraneo che non è un punto.'].join('\r\n')
  const model = handoffModel(skillSrc.replace(/\n/g, '\r\n'), tail, 'a7')
  expect(model).toContain('1. **Uno**: a.\n2. **Due**: b.')
  expect(model).not.toContain('estraneo')
  expect(model).toContain('agent: a7')
  expect(model).toContain('## Prossimo passo immediato')
})

test('handoffModel: fonti mancanti o senza marcatori danno stringa vuota', () => {
  expect(handoffModel('', validatorSrc, 'a7')).toBe('')
  expect(handoffModel(skillSrc, '', 'a7')).toBe('')
  expect(handoffModel('# Handoff senza formato', validatorSrc, 'a7')).toBe('')
  expect(handoffModel(skillSrc, 'nessun elenco numerato', 'a7')).toBe('')
})

test('agentZoneNote: con il modello lo accoda e rimanda a quello', () => {
  const model = handoffModel(skillSrc, validatorSrc, 'a7')
  for (const kind of ['teammate', 'subagent'] as const) {
    const note = agentZoneNote(kind, 1, 125_000, main, path, 'general-purpose', model)
    expect(note).toContain(model)
    expect(note).toContain('modello qui sotto, tutte le sezioni obbligatorie')
    expect(note).not.toContain('nel formato della skill')
  }
  // Senza modello resta il rimando alla skill.
  expect(agentZoneNote('teammate', 1, 125_000, main, path, 'general-purpose')).toContain('nel formato della skill auto-clear-context:handoff')
})

test('capByTokens: per ogni livello la più bassa fra percentuale e token', () => {
  const pct = { soft: 40, hard: 60, margin: 75 }
  expect(capByTokens(pct, 180_000, 250_000, 1_000_000)).toEqual({ soft: 18, hard: 25, margin: 28 })
  // Dura in token non oltre la morbida: morbida + 30k; decimali a 0,1.
  expect(capByTokens(pct, 192_000, 0, 1_000_000)).toEqual({ soft: 19.2, hard: 22.2, margin: 25.2 })
  // Token oltre le percentuali: restano le percentuali.
  expect(capByTokens(pct, 900_000, 950_000, 1_000_000)).toEqual(pct)
  // Spente, monitor spento, finestra ignota o nulla: nessun cambio.
  expect(capByTokens(pct, 0, 250_000, 1_000_000)).toEqual(pct)
  expect(capByTokens({ soft: 0, hard: 10, margin: 25 }, 180_000, 0, 1_000_000)).toEqual({ soft: 0, hard: 10, margin: 25 })
  expect(capByTokens(pct, 180_000, 0, undefined)).toEqual(pct)
  expect(capByTokens(pct, 180_000, 0, 0)).toEqual(pct)
  expect(capByTokens(pct, Number.NaN, 0, 1_000_000)).toEqual(pct)
  // Una soglia in token minuscola non spegne il monitor: almeno 0,1%.
  expect(capByTokens(pct, 40, 0, 1_000_000).soft).toBe(0.1)
})
