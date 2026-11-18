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

// Soglie di un agente in token assoluti, indipendenti dalla principale: dura almeno
// 30000 sopra la morbida, margine 30000 sopra la dura. Principale spenta o morbida 0: spento.
const AGENT_GAP = 30_000
export const agentLimits = (isMainOn: boolean, soft: number, hard: number): Limits => {
  if (!isMainOn || !(soft > 0)) return { soft: 0, hard: 0, margin: 0 }
  const realHard = hard > soft ? hard : soft + AGENT_GAP
  return { soft, hard: realHard, margin: realHard + AGENT_GAP }
}

export const agentZoneOf = (tokens: number, limits: Limits): 0 | 1 | 2 | 3 => {
  if (limits.soft <= 0 || tokens < limits.soft) return 0
  if (tokens >= limits.margin) return 3
  return tokens >= limits.hard ? 2 : 1
}

// Soglie della principale anche in token assoluti (morbida, dura almeno +30k, margine +30k, come per gli agenti):
// convertite in percentuale della finestra, per ogni livello vale la più bassa. Morbida in token 0, monitor
// spento o finestra ignota: restano le percentuali.
export const capByTokens = (limits: Limits, softTokens: number, hardTokens: number, window: number | undefined): Limits => {
  if (limits.soft <= 0 || !(softTokens > 0) || window === undefined || !(window > 0)) return limits
  const tokens = agentLimits(true, softTokens, hardTokens)
  const pct = (value: number) => Math.max(0.1, Math.round((value / window) * 1000) / 10)
  return {
    soft: Math.min(limits.soft, pct(tokens.soft)),
    hard: Math.min(limits.hard, pct(tokens.hard)),
    margin: Math.min(limits.margin, pct(tokens.margin)),
  }
}

// 196526 -> "197k"
export const formatK = (tokens: number) => `${Math.round(tokens / 1000)}k`

export const agentHandoffPath = (session: string, agentId: string) => `${HANDOFF_DIR}/pending/${session}--${agentId}.md`

// L'id dell'agente è la parte del nome file dopo "--".
const agentIdOf = (path: string) => /--([^/]+)\.md$/.exec(path)?.[1] ?? ''

// Passo fisso: l'agente committa i propri file prima di scrivere l'handoff.
export const COMMIT_STEP =
  "Prima di scrivere l'handoff committa i file che hai modificato tu, per nome (git add <file>…; mai git add -A né git add .; mai i file di .claude/handoff/), con un messaggio che dica il punto raggiunto. Se non puoi (test rossi, file in comune con altri, permesso negato, niente repo git), elenca nell'handoff, in «Modifiche», alla riga «Non committato», i file non committati e il motivo."

// Il modello d'handoff per un agente, letto dalle stesse fonti del flusso: da skills/handoff/SKILL.md la sezione
// «## Formato» (preambolo e blocco markdown, col frontmatter da agente), il passo «Raccogli i fatti» e «## Regole»,
// da agents/handoff-validator.md i punti numerati che il validatore controlla. '' se una fonte manca o non ha i marcatori: la nota rimanda alla skill.
export const handoffModel = (skillText: string, validatorText: string, agentId: string): string => {
  const skill = skillText.replace(/\r\n/g, '\n')
  const format = /^## Formato[ \t]*\n([\s\S]*?)^```markdown[ \t]*\n([\s\S]*?)^```[ \t]*$/m.exec(skill)
  // I punti del validatore: il primo blocco numerato dopo «Controlla questi punti».
  const after = /^Controlla questi punti[^\n]*\n([\s\S]*)/m.exec(validatorText.replace(/\r\n/g, '\n'))?.[1] ?? ''
  const points = /^\d+\. [^\n]*(?:\n(?:\d+\. |[ \t]+\S)[^\n]*)*/m.exec(after)?.[0] ?? ''
  if (format === null || points === '') return ''
  // Dalla skill anche il passo «Raccogli i fatti» (con le sue righe rientrate) e la sezione «## Regole».
  const facts = /^\d+\. (\*\*Raccogli i fatti[^\n]*(?:\n[ \t]+\S[^\n]*)*)/m.exec(skill)?.[1] ?? ''
  const rules = /^## Regole[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(skill)?.[1]?.trim() ?? ''
  const preamble = (format[1] ?? '').trim()
  const template = (format[2] ?? '')
    .replace(/^status: draft[ \t]*$/m, 'status: ready')
    .replace(/^session: .*$/m, `agent: ${agentId}`)
    // `mode: pausa` vale solo per la principale: niente rumore nella nota agli agenti.
    .replace(/^mode: .*\n/m, '')
    .trimEnd()
  return [
    `Modello d'handoff richiesto dal validatore (dalla skill auto-clear-context:handoff). ${preamble}`,
    ...(facts === '' ? [] : [`Prima di scrivere: ${facts}`]),
    '```markdown',
    template,
    '```',
    ...(rules === '' ? [] : ['Regole:', rules]),
    'Il validatore controlla questi punti; ognuno che non passa è una lacuna e ti rimanda indietro:',
    points,
  ].join('\n')
}

