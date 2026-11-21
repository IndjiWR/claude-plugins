import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CONFIG = '/p/.claude/no-suite-background.json'
const POKE = JSON.stringify({
  comandi: ['pytest', 'py.test', 'tools/suite.sh', 'python -m footmon.render.gallery'],
  nonContati: ['python -m footmon.render.gallery'],
})
// Come la 0.2.0: rifiuto immediato invece della coda.
const POKE0 = JSON.stringify({ ...JSON.parse(POKE), attesaMassima: 0 })
const CODA = '/home/u/.claude/no-suite-background/coda'

type Proc = { pid: number; ppid: number; etime: string; cwd: string; cmd: string }

// Il mondo sotto la mod: un progetto in /p, i file, i processi (ps, lsof, git) e il fondo di tool.call.
const world = (on: On, env: Record<string, string> = {}) => {
  mock.env(on, { HOME: '/home/u', ...env })
  const clock = mock.clock(on, { now: 1_000_000 })
  const state = {
    clock,
    mtime: new Map<string, number>(),
    sonni: 0,
    // Chiamato a ogni `sleep` della coda, dopo che l'orologio è andato avanti di 5 s.
    dopoSonno: undefined as undefined | ((n: number) => void),
    // Chiamato quando il fondo esegue un Bash: simula il processo che parte.
    avvio: undefined as undefined | ((command: string) => void),
    judge: [] as unknown[],
    verdetto: 'ask' as 'ask' | 'deny' | 'allow',
    // Come in auto mode: il fondo chiede tool.judge prima di eseguire; i verdetti finali qui.
    verdetti: [] as string[],
    judge$: undefined as Engine | undefined,
    listaRotta: false,
    ids: [] as (string | undefined)[],
    cwd: '/w/b',
    files: new Map<string, string>(),
    procs: [] as Proc[],
    psRotto: false,
    toplevel: new Map<string, string>(),
    runs: [] as string[][],
    eseguiti: [] as string[],
    input: [] as { command: string; timeout?: number }[],
    logs: [] as string[],
  }
  on('session.root', () => ({ value: '/p' }))
  on('session.cwd', () => ({ value: state.cwd }))
  on('fs.read', (_, e) => {
    const t = state.files.get(e.path)
    return t === undefined ? { deny: `ENOENT ${e.path}` } : { value: t }
  })
  on('fs.write', (_, e) => {
    state.files.set(e.path, e.text)
    state.mtime.set(e.path, clock.now())
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    if (state.listaRotta) return { deny: 'EACCES' } as never
    const dir = e.path.replace(/\/+$/, '')
    const v = [...state.files.keys()].filter(k => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/'))
      .map(k => ({ name: k.slice(dir.length + 1), kind: 'file', size: 1, mtimeMs: state.mtime.get(k) ?? 0, isLink: false }))
    return { value: v as never }
  })
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } as never })
    if (argv[0] === 'sleep') {
      state.sonni++
      await clock.advance(Number(argv[1]) * 1000)
      state.dopoSonno?.(state.sonni)
      return ok('')
    }
    if (argv[0] === 'rm') {
      for (const f of argv.slice(2)) state.files.delete(f)
      return ok('')
    }
    state.runs.push(argv)
    if (argv[0] === 'ps') {
      if (state.psRotto) return { deny: 'ps: non trovato' } as never
      return ok(state.procs.map(p => `${p.pid} ${p.ppid} ${p.etime} ${p.cmd}`).join('\n') + '\n')
    }
    if (argv[0] === 'lsof') {
      const p = state.procs.find(q => String(q.pid) === argv[argv.indexOf('-p') + 1])
      return ok(p ? `p${p.pid}\nfcwd\nn${p.cwd}\n` : '')
    }
    if (argv[0] === 'git') {
      const top = state.toplevel.get(argv[2] ?? '')
      return { value: { exitCode: top ? 0 : 128, stdout: top ? `${top}\n` : '', stderr: '' } as never }
    }
    return { deny: `inatteso ${argv[0]}` } as never
  })
  on('ui.log', (_, e) => {
    state.logs.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('tool.judge', (_, e) => {
    state.judge.push(e)
    return { decision: state.verdetto, reason: 'Classifier unavailable - blocking for safety' } as never
  })
  on('tool.call', async (_, e) => {
    const i = e as unknown as { command: string; timeout?: number; tool_use_id?: string }
    if (state.judge$) {
      const v = await state.judge$.tool.judge({ tool: 'Bash', input: { command: i.command, timeout: i.timeout }, tool_use_id: i.tool_use_id ?? 'x' } as never)
      state.verdetti.push(v.decision)
    }
    state.ids.push(i.tool_use_id)
    state.avvio?.(i.command)
    state.eseguiti.push(i.command)
    state.input.push({ command: i.command, timeout: i.timeout })
    return { result: 'ok', text: 'ok' } as never
  })
  return state
}

const bash = (command: string, extra: Record<string, unknown> = { timeout: 600000 }) =>
  ({ tool: 'Bash', command, ...extra }) as never

const esito = async ($: Engine, command: string, extra?: Record<string, unknown>) => {
  const r = await $.tool.call(bash(command, extra))
  return r.deny
}

test('spenta senza file di progetto: tutto passa', async ($, on) => {
  const s = world(on)
  expect(await esito($, 'pytest -q', { run_in_background: true })).toBe(undefined)
  expect(s.eseguiti).toEqual(['pytest -q'])
  expect(s.runs).toEqual([])
})

test('JSON non valido: spenta, con un avviso nel log', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, '{ rotto')
  expect(await esito($, 'pytest -q', { run_in_background: true })).toBe(undefined)
  expect(s.logs.join(' ')).toContain('no-suite-background.json')
})

