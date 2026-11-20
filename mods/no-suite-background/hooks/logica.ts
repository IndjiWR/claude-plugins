// Logica pura della mod: lettura dei comandi, comandi pesanti, configurazione, processi.
// Port dell'hook no-suite-background.py di pokefootleague (commit 32ecc99d, 48160b9a).

export const PREDEFINITI = ['pytest', 'py.test', 'npm test', 'npm run test', 'vitest', 'cargo test', 'cargo build']
const TIMEOUT_MASSIMO = 600000 // il massimo che il Bash accetta: oltre, l'agente non potrebbe obbedire

export type Config = {
  voci: string[][]
  testi: string[]
  nonContati: string[][]
  timeoutMinimo: number
  maxSullaMacchina: number
  controlloProcessi: boolean
  riassunto: boolean
  attesaMassima: number
}

export type Processo = { pid: number; ppid: number; eta: number; cmd: string; albero?: string | null; cwd?: string | null }

const PUNT = ';&|()'
const SPAZI = ' \t\r\n'

/** Token in stile shlex POSIX; con `punteggiatura` i separatori `; & | ( )` diventano token a sé.
 * null se una virgoletta non si chiude o un backslash chiude il testo. */
export function tokenizza(cmd: string, punteggiatura: boolean): string[] | null {
  const out: string[] = []
  let cur = ''
  let aperto = false
  const chiudi = () => {
    if (aperto) out.push(cur)
    cur = ''
    aperto = false
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd.charAt(i)
    if (punteggiatura && c === '\n') {
      chiudi()
      out.push(';')
    } else if (SPAZI.includes(c)) {
      chiudi()
    } else if (c === '#' && !aperto) {
      // commento fino all'a capo (un apostrofo dentro non apre una virgoletta)
      while (i + 1 < cmd.length && cmd.charAt(i + 1) !== '\n') i++
    } else if (punteggiatura && PUNT.includes(c)) {
      chiudi()
      let p = c
      while (i + 1 < cmd.length && PUNT.includes(cmd.charAt(i + 1))) p += cmd.charAt(++i)
      out.push(p)
    } else if (c === "'") {
      const fine = cmd.indexOf("'", i + 1)
      if (fine < 0) return null
      cur += cmd.slice(i + 1, fine)
      aperto = true
      i = fine
    } else if (c === '"') {
      aperto = true
      let j = i + 1
      for (; j < cmd.length && cmd.charAt(j) !== '"'; j++) {
        if (cmd.charAt(j) === '\\' && (cmd.charAt(j + 1) === '"' || cmd.charAt(j + 1) === '\\')) j++
        cur += cmd.charAt(j)
      }
      if (j >= cmd.length) return null
      i = j
    } else if (c === '\\') {
      if (i + 1 >= cmd.length) return null
      cur += cmd.charAt(++i)
      aperto = true
    } else {
      cur += c
      aperto = true
    }
  }
  chiudi()
  return out
}

/** I comandi semplici di `cmd`, ognuno come lista di token. Le virgolette tengono insieme un argomento
 * (`pgrep -f "python -m pytest|suite.sh"` è un solo comando); se non si chiudono, split grezzo. */
export function parti(cmd: string): string[][] {
  const tok = tokenizza(cmd, true)
  if (tok === null) {
    return cmd.split(/&&|\|\||[;|\n&()]/).map(p => p.split(/\s+/).filter(Boolean)).filter(p => p.length > 0)
  }
  const out: string[][] = []
  let cur: string[] = []
  for (const t of tok) {
    if (t !== '' && [...t].every(c => PUNT.includes(c))) {
      out.push(cur)
      cur = []
    } else cur.push(t)
  }
  out.push(cur)
  return out.filter(p => p.length > 0)
}

const base = (t: string) => t.split('/').pop() ?? t
const PREFISSI = new Set(['env', 'time', 'nice', 'nohup', 'exec', 'command', 'npx', 'bunx', 'sudo', 'xargs', 'timeout'])
const PAROLE = new Set(['!', '{', 'do', 'then', 'else', 'elif', 'if', 'while', 'until'])
const RUNNER = new Set(['uv', 'poetry', 'pipenv', 'pdm'])
const SHELL = new Set(['sh', 'bash', 'zsh', 'dash'])
const SHELL_C = /^-[a-z]*c[a-z]*$/
// Opzioni che prendono un argomento separato, per programma.
const CON_ARG: Record<string, readonly string[]> = {
  nice: ['-n'], sudo: ['-u', '-g', '-C'], xargs: ['-n', '-I', '-L', '-P', '-d', '-E', '-s'], timeout: ['-s', '-k'],
  env: ['-u', '-C', '-S'], python: ['-W', '-X'],
}
const opzione = (t: string | undefined) => t !== undefined && t.startsWith('-') && t !== '-'

