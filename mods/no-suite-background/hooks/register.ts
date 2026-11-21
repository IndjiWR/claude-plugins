import type { EngineInterface, Register } from 'claude-code'
import { configurazione, correggi, decidi, dirComando, etaLeggibile, leggiPs, occupanti, prenotati, pulisci, quantiPesanti, semplice, timeoutPredefinito } from './logica'
import type { Config, Prenotazione, Processo } from './logica'

// Suite e build (comandi pesanti) solo in primo piano, con timeout 600000, uno per Bash: in background, o in primo
// piano col timeout predefinito di 120 s (che l'harness sposta in background da solo), l'agente chiude il turno ad
// aspettare una notifica che non lo sveglia. Rifiuta il background e più comandi pesanti in un Bash; il timeout
// assente o basso lo corregge (next con l'input riscritto, l'updatedInput delle mod), con `riassunto` anche pytest.
// Se un comando pesante gira già nello stesso albero git, o sulla macchina ce ne sono già maxSullaMacchina, il comando
// aspetta il suo turno (coda FIFO su file, al più attesaMassima secondi) invece di essere rifiutato. In auto mode il
// classificatore non giudica un input riscritto: per un comando pesante semplice la mod risponde allow (tool.judge);
// con BASH_DEFAULT_TIMEOUT_MS sufficiente un timeout assente non si riscrive.
// Port di pokefootleague/.claude/hooks/no-suite-background.py.
// Attiva solo nei progetti con .claude/no-suite-background.json (anche `{}`): vedi README.

const FILE = '.claude/no-suite-background.json'

async function leggiConfig($: EngineInterface, avvisato: Set<string>): Promise<Config | null> {
  const percorso = `${(await $.session.root()).replace(/\/+$/, '')}/${FILE}`
  let testo: string | undefined
  try {
    testo = (await $.fs.read(percorso)) as string
  } catch {
    return null
  }
  const cfg = configurazione(testo)
  if (cfg === null && !avvisato.has(percorso)) {
    avvisato.add(percorso)
    $.ui.log(`${$.plugin.name}: ${percorso} non è un oggetto JSON valido, la mod resta spenta`, { to: 'debug' })
  }
  return cfg
}

async function albero($: EngineInterface, d: string | null | undefined): Promise<string | null> {
  if (!d) return null
  const dir = pulisci(d)
  try {
    const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 10000 })
    const top = r.stdout.trim()
    if (r.exitCode === 0 && top) return top
  } catch {
    // git assente o lento: vale la cartella
  }
  return dir
}

