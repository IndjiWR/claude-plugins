// Pipeline del brief: analisi → intervista → proposte → composizione → anteprima (spec §3 passi 3-7, §8).

import { analysisPrompt, compositionPrompt, parseAnalysis, shortenPrompt } from './prompts'
import type { Analysis, Block, Size } from './prompts'

export type AskFn = (
  question: string,
  opts: { options: string[]; header?: string; multiSelect?: true },
) => Promise<string | undefined>
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type CompleteFn = (prompt: Block[]) => Promise<{ text?: string; usage: Usage }>
export type PipelineDeps = {
  ask: AskFn
  complete: CompleteFn
  guidelines: string
  template: string
  maxQuestions: number
}
export type Stats = { taglia: Size; domande: number; proposteAccettate: number; proposteTotali: number; usage: Usage }
export type PipelineResult =
  | { kind: 'brief'; text: string; stats: Stats }
  | { kind: 'original'; reason: string }
  | { kind: 'fallback'; reason: string }

const MAX_BRIEF = 6000
const WINDOW = 4
const SEND = 'Invia'
const SEND_ORIGINAL = "Invia l'originale"

// Seleziona le proposte di una finestra dalla risposta (multiSelect). Le etichette esatte vengono
// riconosciute per prime (il loro testo può contenere virgole); il resto si divide sulle virgole:
// le parti che iniziano con un numero valido sono scelte, le altre sono testo libero ("Other").
export function parseWindowAnswer(answer: string, labels: string[], firstIndex: number): { picked: number[]; extra: string[] } {
  const picked = new Set<number>()
  let rest = answer
  const byLength = labels.map((l, k) => ({ l, k })).sort((a, b) => b.l.length - a.l.length)
  for (const { l, k } of byLength) {
    if (rest.includes(l)) {
      picked.add(firstIndex + k)
      rest = rest.replace(l, ',')
    }
  }
  const extra: string[] = []
  for (const raw of rest.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const m = /^(\d+)\b/.exec(part)
    const n = m ? Number(m[1]) : NaN
    if (m && n >= firstIndex + 1 && n <= firstIndex + labels.length) picked.add(n - 1)
    else extra.push(part)
  }
  return { picked: [...picked].sort((a, b) => a - b), extra }
}

function summary(brief: string, size: Size): string {
  const sections = (brief.match(/^## /gm) ?? []).length
  const m = /^## Piano subagent[^\n]*\n([\s\S]*?)(?=^## |^---$|(?![\s\S]))/m.exec(brief)
  let subtasks = 0
  if (m) {
    const h = (m[1].match(/^### /gm) ?? []).length
    subtasks = h || (m[1].match(/^(?:- |\d+[.)] )/gm) ?? []).length
  }
  return `Brief pronto: taglia ${size}, ${sections} sezioni, ${subtasks} sotto-task nel Piano subagent.\n\n${brief}`
}

export async function runPipeline(userText: string, deps: PipelineDeps): Promise<PipelineResult> {
  const { ask, complete, guidelines, template, maxQuestions } = deps
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const call = async (prompt: Block[]): Promise<string | undefined> => {
    const r = await complete(prompt)
    usage.input += r.usage.input
    usage.output += r.usage.output
    usage.cacheRead += r.usage.cacheRead
    usage.cacheWrite += r.usage.cacheWrite
    return r.text
  }

  // Analisi (con un secondo tentativo strict se il JSON non è valido)
  let analysis: Analysis | undefined
  for (const strict of [false, true]) {
    const text = await call(analysisPrompt(guidelines, userText, maxQuestions, strict))
    if (text === undefined) return { kind: 'fallback', reason: 'analisi non riuscita' }
    analysis = parseAnalysis(text, maxQuestions)
    if (analysis) break
  }
  if (!analysis) return { kind: 'fallback', reason: 'analisi non valida' }

  // Intervista
  const answers: { domanda: string; risposta: string }[] = []
  const openQuestions: string[] = []
  for (const q of analysis.domande) {
    const a = await ask(q.testo, { options: q.opzioni, header: q.header })
    if (a === undefined) openQuestions.push(q.testo)
    else answers.push({ domanda: q.testo, risposta: a })
  }

  // Proposte, a finestre da 4
  const accepted: string[] = []
  const props = analysis.proposte
  for (let start = 0; start < props.length; start += WINDOW) {
    const win = props.slice(start, start + WINDOW)
    const labels = win.map((p, k) => `${start + k + 1}. ${p.testo}`)
    const a = await ask('Quali proposte vuoi includere nel brief?', {
      options: labels,
      header: 'Proposte',
      multiSelect: true,
    })
    if (a === undefined) continue
    const { picked, extra } = parseWindowAnswer(a, labels, start)
    for (const i of picked) accepted.push(props[i].testo)
    accepted.push(...extra)
  }

  // Composizione
  let brief = await call(compositionPrompt(guidelines, template, userText, answers, openQuestions, accepted, analysis.taglia))
  if (brief === undefined) return { kind: 'fallback', reason: 'composizione non riuscita' }
  if (brief.length > MAX_BRIEF) {
    const short = await call(shortenPrompt(brief))
    if (short !== undefined) brief = short
  }

  // Anteprima
  const choice = await ask(summary(brief, analysis.taglia), { options: [SEND, SEND_ORIGINAL], header: 'Anteprima' })
  if (choice !== SEND) return { kind: 'original', reason: 'anteprima rifiutata' }
  return {
    kind: 'brief',
    text: brief,
    stats: {
      taglia: analysis.taglia,
      domande: analysis.domande.length,
      proposteAccettate: accepted.length,
      proposteTotali: props.length,
      usage,
    },
  }
}