/** Salta le opzioni da `i` in poi; ritorna l'indice del primo token che non è un'opzione. */
function salta(t: readonly string[], i: number, prog: string): number {
  const conArg = CON_ARG[prog] ?? []
  while (opzione(t[i])) i += conArg.includes(t[i] ?? '') ? 2 : 1
  return i
}

/** Toglie i prefissi che lanciano un altro comando: `VAR=x`, `env`, `sudo`, `timeout 900`, `npx`, `uv run`,
 * `python [-u] -m X`, `bash [-x] script`, `node script`, parole chiave della shell (`do`, `then`, `!`…). */
export function normalizza(tok: readonly string[]): string[] {
  let t = [...tok]
  for (let giri = 0; giri < 16 && t.length > 0; giri++) {
    const t0 = t[0] ?? ''
    const b = base(t0)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t0) || PAROLE.has(t0)) t = t.slice(1)
    else if (PREFISSI.has(b)) {
      if (b === 'command' && /^-[vV]/.test(t[1] ?? '')) break // `command -v pytest` cerca, non lancia
      const i = salta(t, 1, b)
      t = t.slice(b === 'timeout' ? i + 1 : i)
    } else if ((RUNNER.has(b) && t[1] === 'run') || ((b === 'pnpm' || b === 'yarn') && t[1] === 'exec')) t = t.slice(salta(t, 2, b))
    else if (b.startsWith('python')) {
      let i = 1
      while (opzione(t[i]) && t[i] !== '-m' && !(t[i] ?? '').startsWith('-c')) i += CON_ARG.python?.includes(t[i] ?? '') ? 2 : 1
      if (t[i] === '-m' && t[i + 1] !== undefined) t = t.slice(i + 1)
      else if (t[i] !== undefined && !opzione(t[i])) t = t.slice(i)
      else break
    } else if (SHELL.has(b) || b === 'node') {
      let i = 1
      while (opzione(t[i]) && !(SHELL.has(b) && SHELL_C.test(t[i] ?? ''))) i++
      if (t[i] !== undefined && !opzione(t[i])) t = t.slice(i)
      else break
    } else break
  }
  return t
}

/** In `bash [opzioni] -c "…"` la stringa del comando, se c'è. */
function stringaShell(t: readonly string[]): string | undefined {
  if (!SHELL.has(base(t[0] ?? ''))) return undefined
  for (let i = 1; opzione(t[i]); i++) if (SHELL_C.test(t[i] ?? '')) return t[i + 1]
  return undefined
}

const corrisponde = (t: readonly string[], voce: readonly string[]) =>
  voce.length > 0 && t.length >= voce.length && base(t[0] ?? '') === base(voce[0] ?? '') && voce.slice(1).every((w, i) => t[i + 1] === w)

const pesanteTok = (tok: readonly string[], voci: readonly string[][]) => {
  const t = normalizza(tok)
  return voci.some(v => corrisponde(t, v))
}

function contaParte(tok: readonly string[], cfg: Config, prof: number): number {
  const t = normalizza(tok)
  const interno = stringaShell(t)
  if (interno !== undefined && prof < 4) return conta(interno, cfg, prof + 1)
  return cfg.voci.some(v => corrisponde(t, v)) ? 1 : 0
}

function conta(cmd: string, cfg: Config, prof: number): number {
  return parti(cmd).reduce((n, p) => n + contaParte(p, cfg, prof), 0)
}

export const quantiPesanti = (cmd: string, cfg: Config) => conta(cmd, cfg, 0)

const voce = (s: string) => normalizza(tokenizza(s, false) ?? s.split(/\s+/).filter(Boolean))
const stringhe = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : null)