const withModel = (model: string) => (model === '' ? '' : `\n\n${model}`)

const levels = (limits: Limits) => `${formatK(limits.soft)}/${formatK(limits.hard)}, margine di sicurezza a ${formatK(limits.margin)}`

// La nota che la mod allega a un agente quando il suo contesto entra in una zona.
// Con `model` (handoffModel) la nota rimanda al modello e lo accoda; senza, rimanda alla skill.
export const agentZoneNote = (kind: AgentKind, zone: 1 | 2 | 3, tokens: number, limits: Limits, path: string, type: string, model = ''): string => {
  const seen = `La mod auto-clear-context rileva il contesto di questo agente a ~${formatK(tokens)} token (soglie ${levels(limits)})`
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
      COMMIT_STEP,
      model === ''
        ? `Scrivi l'handoff in ${path} nel formato della skill auto-clear-context:handoff (stato, decisioni, file toccati, prossimo passo, «Verifica alla ripresa»), con nel frontmatter status: ready e agent: ${agentIdOf(path)}.`
        : `Scrivi l'handoff in ${path} con il modello qui sotto, tutte le sezioni obbligatorie, con nel frontmatter status: ready e agent: ${agentIdOf(path)}.`,
      `Non lanciare il validatore: lo fa la mod. Poi chiudi il turno con la sola riga «HANDOFF ${path}: la mod valida e rilancia questo teammate, non riprendere da solo».`,
      'La mod ferma questo teammate e lo rilancia con lo stesso nome, tipo e modello, dandogli l\'handoff come prompt.',
      'Se invece il lavoro va fermato (chiusura, spegnimento del PC, stop chiesto dal lead o dall\'utente), aggiungi mode: pausa nel frontmatter: la mod valida l\'handoff, lo archivia e ferma il teammate senza rilanciarlo.',
    ].join(' ') + withModel(model)
  }
  return [
    `${seen}.`,
    when,
    COMMIT_STEP,
    'Se il compito si chiude in pochi passi, finiscilo e rispondi come al solito.',
    model === ''
      ? `Altrimenti scrivi l'handoff in ${path} nel formato della skill auto-clear-context:handoff, con status: ready e agent: ${agentIdOf(path)} nel frontmatter, e controllalo da solo sui punti del validatore (ripartire dal solo file: obiettivo, decisioni, file, prossimo passo, verifica alla ripresa, nessun riferimento alla conversazione).`
      : `Altrimenti scrivi l'handoff in ${path} con il modello qui sotto, tutte le sezioni obbligatorie, con status: ready e agent: ${agentIdOf(path)} nel frontmatter, e controllalo da solo sui punti del validatore elencati sotto.`,
    `La risposta finale è una sola riga per chi ti ha lanciato: HANDOFF ${path}: rilancia un subagent ${type} con prompt «Riprendi dall'handoff ${path}».`,
  ].join(' ') + withModel(model)
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
    `Fai così: 1) TaskStop sul teammate ${name}; 2) Agent con lo stesso name «${name}» nello stesso team, lo stesso tipo e lo stesso modello, e prompt «Riprendi dall'handoff ${path}».`,
  ].join(' ')

// Un agente dato attivo ma senza eventi da `minutes` minuti è stantio. 0 spegne la scadenza.
export const isStale = (lastSeen: number, now: number, minutes: number): boolean =>
  minutes > 0 && now - lastSeen >= minutes * 60_000

// Il percorso e l'id dell'agente dell'handoff di un subagent in un prompt «Riprendi dall'handoff …»;
// undefined se manca o se è l'handoff di una principale (nome file senza "--").
export const resumedHandoff = (prompt: string): { path: string; agentId: string } | undefined => {
  const path = /Riprendi dall['’]handoff\s+\S*?(\.claude\/handoff\/pending\/[^\s/]+\.md)/i.exec(prompt)?.[1]
  const agentId = path === undefined ? '' : agentIdOf(path)
  return path !== undefined && agentId !== '' ? { path, agentId } : undefined
}
