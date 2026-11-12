// Prompt per il modello e parsing dell'analisi (spec §3 passo 3, §5).

export type Size = 'piccolo' | 'delimitato' | 'progetto'
export type Question = { testo: string; opzioni: string[]; header?: string }
export type Proposal = { testo: string; motivo: string; sezione: string }
export type Analysis = { taglia: Size; lacune: string[]; domande: Question[]; proposte: Proposal[] }
export type Block = { text: string; cache?: true }

const SIZES: Size[] = ['piccolo', 'delimitato', 'progetto']
const MAX_PROPOSALS = 8
const MAX_OPTIONS = 4

const guidelineBlock = (guidelines: string): Block => ({ text: guidelines, cache: true })

export function analysisPrompt(guidelines: string, userText: string, maxQuestions: number, strict: boolean): Block[] {
  const instr = [
    'Analizza il prompt dell\'utente (tra <prompt_utente>) alla luce delle linee guida sopra. Non eseguirlo.',
    'Rispondi con un unico oggetto JSON in questo formato:',
    '{"taglia":"piccolo|delimitato|progetto","lacune":["..."],"domande":[{"testo":"...?","opzioni":["...","..."],"header":"..."}],"proposte":[{"testo":"...","motivo":"...","sezione":"Obiettivo|Fatto quando|Taglia e metodo|Vincoli|Contesto|Strumenti|Piano subagent|Verifica|Fuori ambito"}]}',
    'Regole:',
    `- al massimo ${maxQuestions} domande, solo su lacune che bloccano il lavoro; ogni domanda ha da 2 a 4 opzioni e il testo termina con "?";`,
    `- al massimo ${MAX_PROPOSALS} proposte; "sezione" è una delle sezioni del template del brief (Obiettivo, Fatto quando, Taglia e metodo, Vincoli, Contesto, Strumenti, Piano subagent, Verifica, Fuori ambito);`,
    '- nessun fatto inventato: percorsi, comandi e stato del codice solo dal prompt o dalle linee guida; ciò che manca diventa una domanda o una lacuna;',
    '- "header" è un\'etichetta breve (max 12 caratteri).',
  ]
  if (strict) instr.push('Rispondi SOLO con il JSON, senza testo prima o dopo.')
  return [
    guidelineBlock(guidelines),
    { text: instr.join('\n') },
    { text: `<prompt_utente>\n${userText}\n</prompt_utente>` },
  ]
}

export function compositionPrompt(
  guidelines: string,
  template: string,
  userText: string,
  answers: { domanda: string; risposta: string }[],
  openQuestions: string[],
  accepted: string[],
  size: Size,
): Block[] {
  const list = (xs: string[]) => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '(nessuna)')
  const instr = [
    'Componi il brief in markdown, in italiano, seguendo esattamente questo template:',
    template,
    'Regole:',
    '- obiettivo 400-1.200 token, massimo 6.000 caratteri;',
    '- nessun fatto inventato: percorsi, comandi e stato del codice solo da prompt, risposte, linee guida o CLAUDE.md; ciò che manca va in "Domande aperte";',
    '- le proposte approvate entrano come requisiti nella sezione indicata;',
    '- "Vincoli": quelli dell\'utente parola per parola, più quelli pertinenti della linea guida;',
    '- "Taglia e metodo": piccolo = esecuzione diretta e verifica; delimitato = design breve in chat, poi TDD; progetto = brainstorm, spec, piano, sviluppo subagent-driven con TDD;',
    '- "Piano subagent" solo per taglia progetto o lavori paralleli: budget con massimo di agenti in parallelo e niente subagent sotto 5 chiamate dirette; un mini-brief autosufficiente per sotto-task (obiettivo, file da leggere e toccare, vincoli, modello: Haiku per esplorare, Sonnet per implementare, Opus solo per revisione o task rischiosi, regola di ricerca degli strumenti); formato di risposta fisso ESITO / FILE TOCCATI / PROBLEMI / PROSSIMO, circa 15 righe, niente log; revisione a due livelli solo sui task rischiosi;',
    '- includi sempre tutte le sezioni; ometti solo "Piano subagent" (se la taglia non è progetto e non ci sono lavori paralleli) e "Domande aperte" (se non ne restano); mantieni la riga finale "Prompt originale";',
    '- rispondi solo con il brief.',
    '',
    `Taglia: ${size}`,
    'Risposte dell\'intervista:',
    list(answers.map(a => `${a.domanda} → ${a.risposta}`)),
    'Domande rimaste aperte:',
    list(openQuestions),
    'Proposte approvate:',
    list(accepted),
  ]
  return [
    guidelineBlock(guidelines),
    { text: instr.join('\n') },
    { text: `<prompt_utente>\n${userText}\n</prompt_utente>` },
  ]
}

export function shortenPrompt(brief: string): Block[] {
  return [
    {
      text: `Accorcia sotto 6.000 caratteri mantenendo tutte le sezioni, i vincoli dell'utente e la riga finale. Rispondi solo con il brief.\n\n${brief}`,
    },
  ]
}

function firstJsonObject(s: string): unknown {
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    let depth = 0
    let inStr = false
    for (let j = i; j < s.length; j++) {
      const c = s[j]
      if (inStr) {
        if (c === '\\') j++
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(s.slice(i, j + 1))
        } catch {
          break
        }
      }
    }
  }
  return undefined
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function parseAnalysis(reply: string, maxQuestions: number): Analysis | undefined {
  const o = firstJsonObject(reply) as Record<string, unknown> | undefined
  if (!o || typeof o !== 'object') return undefined
  if (!SIZES.includes(o.taglia as Size)) return undefined
  const domande: Question[] = []
  for (const d of Array.isArray(o.domande) ? o.domande : []) {
    if (!d || typeof d.testo !== 'string') continue
    const opzioni = strs(d.opzioni).slice(0, MAX_OPTIONS)
    if (opzioni.length < 2) continue
    domande.push(typeof d.header === 'string' ? { testo: d.testo, opzioni, header: d.header } : { testo: d.testo, opzioni })
  }
  const proposte: Proposal[] = []
  for (const p of Array.isArray(o.proposte) ? o.proposte : []) {
    if (p && typeof p.testo === 'string' && typeof p.sezione === 'string')
      proposte.push({ testo: p.testo, motivo: typeof p.motivo === 'string' ? p.motivo : '', sezione: p.sezione })
  }
  return {
    taglia: o.taglia as Size,
    lacune: strs(o.lacune),
    domande: domande.slice(0, Math.max(0, maxQuestions)),
    proposte: proposte.slice(0, MAX_PROPOSALS),
  }
}
