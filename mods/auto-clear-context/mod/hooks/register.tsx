import { atom, read, update } from 'claude-code'
import type { AgentInfo, ConfigRow, EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import { agentHandoffPath, agentLimits, agentResume, agentZoneNote, agentZoneOf, capByTokens, deliveredLeadNote, deliveredStoppedNote, formatK, appendGaps, handoffModel, isStale, leadFallback, leadPauseFallback, parseVerdict, pauseNote, resumedHandoff, setFront, waitingOn } from './agents'
import type { AgentKind } from './agents'
import type { AgentInput, ThresholdField, ThresholdNotice, ThresholdWrite, ThresholdZone } from '../types'

// Vicino alle soglie di contesto Claude salva lo stato in un handoff validato
// (skill auto-clear-context:handoff); a fine turno la mod esegue /clear e, nella
// sessione pulita, allega l'handoff e fa ripartire il turno da sola.
//
// Zone: normale, morbida (handoff al prossimo punto naturale), dura (al primo
// punto sicuro) e margine di sicurezza, dura + 15 (subito). La dura in vigore
// sta almeno 10 punti sopra la morbida; morbida 0 spegne il monitor.
// Monitor: session.measure dopo ogni turno (nota allegata al prossimo prompt) e
// tool.call durante i turni lunghi, nel context del risultato (una lettura ogni
// CHECK_EVERY_MS al massimo); una nota per zona per sessione, la zona già segnalata in $.state.
// Dopo un compact (stessa sessione, contesto di nuovo basso) le zone ripartono.
// Tool context_usage (mcp__auto-clear-context__context_usage): percentuale e zona
// su richiesta, in una riga.
// Handoff: uno per sessione, .claude/handoff/pending/<session id>.md, perché più
// sessioni possono lavorare nella stessa cartella. Il pending.md condiviso delle
// versioni precedenti vale solo se il suo frontmatter porta l'id della sessione.
// Clear: turn.complete con l'handoff della sessione in stato "validated".
// Ripresa: session.end (clear) invia il prompt di ripresa; il primo prompt dopo il
// /clear (o dopo un session.compact) allega e archivia l'handoff validato della
// sessione appena chiusa dal /clear (o di quella compattata), mai quello di un'altra.
// Soglie: /soglia apre un pannello (valore in modifica, preset e −5/+5),
// /soglia 45 imposta la morbida, /soglia 45 65 morbida e dura. Con le righe di
// /config la scrittura va nelle impostazioni e il motore ricarica il modulo con
// le nuove options: con due valori la seconda scrittura aspetta in $.state e, se
// la ricarica ferma questo modulo prima, la completa quello nuovo in session.start.
// Dove /config non ha le righe (sessioni headless, tab Code dell'app) le salva la
// mod in $.store. Il monitor legge le soglie in vigore a ogni controllo.

// `session`, `agent` e `mode` sono i campi del frontmatter, se ci sono; `path` il file da cui viene.
// `mode: pausa`: handoff di chiusura (spegnimento, stop chiesto): /clear e archivio, ma nessun prompt di ripresa.
type Handoff = {
  text: string
  status: string
  session: string | undefined
  agent: string | undefined
  mode: string | undefined
  id: string
  path: string
}
const PAUSE_MODE = 'pausa'
type ClearRecord = { at: number; handoff: string }
// `agent` è la chiave stabile del teammate (nome, teammateId o id), non l'id: cambia a ogni rilancio.
type RestartRecord = { at: number; agent: string; handoff: string }
type Field = ThresholdField
type Pair = Record<Field, number>
type Limits = { soft: number; hard: number; margin: number }
type Settings = { inForce: Pair; inConfig: Pair; overrides: Partial<Pair> }
type Saved = { field: Field; value: number; via: 'config' | 'store' | 'restored' }
type Refused = { field: Field; value: number; deny: string }

const HANDOFF_DIR = '.claude/handoff'
const CHECK_EVERY_MS = 30_000
const HOUR_MS = 3_600_000
const RETRY_MS = 300
const CLEARS_KEY = 'clears'
const CLEARS_KEPT = 20
const RESTARTS_KEY = 'restarts'
const RESTARTS_KEPT = 20
const EVENTS_KEPT = 300
const BUSY = ['pending', 'running', 'waiting']
const DEFER_WARN_MS = 20 * 60_000
const DEFER_DENY = 'clear in attesa: non lanciare agenti nuovi; chiudi quelli che hanno consegnato e chiudi il turno.'
// Soglie in token della principale (userConfig mainSoftTokens/mainHardTokens); 0 = solo percentuali.
let mainTokens = { soft: 0, hard: 0 }

const PANE = 'soglia'
const PANE_ROWS = 20
// Campi di userConfig e chiavi degli override in $.store hanno lo stesso nome.
const FIELDS: readonly Field[] = ['threshold', 'hardThreshold']
const LABELS: Record<Field, string> = { threshold: 'morbida', hardThreshold: 'dura' }
const DEFAULTS: Pair = { threshold: 40, hardThreshold: 60 }
const PRESETS: Record<Field, readonly number[]> = { threshold: [0, 30, 40, 50, 60, 70, 80], hardThreshold: [50, 60, 70, 80, 90] }
const STEP = 5
const MAX_SOFT = 85
const MAX_THRESHOLD = 95
const HARD_GAP = 10
const MARGIN_GAP = 15
const AUTO_COMPACT_PERCENT = 97
const ZONE_NAMES = ['zona normale', 'zona morbida', 'zona dura', 'margine di sicurezza superato'] as const

const CONTEXT_TOOL_NAME = 'context_usage'
const CONTEXT_TOOL = 'mcp__auto-clear-context__context_usage'
const CONTEXT_TOOL_DESCRIPTION = [
  'Legge quanto è pieno il contesto della sessione e la zona della mod auto-clear-context',
  '(normale, morbida, dura, margine di sicurezza superato) con le soglie in vigore.',
  'Risponde con una riga, per esempio "47% · zona morbida (40/60%)". Sola lettura, nessun argomento.',
].join(' ')

const RESUME = [
  'Ripresa automatica della mod auto-clear-context: il /clear è stato eseguito dopo un handoff validato.',
  `L'handoff è allegato al contesto di questa sessione, con una copia in ${HANDOFF_DIR}/archive/.`,
  "Prima di toccare il codice si lanciano i comandi della sezione «Verifica alla ripresa» e si confronta l'esito con quello atteso;",
  "poi il lavoro riprende dal prossimo passo indicato nell'handoff, dopo aver riletto i file che elenca.",
].join(' ')

const USAGE = [
  '/soglia N imposta la morbida (1-85; 0 o spento spengono il monitor),',
  '/soglia N M morbida e dura (dura da morbida + 10 a 95),',
  '/soglia morbida N e /soglia dura N una sola, /soglia da solo apre il pannello.',
].join(' ')

// Le regole che le note riportano in breve.
const NATURAL_POINTS = [
  'un sotto-task finito e verificato (test verdi o build ok)',
  'il risultato di un subagent appena integrato',
  'prima di aprire un file nuovo o di iniziare una feature o un sotto-task nuovo',
  "la fine di una risposta all'utente quando il passo dopo è un argomento nuovo",
].join('; ')
const NEVER_POINTS = [
  'a metà di un edit o con modifiche su più file non ancora coerenti',
  'a metà di un debug (ipotesi in prova, test rossi non spiegati)',
  'con lavoro in background attivo',
  "con una richiesta di permesso o una domanda all'utente in sospeso",
].join('; ')

// L'handoff di una sessione, relativo alla root del repo principale.
const handoffPath = (session: string) => `${HANDOFF_DIR}/pending/${session}.md`

// Come si arriva al /clear, con il percorso assoluto del file di handoff della sessione.
const how = (path: string) =>
  [
    `L'handoff lo prepara la skill auto-clear-context:handoff, che salva lo stato in ${path} (il file di questa sessione, percorso assoluto nel repo principale) e lo fa validare da un subagent;`,
    "con l'handoff validato e nessun lavoro in background, a fine turno la mod esegue /clear e il lavoro riparte da solo nella sessione pulita.",
    `Percentuale e zona si leggono su richiesta con il tool ${CONTEXT_TOOL}.`,
  ].join(' ')

// "40/60%", con il margine "40/60/75%".
const levels = (limits: Limits, withMargin = false) => `${limits.soft}/${limits.hard}${withMargin ? `/${limits.margin}` : ''}%`

// La nota che la mod allega quando il contesto entra in una zona.
const zoneNote = (zone: ThresholdZone, percent: number, limits: Limits, autoCompact: number | undefined, path: string) => {
  const steps = how(path)
  const seen = `La mod auto-clear-context rileva il contesto al ${percent}% della finestra`
  const levelsText = `soglie ${levels(limits)}, margine di sicurezza al ${limits.margin}%`
  if (zone === 3) {
    const compact = autoCompact === undefined ? "l'auto-compact è spento in questa sessione" : `l'auto-compact scatta al ${autoCompact}%`
    return [
      `${seen}: margine di sicurezza superato (soglie ${levels(limits, true)}); ${compact}.`,
      "In questa zona l'handoff è previsto subito, anche fuori dai punti sicuri: il lavoro rimasto a metà va nella sezione «Lavoro interrotto» dell'handoff.",
      steps,
    ].join(' ')
  }
  if (zone === 2) {
    return [
      `${seen}: zona dura (${levelsText}).`,
      "In questa zona l'handoff è previsto al primo punto sicuro: si completa l'azione atomica in corso e non se ne iniziano altre.",
      `Non sono punti sicuri: ${NEVER_POINTS}.`,
      "Se resta un debug aperto o ci sono test rossi, l'handoff aggiunge la sezione «Lavoro interrotto».",
      steps,
    ].join(' ')
  }
  return [
    `${seen}: zona morbida (${levelsText}).`,
    `In questa zona l'handoff è previsto al prossimo punto naturale: ${NATURAL_POINTS}.`,
    `Non sono punti adatti: ${NEVER_POINTS}.`,
    steps,
  ].join(' ')
}

const attached = (handoff: Handoff, archived: string) =>
  `Handoff della sessione precedente, validato e allegato dalla mod auto-clear-context (copia in ${archived}):\n\n${handoff.text}`

// L'esito dell'ultima modifica delle soglie: in $.state, perché la scrittura
// ricarica il modulo e il pannello deve ancora mostrarlo dopo.
const notice = atom({ plugin: 'auto-clear-context', key: 'thresholdNotice' } as const, null)
// Il valore che il pannello modifica (tasto t nel terminale, pulsante nell'app).
const paneTarget = atom({ plugin: 'auto-clear-context', key: 'paneTarget' } as const, 'threshold')
// Per session id, la zona più alta già segnalata a Claude.
const SIGNALED = { plugin: 'auto-clear-context', key: 'signaledZone' } as const
// La seconda scrittura in /config di una coppia, finché qualcuno non la prende.
const PENDING_WRITE = { plugin: 'auto-clear-context', key: 'pendingWrite' } as const

let pendingNote: { session: string; zone: ThresholdZone; text: string } | undefined
let lastCheckAt = 0
let isClearRequested = false
// Il clear chiesto è per un handoff di pausa: session.end non invia la ripresa.
let isPauseClear = false
// Clear della principale con agenti attivi: `isMainBusy` è vero finché la principale è in un turno;
// `isTryingClear` evita che due controlli ravvicinati (principale e agenti) lancino due /clear.
let isMainBusy = false
let isTryingClear = false
// Il rinvio in corso: da quando e per quale handoff (impronta); l'avviso dei 20 minuti esce una volta.
let deferredSince: number | undefined
let deferredId: string | undefined
let isDeferWarned = false
// Per agente, l'impronta dell'handoff della principale per cui ha già avuto la nota di pausa.
const pausedFor = new Map<string, string>()
// Ultimo evento visto di ogni agente (inizio/passo/tool/fine turno): oltre agentStaleMinutes senza eventi
// un agente dato attivo non trattiene più il clear. 0 spegne la scadenza.
const lastSeen = new Map<string, number>()
const staleLogged = new Set<string>()
const MAX_STALE_MINUTES = 1440
let agentStaleMinutes = 30
// Un teammate in un pannello separato non manda eventi qui: la sua attività si legge dall'elenco
// (stato, label, token). Per agente, l'ultima firma vista; un cambio vale come un evento.
const panelSigns = new Map<string, string>()
// Col clear rimandato la principale non lancia agenti nuovi (userConfig blockAgentsWhileDeferred).
let blockAgentsWhileDeferred = true
let staleTimer: Timer | undefined
// Subagent che hanno già consegnato (taskStatus completed o fine turno vista senza un nuovo inizio) ma restano
// attivi, per esempio per un loro processo in background: avvisati subito, fermati con TaskStop dopo DELIVERED_GRACE_MS.
const DELIVERED_GRACE_MS = 2 * 60_000
// Anche senza clear rimandato: un consegnato si ferma dopo deliveredStopMinutes (0 = mai), con un timer proprio.
let deliveredStopMinutes = 5
let deliveredTimer: Timer | undefined
// Gli agenti con un TaskStop in corso: un timer e una fine turno ravvicinati non ne mandano due.
const stopping = new Set<string>()
// Per agente, l'ultimo comando lanciato in background (Bash run_in_background, Monitor): avvisi e note lo citano.
const backgroundCommands = new Map<string, string>()
// Note per la principale (agenti fermati), allegate al suo prossimo tool o prompt.
const leadNotes: string[] = []
const endedAgents = new Set<string>()
const deliveredSince = new Map<string, number>()
const stoppedAgents = new Set<string>()
const leadAsked = new Set<string>()
// Contesto dell'ultimo passo di ogni agente (turn.step), in token: le zone degli agenti sono in token assoluti.
const agentTokens = new Map<string, number>()
// Il percorso dell'handoff dato a ogni agente con la prima nota: resta quello anche dopo un /clear della principale.
const agentPaths = new Map<string, string>()
// Gli agenti avviati dalla mod (validatori, teammate rilanciati): niente note di zona.
const ownAgents = new Set<string>()
let agentsEnabled = true
// Validazione dell'handoff di un teammate: `checking` tiene gli agenti con un controllo in corso
// (preso in modo sincrono, perché due turn.complete ravvicinati non lancino due validatori);
// `validating` ricorda per ogni validatore lanciato di chi è, il file e il giro.
const checking = new Set<string>()
const validating = new Map<string, { agentId: string; path: string; round: number; id: string }>()
// I giri già fatti per teammate: se il teammate riscrive il file senza `rounds`, il conto non riparte da 0.
const doneRounds = new Map<string, number>()
// Rilancio del teammate: tetto orario (come i clear), rilanci in corso e handoff già passati alla principale.
let maxRestartsPerHour = 3
let maxClearsPerHour = 3
const restarting = new Set<string>()
const handedToLead = new Set<string>()
const VALIDATOR = 'auto-clear-context:handoff-validator'
const VALIDATOR_MODEL = 'sonnet'
const AGENT_INPUTS = { plugin: 'auto-clear-context', key: 'agentInputs' } as const
// Dopo un /clear (la sessione che ha chiuso, perché la nuova ha già un altro id) o un
// compact (la sessione stessa): di chi è l'handoff che il prossimo prompt allega.
// `ready`: l'handoff già archiviato al /clear di una pausa, da allegare al primo prompt scritto.
type AttachFor = { owner: string; source: 'clear' | 'compact' | 'pausa'; ready?: Promise<string | undefined> }
let attachFor: AttachFor | undefined
// Gli handoff che non sono della sessione già segnalati nel log, per impronta.
const reported = new Set<string>()
let isExcludeChecked = false
let logChain: Promise<void> = Promise.resolve()
// Le soglie che questo modulo ha scritto in /config: valgono finché il motore non
// lo ricarica con le nuove options (o se non lo ricarica).
const configApplied: Partial<Pair> = {}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// In un .tsx `<T,>` distingue il generico da un tag JSX.
const orElse = <T,>(read: Promise<T>, fallback: T) => read.catch(() => fallback)

const trimSlash = (path: string) => path.replace(/[\\/]+$/, '')

// La radice del repo principale per radice di sessione: la cartella madre della git common dir,
// così un worktree legge e scrive gli handoff nel principale. Fuori da git, repo bare o errore: la root della sessione.
// In cache solo un esito certo (exit 0, o 128 «not a git repository»): un errore o un timeout si riprova alla chiamata dopo.
const mainRoots = new Map<string, Promise<string>>()
const mainRootOf = ($: EngineInterface, root: string) => {
  const cached = mainRoots.get(root)
  if (cached !== undefined) return cached
  const found = (async () => {
    try {
      const run = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, timeoutMs: 5000 })
      if (run.exitCode !== 0 && run.exitCode !== 128) mainRoots.delete(root)
      const dir = trimSlash(run.stdout.trim().replace(/\\/g, '/'))
      return run.exitCode === 0 && dir.endsWith('/.git') && dir.length > 5 ? dir.slice(0, -5) : root
    } catch {
      mainRoots.delete(root)
      return root
    }
  })()
  mainRoots.set(root, found)
  return found
}

