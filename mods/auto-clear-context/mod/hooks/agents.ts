// Funzioni pure per l'estensione agli agenti (subagent e teammate): soglie,
// percorsi, note, verdetto del validatore, frontmatter, prompt di ripresa.

export type Limits = { soft: number; hard: number; margin: number }
export type AgentKind = 'teammate' | 'subagent'

const HANDOFF_DIR = '.claude/handoff'

const NATURAL_POINTS = [
  'un sotto-task finito e verificato (test verdi o build ok)',
  'il risultato di un subagent appena integrato',
  'prima di aprire un file nuovo o di iniziare un sotto-task nuovo',
].join('; ')
const NEVER_POINTS = [
  'a metà di un edit o con modifiche su più file non ancora coerenti',
  'a metà di un debug (ipotesi in prova, test rossi non spiegati)',
  "con una richiesta di permesso o una domanda all'utente in sospeso",
].join('; ')

// Soglie di un agente: morbida propria (o quella della principale), dura e
// margine a distanza come nella principale. Morbida della principale a 0: spento.
export const agentLimits = (main: Limits, agentThreshold: number): Limits => {
  if (main.soft <= 0) return { soft: 0, hard: 0, margin: 0 }
  const soft = agentThreshold > 0 ? agentThreshold : main.soft
  const hard = Math.min(95, soft + (main.hard - main.soft))
  return { soft, hard, margin: Math.min(95, hard + 15) }
}

export const agentHandoffPath = (session: string, agentId: string) => `${HANDOFF_DIR}/pending/${session}--${agentId}.md`

// L'id dell'agente è la parte del nome file dopo "--".
const agentIdOf = (path: string) => /--([^/]+)\.md$/.exec(path)?.[1] ?? ''

const levels = (limits: Limits) => `${limits.soft}/${limits.hard}%, margine di sicurezza al ${limits.margin}%`

// La nota che la mod allega a un agente quando il suo contesto entra in una zona.
export const agentZoneNote = (kind: AgentKind, zone: 1 | 2 | 3, percent: number, limits: Limits, path: string, type: string): string => {
  const seen = `La mod auto-clear-context rileva il contesto di questo agente al ${percent}% della finestra (soglie ${levels(limits)})`
  const when =
    zone === 3
      ? "Margine di sicurezza superato: l'handoff è previsto subito, anche fuori dai punti sicuri; il lavoro rimasto a metà va nella sezione «Lavoro interrotto»."
      : zone === 2
        ? `Zona dura: l'handoff è previsto al primo punto sicuro, completando l'azione atomica in corso. Non sono punti sicuri: ${NEVER_POINTS}.`
        : `Zona morbida: l'handoff è previsto al prossimo punto naturale: ${NATURAL_POINTS}. Non sono punti adatti: ${NEVER_POINTS}.`
  if (kind === 'teammate') {
    return [
      `${seen}.`,
      when,
      `Scrivi l'handoff in ${path} nel formato della skill auto-clear-context:handoff (stato, decisioni, file toccati, prossimo passo, «Verifica alla ripresa»), con nel frontmatter status: ready e agent: ${agentIdOf(path)}.`,
      'Non lanciare il validatore: lo fa la mod. Poi chiudi il turno con una sola riga.',
      'La mod ferma questo teammate e lo rilancia con lo stesso nome, tipo e modello, dandogli l\'handoff come prompt.',
    ].join(' ')
  }
  return [
    `${seen}.`,
    when,
    'Se il compito si chiude in pochi passi, finiscilo e rispondi come al solito.',
    `Altrimenti scrivi l'handoff in ${path} nel formato della skill auto-clear-context:handoff, con status: ready nel frontmatter, e controllalo da solo sui punti del validatore (ripartire dal solo file: obiettivo, decisioni, file, prossimo passo, verifica alla ripresa, nessun riferimento alla conversazione).`,
    `La risposta finale è una sola riga per chi ti ha lanciato: HANDOFF ${path}: rilancia un subagent ${type} con prompt «Riprendi dall'handoff ${path}».`,
  ].join(' ')
}

// Nota agli agenti attivi quando la principale sta per ripartire con /clear.
export const pauseNote = () =>
  [
    'La mod auto-clear-context: la sessione principale riparte (handoff validato, /clear in arrivo) appena gli agenti attivi finiscono.',
    "Chiudi il turno al prossimo punto naturale e manda il report a chi ti ha lanciato; se il tuo contesto è in zona, scrivi prima l'handoff come indicato dalla nota di zona.",
  ].join(' ')

// Il verdetto del validatore: righe LACUNE: … e VERDETTO: completo | da integrare.
export const parseVerdict = (answer: string): { isComplete: boolean; gaps: string } => {
  const verdict = /^\s*VERDETTO:\s*(.*)$/im.exec(answer)
  const verdictText = verdict?.[1] ?? ''
  const isComplete = verdict !== null && /\bcompleto\b/i.test(verdictText) && !/da integrare/i.test(verdictText)
  const gaps = /LACUNE:([\s\S]*?)(?=^\s*VERDETTO:|$(?![\s\S]))/m.exec(answer)?.[1]?.trim() ?? ''
  return { isComplete, gaps }
}

// Sostituisce o aggiunge campi nel frontmatter; senza frontmatter lo crea.
export const setFront = (text: string, fields: Record<string, string>): string => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const lines = match ? (match[1] ?? '').split(/\r?\n/) : []
  const body = match ? text.slice(match[0].length) : text
  for (const [key, value] of Object.entries(fields)) {
    const at = lines.findIndex(line => line.startsWith(`${key}:`))
    if (at >= 0) lines[at] = `${key}: ${value}`
    else lines.push(`${key}: ${value}`)
  }
  return `---\n${lines.join('\n')}\n---\n${body}`
}

export const appendGaps = (text: string, gaps: string) => `${text.replace(/\s+$/, '')}\n\n## Lacune segnalate dal validatore\n${gaps}\n`

// Prompt di ripresa del teammate rilanciato: la regola di RESUME, poi l'handoff.
export const agentResume = (handoff: string, archived: string) =>
  [
    `Sei un teammate rilanciato dalla mod auto-clear-context: il tuo contesto era pieno e hai scritto un handoff, validato (copia in ${archived}).`,
    "Prima di toccare il codice si lanciano i comandi della sezione «Verifica alla ripresa» e si confronta l'esito con quello atteso;",
    "poi il lavoro riprende dal prossimo passo indicato nell'handoff, dopo aver riletto i file che elenca.",
    '',
    'Handoff:',
    '',
    handoff,
  ].join('\n')

// Riserva: istruzioni alla principale quando la mod non riesce a fermare o rilanciare il teammate.
export const leadFallback = (name: string, path: string, reason: string) =>
  [
    `La mod auto-clear-context non è riuscita a rilanciare da sola il teammate «${name}» (${reason}); il suo handoff è validato in ${path}.`,
    `Fai così: 1) TaskStop sul teammate ${name}; 2) Agent con lo stesso name «${name}», lo stesso tipo e lo stesso modello, e prompt «Riprendi dall'handoff ${path}».`,
  ].join(' ')
