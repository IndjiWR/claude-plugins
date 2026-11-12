import { expect, test } from 'claude-code/testing'

import { analysisPrompt, compositionPrompt, parseAnalysis, shortenPrompt } from '../hooks/prompts'

const valid = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    taglia: 'delimitato',
    lacune: ['manca il framework'],
    domande: [{ testo: 'Quale framework?', opzioni: ['React', 'Vue'], header: 'Framework' }],
    proposte: [{ testo: 'Test e2e', motivo: 'copertura', sezione: 'Verifica' }],
    ...over,
  })
const q = (i: number, n = 2) => ({ testo: `D${i}?`, opzioni: ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, n) })

test('analysisPrompt: struttura dei blocchi', () => {
  const b = analysisPrompt('LINEE-GUIDA', 'fai x', 5, false)
  expect(b[0].cache).toBe(true)
  expect(b[0].text).toContain('LINEE-GUIDA')
  expect(b[b.length - 1].text).toContain('<prompt_utente>')
  expect(b.map(x => x.text).join('\n')).not.toContain('SOLO con il JSON')
  expect(analysisPrompt('g', 'x', 5, true).map(x => x.text).join('\n')).toContain('SOLO con il JSON')
})

test('parseAnalysis accetta il recinto json', () => {
  const a = parseAnalysis('Ecco:\n```json\n' + valid() + '\n```', 5)
  expect(a?.taglia).toBe('delimitato')
  expect(a?.domande[0].header).toBe('Framework')
})

test('parseAnalysis tronca e filtra', () => {
  const dom = Array.from({ length: 7 }, (_, i) => q(i))
  expect(parseAnalysis(valid({ domande: dom }), 5)?.domande.length).toBe(5)
  const pro = Array.from({ length: 10 }, (_, i) => ({ testo: `p${i}`, motivo: 'm', sezione: 'Verifica' }))
  expect(parseAnalysis(valid({ proposte: pro }), 5)?.proposte.length).toBe(8)
  expect(parseAnalysis(valid({ domande: [q(1, 1), q(2)] }), 5)?.domande.length).toBe(1)
  expect(parseAnalysis(valid({ domande: [q(1, 6)] }), 5)?.domande[0].opzioni.length).toBe(4)
})

test('parseAnalysis rifiuta input non valido', () => {
  expect(parseAnalysis('non è json', 5)).toBeUndefined()
  expect(parseAnalysis(valid({ taglia: 'enorme' }), 5)).toBeUndefined()
})

test('compositionPrompt include template, risposte, proposte e taglia', () => {
  const b = compositionPrompt('GL', 'TEMPLATE-X', 'prompt', [{ domanda: 'Quale?', risposta: 'Vue' }], ['aperta?'], ['Test e2e'], 'progetto')
  expect(b[0].cache).toBe(true)
  const all = b.map(x => x.text).join('\n')
  for (const s of ['TEMPLATE-X', 'Quale?', 'Vue', 'aperta?', 'Test e2e', 'progetto']) expect(all).toContain(s)
})

test('shortenPrompt', () => {
  expect(shortenPrompt('BRIEF').map(x => x.text).join('\n')).toContain('6.000')
})