async function processi($: EngineInterface, cfg: Config) {
  const ps = await $.process.run(['ps', '-axo', 'pid=,ppid=,etime=,command='], { timeoutMs: 10000 })
  if (ps.exitCode !== 0) throw new Error(`ps: uscita ${ps.exitCode}`)
  const { genitori, pesanti } = leggiPs(ps.stdout, cfg)
  const out: Processo[] = []
  for (const p of pesanti) {
    let cwd: string | null = null
    try {
      const o = await $.process.run(['lsof', '-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], { timeoutMs: 10000 })
      cwd = o.stdout.split('\n').find(l => l.startsWith('n'))?.slice(1) ?? null
    } catch {
      // processo sparito o lsof assente: albero sconosciuto
    }
    out.push({ ...p, cwd, albero: await albero($, cwd) })
  }
  return { genitori, procs: out }
}

const SONNO_S = 5 // un giro della coda
const VECCHIO = 10 * 60_000 // un file della coda più vecchio si toglie

async function togli($: EngineInterface, file: string) {
  try {
    await $.process.run(['rm', '-f', file], { timeoutMs: 10000 })
  } catch {
    // resta: scade da solo
  }
}

/** Le prenotazioni in `dir`; quelle oltre VECCHIO le toglie. Un errore vale una coda vuota. */
async function leggiCoda($: EngineInterface, dir: string, ora: number): Promise<Prenotazione[]> {
  const out: Prenotazione[] = []
  let voci: Awaited<ReturnType<EngineInterface['fs']['list']>>
  try {
    voci = await $.fs.list(dir)
  } catch {
    return out
  }
  for (const v of voci) {
    if (v.kind !== 'file' || !v.name.endsWith('.json')) continue
    const file = `${dir}/${v.name}`
    if (ora - v.mtimeMs > VECCHIO) {
      await togli($, file)
      continue
    }
    try {
      const d = JSON.parse((await $.fs.read(file)) as string) as Record<string, unknown>
      out.push({
        nome: v.name.slice(0, -'.json'.length),
        stato: d.stato === 'partito' ? 'partito' : 'attesa',
        t: Number(d.t) || 0,
        agg: v.mtimeMs,
        albero: typeof d.albero === 'string' ? d.albero : null,
        cmd: typeof d.cmd === 'string' ? d.cmd : '',
      })
    } catch {
      // file a metà o sparito: non conta
    }
  }
  return out
}

export const register: Register = on => {
  const avvisato = new Set<string>()
  // tool_use_id dei Bash semplici di cui la mod ha riscritto l'input: in auto mode li lascia passare (tool.judge).
  const riscritti = new Set<string>()
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let cfg: Config | null
    try {
      cfg = await leggiConfig($, avvisato)
    } catch {
      return next(e) // mai bloccare per un errore della mod
    }
    if (cfg === null) return next(e)
    const motivo = decidi(e, cfg)
    if (motivo) return { deny: `${$.plugin.name}: ${motivo}` }
    // Con BASH_DEFAULT_TIMEOUT_MS nelle settings il timeout assente non si riscrive (0.3.1).
    const predefinito = timeoutPredefinito(await $.env.get('BASH_DEFAULT_TIMEOUT_MS').catch(() => undefined))
    const modifica = correggi(e, cfg, predefinito)
    const finale = modifica ? { ...e, ...modifica } : e
    // In auto mode il judge di questa chiamata scatta dentro next: l'id vale solo per la sua durata.
    const id = modifica && typeof e.tool_use_id === 'string' && typeof e.command === 'string' && semplice(e.command, cfg)
      ? e.tool_use_id
      : undefined
    const esegui = async () => {
      if (id !== undefined) riscritti.add(id)
      try {
        return await next(finale)
      } finally {
        if (id !== undefined) riscritti.delete(id)
      }
    }
    if (!cfg.controlloProcessi || typeof e.command !== 'string' || quantiPesanti(e.command, cfg) === 0) return esegui()

    // Coda: si aspetta un posto (stesso albero libero, tetto non pieno), un giro ogni SONNO_S secondi.
    let mio: string | null = null
    let dir: string | null = null
    try {
      const home = await $.env.get('HOME').catch(() => undefined)
      if (home) dir = `${home.replace(/\/+$/, '')}/.claude/no-suite-background/coda`
      mio = await albero($, dirComando(e.command, await $.session.cwd(), home ?? undefined))
    } catch {
      // albero sconosciuto: vale solo il tetto
    }
    const coda = cfg.attesaMassima > 0 && dir !== null
    const inizio = await $.clock.now()
    const nome = `${String(inizio).padStart(13, '0')}-${e.tool_use_id ?? Math.random().toString(36).slice(2)}`
    const file = `${dir}/${nome}.json`
    const scrivi = async (stato: 'attesa' | 'partito', t: number) => {
      if (!coda) return
      try {
        await $.fs.write(file, JSON.stringify({ stato, t, albero: mio, cmd: e.command }))
      } catch {
        // senza file la coda vale solo per questo processo: si va avanti col solo ps
      }
    }
    try {
      for (;;) {
        await scrivi('attesa', inizio) // rinfresco a ogni giro: un'attesa ferma da 30 s è di una sessione morta
        let msg: string | undefined
        try {
          const { genitori, procs } = await processi($, cfg)
          const ora = await $.clock.now()
          const altri = coda && dir !== null ? prenotati(await leggiCoda($, dir, ora), nome, procs, ora) : []
          msg = occupanti(procs, mio, cfg, genitori, altri)
        } catch {
          msg = undefined // mai bloccare per un errore nella lettura dei processi
        }
        if (!msg) break
        if (!coda) return { deny: `${$.plugin.name}: ${msg}` }
        const atteso = ((await $.clock.now()) - inizio) / 1000
        if (atteso >= cfg.attesaMassima || next.signal.aborted) {
          return {
            deny: `${$.plugin.name}: in coda da ${etaLeggibile(Math.trunc(atteso))} senza un posto ` +
              `(attesaMassima ${cfg.attesaMassima} s). ${msg} Non aspettare con sleep: riprova più tardi o fai altro intanto.`,
          }
        }
        await $.process.run(['sleep', String(SONNO_S)], { timeoutMs: (SONNO_S + 10) * 1000 })
      }
      await scrivi('partito', await $.clock.now())
      return await esegui()
    } finally {
      if (coda) await togli($, file)
    }
  })
  on('tool.judge', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    const nostro = riscritti.has(e.tool_use_id)
    if (r.decision === 'ask' && nostro) {
      return { decision: 'allow', reason: `${$.plugin.name}: comando pesante semplice, input cambiato dalla mod (timeout o riassunto)` }
    }
    return r
  })
}