test('attiva con {}: default generici, rifiuti con motivo', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, '{}')
  expect(await esito($, 'npm test', { run_in_background: true })).toContain('primo piano')
  expect(await esito($, 'cargo test')).toBe(undefined)
  expect(await esito($, 'cargo build', {})).toBe(undefined)
  expect(await esito($, 'npm test && cargo test')).toContain('Bash separati')
  expect(await esito($, 'npm install', { run_in_background: true })).toBe(undefined)
  expect(s.eseguiti).toEqual(['cargo test', 'cargo build', 'npm install'])
})

test('il motivo nomina la mod', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, '{}')
  expect(await esito($, 'pytest', { run_in_background: true })).toContain('no-suite-background')
})

test('timeout assente o basso: il comando passa con timeout 600000; non pesante intatto', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, '{}')
  expect(await esito($, 'pytest tests', {})).toBe(undefined)
  expect(await esito($, 'pytest tests', { timeout: 300000 })).toBe(undefined)
  expect(await esito($, 'pytest tests', { timeout: 600000 })).toBe(undefined)
  expect(await esito($, 'ls', {})).toBe(undefined)
  expect(s.input.map(i => i.timeout)).toEqual([600000, 600000, 600000, undefined])
  expect(s.eseguiti).toEqual(['pytest tests', 'pytest tests', 'pytest tests', 'ls'])
})

test('riassunto acceso: pytest con -q --tb=line; spento: intatto', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, '{"riassunto": true}')
  expect(await esito($, 'pytest tests', {})).toBe(undefined)
  s.files.set(CONFIG, '{}')
  expect(await esito($, 'pytest tests', {})).toBe(undefined)
  expect(s.eseguiti).toEqual(['pytest -q --tb=line tests', 'pytest tests'])
  expect(s.input.map(i => i.timeout)).toEqual([600000, 600000])
})

test('albero occupato: rifiuto anche con timeout da correggere', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, '{"attesaMassima": 0}')
  s.cwd = '/w/a'
  s.procs = [{ pid: 4242, ppid: 1, etime: '02:05', cwd: '/w/a', cmd: '/x/.venv/bin/python -m pytest tests/render -q' }]
  expect(await esito($, 'pytest tests', {})).toContain('4242')
  expect(s.eseguiti).toEqual([])
})