/** La configurazione del progetto dal testo di `.claude/no-suite-background.json`; null = mod spenta. */
export function configurazione(testo: string | undefined): Config | null {
  if (testo === undefined) return null
  let d: unknown
  try {
    d = JSON.parse(testo)
  } catch {
    return null
  }
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return null
  const o = d as Record<string, unknown>
  const testi = [...(stringhe(o.comandi) ?? PREDEFINITI), ...(stringhe(o.aggiungi) ?? [])]
  const tm = typeof o.timeoutMinimo === 'number' && o.timeoutMinimo > 0 ? Math.min(o.timeoutMinimo, TIMEOUT_MASSIMO) : TIMEOUT_MASSIMO
  const mx = typeof o.maxSullaMacchina === 'number' && o.maxSullaMacchina >= 0 ? Math.floor(o.maxSullaMacchina) : 3
  return {
    voci: testi.map(voce),
    testi,
    nonContati: (stringhe(o.nonContati) ?? []).map(voce),
    timeoutMinimo: tm,
    maxSullaMacchina: mx,
    controlloProcessi: typeof o.controlloProcessi === 'boolean' ? o.controlloProcessi : true,
    riassunto: o.riassunto === true,
    attesaMassima: typeof o.attesaMassima === 'number' && o.attesaMassima >= 0 ? Math.floor(o.attesaMassima) : 1200,
  }
}

export type InputBash = { command?: unknown; run_in_background?: unknown; timeout?: unknown }

/** Il motivo del rifiuto per un Bash, senza guardare i processi; undefined se passa. Il timeout basso non si
 * rifiuta: lo corregge `correggi`. */
export function decidi(input: InputBash, cfg: Config): string | undefined {
  const cmd = typeof input.command === 'string' ? input.command : ''
  const n = quantiPesanti(cmd, cfg)
  if (n === 0) return undefined
  const elenco = cfg.testi.join(', ')
  const motivo = `lancialo in primo piano, timeout ${cfg.timeoutMinimo} (${elenco} non vanno in background)`
  if (input.run_in_background === true || input.run_in_background === 'true') return motivo
  if (n > 1) {
    return `un solo comando pesante (${elenco}) per Bash: insieme possono superare i 10 minuti e l'harness li sposta ` +
      `in background; lanciali in Bash separati, ognuno con timeout ${cfg.timeoutMinimo}`
  }
  return undefined
}

/** I token (normalizzati) dei comandi pesanti, anche dentro `bash -c "…"`. */
function tokPesanti(cmd: string, cfg: Config, prof: number): string[][] {
  return parti(cmd).flatMap(p => {
    const t = normalizza(p)
    const interno = stringaShell(t)
    if (interno !== undefined && prof < 4) return tokPesanti(interno, cfg, prof + 1)
    return cfg.voci.some(v => corrisponde(t, v)) ? [t] : []
  })
}