const paths = async ($: EngineInterface) => {
  const sessionRoot = trimSlash(await $.session.root())
  const root = await mainRootOf($, sessionRoot)
  const dir = `${root}/${HANDOFF_DIR}`
  return { root, sessionRoot, shared: `${dir}/pending.md`, archive: `${dir}/archive`, events: `${dir}/events.log` }
}

// Le cartelle fuori dal repo principale dove un handoff può finire per errore: il cwd di un agente,
// il cwd e la root della sessione (un worktree), ognuna una volta.
const outsideRoots = async ($: EngineInterface, agentCwd?: string) => {
  const { root, sessionRoot } = await paths($)
  const cwd = await orElse($.session.cwd(), root)
  const dirs = [agentCwd, typeof cwd === 'string' ? cwd : root, sessionRoot].map(dir => (dir === undefined ? '' : trimSlash(dir)))
  return [...new Set(dirs)].filter(dir => dir !== '' && dir !== root)
}

// Un handoff trovato fuori dal repo principale: una riga di log per file e contenuto.
const outsideLogged = new Set<string>()
const logOutside = ($: EngineInterface, handoff: Handoff) => {
  const key = `${handoff.path}:${handoff.id}`
  if (outsideLogged.has(key)) return
  outsideLogged.add(key)
  log($, `handoff trovato fuori dal repo principale: ${handoff.path} (atteso in ${HANDOFF_DIR}/pending/ del principale)`)
}

// Le prime cifre dell'id, per distinguere le sessioni nel log condiviso.
const short = (session: string) => session.slice(0, 8)

const readText = async ($: EngineInterface, path: string) => {
  const read = await orElse($.fs.read(path), '')
  return typeof read === 'string' ? read : ''
}