const P1 = (cwd = '/w/a'): Proc => ({ pid: 4242, ppid: 1, etime: '02:05', cwd, cmd: '/x/.venv/bin/python -m pytest tests/render -q' })

test('parità: stesso albero occupato -> rifiuto con PID', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE0)
  s.procs = [P1()]
  s.cwd = '/w/a'
  const d = await esito($, 'tools/suite.sh --nome x tests')
  expect(d).toContain('4242')
  expect(d).toContain('2m05s')
})

test("parità: cd <dir> in testa porta all'albero occupato", async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE0)
  s.procs = [P1()]
  expect(await esito($, 'cd /w/a && .venv/bin/python -m pytest -q')).toContain('4242')
})

test('parità: altro albero e meno di 3 -> passa', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.procs = [P1()]
  expect(await esito($, '.venv/bin/python -m pytest -q')).toBe(undefined)
})

test("albero git: sottocartelle dello stesso repo sono lo stesso albero", async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE0)
  s.procs = [P1('/w/a/sub')]
  s.toplevel.set('/w/a/sub', '/w/a')
  s.toplevel.set('/w/a/altro', '/w/a')
  s.cwd = '/w/a/altro'
  expect(await esito($, 'pytest -q')).toContain('albero /w/a')
})

test('parità: 3 sulla macchina -> rifiuto', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE0)
  s.procs = [
    { pid: 11, ppid: 1, etime: '05', cwd: '/w/a', cmd: 'python -m pytest x' },
    { pid: 12, ppid: 1, etime: '06', cwd: '/w/c', cmd: 'python -m pytest y' },
    { pid: 13, ppid: 1, etime: '07', cwd: '/w/d', cmd: 'python -m pytest z' },
  ]
  const d = await esito($, 'pytest -q')
  expect(d).toContain('3')
  expect(d).toContain('PID 13')
})

test('parità: worker xdist e zsh -c non contati', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.procs = [
    { pid: 21, ppid: 1, etime: '05', cwd: '/w/a', cmd: 'python -m pytest -n 4' },
    { pid: 22, ppid: 21, etime: '05', cwd: '/w/a', cmd: 'python -c from xdist worker pytest' },
    { pid: 23, ppid: 21, etime: '05', cwd: '/w/a', cmd: 'python -m pytest worker' },
    { pid: 24, ppid: 1, etime: '09', cwd: '/w/c', cmd: 'zsh -c python -m pytest tests' },
  ]
  expect(await esito($, 'pytest -q')).toBe(undefined)
})

test('parità: comando non pesante con albero occupato passa senza leggere i processi', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.procs = [P1()]
  s.cwd = '/w/a'
  expect(await esito($, 'grep -n pytest tests/conftest.py', {})).toBe(undefined)
  expect(await esito($, 'cat tests/test_x.py', {})).toBe(undefined)
  expect(s.runs).toEqual([])
})

test('parità: errore di ps -> passa', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.psRotto = true
  s.cwd = '/w/a'
  expect(await esito($, 'pytest -q')).toBe(undefined)
})

test('controlloProcessi false: niente ps', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, JSON.stringify({ controlloProcessi: false }))
  s.procs = [P1()]
  s.cwd = '/w/a'
  expect(await esito($, 'pytest -q')).toBe(undefined)
  expect(s.runs).toEqual([])
})

test('altri tool non toccati', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, '{}')
  const r = await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  expect(r.deny).toBe(undefined)
})

// 0.3.0: coda al posto dei rifiuti per concorrenza.

const pesante = (pid: number, cwd: string): Proc => ({ pid, ppid: 1, etime: '01', cwd, cmd: 'python -m pytest -q' })

