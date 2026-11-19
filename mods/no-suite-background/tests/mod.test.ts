import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CONFIG = '/p/.claude/no-suite-background.json'
const POKE = JSON.stringify({
  comandi: ['pytest', 'py.test', 'tools/suite.sh', 'python -m footmon.render.gallery'],
  nonContati: ['python -m footmon.render.gallery'],
})

type Proc = { pid: number; ppid: number; etime: string; cwd: string; cmd: string }

// Il mondo sotto la mod: un progetto in /p, i file, i processi (ps, lsof, git) e il fondo di tool.call.
const world = (on: On) => {
  mock.env(on, { HOME: '/home/u' })
  const state = {
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
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    state.runs.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } as never })
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
  on('tool.call', (_, e) => {
    const i = e as unknown as { command: string; timeout?: number }
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
  s.files.set(CONFIG, '{}')
  s.cwd = '/w/a'
  s.procs = [{ pid: 4242, ppid: 1, etime: '02:05', cwd: '/w/a', cmd: '/x/.venv/bin/python -m pytest tests/render -q' }]
  expect(await esito($, 'pytest tests', {})).toContain('4242')
  expect(s.eseguiti).toEqual([])
})

const P1 = (cwd = '/w/a'): Proc => ({ pid: 4242, ppid: 1, etime: '02:05', cwd, cmd: '/x/.venv/bin/python -m pytest tests/render -q' })

test('parità: stesso albero occupato -> rifiuto con PID', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
  s.procs = [P1()]
  s.cwd = '/w/a'
  const d = await esito($, 'tools/suite.sh --nome x tests')
  expect(d).toContain('4242')
  expect(d).toContain('2m05s')
})

test("parità: cd <dir> in testa porta all'albero occupato", async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
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
  s.files.set(CONFIG, POKE)
  s.procs = [P1('/w/a/sub')]
  s.toplevel.set('/w/a/sub', '/w/a')
  s.toplevel.set('/w/a/altro', '/w/a')
  s.cwd = '/w/a/altro'
  expect(await esito($, 'pytest -q')).toContain('albero /w/a')
})

test('parità: 3 sulla macchina -> rifiuto', async ($, on) => {
  const s = world(on)
  s.files.set(CONFIG, POKE)
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