// Seguita da virgoletta (`"pytest" tests`) l'inserimento finirebbe dentro il nome del programma: non si tocca.
const PAROLA_PYTEST = /(^|[\s;&|(/"'`])(py\.test|pytest)(?=$|[\s;&|)])/g
const SILENZIO = /^-[A-Za-z]*[qv][A-Za-z]*$|^--(quiet|verbose)$|^--verbosity(=|$)/

/** Con `riassunto`: il comando con `-q --tb=line` dopo la parola pytest, se l'unico comando pesante è pytest senza
 * `-q`/`-v`. undefined se non si tocca (la parola pytest compare più volte nel testo: non si sa quale sia). */
function riassunto(cmd: string, cfg: Config): string | undefined {
  const [t] = tokPesanti(cmd, cfg, 0)
  if (!t || !['pytest', 'py.test'].includes(base(t[0] ?? ''))) return undefined
  const arg = t.slice(1)
  if (arg.some(a => SILENZIO.test(a))) return undefined
  const trovate = [...cmd.matchAll(PAROLA_PYTEST)]
  if (trovate.length !== 1) return undefined
  const fine = (trovate[0]?.index ?? 0) + (trovate[0]?.[0].length ?? 0)
  const extra = arg.some(a => a === '--tb' || a.startsWith('--tb=')) ? ' -q' : ' -q --tb=line'
  return cmd.slice(0, fine) + extra + cmd.slice(fine)
}

/** I campi da riscrivere in un Bash con un solo comando pesante in primo piano: `timeout` portato a `timeoutMinimo`
 * se assente o più basso; con `riassunto`, `command` con `-q --tb=line`. undefined se non c'è niente da cambiare. */
export function correggi(input: InputBash, cfg: Config): { timeout?: number; command?: string } | undefined {
  if (typeof input.command !== 'string' || decidi(input, cfg) !== undefined) return undefined
  if (quantiPesanti(input.command, cfg) !== 1) return undefined
  const out: { timeout?: number; command?: string } = {}
  const v = Number(input.timeout ?? 0)
  const t = Number.isFinite(v) ? Math.trunc(v) : 0
  if (t < cfg.timeoutMinimo) out.timeout = cfg.timeoutMinimo
  const c = cfg.riassunto ? riassunto(input.command, cfg) : undefined
  if (c !== undefined) out.command = c
  return Object.keys(out).length > 0 ? out : undefined
}

export function etaSecondi(e: string): number {
  const k = e.lastIndexOf('-')
  const giorni = k >= 0 ? Number(e.slice(0, k)) : 0
  const sec = e.slice(k + 1).split(':').reduce((s, x) => s * 60 + Number(x), 0)
  return sec + giorni * 86400
}

export function etaLeggibile(s: number): string {
  const due = (n: number) => String(n).padStart(2, '0')
  if (s >= 3600) return `${Math.floor(s / 3600)}h${due(Math.floor((s % 3600) / 60))}m`
  return `${Math.floor(s / 60)}m${due(s % 60)}s`
}

/** Un processo pesante vero (riga di `ps`), non una shell `-c` né un worker che lo cita nel testo. */
export function principale(cmd: string, cfg: Config): boolean {
  return pesanteTok(tokenizza(cmd, false) ?? cmd.split(/\s+/).filter(Boolean), cfg.voci)
}

/** Righe di `ps -axo pid=,ppid=,etime=,command=`: tutti i genitori e i processi pesanti. */
export function leggiPs(out: string, cfg: Config): { genitori: Map<number, number>; pesanti: Processo[] } {
  const genitori = new Map<number, number>()
  const pesanti: Processo[] = []
  for (const r of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(r)
    if (!m) continue
    const [, a = '', b = '', etime = '', cmd = ''] = m
    const pid = Number(a)
    const ppid = Number(b)
    genitori.set(pid, ppid)
    if (principale(cmd, cfg)) pesanti.push({ pid, ppid, eta: etaSecondi(etime), cmd })
  }
  return { genitori, pesanti }
}

/** La cartella in cui gira `cmd`: un `cd <dir> &&` o `cd <dir>;` in testa la sposta. */
export function dirComando(cmd: string, cwd: string, home?: string): string {
  const m = /^\s*cd\s+(\S+)\s*(?:&&|;)/.exec(cmd)
  if (!m) return cwd
  let d = (m[1] ?? '').replace(/^['"]|['"]$/g, '')
  if (home && (d === '~' || d.startsWith('~/'))) d = home + d.slice(1)
  return pulisci(d.startsWith('/') ? d : `${cwd.replace(/\/+$/, '')}/${d}`)
}

export function pulisci(p: string): string {
  const out: string[] = []
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return `/${out.join('/')}`
}

/** Il motivo del rifiuto se un comando pesante occupa già lo stesso albero, o il tetto sulla macchina è pieno.
 * `procs` ha l'albero già risolto; si contano solo i processi radice (né worker né figli di un pesante). */
export function occupanti(
  procs: readonly Processo[], mio: string | null, cfg: Config, genitori?: Map<number, number>, prenotati: readonly Processo[] = [],
): string | undefined {
  const pesanti = procs.filter(p => principale(p.cmd, cfg))
  const pids = new Set(pesanti.map(p => p.pid))
  const haAntenatoPesante = (p: Processo) => {
    let q = p.ppid
    for (let giri = 0; giri < 64 && q > 1; giri++) {
      if (pids.has(q)) return true
      const g = genitori?.get(q)
      if (g === undefined) return false
      q = g
    }
    return false
  }
  const radici = [...pesanti.filter(p => !haAntenatoPesante(p)), ...prenotati]
  const desc = (p: Processo, motivo: string) => {
    const c = p.cmd.length <= 80 ? p.cmd : `${p.cmd.slice(0, 77)}...`
    const chi = p.pid > 0 ? `il PID ${p.pid}` : 'un comando pesante in coda o appena partito'
    return `${motivo}: occupa il posto ${chi} (da ${etaLeggibile(Math.trunc(p.eta))}, ` +
      `albero ${p.albero || 'sconosciuto'}, comando \`${c}\`). Aspetta che finisca o fermalo se è un tuo doppione.`
  }
  if (mio) {
    const stesso = radici.find(p => p.albero === mio)
    if (stesso) return desc(stesso, 'Nello stesso albero di lavoro gira già un comando pesante')
  }
  const contati = radici.filter(p => !pesanteTok(tokenizza(p.cmd, false) ?? p.cmd.split(/\s+/), cfg.nonContati))
  if (cfg.maxSullaMacchina > 0 && contati.length >= cfg.maxSullaMacchina) {
    const vecchio = contati.reduce((a, b) => (b.eta > a.eta ? b : a))
    return desc(vecchio, `Sulla macchina girano già ${contati.length} comandi pesanti (massimo ${cfg.maxSullaMacchina})`)
  }
  return undefined
}

/** Una prenotazione della coda, da un file di `~/.claude/no-suite-background/coda/`. `nome` ordina la coda
 * (istante d'ingresso a 13 cifre, poi un id); `agg` è l'ultimo rinfresco (mtime del file). */
export type Prenotazione = { nome: string; stato: 'attesa' | 'partito'; t: number; agg: number; albero: string | null; cmd: string }

/** Oltre questa età una prenotazione non conta: un'attesa non rinfrescata (sessione morta), un partito già in `ps`. */
export const SCADENZA_PRENOTAZIONE = 30_000

/** Le prenotazioni degli altri che occupano un posto per `mio`, come processi senza PID (`eta` in secondi):
 * le attese vive arrivate prima (FIFO) e i partiti recenti che `ps` non mostra ancora (nessuna radice nello stesso
 * albero con un'età compatibile). */
export function prenotati(lista: readonly Prenotazione[], mio: string, procs: readonly Processo[], ora: number): Processo[] {
  return lista.filter(p => {
    if (p.nome === mio) return false
    if (p.stato === 'attesa') return p.nome < mio && ora - p.agg <= SCADENZA_PRENOTAZIONE
    const eta = (ora - p.t) / 1000
    if (ora - p.t > SCADENZA_PRENOTAZIONE) return false
    return !procs.some(q => p.albero !== null && q.albero === p.albero && q.eta <= eta + 5)
  }).map(p => ({ pid: 0, ppid: 0, eta: Math.max(0, (ora - p.t) / 1000), cmd: p.cmd, albero: p.albero }))
}

const FILTRI = new Set(['tail', 'head', 'grep', 'wc', 'sort', 'uniq', 'cut', 'true', 'echo'])
const VIETATI = new Set(['sudo', 'xargs', 'eval', 'exec', 'source', '.', ...SHELL])
const OPERATORI = new Set(['&&', '||', ';', '|'])

/** Il comando è un solo comando pesante, al più con `cd <dir>` e filtri in pipe (`tail`, `grep`…, anche `true` ed `echo`), uniti da
 * `&&`, `||`, `;`, `|`: niente sostituzioni, redirezioni (salvo `2>&1`), background, sottoshell, a capo. Solo su
 * questi, riscritti dalla mod, il hook `tool.judge` risponde allow al posto del classificatore dell'auto mode. */
export function semplice(cmd: string, cfg: Config): boolean {
  const s = cmd.replace(/(^|\s)2>&1(?=\s|$)/g, ' ')
  if (/[<>`\n\\]|\$\(/.test(s)) return false
  const tok = tokenizza(s, true)
  if (tok === null) return false
  let pesanti = 0
  let parte: string[] = []
  const chiudi = (): boolean => {
    const t = parte
    parte = []
    if (t.length === 0) return false
    const b = base(t[0] ?? '')
    if (b === 'cd') return t.length <= 2
    if (FILTRI.has(b)) return true
    if (VIETATI.has(b)) return false
    const n = normalizza(t)
    if (VIETATI.has(base(n[0] ?? '')) || !cfg.voci.some(v => corrisponde(n, v))) return false
    pesanti++
    return true
  }
  for (const t of tok) {
    if (t !== '' && [...t].every(c => PUNT.includes(c))) {
      if (!OPERATORI.has(t) || !chiudi()) return false
    } else parte.push(t)
  }
  return chiudi() && pesanti === 1
}