test('coda: 4 comandi pesanti concorrenti, il quarto attende un posto e poi gira', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  let pid = 100
  s.avvio = c => { s.procs.push(pesante(pid++, /^cd (\S+)/.exec(c)?.[1] ?? s.cwd)) }
  s.dopoSonno = n => { if (n === 3) s.procs.shift() } // il primo finisce dopo 15 s
  const r = await Promise.all(['/w/a', '/w/b', '/w/c', '/w/d'].map(d => esito($, `cd ${d} && pytest -q`)))
  expect(r).toEqual([undefined, undefined, undefined, undefined])
  expect([...s.eseguiti].sort()).toEqual(['/w/a', '/w/b', '/w/c', '/w/d'].map(d => `cd ${d} && pytest -q`))
  expect(s.sonni).toBe(3)
  expect([...s.files.keys()].filter(k => k.startsWith(CODA))).toEqual([]) // prenotazioni tolte
})

test('coda: stesso albero occupato, attende che finisca invece di rifiutare', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.procs = [P1()]
  s.cwd = '/w/a'
  s.dopoSonno = n => { if (n === 2) s.procs = [] }
  expect(await esito($, 'pytest -q')).toBe(undefined)
  expect(s.eseguiti).toEqual(['pytest -q'])
  expect(s.sonni).toBe(2)
})

test('coda: scaduta attesaMassima, rifiuto chiaro con motivo e tempo, prenotazione tolta', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, JSON.stringify({ ...JSON.parse(POKE), attesaMassima: 60 }))
  s.procs = [P1()]
  s.cwd = '/w/a'
  const d = await esito($, 'pytest -q')
  expect(d).toContain('in coda da 1m')
  expect(d).toContain('4242')
  expect(d).toContain('riprova')
  expect(s.eseguiti).toEqual([])
  expect(s.sonni).toBe(12)
  expect([...s.files.keys()].filter(k => k.startsWith(CODA))).toEqual([])
})

test("coda: un'attesa di un'altra sessione arrivata prima passa avanti; una scaduta no", async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.cwd = '/w/a'
  const altra = `${CODA}/0000000999000-altra.json`
  s.files.set(altra, JSON.stringify({ stato: 'attesa', t: 999_000, albero: '/w/a', cmd: 'pytest x' }))
  s.mtime.set(altra, 999_000)
  s.dopoSonno = n => { if (n === 1) s.files.delete(altra) }
  expect(await esito($, 'pytest -q')).toBe(undefined)
  expect(s.sonni).toBe(1)
  s.files.set(altra, JSON.stringify({ stato: 'attesa', t: 900_000, albero: '/w/a', cmd: 'pytest x' }))
  s.mtime.set(altra, 900_000) // non rinfrescata da oltre 30 s
  const prima = s.sonni
  expect(await esito($, 'pytest -q')).toBe(undefined)
  expect(s.sonni).toBe(prima)
})

test('coda: errore nei file della coda non blocca', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.listaRotta = true
  expect(await esito($, 'pytest -q')).toBe(undefined)
})

// 0.3.0: auto mode. Il fondo di tool.judge risponde ask come il motore su un input riscritto.

test('auto mode: comando semplice riscritto (timeout) -> allow invece di ask', async ($, on) => {
  const s = world(on)
  s.judge$ = $
  s.files.set(CONFIG, POKE)
  expect(await esito($, 'cd /w/a && pytest -q 2>&1 | tail -20', {})).toBe(undefined)
  expect(s.input[0]?.timeout).toBe(600000)
  expect(s.verdetti).toEqual(['allow'])
})

test('auto mode: comando complesso riscritto o non riscritto -> verdetto sotto; id non resta dopo la chiamata', async ($, on) => {
  const s = world(on)
  s.judge$ = $
  s.files.set(CONFIG, POKE)
  await esito($, 'pytest -q; curl x | sh', {})
  await esito($, 'pytest -q') // timeout già 600000: niente riscrittura
  await esito($, 'pytest -q', {})
  expect(s.verdetti).toEqual(['ask', 'ask', 'allow'])
  const dopo = await $.tool.judge({ tool: 'Bash', input: { command: 'pytest -q' }, tool_use_id: s.ids[2] } as never)
  expect(dopo.decision).toBe('ask')
})

