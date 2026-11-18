import type { EngineInterface, Register } from 'claude-code'
import { configurazione, decidi, dirComando, leggiPs, occupanti, pulisci, quantiPesanti } from './logica'
import type { Config, Processo } from './logica'

// Suite e build (comandi pesanti) solo in primo piano, con timeout 600000, uno per Bash: in background, o in primo
// piano col timeout predefinito di 120 s (che l'harness sposta in background da solo), l'agente chiude il turno ad
// aspettare una notifica che non lo sveglia. Rifiuta anche un comando pesante se ne gira già uno nello stesso albero
// git o se sulla macchina ce ne sono già maxSullaMacchina. Port di pokefootleague/.claude/hooks/no-suite-background.py.
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

export const register: Register = on => {
  const avvisato = new Set<string>()
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
    if (cfg.controlloProcessi && typeof e.command === 'string' && quantiPesanti(e.command, cfg) > 0) {
      let msg: string | undefined
      try {
        const { genitori, procs } = await processi($, cfg)
        const home = await $.env.get('HOME').catch(() => undefined)
        const mio = await albero($, dirComando(e.command, await $.session.cwd(), home ?? undefined))
        msg = occupanti(procs, mio, cfg, genitori)
      } catch {
        msg = undefined // mai bloccare per un errore nella lettura dei processi
      }
      if (msg) return { deny: `${$.plugin.name}: ${msg}` }
    }
    return next(e)
  })
}