// Impronta breve del testo (FNV-1a a 32 bit più la lunghezza): riconosce lo
// stesso handoff tra un turno e l'altro.
const fingerprint = (text: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}${text.length.toString(16)}`
}

// .claude/handoff/ resta fuori da git: la mod lo aggiunge a .git/info/exclude,
// che è locale e non finisce in nessun commit.
const ensureExcluded = async ($: EngineInterface) => {
  if (isExcludeChecked) return
  isExcludeChecked = true
  const { root } = await paths($)
  const git = await orElse($.fs.stat(`${root}/.git`), undefined)
  if (git?.kind !== 'dir') return
  const exclude = `${root}/.git/info/exclude`
  const current = await readText($, exclude)
  if (/^\/?\.claude\/handoff\/?\s*$/m.test(current)) return
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  await $.fs.write(exclude, `${current}${separator}${HANDOFF_DIR}/\n`)
}

const log = ($: EngineInterface, text: string) => {
  $.ui.log(`auto-clear-context: ${text}`)
  logChain = logChain
    .then(async () => {
      await ensureExcluded($)
      const { events } = await paths($)
      const at = new Date(await $.clock.now()).toISOString()
      const kept = (await readText($, events)).split('\n').filter(line => line !== '').slice(1 - EVENTS_KEPT)
      await $.fs.write(events, `${[...kept, `${at} ${text}`].join('\n')}\n`)
    })
    .catch(() => undefined)
}

// Il valore di un campo del frontmatter, senza virgolette; un campo vuoto non
// prende la riga dopo.
const frontField = (front: string, field: string) =>
  new RegExp(`^${field}:[ \\t]*["']?([^\\s"']+)`, 'm').exec(front)?.[1]

// Una riga di log per handoff, non una a ogni fine turno di ogni sessione.
const reportOnce = ($: EngineInterface, handoff: Handoff, text: string) => {
  if (reported.has(handoff.id)) return
  reported.add(handoff.id)
  log($, text)
}

// Impronta del corpo dell'handoff (senza frontmatter): non cambia se cambiano solo status, rounds, validated_at.
const bodyHash = (text: string) => `fnv:${fingerprint(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''))}`

const readHandoff = async ($: EngineInterface, path: string): Promise<Handoff | undefined> => {
  const text = await readText($, path)
  if (text.trim() === '') return undefined
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const status = frontField(front, 'status') ?? 'draft'
  return {
    text,
    status,
    session: frontField(front, 'session'),
    agent: frontField(front, 'agent'),
    mode: frontField(front, 'mode'),
    id: fingerprint(text),
    path,
  }
}

// L'handoff di una sessione: il suo file in pending/ (se il frontmatter non
// porta l'id di un'altra), altrimenti il pending.md condiviso delle versioni
// precedenti se porta il suo id. Un pending.md senza id non è di nessuna
// sessione: resta dov'è e il log lo dice una volta. Un file con `agent:` nel
// frontmatter è l'handoff di un agente: non fa mai il /clear della principale.
const readOwnHandoff = async ($: EngineInterface, session: string): Promise<Handoff | undefined> => {
  const { root, shared } = await paths($)
  const own = (await readHandoff($, `${root}/${handoffPath(session)}`)) ?? (await readOutside($, handoffPath(session)))
  const isAgents = own?.agent !== undefined
  if (own !== undefined && !isAgents && (own.session === undefined || own.session === session)) return own
  if (own?.status === 'validated') {
    const whose = isAgents ? `agent: ${own.agent}: è l'handoff di un agente` : `la sessione ${own.session}: non è di questa sessione`
    reportOnce($, own, `${handoffPath(session)} porta ${whose}, nessun /clear`)
  }
  const old = await readHandoff($, shared)
  if (old?.session === session && old.agent === undefined) return old
  if (old?.status === 'validated' && old.session === undefined) {
    reportOnce($, old, `${HANDOFF_DIR}/pending.md validato senza session nel frontmatter: non è di nessuna sessione, nessun /clear né ripresa (si riprende a mano)`)
  }
  return undefined
}

// Il file `relative` (sotto la radice) fuori dal repo principale, se c'è e non è vuoto; col log.
const readOutside = async ($: EngineInterface, relative: string, agentCwd?: string) => {
  for (const dir of await outsideRoots($, agentCwd)) {
    const found = await readHandoff($, `${dir}/${relative}`)
    if (found !== undefined) {
      logOutside($, found)
      return found
    }
  }
  return undefined
}

// Copia l'handoff in archive/ lasciando intatto il suo file.
const archiveCopy = async ($: EngineInterface, handoff: Handoff) => {
  await ensureExcluded($)
  const { archive: dir } = await paths($)
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const name = `${stamp}-${handoff.id}.md`
  await $.fs.write(`${dir}/${name}`, handoff.text)
  return `${HANDOFF_DIR}/archive/${name}`
}

// $.fs non cancella: l'handoff si copia in archive/ e il suo file resta vuoto.
const archive = async ($: EngineInterface, handoff: Handoff) => {
  const archived = await archiveCopy($, handoff)
  await $.fs.write(handoff.path, '')
  return archived
}

// L'handoff validato di `attach.owner`, archiviato, nel testo da allegare al prompt;
// niente se non c'è o non è validato. Gli errori restano nel log: il prompt parte lo stesso.
const attachedHandoff = async ($: EngineInterface, attach: AttachFor): Promise<string | undefined> => {
  try {
    const handoff = await readOwnHandoff($, attach.owner)
    if (handoff?.status !== 'validated') return undefined
    const archived = await archive($, handoff)
    const done =
      attach.source === 'pausa'
        ? `archiviato in ${archived} per la ripresa (pausa): si allega al primo prompt scritto, se la sessione resta aperta`
        : `allegato alla sessione (${attach.source}) e archiviato in ${archived}`
    log($, `handoff ${handoff.id} della sessione ${short(attach.owner)} ${done}`)
    return attached(handoff, archived)
  } catch (error) {
    log($, `handoff della sessione ${short(attach.owner)} non allegato: ${errorText(error)}`)
    return undefined
  }
}

// Un Agent riuscito che riprende l'handoff di un subagent: il file resta in pending/ col suo testo (l'agente
// in background può leggerlo dopo che next si risolve), segnato status: resumed, con una copia in archive/.
const archiveResumed = async ($: EngineInterface, prompt: string) => {
  const found = resumedHandoff(prompt)
  if (found === undefined) return
  const { root } = await paths($)
  let handoff =
    found.absolute !== undefined
      ? await readHandoff($, found.absolute)
      : ((await readHandoff($, `${root}/${found.path}`)) ?? (await readOutside($, found.path, (await findAgent($, found.agentId))?.cwd)))
  // Il percorso assoluto nel principale che non c'è: il file può essere nel worktree o nel cwd dell'agente.
  if (handoff === undefined && found.absolute?.startsWith(`${root}/`) === true) {
    handoff = await readOutside($, found.absolute.slice(root.length + 1), (await findAgent($, found.agentId))?.cwd)
  }
  if (handoff === undefined) return
  const resumed = { ...handoff, text: setFront(handoff.text, { status: 'resumed' }) }
  const archived = await archiveCopy($, resumed)
  await $.fs.write(handoff.path, resumed.text)
  log($, `handoff dell'agente ${short(found.agentId)} ripreso: segnato resumed, copia in ${archived}`)
}

const runClear = ($: EngineInterface, canRetry: boolean) => {
  $.command.run({ command: 'clear' }).then(
    () => undefined,
    error => {
      if (canRetry) {
        $.clock.after(RETRY_MS, () => runClear($, false))
        return
      }
      isClearRequested = false
      log($, `/clear non eseguito: ${errorText(error)}`)
    },
  )
}

// 1.000.000 → "1M", 450.000 → "450k".
const formatTokens = (tokens: number) => {
  if (tokens >= 999_500) return `${String(Math.round(tokens / 100_000) / 10).replace('.', ',')}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(Math.round(tokens))
}

// "50% · 500k token" sulla finestra del modello; senza finestra nota, "50%".
const describeThreshold = (percent: number, window: number | undefined) => {
  if (percent <= 0) return '0% · monitor spento'
  if (window === undefined) return `${percent}%`
  return `${percent}% · ${formatTokens((window * percent) / 100)} token`
}

// Le soglie in vigore: la dura almeno morbida + 10, il margine dura + 15, mai oltre il 95%.
const limitsOf = (pair: Pair): Limits => {
  const soft = pair.threshold
  const hard = Math.min(MAX_THRESHOLD, Math.max(pair.hardThreshold, soft + HARD_GAP))
  return { soft, hard, margin: Math.min(MAX_THRESHOLD, hard + MARGIN_GAP) }
}

const zoneOf = (percent: number, limits: Limits): ThresholdZone => {
  if (limits.soft <= 0 || percent < limits.soft) return 0
  if (percent >= limits.margin) return 3
  return percent >= limits.hard ? 2 : 1
}

const describeUsage = (usage: SessionUsage | undefined, limits: Limits) => {
  if (usage === undefined) return 'Contesto ora: non disponibile'
  const { tokens, percent, window } = usage.context
  if (tokens === undefined) return `Contesto ora: non ancora misurato · finestra da ${formatTokens(window)} token`
  const where = limits.soft <= 0 ? ' · monitor spento' : percent === undefined ? '' : ` · ${ZONE_NAMES[zoneOf(percent, limits)]}`
  return `Contesto ora: ${formatTokens(tokens)} token${percent === undefined ? '' : ` (${percent}%)`}${where}`
}

// La riga del tool context_usage: "47% · zona morbida (40/60%)".
const usageLine = (usage: SessionUsage | undefined, limits: Limits) => {
  const percent = usage?.context.percent
  if (limits.soft <= 0) return percent === undefined ? 'monitor spento' : `${percent}% · monitor spento`
  if (usage === undefined) return `contesto non disponibile (${levels(limits)})`
  if (percent === undefined) return `contesto non ancora misurato (${levels(limits)})`
  const zone = zoneOf(percent, limits)
  return `${percent}% · ${ZONE_NAMES[zone]} (${levels(limits, zone === 3)})`
}

// −5/+5 sui multipli di 5 (47 → 45 o 50), tra 0 e 95.
const stepThreshold = (percent: number, delta: number) => {
  const base = delta > 0 ? Math.floor(percent / STEP) * STEP : Math.ceil(percent / STEP) * STEP
  return Math.min(MAX_THRESHOLD, Math.max(0, base + delta))
}

// I valori che un campo può prendere con l'altro fermo.
const boundsOf = (field: Field, pair: Pair) =>
  field === 'threshold'
    ? { min: 0, max: Math.min(MAX_SOFT, pair.hardThreshold - HARD_GAP) }
    : { min: pair.threshold + HARD_GAP, max: MAX_THRESHOLD }

// "45", "45%", "0", "spento" o "off"; undefined per tutto il resto.
const parseThreshold = (text: string) => {
  if (/^(spento|spenta|off)$/i.test(text)) return 0
  const percent = Number(/^(\d{1,3})\s*%?$/.exec(text)?.[1] ?? Number.NaN)
  return percent <= MAX_THRESHOLD ? percent : undefined
}

// Gli argomenti di /soglia: "45" (morbida), "45 65" o "45/65" (morbida e dura),
// "morbida 45", "dura 65"; undefined per tutto il resto.
const parseRequest = (text: string): Partial<Pair> | undefined => {
  const words = text.toLowerCase().split(/[\s/]+/)
  const [first = '', second] = words
  if (words.length > 2) return undefined
  if (second !== undefined && (first === 'morbida' || first === 'dura')) {
    const value = parseThreshold(second)
    if (value === undefined) return undefined
    return first === 'morbida' ? { threshold: value } : { hardThreshold: value }
  }
  const soft = parseThreshold(first)
  if (soft === undefined) return undefined
  if (second === undefined) return { threshold: soft }
  const hard = parseThreshold(second)
  return hard === undefined ? undefined : { threshold: soft, hardThreshold: hard }
}

const nearestText = (percent: number) => (percent === 0 ? '0 (monitor spento)' : `${percent}%`)

// Una coppia fuori dai limiti si rifiuta indicando il valore valido più vicino
// del campo chiesto; l'altro valore non si tocca.
const checkPair = (pair: Pair, asked: readonly Field[]) => {
  const soft = pair.threshold
  const hard = pair.hardThreshold
  if (soft > MAX_SOFT) return `La soglia morbida va da 1 a ${MAX_SOFT}% (0 spegne il monitor): il valore valido più vicino è ${MAX_SOFT}%.`
  if (hard >= soft + HARD_GAP) return undefined
  if (asked.includes('hardThreshold')) {
    const nearest = Math.min(MAX_THRESHOLD, Math.max(hard, soft + HARD_GAP))
    return `La soglia dura va da morbida + ${HARD_GAP} a ${MAX_THRESHOLD}%: con la morbida al ${soft}% il valore valido più vicino è ${nearest}%.`
  }
  const nearest = Math.max(0, Math.min(MAX_SOFT, hard - HARD_GAP))
  return `La soglia morbida resta almeno ${HARD_GAP} punti sotto la dura (${hard}%): il valore valido più vicino è ${nearestText(nearest)}; /soglia ${soft} ${soft + HARD_GAP} le cambia insieme.`
}

// La riga di /config di un campo: `<plugin>.<campo>`, oppure
// `<plugin>@<origine>.<campo>` se due plugin caricati hanno lo stesso nome.
const findRow = (rows: readonly ConfigRow[], name: string, field: Field) =>
  rows.find(row => row.key === `${name}.${field}`) ??
  rows.find(row => row.key.startsWith(`${name}@`) && row.key.endsWith(`.${field}`))

const readUsage = ($: EngineInterface) => orElse<SessionUsage | undefined>($.session.usage(), undefined)

// La percentuale a cui scatta l'auto-compact, dal breakdown di /context (stima
// locale, nessuna richiesta): undefined se è spento, AUTO_COMPACT_PERCENT se il
// motore non la dà.
const readAutoCompact = async ($: EngineInterface) => {
  const usage = await orElse<SessionUsage | undefined>($.session.usage({ breakdown: 'summary' }), undefined)
  const breakdown = usage?.context.breakdown
  if (usage === undefined || breakdown === undefined) return AUTO_COMPACT_PERCENT
  if (!breakdown.isAutoCompactEnabled) return undefined
  const at = breakdown.autoCompactThreshold
  if (at === undefined || usage.context.window <= 0) return AUTO_COMPACT_PERCENT
  return Math.min(100, Math.round((at * 100) / usage.context.window))
}

const buildNote = async ($: EngineInterface, zone: ThresholdZone, percent: number, limits: Limits, session: string) =>
  zoneNote(zone, percent, limits, zone === 3 ? await readAutoCompact($) : AUTO_COMPACT_PERCENT, `${(await paths($)).root}/${handoffPath(session)}`)

const findAgent = async ($: EngineInterface, agentId: string): Promise<AgentInfo | undefined> =>
  (await orElse($.agent.list(), [] as readonly AgentInfo[])).find(agent => agent.id === agentId)

const kindOf = (info: AgentInfo): AgentKind => (info.teammateId === undefined ? 'subagent' : 'teammate')

const readSignaled = async ($: EngineInterface, session: string) =>
  (await orElse(read($, { ...SIGNALED, id: session }), undefined)) ?? 0

// Segna la zona come segnalata nella sessione; false se lo era già, anche per
// una lettura parallela arrivata prima (scrittura con ifVersion).
const markSignaled = async ($: EngineInterface, session: string, zone: ThresholdZone) => {
  const ref = { ...SIGNALED, id: session }
  const { value = 0, version } = await $.state.get(ref)
  if (value >= zone) return false
  return (await $.state.set(ref, zone, { ifVersion: version })).isSet
}

// Dopo un compact la sessione resta la stessa ma il contesto riparte basso: le
// zone tornano da segnalare e una nota in attesa non vale più.
const resetSignaled = async ($: EngineInterface) => {
  pendingNote = undefined
  await $.state.set({ ...SIGNALED, id: await $.session.id() }, 0)
}

// L'override che la mod salva in $.store dove /config non può scrivere un campo:
// vale subito e in ogni sessione, finché /config non torna a decidere.
const readOverride = async ($: EngineInterface, field: Field) => {
  const value = await orElse($.store.get(field), undefined)
  return typeof value === 'number' && value >= 0 && value <= MAX_THRESHOLD ? value : undefined
}

// Le soglie di /config come le usa il monitor: quelle appena scritte da questo
// modulo, altrimenti le options con cui è stato caricato.
const fromConfig = (configured: Pair): Pair => ({
  threshold: configApplied.threshold ?? configured.threshold,
  hardThreshold: configApplied.hardThreshold ?? configured.hardThreshold,
})

// Le soglie in vigore, lette a ogni controllo: l'override, poi /config.
const readSettings = async ($: EngineInterface, configured: Pair): Promise<Settings> => {
  const [threshold, hardThreshold] = await Promise.all([readOverride($, 'threshold'), readOverride($, 'hardThreshold')])
  const inConfig = fromConfig(configured)
  return {
    inForce: { threshold: threshold ?? inConfig.threshold, hardThreshold: hardThreshold ?? inConfig.hardThreshold },
    inConfig,
    overrides: { threshold, hardThreshold },
  }
}

// Le soglie in vigore in percentuale, abbassate dalle soglie in token della principale se configurate.
const effectiveLimits = async ($: EngineInterface, configured: Pair) => {
  const limits = limitsOf((await readSettings($, configured)).inForce)
  if (limits.soft <= 0 || mainTokens.soft <= 0) return limits
  return capByTokens(limits, mainTokens.soft, mainTokens.hard, (await readUsage($))?.context.window)
}

// Prende la scrittura in sospeso, una volta sola anche se il modulo vecchio e
// quello ricaricato ci provano insieme.
const claimPendingWrite = async ($: EngineInterface) => {
  const { value, version } = await $.state.get(PENDING_WRITE)
  if (value === undefined || value === null) return undefined
  const { isSet } = await $.state.set(PENDING_WRITE, null, { ifVersion: version })
  return isSet ? value : undefined
}

// Salva un valore: in /config se il campo ha la riga (l'override si toglie
// prima, perché la scrittura ricarica il modulo, e torna se config.set dice no);
// altrimenti, o se config.set rifiuta la chiave, come override in $.store.
const saveField = async ($: EngineInterface, write: ThresholdWrite, inConfig: Pair): Promise<Saved | Refused> => {
  const { field, value, key, override } = write
  if (key !== undefined) {
    if (override !== undefined) await $.store.delete(field)
    const result = await $.config.set({ key, value }).then(set => set, () => undefined)
    if (result?.deny !== undefined) {
      if (override !== undefined) await orElse($.store.set(field, override), undefined)
      return { field, value, deny: result.deny }
    }
    if (result !== undefined) {
      const applied = typeof result.value === 'number' ? result.value : value
      configApplied[field] = applied
      return { field, value: applied, via: 'config' }
    }
  }
  // Il valore di /config non ha bisogno di un override: si toglie quello che c'è.
  if (value === inConfig[field]) {
    await $.store.delete(field)
    return { field, value, via: 'restored' }
  }
  await $.store.set(field, value)
  return { field, value, via: 'store' }
}

const viaText = (via: Saved['via'], inConfig: Pair, field?: Field) => {
  if (via === 'restored') return 'vale di nuovo /config'
  if (via === 'config') return field === undefined ? 'salvate nelle impostazioni' : 'salvata nelle impostazioni'
  return field === undefined
    ? `salvate dalla mod; /config mostra ancora ${inConfig.threshold}/${inConfig.hardThreshold}%`
    : `salvata dalla mod; /config mostra ancora ${inConfig[field]}%`
}

const isRefused = (outcome: Saved | Refused): outcome is Refused => 'deny' in outcome

// Il testo dell'esito: una frase per valore, una sola se i due sono finiti nello
// stesso posto.
const describeOutcomes = (outcomes: readonly (Saved | Refused)[], asked: number, inConfig: Pair, window: number | undefined) => {
  const saved = FIELDS.flatMap(field => outcomes.filter((one): one is Saved => one.field === field && !isRefused(one)))
  const refused = outcomes.find(isRefused)
  if (saved.length === 0 && refused !== undefined) {
    return `${asked > 1 ? 'Soglie non cambiate' : `Soglia ${LABELS[refused.field]} non cambiata`}: ${refused.deny}`
  }
  const [soft, hard] = saved
  const text =
    soft !== undefined && hard !== undefined && soft.via === hard.via
      ? `Soglie impostate: morbida ${describeThreshold(soft.value, window)}, dura ${describeThreshold(hard.value, window)} (${viaText(soft.via, inConfig)}).`
      : saved
          .map(one =>
            one.field === 'threshold' && one.value === 0
              ? `Monitor di contesto spento, soglia morbida 0% (${viaText(one.via, inConfig, one.field)}).`
              : `Soglia ${LABELS[one.field]} impostata al ${describeThreshold(one.value, window)} (${viaText(one.via, inConfig, one.field)}).`,
          )
          .join(' ')
  return refused === undefined ? text : `${text} Soglia ${LABELS[refused.field]} non cambiata: ${refused.deny}`
}

const alreadyText = (target: Pair, asked: readonly Field[], window: number | undefined) => {
  const [field] = asked
  if (asked.length > 1 || field === undefined) return `Le soglie sono già al ${target.threshold}/${target.hardThreshold}%.`
  if (field === 'threshold' && target.threshold === 0) return 'Il monitor è già spento (soglia morbida 0%).'
  return `La soglia ${LABELS[field]} è già al ${describeThreshold(target[field], window)}.`
}

// Applica le soglie chieste. Prima gli override in $.store, che non ricaricano
// nulla; poi /config, nell'ordine che tiene valida la coppia intermedia
// (alzando la morbida, prima la dura). Con due scritture in /config la seconda
// aspetta in $.state: la prima può far ricaricare il modulo prima che questo
// hook arrivi alla seconda, e allora la completa session.start nel modulo nuovo.
// L'esito porta le soglie in vigore dopo l'azione.
const applyThresholds = async ($: EngineInterface, request: Partial<Pair>, configured: Pair): Promise<ThresholdNotice> => {
  const [settings, usage, rows] = await Promise.all([readSettings($, configured), readUsage($), orElse($.config.list(), [])])
  const { inForce, inConfig, overrides } = settings
  const window = usage?.context.window
  const asked = FIELDS.filter(field => request[field] !== undefined)
  const target: Pair = { ...inForce, ...request }
  const changed = asked.filter(field => target[field] !== inForce[field])
  if (changed.length === 0) return { text: alreadyText(target, asked, window), isError: false, ...inForce }
  const error = checkPair(target, asked)
  if (error !== undefined) return { text: error, isError: true, ...inForce }

  const order: readonly Field[] = target.threshold > inForce.threshold ? ['hardThreshold', 'threshold'] : FIELDS
  const writes: ThresholdWrite[] = order
    .filter(field => changed.includes(field))
    .map(field => ({ field, value: target[field], key: findRow(rows, $.plugin.name, field)?.key, override: overrides[field] }))
  const outcomes: (Saved | Refused)[] = []
  for (const write of writes.filter(one => one.key === undefined)) outcomes.push(await saveField($, write, inConfig))
  const [first, second] = writes.filter(one => one.key !== undefined)
  if (first !== undefined) {
    if (second !== undefined) await $.state.set(PENDING_WRITE, second)
    const done = await saveField($, first, inConfig)
    outcomes.push(done)
    // La seconda la riprende questo modulo, se quello ricaricato dopo la prima non
    // l'ha già presa; dopo un rifiuto si toglie e basta.
    const isMine = second !== undefined && (await claimPendingWrite($)) !== undefined
    if (second !== undefined && !isRefused(done)) {
      if (isMine) outcomes.push(await saveField($, second, inConfig))
      else {
        configApplied[second.field] = second.value
        outcomes.push({ field: second.field, value: second.value, via: 'config' })
      }
    }
  }
  const after = (await readSettings($, configured)).inForce
  return { text: describeOutcomes(outcomes, changed.length, inConfig, window), isError: outcomes.some(isRefused), ...after }
}

// La seconda scrittura di una coppia rimasta in $.state: la completa il modulo
// ricaricato dopo la prima, se quello che l'ha lasciata non ci è arrivato.
const finishPendingWrite = async ($: EngineInterface, configured: Pair) => {
  const write = await claimPendingWrite($)
  if (write === undefined) return
  const inConfig = fromConfig(configured)
  const [done, usage] = await Promise.all([saveField($, write, inConfig), readUsage($)])
  const outcome: ThresholdNotice = {
    text: describeOutcomes([done], 1, inConfig, usage?.context.window),
    isError: isRefused(done),
    ...(await readSettings($, configured)).inForce,
  }
  log($, `scrittura in sospeso completata dopo la ricarica: ${outcome.text}`)
  await orElse(update($, notice, () => outcome), outcome)
  $.ui.toast(outcome.text)
}

// «Ripristina /config»: toglie gli override e tornano a valere le soglie di /config.
const resetOverrides = async ($: EngineInterface, configured: Pair): Promise<ThresholdNotice> => {
  const usage = await readUsage($)
  await Promise.all(FIELDS.map(field => $.store.delete(field)))
  const inConfig = fromConfig(configured)
  const window = usage?.context.window
  const text = `Override della mod tolti: vale /config, morbida ${describeThreshold(inConfig.threshold, window)}, dura ${describeThreshold(inConfig.hardThreshold, window)}.`
  return { text, isError: false, ...inConfig }
}

// Un pulsante del pannello: l'esito va nel pannello e in un toast. Un errore
// porta le soglie rimaste in vigore.
const reportFromPane = async ($: EngineInterface, configured: Pair, run: () => Promise<ThresholdNotice>) => {
  const outcome = await run().catch(
    async (error: unknown): Promise<ThresholdNotice> => ({
      text: `Soglie non cambiate: ${errorText(error)}`,
      isError: true,
      ...(await readSettings($, configured)).inForce,
    }),
  )
  await orElse(update($, notice, () => outcome), outcome)
  $.ui.toast(outcome.text)
}

const only = (field: Field, value: number): Partial<Pair> => (field === 'threshold' ? { threshold: value } : { hardThreshold: value })

// "Soglia dura: 60% · 600k token"; se /config o l'override la tengono sotto
// morbida + 10, quella in vigore e quella impostata.
const describeHard = (pair: Pair, limits: Limits, window: number | undefined) =>
  `${describeThreshold(limits.hard, window)}${limits.hard === pair.hardThreshold ? '' : ` (impostata al ${pair.hardThreshold}%, fuori dai limiti)`}`

const describeOverrides = (settings: Settings, window: number | undefined) => {
  const fields = FIELDS.filter(field => settings.overrides[field] !== undefined)
  const [field] = fields
  if (field === undefined) return undefined
  if (fields.length > 1) return `Salvate dalla mod; in /config restano ${settings.inConfig.threshold}/${settings.inConfig.hardThreshold}%`
  return `${field === 'threshold' ? 'Morbida' : 'Dura'} salvata dalla mod; in /config resta ${describeThreshold(settings.inConfig[field], window)}`
}

// L'handoff di un agente si cerca per id (pending/*--<agentId>.md, il più recente non vuoto), non con l'id
// della principale, che cambia a ogni /clear.
// Prima nel repo principale, poi fuori (cwd dell'agente, worktree della sessione), con una riga di log.
const newestAgentHandoff = async ($: EngineInterface, root: string, agentId: string) => {
  const dir = `${root}/${HANDOFF_DIR}/pending`
  const entries = await orElse($.fs.list(dir), [])
  const [newest] = entries
    .filter(entry => entry.kind === 'file' && entry.size > 0 && entry.name.endsWith(`--${agentId}.md`))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  return newest === undefined ? undefined : readHandoff($, `${dir}/${newest.name}`)
}
const findAgentHandoff = async ($: EngineInterface, agentId: string, agentCwd?: string): Promise<Handoff | undefined> => {
  const inMain = await newestAgentHandoff($, (await paths($)).root, agentId)
  if (inMain !== undefined) return inMain
  for (const dir of await outsideRoots($, agentCwd)) {
    const found = await newestAgentHandoff($, dir, agentId)
    if (found !== undefined) {
      logOutside($, found)
      return found
    }
  }
  return undefined
}

// Il modello d'handoff dalle fonti che usano la skill e il validatore, lette a ogni nota: niente copie che divergono.
const agentModel = async ($: EngineInterface, agentId: string) => {
  const root = $.plugin.root.replace(/[\\/]+$/, '')
  const [skill, validator] = await Promise.all([readText($, `${root}/skills/handoff/SKILL.md`), readText($, `${root}/agents/handoff-validator.md`)])
  return handoffModel(skill, validator, agentId)
}

// La nota di zona per un agente, una volta per zona: il suo handoff lo scrive lui.
const agentZoneContext = async ($: EngineInterface, agentId: string, configured: Pair, agentTokensLimits: { soft: number; hard: number }): Promise<string | undefined> => {
  const tokens = agentTokens.get(agentId)
  if (!agentsEnabled || tokens === undefined || ownAgents.has(agentId)) return undefined
  const isMainOn = (await effectiveLimits($, configured)).soft > 0
  const limits = agentLimits(isMainOn, agentTokensLimits.soft, agentTokensLimits.hard)
  if (limits.soft <= 0) return undefined
  const zone = agentZoneOf(tokens, limits)
  if (zone === 0) return undefined
  const info = await findAgent($, agentId)
  if (info === undefined) return undefined
  // Chiave e percorso per agente, non per sessione: la principale cambia id a ogni /clear.
  if (!(await markSignaled($, `agent:${agentId}`, zone))) return undefined
  const path = agentPaths.get(agentId) ?? `${(await paths($)).root}/${agentHandoffPath(await $.session.id(), agentId)}`
  agentPaths.set(agentId, path)
  expectHandoff($, agentId, path)
  const model = await agentModel($, agentId)
  log($, `agente ${short(agentId)} a ~${formatK(tokens)} token (${ZONE_NAMES[zone]}): nota di handoff${model === '' ? ', senza modello (skill o validatore illeggibili)' : ''}`)
  return agentZoneNote(kindOf(info), zone, tokens, limits, path, info.type, model)
}

// Attese di handoff: dopo una nota di zona, per chi l'ha ricevuta ('main' o l'id dell'agente), il file atteso.
// A fine turno con HANDOFF (o dopo la skill handoff) e allo scadere di handoffWaitSeconds, se il file manca o è
// vuoto, un avviso: una volta per nota. `isDue`: il timer è scaduto mentre il destinatario era in un turno.
type HandoffWait = { path: string; isWarned: boolean; isDue: boolean; isSkillRun: boolean; timer?: Timer }
const handoffWaits = new Map<string, HandoffWait>()
let handoffWaitMs = 180_000

// Lo stato del file atteso: 'ok' se c'è e non è vuoto (anche fuori dal principale, dove la mod lo recupera).
const handoffState = async ($: EngineInterface, path: string, agentCwd?: string): Promise<'ok' | 'missing' | 'empty'> => {
  const text = await orElse($.fs.read(path), undefined)
  if (typeof text === 'string' && text.trim() !== '') return 'ok'
  const { root } = await paths($)
  if (path.startsWith(`${root}/`)) {
    const relative = path.slice(root.length + 1)
    for (const dir of await outsideRoots($, agentCwd)) {
      const outside = await orElse($.fs.read(`${dir}/${relative}`), undefined)
      if (typeof outside === 'string' && outside.trim() !== '') return 'ok'
    }
  }
  return typeof text === 'string' ? 'empty' : 'missing'
}

const forgetWait = (owner: string) => {
  handoffWaits.get(owner)?.timer?.cancel()
  handoffWaits.delete(owner)
}

const isOwnerBusy = (owner: string) => (owner === 'main' ? isMainBusy : !endedAgents.has(owner))

const warnHandoff = async ($: EngineInterface, owner: string, why: string) => {
  const wait = handoffWaits.get(owner)
  if (wait === undefined || wait.isWarned) return
  const info = owner === 'main' ? undefined : await findAgent($, owner)
  // Un agente sparito dall'elenco o finito non consegnerà più: niente avviso.
  if (owner !== 'main' && (info === undefined || ['completed', 'failed', 'killed'].includes(info.taskStatus ?? ''))) {
    forgetWait(owner)
    return
  }
  const state = await handoffState($, wait.path, info?.cwd)
  if (state === 'ok') {
    forgetWait(owner)
    return
  }
  wait.isWarned = true
  wait.timer?.cancel()
  wait.timer = undefined
  const what = state === 'missing' ? "il file non c'è" : 'è vuoto'
  const text = `auto-clear-context: handoff atteso in ${wait.path}, ma ${what}. Scrivilo lì (percorso assoluto nel repo principale) e verificalo con \`test -s ${wait.path}\` prima della riga finale.`
  log($, `handoff atteso${owner === 'main' ? '' : ` dall'agente ${short(owner)}`} (${why}): ${wait.path}, ${what}`)
  if (owner === 'main') {
    leadNotes.push(text)
    return
  }
  if (info !== undefined && kindOf(info) === 'teammate') {
    const sent = await $.session.send({ to: { agentId: owner }, text }).then(
      outcome => (outcome as { isDelivered?: boolean } | undefined)?.isDelivered !== false,
      () => false,
    )
    if (sent) return
  }
  leadNotes.push(`${text.replace('auto-clear-context: ', `auto-clear-context: l'agente ${info?.description ?? owner} (${owner}) aveva una nota di handoff; `)} Se serve, diglielo tu.`)
}

// Una nota di zona partita verso `owner`: si attende il suo file. Una nota nuova per lo stesso file conserva
// skill e timer già scaduto: si azzerano solo l'avviso e il timer.
const expectHandoff = ($: EngineInterface, owner: string, path: string) => {
  const old = handoffWaits.get(owner)
  const kept = old?.path === path ? { isDue: old.isDue, isSkillRun: old.isSkillRun } : { isDue: false, isSkillRun: false }
  forgetWait(owner)
  const wait: HandoffWait = { path, isWarned: false, ...kept }
  handoffWaits.set(owner, wait)
  if (handoffWaitMs <= 0) return
  wait.timer = $.clock.after(handoffWaitMs, () => {
    wait.timer = undefined
    if (handoffWaits.get(owner) !== wait) return
    if (isOwnerBusy(owner)) {
      wait.isDue = true
      return
    }
    warnHandoff($, owner, 'attesa scaduta').catch((error: unknown) => log($, `handoff atteso non controllato: ${errorText(error)}`))
  })
}

// Fine turno di `owner`: avviso se ha annunciato l'handoff (o usato la skill) o se il timer è scaduto nel turno.
const checkHandoffAtEnd = async ($: EngineInterface, owner: string, answer: string) => {
  const wait = handoffWaits.get(owner)
  if (wait === undefined || wait.isWarned) return
  const isAnnounced = /\bHANDOFF\b/.test(answer) || wait.isSkillRun
  // Un subagent che chiude il compito senza handoff ha finito: non si attende più il suo file, anche col timer scaduto.
  if (!isAnnounced && owner !== 'main' && (await findAgent($, owner))?.teammateId === undefined) {
    forgetWait(owner)
    return
  }
  if (isAnnounced || wait.isDue) await warnHandoff($, owner, 'fine turno')
}

// Le note durante il turno, dopo il risultato di un tool: a un agente la sua zona e la
// pausa, alla principale la zona letta al massimo ogni CHECK_EVERY_MS.
const turnNotes = async (
  $: EngineInterface,
  agentId: string | undefined,
  configured: Pair,
  agentTokensLimits: { soft: number; hard: number },
): Promise<string[]> => {
  if (agentId !== undefined) {
    return [await agentZoneContext($, agentId, configured, agentTokensLimits), await pauseContext($, agentId)].filter(
      (note): note is string => note !== undefined,
    )
  }
  const now = await $.clock.now()
  if (now - lastCheckAt < CHECK_EVERY_MS) return []
  lastCheckAt = now
  const limits = await effectiveLimits($, configured)
  if (limits.soft <= 0) return []
  const { percent } = (await $.session.usage()).context
  if (percent === undefined) return []
  const zone = zoneOf(percent, limits)
  if (zone === 0) return []
  const session = await $.session.id()
  if (!(await markSignaled($, session, zone))) return []
  if (pendingNote?.session === session && pendingNote.zone <= zone) pendingNote = undefined
  log($, `contesto al ${percent}% (${ZONE_NAMES[zone]}) durante il turno: segnalato a Claude`)
  expectHandoff($, 'main', `${(await paths($)).root}/${handoffPath(session)}`)
  return [await buildNote($, zone, percent, limits, session)]
}

// Un tool chiamato dalla mod che non è andato a buon fine: il motivo, altrimenti niente.
const refusalOf = (outcome: { deny?: string; isError?: boolean; text?: string }) =>
  outcome.deny ?? (outcome.isError === true ? (outcome.text ?? 'errore del tool') : undefined)

// Riserva: stop o rilancio non riusciti, le istruzioni vanno alla principale (una sola volta per handoff).
const handToLead = async ($: EngineInterface, agentId: string, name: string, handoff: Handoff, reason: string) => {
  handedToLead.add(handoff.id)
  log($, `teammate ${short(agentId)}: rilancio non riuscito (${reason}); istruzioni alla sessione principale, l'handoff resta in pending/`)
  const text = leadFallback(name, handoff.path, reason)
  $.prompt.submit({ text }).then(
    submitted => {
      if (submitted.drop !== undefined) log($, `istruzioni di rilancio alla principale scartate: ${submitted.drop}`)
    },
    error => log($, `istruzioni di rilancio alla principale rifiutate: ${errorText(error)}`),
  )
}

// Il rilanciato è un teammate se lo spawn dà il teammateId; altrimenti si guarda la lista: per id, o per nome
// se il motore non ha dato l'id (il vecchio teammate, fermato, è escluso).
const isRestartedTeammate = async ($: EngineInterface, spawned: { agentId?: string; teammateId?: string }, name: string, oldId: string) => {
  if (spawned.teammateId !== undefined) return true
  const list = await orElse($.agent.list(), [] as readonly AgentInfo[])
  return list.some(
    agent =>
      agent.id !== oldId &&
      agent.teammateId !== undefined &&
      (spawned.agentId === undefined ? (agent.name ?? agent.teammateId.split('@')[0]) === name : agent.id === spawned.agentId),
  )
}

// Il teammate fermato non ha più bisogno delle mappe per agente.
const forgetAgent = (agentId: string) => {
  agentTokens.delete(agentId)
  doneRounds.delete(agentId)
  checking.delete(agentId)
  agentPaths.delete(agentId)
  forgetWait(agentId)
}

// Rilancio del teammate con l'handoff validato: TaskStop, poi $.agent.spawn con l'input originale dell'Agent
// (o i dati della lista, se non è registrato). Il teammate nuovo non è in ownAgents: torna sotto il monitor.
// `isEnding`: chiamato dal turn.complete del teammate stesso, che sta finendo il turno: è fermo qualunque
// stato mostri la lista. Da un altro evento (fine del validatore) conta lo stato in lista.
const restartAgent = async ($: EngineInterface, agentId: string, handoff: Handoff, isEnding = false) => {
  if (!agentsEnabled || restarting.has(agentId) || handedToLead.has(handoff.id)) return
  restarting.add(agentId)
  try {
    const info = await findAgent($, agentId)
    if (info === undefined) {
      log($, `teammate ${short(agentId)} non più in elenco: nessun rilancio`)
      return
    }
    if (!isEnding && info.status !== 'idle') {
      log($, `handoff ${handoff.id} validato, ma il teammate ${short(agentId)} è ${info.status}: rilancio al suo prossimo fine turno`)
      return
    }
    const input = await orElse(read($, { ...AGENT_INPUTS, id: agentId }), undefined)
    const name = input?.name ?? info.teammateId?.split('@')[0] ?? agentId
    if (handoff.mode === PAUSE_MODE) return await pauseAgent($, agentId, name, handoff)
    // Ogni rilancio dà un id nuovo: il tetto e il dedupe contano per una chiave stabile (nome, teammateId, id).
    const key = input?.name ?? info.teammateId ?? agentId
    const now = await $.clock.now()
    const restarts = ((await $.store.get(RESTARTS_KEY)) as RestartRecord[] | undefined) ?? []
    if (restarts.some(restart => restart.agent === key && restart.handoff === handoff.id)) {
      log($, `l'handoff ${handoff.id} ha già avuto il suo rilancio: nessun nuovo rilancio`)
      return
    }
    if (restarts.filter(restart => restart.agent === key && now - restart.at < HOUR_MS).length >= maxRestartsPerHour) {
      reportOnce($, handoff, `limite di ${maxRestartsPerHour} rilanci in un'ora per il teammate ${key}: l'handoff ${handoff.id} resta in attesa`)
      return
    }
    const archived = await archiveCopy($, handoff)
    const prompt = agentResume(handoff.text, archived)
    let newId: string | undefined
    let isTeammate = false
    try {
      const stop = await $.tool.call({ tool: 'TaskStop', task_id: agentId })
      const stopRefused = refusalOf(stop)
      if (stopRefused !== undefined) return await handToLead($, agentId, name, handoff, `TaskStop non riuscito: ${stopRefused}`)
      // Il motore non lascia a un plugin il tool Agent via $.tool.call ("that is $.agent.spawn"): si rilancia
      // con $.agent.spawn, con nome, tipo, modello e descrizione dell'input originale (o della lista).
      const subagentType = input?.subagent_type ?? (info.type === 'teammate' ? undefined : info.type)
      const spawned = await $.agent.spawn({
        name,
        description: input?.description ?? info.description,
        prompt,
        ...(subagentType === undefined ? {} : { subagentType }),
        ...(input?.model === undefined ? {} : { model: input.model }),
      })
      if (spawned.deny !== undefined) return await handToLead($, agentId, name, handoff, `Agent non riuscito: ${spawned.deny}`)
      newId = spawned.agentId
      isTeammate = await isRestartedTeammate($, spawned, name, agentId)
    } catch (error) {
      return await handToLead($, agentId, name, handoff, errorText(error))
    }
    await $.store.set(RESTARTS_KEY, [...restarts, { at: now, agent: key, handoff: handoff.id }].slice(-RESTARTS_KEPT))
    forgetAgent(agentId)
    // $.agent.spawn non ha il team tra gli argomenti: senza teammateId il rilanciato non è un teammate.
    // Riserva sul lead, che con il tool Agent può rilanciarlo nel team; l'handoff resta in pending/.
    if (!isTeammate) {
      const reason = `il rilanciato ${newId === undefined ? '' : `${short(newId)} `}non risulta un teammate: fermalo e rilancialo nel team`
      $.ui.toast(`auto-clear-context: teammate «${name}» rilanciato fuori dal team, istruzioni alla principale`)
      return await handToLead($, agentId, name, handoff, reason)
    }
    // Il nuovo teammate si rilancia uguale al prossimo giro: l'input passa al suo id.
    if (newId !== undefined && input !== undefined) {
      await orElse($.state.set({ ...AGENT_INPUTS, id: newId }, input), undefined)
    }
    await $.fs.write(handoff.path, '')
    log($, `teammate ${short(agentId)} fermato e rilanciato${newId === undefined ? '' : ` come ${short(newId)}`} con l'handoff ${handoff.id} (copia in ${archived})`)
  } finally {
    restarting.delete(agentId)
  }
}

// Handoff di pausa di un teammate: copia in archive/, TaskStop e file svuotato, ma nessun rilancio.
// Se TaskStop non riesce il file resta in pending/ e la principale riceve, una volta, la richiesta di fermarlo.
const pauseAgent = async ($: EngineInterface, agentId: string, name: string, handoff: Handoff) => {
  let refused: string | undefined
  try {
    refused = refusalOf(await $.tool.call({ tool: 'TaskStop', task_id: agentId }))
  } catch (error) {
    refused = errorText(error)
  }
  if (refused !== undefined) {
    handedToLead.add(handoff.id)
    log($, `teammate ${short(agentId)} in pausa: TaskStop non riuscito (${refused}); istruzioni alla principale, l'handoff resta in pending/`)
    $.prompt.submit({ text: leadPauseFallback(name, handoff.path, refused) }).then(
      submitted => {
        if (submitted.drop !== undefined) log($, `istruzioni di pausa alla principale scartate: ${submitted.drop}`)
      },
      error => log($, `istruzioni di pausa alla principale rifiutate: ${errorText(error)}`),
    )
    return
  }
  const archived = await archiveCopy($, handoff)
  await $.fs.write(handoff.path, '')
  forgetAgent(agentId)
  log($, `handoff ${handoff.id} del teammate ${short(agentId)} validato (pausa): fermato senza rilancio, si riprende da ${archived}`)
}

const roundsOf = (text: string) => Number(frontField(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '', 'rounds') ?? 0) || 0

const unclaimedValidator = async ($: EngineInterface) => {
  const list = await orElse($.agent.list(), [] as readonly AgentInfo[])
  const found = list.find(agent => agent.type === VALIDATOR && !ownAgents.has(agent.id))
  if (found !== undefined) ownAgents.add(found.id)
  return found?.id
}

// Fine turno di un teammate: con l'handoff `ready` parte il validatore (uno solo per volta).
const checkTeammate = async ($: EngineInterface, agentId: string) => {
  if (!agentsEnabled || ownAgents.has(agentId) || checking.has(agentId)) return
  checking.add(agentId)
  let isStarted = false
  try {
    const info = await findAgent($, agentId)
    if (info === undefined || kindOf(info) !== 'teammate') return
    const handoff = await findAgentHandoff($, agentId, info.cwd)
    // Handoff già validato e rilancio rimandato (il teammate era in lavoro): ora il turno è finito.
    if (handoff?.status === 'validated') return await restartAgent($, agentId, handoff, true)
    if (handoff?.status !== 'ready') return
    const path = handoff.path
    // Già validato e corpo invariato: non si rilancia il validatore.
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(handoff.text)?.[1] ?? ''
    if (frontField(front, 'validated_hash') === bodyHash(handoff.text)) {
      await $.fs.write(path, setFront(handoff.text, { status: 'validated' }))
      log($, `handoff del teammate ${short(agentId)} già validato e invariato: nessuna nuova validazione`)
      const again = await readHandoff($, path)
      if (again !== undefined) await restartAgent($, agentId, again)
      return
    }
    const round = Math.max(roundsOf(handoff.text), doneRounds.get(agentId) ?? 0) + 1
    const spawned = await $.agent.spawn({
      subagentType: VALIDATOR,
      // Esplicito: senza, il validatore eredita il modello del lead. L'effort (low) sta nella definizione dell'agent.
      model: VALIDATOR_MODEL,
      description: `Valida l'handoff di ${short(agentId)}`,
      prompt: path,
    })
    // L'id lo dà il motore; se manca, è il validatore in elenco che la mod non ha ancora preso.
    const validatorId = spawned.deny === undefined ? (spawned.agentId ?? (await unclaimedValidator($))) : undefined
    if (validatorId === undefined) {
      log($, `validatore dell'handoff del teammate ${short(agentId)} non avviato: ${spawned.deny ?? 'id non trovato'}`)
      return
    }
    ownAgents.add(validatorId)
    validating.set(validatorId, { agentId, path, round, id: handoff.id })
    isStarted = true
    log($, `handoff del teammate ${short(agentId)} pronto: validatore ${short(validatorId)} (giro ${round})`)
  } finally {
    if (!isStarted) checking.delete(agentId)
  }
}

// Fine turno del validatore: completo, oppure lacune al teammate (giro 1) o accettate e annotate (giro 2).
const concludeValidation = async ($: EngineInterface, validatorId: string, answer: string) => {
  const job = validating.get(validatorId)
  if (job === undefined) return
  validating.delete(validatorId)
  let isChanged = false
  try {
    const handoff = await readHandoff($, job.path)
    if (handoff === undefined) {
      log($, `handoff del teammate ${short(job.agentId)} rimosso durante la validazione: nessun rilancio`)
      return
    }
    if (handoff.status !== 'ready') {
      log($, `handoff del teammate ${short(job.agentId)} cambiato durante la validazione: nessun verdetto applicato`)
      return
    }
    // Riscritto mentre il validatore lavorava: il suo verdetto è su un testo vecchio, si rivalida (stesso giro).
    if (handoff.id !== job.id) {
      log($, `handoff del teammate ${short(job.agentId)} cambiato durante la validazione: nuova validazione`)
      isChanged = true
      return
    }
    const verdict = parseVerdict(answer)
    const rounds = String(Math.max(job.round, roundsOf(handoff.text)))
    doneRounds.set(job.agentId, Number(rounds))
    if (verdict.isComplete || job.round >= 2) {
      doneRounds.delete(job.agentId)
      const base = setFront(handoff.text, { status: 'validated', rounds, validated_hash: bodyHash(handoff.text) })
      await $.fs.write(job.path, verdict.isComplete || verdict.gaps === '' ? base : appendGaps(base, verdict.gaps))
      log($, `handoff del teammate ${short(job.agentId)} validato (giro ${job.round}${verdict.isComplete ? '' : ', con lacune annotate'})`)
      const validated = await readHandoff($, job.path)
      if (validated !== undefined) await restartAgent($, job.agentId, validated)
      return
    }
    await $.fs.write(job.path, setFront(handoff.text, { rounds }))
    const gaps = verdict.gaps === '' ? '(il validatore non ha indicato le lacune)' : verdict.gaps
    await $.session.send({
      to: { agentId: job.agentId },
      text: `Il validatore dell'handoff ha segnalato lacune:\n${gaps}\nCorreggi ${job.path} e rimetti status: ready, poi chiudi il turno con una riga.`,
    })
    log($, `handoff del teammate ${short(job.agentId)}: lacune mandate al teammate (giro ${job.round})`)
  } finally {
    checking.delete(job.agentId)
    if (isChanged) await checkTeammate($, job.agentId)
  }
}

// Gli agenti che trattengono il clear: pending/running/waiting. Un teammate idle, i validatori e gli agenti
// avviati dalla mod non contano, né `ending`, l'agente al suo turn.complete (la lista può dirlo ancora running).
const isPanelTeammate = (agent: AgentInfo) => agent.teammateId !== undefined && agent.id === agent.teammateId

const activeAgents = async ($: EngineInterface, ending?: string) => {
  const busy = (await orElse($.agent.list(), [] as readonly AgentInfo[])).filter(
    agent =>
      BUSY.includes(agent.status) && !ownAgents.has(agent.id) && !stoppedAgents.has(agent.id) && agent.type !== VALIDATOR && agent.id !== ending,
  )
  const now = await $.clock.now()
  return busy.filter(agent => {
    // Teammate in un pannello separato: il suo ciclo non gira qui, nessun evento; una riga dell'elenco rimasta
    // running anche se il pannello è morto o fermo non deve trattenere il clear per sempre: stessa scadenza degli altri,
    // contata dall'ultima variazione di stato, label o token.
    if (isPanelTeammate(agent)) {
      const sign = `${agent.status}|${agent.label}|${agent.tokenCount}`
      if (panelSigns.get(agent.id) !== sign) {
        panelSigns.set(agent.id, sign)
        lastSeen.set(agent.id, now)
        staleLogged.delete(agent.id)
        return true
      }
    }
    const seen = lastSeen.get(agent.id)
    if (seen === undefined) {
      lastSeen.set(agent.id, now)
      return true
    }
    if (!isStale(seen, now, agentStaleMinutes)) return true
    if (!staleLogged.has(agent.id)) {
      staleLogged.add(agent.id)
      log($, `agente ${short(agent.id)} senza attività da ${Math.floor((now - seen) / 60_000)} minuti: non trattiene più il clear`)
    }
    return false
  })
}

// Un evento di un agente: torna attivo e potrà essere di nuovo segnalato come stantio.
const markSeen = async ($: EngineInterface, agentId: string | undefined) => {
  if (agentId === undefined) return
  lastSeen.set(agentId, await $.clock.now())
  staleLogged.delete(agentId)
}

// Un solo timer alla scadenza più vicina tra gli agenti che trattengono il clear: allo scadere si ricontrolla.
const cancelStaleCheck = () => {
  staleTimer?.cancel()
  staleTimer = undefined
}

const scheduleStaleCheck = ($: EngineInterface, busy: readonly AgentInfo[], now: number) => {
  cancelStaleCheck()
  const dues: number[] = []
  for (const agent of busy) {
    const since = deliveredSince.get(agent.id)
    // Un consegnato già passato alla principale (TaskStop rifiutato) torna alla sola scadenza; con la principale
    // in un turno il TaskStop aspetta la sua fine turno, che ricontrolla da sola.
    if (since !== undefined && isDelivered(agent) && !leadAsked.has(agent.id) && !isMainBusy) dues.push(since + DELIVERED_GRACE_MS)
    else if (agentStaleMinutes > 0) dues.push((lastSeen.get(agent.id) ?? now) + agentStaleMinutes * 60_000)
  }
  if (dues.length === 0) return
  staleTimer = $.clock.after(Math.max(1, Math.min(...dues) - now), () => {
    staleTimer = undefined
    tryClear($, 'controllo a tempo degli agenti').catch((error: unknown) => log($, `clear non controllato: ${errorText(error)}`))
  })
}

// Un subagent che ha già consegnato: il motore lo dà completed come task, o la mod ne ha visto la fine turno
// senza un nuovo inizio e il motore non lo dà running come task. Un teammate torna running tra un turno e l'altro:
// è consegnato solo se, dopo una fine turno vista, resta waiting su una shell sua (idle aspetta un messaggio; un
// waiting senza shell può essere l'approvazione di un piano) e nessuna validazione del suo handoff è in corso.
const isDelivered = (agent: AgentInfo) =>
  agent.teammateId === undefined
    ? agent.taskStatus === 'completed' || (endedAgents.has(agent.id) && agent.taskStatus !== 'running')
    : !isPanelTeammate(agent) &&
      endedAgents.has(agent.id) &&
      agent.status === 'waiting' &&
      backgroundCommands.has(agent.id) &&
      !checking.has(agent.id)

const agentLabel = (agent: AgentInfo) => `«${agent.description}» (${agent.id})`

// I consegnati si segnalano alla prima vista e si fermano con TaskStop dopo `grace` (hanno già dato il report).
// Con il clear rimandato (`holdsClear`) la scadenza è DELIVERED_GRACE_MS e il TaskStop aspetta la principale
// ferma; dalla sorveglianza generale (watchDelivered) è deliveredStopMinutes, anche con la principale in un turno.
// Se TaskStop non riesce, la principale riceve una volta la richiesta. Risponde gli id fermati.
const stopDelivered = async ($: EngineInterface, busy: readonly AgentInfo[], now: number, grace = DELIVERED_GRACE_MS, holdsClear = true) => {
  const stopped = new Set<string>()
  // Un agente ripreso dopo l'avviso non è più consegnato: ripartirà da capo se riconsegna.
  for (const agent of busy) if (!isDelivered(agent)) deliveredSince.delete(agent.id)
  for (const agent of busy.filter(isDelivered)) {
    const command = backgroundCommands.get(agent.id)
    const since = deliveredSince.get(agent.id)
    if (since === undefined) {
      deliveredSince.set(agent.id, now)
      const held = holdsClear ? ' e trattiene il clear' : ''
      const text = `${agentLabel(agent)} ha consegnato ma resta attivo${waitingOn(command)}${held}: lo fermo tra ${grace / 60_000} minuti (TaskStop ${agent.id})`
      $.ui.toast(`auto-clear-context: ${text}`)
      log($, text)
      continue
    }
    if (now - since < grace || leadAsked.has(agent.id) || stopping.has(agent.id) || (holdsClear && isMainBusy)) continue
    stopping.add(agent.id)
    let refused: string | undefined
    try {
      refused = refusalOf(await $.tool.call({ tool: 'TaskStop', task_id: agent.id }))
    } catch (error) {
      refused = errorText(error)
    } finally {
      stopping.delete(agent.id)
    }
    if (refused === undefined) {
      const minutes = Math.round((now - since) / 60_000)
      stopped.add(agent.id)
      stoppedAgents.add(agent.id)
      deliveredSince.delete(agent.id)
      backgroundCommands.delete(agent.id)
      const held = holdsClear ? ' e tratteneva il clear' : ''
      const text = `agente ${agentLabel(agent)} fermato con TaskStop: aveva consegnato ma restava attivo da ${minutes} minuti${waitingOn(command)}${held}`
      $.ui.toast(`auto-clear-context: ${text}`)
      log($, text)
      leadNotes.push(deliveredStoppedNote(agent.description, agent.id, minutes, command))
      continue
    }
    leadAsked.add(agent.id)
    log($, `agente ${agentLabel(agent)}: TaskStop non riuscito (${refused}); richiesta alla principale`)
    $.prompt.submit({ text: deliveredLeadNote(agent.description, agent.id, refused, command, holdsClear) }).then(
      submitted => {
        if (submitted.drop !== undefined) log($, `richiesta di TaskStop alla principale scartata: ${submitted.drop}`)
      },
      error => log($, `richiesta di TaskStop alla principale rifiutata: ${errorText(error)}`),
    )
  }
  return stopped
}

// Sorveglianza dei consegnati anche senza handoff: a ogni fine turno e a tempo, alla scadenza più vicina.
const watchDelivered = async ($: EngineInterface) => {
  deliveredTimer?.cancel()
  deliveredTimer = undefined
  if (deliveredStopMinutes <= 0) return
  const grace = deliveredStopMinutes * 60_000
  const list = await orElse($.agent.list(), [] as readonly AgentInfo[])
  // Agenti spariti dall'elenco: niente conti né comandi rimasti.
  const listed = new Set(list.map(agent => agent.id))
  for (const id of [...deliveredSince.keys()]) if (!listed.has(id)) deliveredSince.delete(id)
  for (const id of [...backgroundCommands.keys()]) if (!listed.has(id)) backgroundCommands.delete(id)
  for (const id of [...leadAsked]) if (!listed.has(id)) leadAsked.delete(id)
  const busy = list.filter(
    agent => BUSY.includes(agent.status) && !ownAgents.has(agent.id) && !stoppedAgents.has(agent.id) && agent.type !== VALIDATOR,
  )
  const now = await $.clock.now()
  const stopped = await stopDelivered($, busy, now, grace, false)
  const dues = busy
    .filter(agent => !stopped.has(agent.id) && !leadAsked.has(agent.id) && isDelivered(agent))
    .map(agent => (deliveredSince.get(agent.id) ?? now) + grace)
  if (dues.length > 0) {
    deliveredTimer = $.clock.after(Math.max(1, Math.min(...dues) - now), () => {
      deliveredTimer = undefined
      watchDelivered($).catch((error: unknown) => log($, `agenti consegnati non controllati: ${errorText(error)}`))
    })
  }
  // Uno stop può liberare un clear rimandato.
  if (stopped.size > 0 && deferredId !== undefined && !isMainBusy) await tryClear($, 'agente consegnato fermato')
}

const resetDeferral = () => {
  deferredSince = undefined
  deferredId = undefined
  isDeferWarned = false
  pausedFor.clear()
  cancelStaleCheck()
}

// Dopo 20 minuti di rinvio, un avviso una volta sola: il clear non si forza, perché l'effetto di /clear
// sugli agenti in corso non è garantito dall'API.
const warnLongDeferral = async ($: EngineInterface) => {
  if (deferredSince === undefined || isDeferWarned) return
  const elapsed = (await $.clock.now()) - deferredSince
  if (elapsed < DEFER_WARN_MS) return
  isDeferWarned = true
  const names = (await activeAgents($)).map(agent => `${agent.description} (${short(agent.id)})`).join(', ')
  const text = `clear rimandato da ${Math.floor(elapsed / 60_000)} minuti: agenti attivi ${names === '' ? 'nessuno' : names}`
  $.ui.toast(`auto-clear-context: ${text}`)
  log($, text)
}

// La nota di pausa per un agente attivo, una volta per handoff della principale in attesa del clear.
const pauseContext = async ($: EngineInterface, agentId: string): Promise<string | undefined> => {
  if (!agentsEnabled || deferredId === undefined || ownAgents.has(agentId)) return undefined
  await warnLongDeferral($)
  if (pausedFor.get(agentId) === deferredId) return undefined
  pausedFor.set(agentId, deferredId)
  log($, `agente ${short(agentId)}: nota di pausa, la principale riparte con /clear`)
  return pauseNote()
}

// Il clear della principale, se l'handoff è validato e nessun agente è attivo. Si ricontrolla a ogni fine turno
// della principale e di un agente (reason dice da chi arriva; `ending` è l'agente che sta finendo il turno).
const tryClear = async ($: EngineInterface, reason: string, ending?: string) => {
  if (isClearRequested || isTryingClear) return
  isTryingClear = true
  try {
    const session = await $.session.id()
    const handoff = await readOwnHandoff($, session)
    if (handoff?.status !== 'validated') {
      resetDeferral()
      return
    }
    const now = await $.clock.now()
    const clears = ((await $.store.get(CLEARS_KEY)) as ClearRecord[] | undefined) ?? []
    if (clears.some(clear => clear.handoff === handoff.id)) {
      cancelStaleCheck()
      log($, `l'handoff ${handoff.id} ha già avuto il suo clear: nessun nuovo clear`)
      return
    }
    if (clears.filter(clear => now - clear.at < HOUR_MS).length >= maxClearsPerHour) {
      cancelStaleCheck()
      log($, `limite di ${maxClearsPerHour} clear in un'ora raggiunto: l'handoff ${handoff.id} resta in attesa`)
      return
    }
    const listed = await activeAgents($, ending)
    if (listed.length > 0 && deferredId !== handoff.id) {
      // Handoff riscritto ma ancora validato con un rinvio in corso: il rinvio è lo stesso, da quando è cominciato.
      const since = deferredSince
      const warned = isDeferWarned
      resetDeferral()
      deferredId = handoff.id
      if (since === undefined) {
        deferredSince = now
        log($, `handoff ${handoff.id} validato, ma ${listed.length} agenti ancora attivi: clear rimandato a quando si fermano (${reason})`)
      } else {
        deferredSince = since
        isDeferWarned = warned
      }
    }
    const stopped = await stopDelivered($, listed, now)
    const busy = listed.filter(agent => !stopped.has(agent.id))
    if (busy.length > 0) {
      await warnLongDeferral($)
      scheduleStaleCheck($, busy, now)
      return
    }

    // La principale può essere ripartita durante gli await: il /clear spazzerebbe il suo prompt.
    if (isMainBusy) return
    isClearRequested = true
    isPauseClear = handoff.mode === PAUSE_MODE
    resetDeferral()
    try {
      await $.store.set(CLEARS_KEY, [...clears, { at: now, handoff: handoff.id }].slice(-CLEARS_KEPT))
    } catch (error) {
      isClearRequested = false
      throw error
    }
    const kind = isPauseClear ? 'validato (pausa)' : 'validato'
    log($, `handoff ${handoff.id} della sessione ${short(session)} ${kind}: eseguo /clear (${reason})`)
    runClear($, true)
  } finally {
    isTryingClear = false
  }
}

export const register: Register = (on, options) => {
  // Le soglie di /config; quelle in vigore le dà readSettings a ogni controllo.
  const configured: Pair = {
    threshold: Number(options.threshold ?? DEFAULTS.threshold),
    hardThreshold: Number(options.hardThreshold ?? DEFAULTS.hardThreshold),
  }
  maxClearsPerHour = Number(options.maxClearsPerHour ?? 3)
  maxRestartsPerHour = maxClearsPerHour
  agentsEnabled = options.agents !== false
  blockAgentsWhileDeferred = options.blockAgentsWhileDeferred !== false
  agentStaleMinutes = Math.min(Number(options.agentStaleMinutes ?? 30), MAX_STALE_MINUTES)
  const stopMinutes = Number(options.deliveredStopMinutes ?? 5)
  const waitSeconds = Number(options.handoffWaitSeconds ?? 180)
  handoffWaitMs = Number.isFinite(waitSeconds) ? Math.max(waitSeconds, 0) * 1000 : 180_000
  deliveredStopMinutes = Number.isFinite(stopMinutes) ? Math.min(Math.max(stopMinutes, 0), MAX_STALE_MINUTES) : 5
  const tokenOption = (value: unknown, fallback: number) => {
    const n = Number(value ?? fallback)
    return Number.isFinite(n) ? n : fallback
  }
  mainTokens = { soft: tokenOption(options.mainSoftTokens, 0), hard: tokenOption(options.mainHardTokens, 0) }
  const agentTokensLimits = {
    soft: tokenOption(options.agentSoftTokens, 120_000),
    hard: tokenOption(options.agentHardTokens, 150_000),
  }

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    // Il pannello di /soglia, se è aperto, segue l'uso del contesto.
    if (e.changed.includes('context')) $.ui.invalidate('ui.render')
    const percent = e.context.percent
    if (percent === undefined) return result
    const limits = await effectiveLimits($, configured)
    const zone = zoneOf(percent, limits)
    const session = await $.session.id()
    if (zone === 0) {
      // Riserva del hook session.compact, se un plugin più esterno lo salta: il contesto
      // tornato sotto la morbida dopo una zona segnalata vuol dire un compact.
      if ((await readSignaled($, session)) > 0) {
        await resetSignaled($)
        log($, 'contesto sceso sotto la morbida: le zone tornano da segnalare')
      }
      return result
    }
    if (zone <= (await readSignaled($, session))) return result
    if (pendingNote?.session === session && pendingNote.zone >= zone) return result
    pendingNote = { session, zone, text: await buildNote($, zone, percent, limits, session) }
    log($, `contesto al ${percent}% (${ZONE_NAMES[zone]}, soglie ${levels(limits, true)}): la nota parte con il prossimo prompt`)
    return result
  })

  // Streaming: i pezzi passano intatti; si legge solo l'usage del passo di un agente.
  on('turn.step', async function* ($, e, next) {
    await markSeen($, e.agentId)
    const result = yield* next(e)
    const usage = result.usage
    if (e.agentId !== undefined && usage != null) {
      agentTokens.set(e.agentId, usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens)
    }
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  // Un teammate avviato dal tool Agent: se ne tiene l'input, per rilanciarlo uguale. Solo osservazione.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // Handoff validato in attesa del clear: ogni agente nuovo della principale (fork compresi) trattiene il clear
    // di nuovo. Gli spawn della mod (validatore, rilanci) passano da $.agent.spawn, non da qui; quelli di altri
    // plugin e degli agenti non si toccano.
    if (blockAgentsWhileDeferred && agentsEnabled && deferredId !== undefined && e.agentId === undefined && next.origin.plugin === 'engine') {
      log($, `Agent «${e.description}» negato: clear in attesa del handoff ${deferredId}`)
      return { deny: DEFER_DENY }
    }
    const result = await next(e)
    // Lo spawn è già avvenuto: gli errori dell'archiviazione restano nel log (mai un secondo next).
    if (result.deny === undefined && result.isError !== true) {
      await archiveResumed($, e.prompt).catch((error: unknown) => log($, `handoff ripreso non archiviato: ${errorText(error)}`))
    }
    const record = result.result as { status?: string; agentId?: string; agent_id?: string } | undefined
    if (record?.status !== 'teammate_spawned') return result
    const agentId = record.agentId ?? record.agent_id
    if (agentId === undefined) return result
    const input: AgentInput = { description: e.description }
    if (e.name !== undefined) input.name = e.name
    if (e.subagent_type !== undefined) input.subagent_type = e.subagent_type
    if (e.model !== undefined) input.model = e.model
    if (e.effort !== undefined) input.effort = e.effort
    // Il teammate è già partito: un errore qui non deve far richiamare next dal catch (lancio doppio).
    try {
      await $.state.set({ ...AGENT_INPUTS, id: agentId }, input)
    } catch (error) {
      log($, `input del teammate ${short(agentId)} non registrato: ${errorText(error)}`)
    }
    return result
  }).catch(($, e, next) => next(e))

  // Il primo prompt dopo un /clear o un compact (la ripresa della mod o uno dell'utente,
  // non un comando) porta l'handoff validato; ogni prompt la nota di zona in attesa.
  on('prompt.submit', async ($, e, next) => {
    const context = [...(e.context ?? [])]
    const attach = attachFor
    if (attach !== undefined && e.command === undefined) {
      attachFor = undefined
      const text = await (attach.ready ?? attachedHandoff($, attach))
      if (text !== undefined) context.push(text)
    }
    if (e.command === undefined) context.push(...leadNotes.splice(0))
    const note = pendingNote
    if (note !== undefined) {
      pendingNote = undefined
      const session = await $.session.id()
      if (note.session === session && (await markSignaled($, session, note.zone))) {
        log($, `${ZONE_NAMES[note.zone]} segnalata a Claude insieme al prompt`)
        context.push(note.text)
        expectHandoff($, 'main', `${(await paths($)).root}/${handoffPath(session)}`)
      }
    }
    return context.length === (e.context?.length ?? 0) ? next(e) : next({ ...e, context })
  }).catch(($, e, next) => next(e))

  // La principale in un turno: il clear aspetta la sua fine turno, anche se un agente si ferma prima.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isMainBusy = true
    else {
      // L'agente riparte (anche ripreso dopo un TaskStop): non è più consegnato né fermato.
      endedAgents.delete(e.agentId)
      deliveredSince.delete(e.agentId)
      stoppedAgents.delete(e.agentId)
      leadAsked.delete(e.agentId)
      // Contano solo i comandi in background del turno in corso: una shell vecchia non fa un consegnato.
      backgroundCommands.delete(e.agentId)
    }
    await markSeen($, e.agentId)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // Prima di next: se next lancia, la principale non resta "in un turno" per sempre.
    if (e.agentId === undefined) isMainBusy = false
    await markSeen($, e.agentId)
    const result = await next(e)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      if (!e.isAborted) {
        endedAgents.add(agentId)
        await checkHandoffAtEnd($, agentId, e.answer).catch((error: unknown) => log($, `handoff atteso non controllato: ${errorText(error)}`))
      }
      if (e.isAborted) {
        // Validatore annullato: si libera il teammate, il suo prossimo turno rilancia lo stesso giro.
        const job = validating.get(agentId)
        if (job !== undefined) {
          validating.delete(agentId)
          checking.delete(job.agentId)
          log($, `validatore ${short(agentId)} annullato: l'handoff del teammate ${short(job.agentId)} sarà validato al suo prossimo turno`)
        }
      } else {
        const run = validating.has(agentId) ? concludeValidation($, agentId, e.answer) : checkTeammate($, agentId)
        await run.catch((error: unknown) => log($, `agente ${short(agentId)}: validazione non riuscita: ${errorText(error)}`))
      }
      // Un agente che si ferma può liberare il clear della principale, se questa è ferma.
      if (!isMainBusy) {
        await tryClear($, `agente ${short(agentId)} fermo`, agentId).catch((error: unknown) => log($, `clear non controllato: ${errorText(error)}`))
      }
      await watchDelivered($).catch((error: unknown) => log($, `agenti consegnati non controllati: ${errorText(error)}`))
      return result
    }
    await watchDelivered($).catch((error: unknown) => log($, `agenti consegnati non controllati: ${errorText(error)}`))
    if (!e.isAborted) await checkHandoffAtEnd($, 'main', e.answer).catch((error: unknown) => log($, `handoff atteso non controllato: ${errorText(error)}`))
    if (e.isAborted || isClearRequested) return result
    await tryClear($, 'fine turno della principale')
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', ($, e, next) => {
    // Un handoff di pausa archiviato e non ancora allegato passa anche a un altro /clear prima del primo prompt.
    const carried = e.reason === 'clear' ? attachFor?.ready : undefined
    forgetWait('main')
    attachFor = e.reason === 'clear' ? { owner: e.sessionId, source: 'clear', ...(carried === undefined ? {} : { ready: carried }) } : undefined
    if (e.reason === 'clear' && isClearRequested && isPauseClear) {
      // Pausa: archivio subito (resta anche se il PC si spegne), nessuna ripresa; il primo prompt scritto lo allega.
      isClearRequested = false
      isPauseClear = false
      pendingNote = undefined
      resetDeferral()
      log($, 'clear eseguito per un handoff di pausa: nessun prompt di ripresa, il lavoro resta fermo')
      attachFor = { owner: e.sessionId, source: 'clear', ready: attachedHandoff($, { owner: e.sessionId, source: 'pausa' }) }
    } else if (e.reason === 'clear' && isClearRequested) {
      isClearRequested = false
      pendingNote = undefined
      resetDeferral()
      log($, 'clear eseguito: invio il prompt di ripresa')
      $.prompt.submit({ text: RESUME }).then(
        submitted => {
          if (submitted.drop !== undefined) log($, `prompt di ripresa scartato: ${submitted.drop}`)
        },
        error => log($, `prompt di ripresa rifiutato: ${errorText(error)}`),
      )
    }
    return next(e)
  })

  // Un compact riuscito della principale: stessa sessione, contesto di nuovo basso. Le zone
  // ripartono e il prossimo prompt allega l'handoff validato della sessione.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.skip !== undefined) return result
    try {
      await orElse(resetSignaled($), undefined)
      log($, 'compact: le zone tornano da segnalare in questa sessione')
      attachFor = { owner: await $.session.id(), source: 'compact' }
    } catch (error) {
      log($, `compact non registrato: ${errorText(error)}`)
    }
    return result
  }).catch(($, e, next) => next(e))

  // /soglia e il tool context_usage: registrati a ogni caricamento del modulo,
  // anche dopo la ricarica che segue un cambio di soglia; poi la scrittura in
  // sospeso, se la ricarica è arrivata tra le due di una coppia.
  on('session.start', async ($, e, next) => {
    const [, tool] = await Promise.all([
      $.command.register({
        name: 'soglia',
        description: 'Imposta le soglie di contesto di auto-clear-context (morbida e dura)',
        argumentHint: '[N] [M] | morbida N | dura N | spento',
        immediate: true,
      }),
      orElse($.tool.register({ name: CONTEXT_TOOL_NAME, description: CONTEXT_TOOL_DESCRIPTION, isDeferred: false }), undefined),
    ])
    if (tool === undefined) log($, 'tool context_usage non registrato')
    else if (tool.tool !== CONTEXT_TOOL) log($, `tool registrato come ${tool.tool}: l'hook risponde solo a ${CONTEXT_TOOL}`)
    await orElse(finishPendingWrite($, configured), undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Il tool context_usage: una riga, senza argomenti; non chiama next, quindi
  // non tocca il motore né altri tool.
  on('tool.call', { tool: CONTEXT_TOOL }, async $ => {
    const [usage, limits] = await Promise.all([readUsage($), effectiveLimits($, configured)])
    return { result: usageLine(usage, limits) }
  }).catch(() => ({ result: 'contesto non disponibile: la lettura della mod non è riuscita' }))

  // Ogni tool, dopo i hook con matcher (context_usage risponde da sé e non arriva qui): le
  // note durante il turno nel context del risultato, un promemoria che il modello legge dopo
  // il risultato come quello di PostToolUse. Niente note su un deny né sui tool chiamati da
  // un plugin, il cui context il modello non legge. Il tool è già eseguito: dopo next nessun
  // errore esce.
  on('tool.call', async ($, e, next) => {
    await orElse(markSeen($, e.agentId), undefined)
    const result = await next(e)
    if (result.deny !== undefined || next.origin.plugin !== 'engine') return result
    const call = e as { command?: unknown; run_in_background?: unknown; skill?: unknown }
    // La skill handoff si segna dopo le note: una nota nuova nello stesso tool.call non la perde.
    const markSkill = () => {
      if (e.tool !== 'Skill' || typeof call.skill !== 'string' || !call.skill.includes('handoff')) return
      const wait = handoffWaits.get(e.agentId ?? 'main')
      if (wait !== undefined) wait.isSkillRun = true
    }
    if (e.agentId !== undefined && typeof call.command === 'string' && (call.run_in_background === true || e.tool === 'Monitor')) {
      backgroundCommands.set(e.agentId, call.command)
    }
    try {
      const zoneNotes = await turnNotes($, e.agentId, configured, agentTokensLimits).finally(markSkill)
      const notes = [...(e.agentId === undefined ? leadNotes.splice(0) : []), ...zoneNotes]
      return notes.length === 0 ? result : { ...result, context: [...(result.context ?? []), ...notes] }
    } catch (error) {
      log($, `note durante il turno non controllate: ${errorText(error)}`)
      return result
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'soglia' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') {
      await orElse(update($, notice, () => null), null)
      await orElse(update($, paneTarget, () => 'threshold'), 'threshold')
      const opened = await $.ui
        .open({ id: PANE, title: 'Soglie di contesto', focus: true, closeOnEscape: true, rows: PANE_ROWS })
        .catch((error: unknown) => ({ isPlaced: false as const, reason: errorText(error) }))
      if (opened.isPlaced) return {}
      const [settings, usage] = await Promise.all([readSettings($, configured), readUsage($)])
      const limits = limitsOf(settings.inForce)
      const window = usage?.context.window
      const current = `morbida ${describeThreshold(limits.soft, window)}, dura ${describeThreshold(limits.hard, window)}, margine di sicurezza ${limits.margin}%`
      return { text: `Il pannello di /soglia non si apre qui (${opened.reason}). Soglie attuali: ${current}; si cambiano con /soglia N M.` }
    }
    const request = parseRequest(text)
    if (request === undefined) return { text: `"${text}" non è una soglia valida: ${USAGE}` }
    const outcome = await applyThresholds($, request, configured)
    await orElse(update($, notice, () => outcome), outcome)
    return { text: outcome.text }
  }).catch(() => ({ text: '/soglia non è riuscito: le soglie si cambiano anche da /config.' }))

  // Il pannello: soglie in vigore, margine e contesto con la zona; il valore in
  // modifica (t lo cambia), i suoi preset con i token, −5/+5 e, con un override,
  // «Ripristina /config». Le opzioni che romperebbero morbida + 10 ≤ dura non
  // compaiono. Tasti nel terminale (le cifre i preset, t il valore, m e p i
  // passi, r il ripristino, Esc chiude), clic nell'app.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [usage, settings, last, editing] = await Promise.all([
      readUsage($),
      readSettings($, configured),
      orElse(read($, notice), null),
      orElse(read($, paneTarget), 'threshold' as const),
    ])
    const { inForce, inConfig } = settings
    const limits = limitsOf(inForce)
    const window = usage?.context.window
    const other: Field = editing === 'threshold' ? 'hardThreshold' : 'threshold'
    const current = inForce[editing]
    const { min, max } = boundsOf(editing, inForce)
    const fits = (percent: number) => percent >= min && percent <= max
    const presets = PRESETS[editing].filter(percent => percent === current || fits(percent))
    const down = stepThreshold(current, -STEP)
    const up = stepThreshold(current, STEP)
    const overrides = describeOverrides(settings, window)
    const choose = (percent: number) => () => {
      void reportFromPane($, configured, () => applyThresholds($, only(editing, percent), configured))
    }
    const toggle = () => {
      void update($, paneTarget, field => (field === 'threshold' ? 'hardThreshold' : 'threshold'))
    }
    const reset = () => {
      void reportFromPane($, configured, () => resetOverrides($, configured))
    }
    // Un esito vale finché le soglie in vigore sono quelle che ha prodotto: dopo
    // un cambio da fuori (un'altra sessione, /config) non si mostra più.
    const shown = last !== null && last.threshold === inForce.threshold && last.hardThreshold === inForce.hardThreshold ? last : null

    return (
      <Box flexDirection="column">
        <Text bold={editing === 'threshold'}>Soglia morbida: {describeThreshold(inForce.threshold, window)}</Text>
        <Text bold={editing === 'hardThreshold'}>Soglia dura: {describeHard(inForce, limits, window)}</Text>
        <Text dimColor>{`Margine di sicurezza: ${describeThreshold(limits.margin, window)} (dura + ${MARGIN_GAP})`}</Text>
        {overrides !== undefined && <Text color="warning">{overrides}</Text>}
        <Text dimColor>{describeUsage(usage, limits)}</Text>
        <Box marginTop={1}>
          <Button key="target" hotkey="t" plain onPress={toggle}>
            In modifica: {LABELS[editing]}
            <Text dimColor> · passa alla {LABELS[other]}</Text>
          </Button>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {presets.map(percent => (
            <Button
              key={`preset-${percent}`}
              hotkey={String(percent / 10)}
              plain
              variant={percent === current ? 'primary' : 'secondary'}
              onPress={choose(percent)}
            >
              {percent === 0 ? 'Spento' : describeThreshold(percent, window)}
              {percent === current && <Text dimColor> ← attuale</Text>}
            </Button>
          ))}
        </Box>
        <Box marginTop={1} columnGap={3}>
          {down !== current && fits(down) && (
            <Button key="down" hotkey="m" plain onPress={choose(down)}>
              −5 → {down === 0 ? 'spento' : `${down}%`}
            </Button>
          )}
          {up !== current && fits(up) && (
            <Button key="up" hotkey="p" plain onPress={choose(up)}>
              +5 → {up}%
            </Button>
          )}
        </Box>
        {overrides !== undefined && (
          <Button key="reset" hotkey="r" plain onPress={reset}>
            {`Ripristina /config (${inConfig.threshold}/${inConfig.hardThreshold}%)`}
          </Button>
        )}
        {shown !== null && <Text color={shown.isError ? 'error' : 'success'}>{shown.text}</Text>}
        <Text dimColor>Valori liberi: /soglia N M (morbida e dura){e.surface === 'terminal' ? ' · Esc chiude' : ''}</Text>
      </Box>
    )
  })
}