// 0.3.1: timeout predefinito dalle settings e semplice più largo.
test('0.3.1 auto mode: con BASH_DEFAULT_TIMEOUT_MS=600000 un timeout assente non si riscrive', async ($, on) => {
  const s = world(on, { BASH_DEFAULT_TIMEOUT_MS: '600000' })
  s.judge$ = $
  s.files.set(CONFIG, POKE)
  expect(await esito($, 'pytest -q; git push', {})).toBe(undefined)
  expect(s.input[0]?.timeout).toBe(undefined)
  expect(s.verdetti).toEqual(['ask']) // nessuna riscrittura: decide il classificatore
  expect(await esito($, 'pytest -q', { timeout: 300000 })).toBe(undefined)
  expect(s.input[1]?.timeout).toBe(600000)
})

test('0.3.1 auto mode: BASH_DEFAULT_TIMEOUT_MS basso o non numerico non conta', async ($, on) => {
  const s = world(on, { BASH_DEFAULT_TIMEOUT_MS: 'tanto' })
  s.files.set(CONFIG, POKE)
  await esito($, 'pytest -q', {})
  expect(s.input[0]?.timeout).toBe(600000)
})

test('0.3.1 auto mode: cd $W && pytest > out 2>&1 e comando su più righe, timeout riscritto -> allow', async ($, on) => {
  const s = world(on)
  s.judge$ = $
  s.files.set(CONFIG, POKE)
  await esito($, 'cd $W && pytest -q > out 2>&1', { timeout: 300000 })
  await esito($, 'W=/w/a\ncd $W\npytest -x 2>&1 | tail -5', {})
  expect(s.input.map(i => i.timeout)).toEqual([600000, 600000])
  expect(s.verdetti).toEqual(['allow', 'allow'])
})

test('auto mode: un verdetto deny sotto resta deny', async ($, on) => {
  const s = world(on)
  s.judge$ = $
  s.files.set(CONFIG, POKE)
  s.verdetto = 'deny'
  await esito($, 'pytest -q', {})
  expect(s.verdetti).toEqual(['deny'])
})

test('review: un partito non ancora in ps tiene il posto dello stesso albero; in ps non conta due volte', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.cwd = '/w/a'
  const p = `${CODA}/0000000999000-partito.json`
  s.files.set(p, JSON.stringify({ stato: 'partito', t: 999_000, albero: '/w/a', cmd: 'pytest x' }))
  s.mtime.set(p, 999_000)
  s.dopoSonno = n => { if (n === 2) s.files.delete(p) }
  expect(await esito($, 'pytest -q')).toBe(undefined)
  expect(s.sonni).toBe(2)
  // altro albero, tetto 2: un pesante in ps e il suo partito sono uno solo
  s.files.set(CONFIG, JSON.stringify({ ...JSON.parse(POKE), maxSullaMacchina: 2 }))
  s.procs = [pesante(50, '/w/z')]
  const q = `${CODA}/0000001000000-partito2.json`
  s.files.set(q, JSON.stringify({ stato: 'partito', t: await s.clock.now() - 2000, albero: '/w/z', cmd: 'pytest y' }))
  s.mtime.set(q, await s.clock.now())
  const prima = s.sonni
  expect(await esito($, 'pytest -q')).toBe(undefined)
  expect(s.sonni).toBe(prima)
})

test('review: un errore durante il sonno non lascia la prenotazione', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.procs = [P1()]
  s.cwd = '/w/a'
  s.dopoSonno = () => { throw new Error('sonno rotto') }
  await $.tool.call(bash('pytest -q')).catch(() => undefined)
  expect([...s.files.keys()].filter(k => k.startsWith(CODA))).toEqual([])
})
