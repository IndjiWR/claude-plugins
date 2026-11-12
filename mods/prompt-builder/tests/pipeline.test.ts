import { expect, test } from 'claude-code/testing'

import { runPipeline } from '../hooks/pipeline'
import type { AskFn, CompleteFn } from '../hooks/pipeline'

const u = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }
const analysis = (nq: number, np: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    taglia: 'progetto',
    lacune: [],
    domande: Array.from({ length: nq }, (_, i) => ({ testo: `D${i}?`, opzioni: ['si', 'no'], header: `H${i}` })),
    proposte: Array.from({ length: np }, (_, i) => ({ testo: `prop ${i + 1}`, motivo: 'm', sezione: 'Verifica' })),
    ...over,
  })

function world(completes: (string | undefined)[], asks: (string | undefined)[]) {
  const cq = [...completes]
  const aq = [...asks]
  const prompts: { text: string }[][] = []
  const questions: { q: string; opts: Parameters<AskFn>[1] }[] = []
  const complete: CompleteFn = async p => {
    prompts.push(p)
    return { text: cq.shift(), usage: u }
  }
  const ask: AskFn = async (q, opts) => {
    questions.push({ q, opts })
    return aq.shift()
  }
  const run = (text = 'fai x') =>
    runPipeline(text, { ask, complete, guidelines: 'G', template: 'T', maxQuestions: 5 })
  return { run, prompts, questions }
}
const BRIEF = '# Brief: x\n## Obiettivo\nx\n## Piano subagent\n### A\n### B\n## Verifica\nv\n---\nPrompt originale: p'

test('flusso completo', async () => {
  const w = world([analysis(2, 5), BRIEF], ['si', 'no', '1. prop 1, 3. prop 3', '5. prop 5', 'Invia'])
  const r = await w.run()
  expect(r.kind).toBe('brief')
  if (r.kind !== 'brief') return
  expect(w.questions.length).toBe(5)
  expect(w.questions[0].opts.header).toBe('H0')
  expect(w.questions[2].opts.options.length).toBe(4)
  expect(w.questions[2].opts.multiSelect).toBe(true)
  expect(w.questions[3].opts.options).toEqual(['5. prop 5'])
  expect(r.stats.proposteAccettate).toBe(3)
  expect(r.stats.proposteTotali).toBe(5)
  expect(r.stats.domande).toBe(2)
  expect(r.stats.usage).toEqual({ input: 20, output: 10, cacheRead: 4, cacheWrite: 2 })
  expect(w.questions[4].q).toContain('2 sotto-task')
  expect(w.questions[4].opts.options).toEqual(['Invia', "Invia l'originale"])
  expect(r.text).toBe(BRIEF)
})

test('nessuna domanda né proposta', async () => {
  const w = world([analysis(0, 0), BRIEF], ['Invia'])
  const r = await w.run()
  expect(r.kind).toBe('brief')
  expect(w.questions.length).toBe(1)
})

test("risposta libera uguale a un'etichetta", async () => {
  const w = world([analysis(1, 0), BRIEF], ['no', 'Invia'])
  await w.run()
  expect(w.prompts[1].map(b => b.text).join('\n')).toContain('D0? → no')
})

test('proposte con virgole nel testo', async () => {
  const props = [
    { testo: 'usa a, b e c', motivo: 'm', sezione: 'Verifica' },
    { testo: 'due', motivo: 'm', sezione: 'Verifica' },
    { testo: 'test', motivo: 'm', sezione: 'Verifica' },
  ]
  const w = world([analysis(0, 0, { proposte: props }), BRIEF], ['1. usa a, b e c, 3. test', 'Invia'])
  const r = await w.run()
  expect(r.kind === 'brief' && r.stats.proposteAccettate).toBe(2)
  expect(w.prompts[1].map(b => b.text).join('\n')).toContain('- usa a, b e c\n- test')
})

test('Other nelle proposte', async () => {
  const w = world([analysis(0, 3), BRIEF], ['2. prop 2, aggiungi i log', 'Invia'])
  const r = await w.run()
  expect(r.kind === 'brief' && r.stats.proposteAccettate).toBe(2)
  expect(w.prompts[1].map(b => b.text).join('\n')).toContain('- prop 2\n- aggiungi i log')
})

test('finestra proposte chiusa', async () => {
  const w = world([analysis(0, 2), BRIEF], [undefined, 'Invia'])
  const r = await w.run()
  expect(r.kind === 'brief' && r.stats.proposteAccettate).toBe(0)
})

test('domanda chiusa finisce in openQuestions', async () => {
  const w = world([analysis(1, 0), BRIEF], [undefined, 'Invia'])
  await w.run()
  const text = w.prompts[1].map(b => b.text).join('\n')
  expect(text).toContain('Domande rimaste aperte:\n- D0?')
})

test("errore API all'analisi", async () => {
  const w = world([undefined], [])
  expect((await w.run()).kind).toBe('fallback')
})

test('JSON non valido poi valido', async () => {
  const w = world(['boh', analysis(0, 0), BRIEF], ['Invia'])
  const r = await w.run()
  expect(r.kind).toBe('brief')
  expect(w.prompts.length).toBe(3)
  expect(w.prompts[1].map(b => b.text).join('\n')).toContain('SOLO con il JSON')
})

test('JSON non valido due volte', async () => {
  const w = world(['boh', 'boh'], [])
  expect((await w.run()).kind).toBe('fallback')
  expect(w.prompts.length).toBe(2)
})

test('composizione fallita', async () => {
  const w = world([analysis(0, 0), undefined], [])
  expect((await w.run()).kind).toBe('fallback')
})

test('brief troppo lungo', async () => {
  const w = world([analysis(0, 0), 'x'.repeat(6001), BRIEF], ['Invia'])
  const r = await w.run()
  expect(w.prompts.length).toBe(3)
  expect(r.kind === 'brief' && r.text).toBe(BRIEF)
})

test('accorciamento fallito: tiene il brief lungo', async () => {
  const long = 'x'.repeat(6001)
  const w = world([analysis(0, 0), long, undefined], ['Invia'])
  const r = await w.run()
  expect(r.kind === 'brief' && r.text).toBe(long)
})

test('anteprima chiusa o rifiutata', async () => {
  for (const a of [undefined, "Invia l'originale"]) {
    const r = await world([analysis(0, 0), BRIEF], [a]).run()
    expect(r).toEqual({ kind: 'original', reason: 'anteprima rifiutata' })
  }
})
