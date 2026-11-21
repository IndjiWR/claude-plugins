import { expect, test } from 'claude-code/testing'
import { configurazione, correggi, decidi, dirComando, etaLeggibile, etaSecondi, occupanti, parti, prenotati, principale, quantiPesanti, semplice } from '../hooks/logica'
import type { Prenotazione, Processo } from '../hooks/logica'

// La configurazione di pokefootleague: i casi qui sotto sono quelli di test_no_suite_background.sh.
const POKE = configurazione(JSON.stringify({
  comandi: ['pytest', 'py.test', 'tools/suite.sh', 'python -m footmon.render.gallery'],
  nonContati: ['python -m footmon.render.gallery'],
}))!
const DEF = configurazione('{}')!

const bash = (command: string, bg: boolean, timeout?: number) =>
  ({ command, run_in_background: bg, ...(timeout === undefined ? {} : { timeout }) })

// prova: timeout 600000, esito 0 = passa (undefined), 2 = rifiuto.
const prova = (atteso: 0 | 2, bg: 0 | 1, cmd: string) =>
  expect([cmd, decidi(bash(cmd, bg === 1, 600000), POKE) === undefined ? 0 : 2]).toEqual([cmd, atteso])
// Esito: 0 = passa intatto, 1 = passa con timeout corretto, 2 = rifiuto.
const esito = (i: ReturnType<typeof bash>, cfg = POKE) => (decidi(i, cfg) !== undefined ? 2 : correggi(i, cfg) ? 1 : 0)
// provat: in primo piano, timeout dato o assente ('-').
const provat = (atteso: 0 | 1 | 2, t: number | '-', cmd: string) =>
  expect([cmd, esito(bash(cmd, false, t === '-' ? undefined : t))]).toEqual([cmd, atteso])

test('parità: background (prova)', () => {
  prova(0, 0, 'tools/suite.sh --nome x --attendi tests/render -q')
  prova(0, 0, '.venv/bin/python -m pytest tests/render -q')
  prova(0, 0, 'PATH="$HOME/.local/bin:$PATH" .venv/bin/python -m footmon.render.gallery bulldoze')
  prova(0, 1, 'tools/galleria.sh')
  prova(0, 1, 'sleep 5; ls out')
  prova(0, 1, 'grep -n pytestmark tests/conftest.py')
  prova(2, 1, '.venv/bin/python -m pytest tests/render -q')
  prova(2, 1, 'cd wt && tools/suite.sh --nome x --attendi tests/render -q')
  prova(2, 1, 'PATH="$HOME/.local/bin:$PATH" .venv/bin/python -m footmon.render.gallery bulldoze')
  prova(2, 1, '.venv/bin/python -m footmon.render.gallery --tutte')
  prova(2, 1, 'pytest -q tests/tools')
})

test('parità: timeout in primo piano (provat)', () => {
  // 0.2.0: il timeout basso o assente non si rifiuta più, si corregge.
  provat(1, '-', '.venv/bin/python -m pytest tests/live -q -n 4')
  provat(1, 120000, 'cd wt && sed -i "" s/a/b/ x.py && .venv/bin/python -m pytest tests/live -q')
  provat(1, '-', 'tools/suite.sh --attendi --nome x tests/render -q')
  provat(0, 600000, '.venv/bin/python -m pytest tests/live -q -n 4')
  provat(0, '-', 'grep -n pytest tests/conftest.py')
  provat(0, '-', 'ls tests')
  provat(0, '-', 'pgrep -fl "python -m pytest|suite.sh" | cut -c1-160')
  provat(0, '-', 'pgrep -fl "python -m pytest"')
  provat(0, '-', 'pkill -f "pytest tests/live -q"')
  provat(1, '-', 'sleep 5\n.venv/bin/python -m pytest -q')
})

test('parità: un solo comando pesante per Bash', () => {
  provat(2, 600000, 'tools/suite.sh --attendi --nome x -q 2>&1 | tail -8; .venv/bin/python -m pytest tests/render/gallery -q')
  provat(2, 600000, '.venv/bin/python -m pytest tests/a -q && .venv/bin/python -m pytest tests/b -q')
  provat(0, 600000, 'cd wt && tools/suite.sh --attendi --nome x -q 2>&1 | tail -8; cat out/suite/x/fatto')
})

test('motivi: dicono cosa fare', () => {
  expect(decidi(bash('pytest -q', true, 600000), POKE)).toContain('primo piano')
  expect(decidi(bash('pytest a && pytest b', false, 600000), POKE)).toContain('Bash separati')
})

test('timeout: assente, basso, 300000, non numerico -> 600000; già 600000 o oltre -> intatto', () => {
  expect(correggi(bash('pytest -q', false), POKE)).toEqual({ timeout: 600000 })
  expect(correggi(bash('pytest -q', false, 120000), POKE)).toEqual({ timeout: 600000 })
  expect(correggi(bash('pytest -q', false, 300000), POKE)).toEqual({ timeout: 600000 })
  expect(correggi({ command: 'pytest -q', timeout: 'x' as never }, POKE)).toEqual({ timeout: 600000 })
  expect(correggi(bash('pytest -q', false, 600000), POKE)).toBe(undefined)
  expect(decidi(bash('pytest -q', false), POKE)).toBe(undefined)
  expect(decidi(bash('pytest -q', false, 120000), POKE)).toBe(undefined)
})

test('correggi: comando non pesante, background e più pesanti non si toccano', () => {
  expect(correggi(bash('ls tests', false), POKE)).toBe(undefined)
  expect(correggi({ command: 3 }, POKE)).toBe(undefined)
  expect(correggi(bash('pytest -q', true), POKE)).toBe(undefined)
  expect(correggi(bash('pytest a && pytest b', false), POKE)).toBe(undefined)
})

const RIA = configurazione(JSON.stringify({ comandi: ['pytest', 'py.test', 'tools/suite.sh'], riassunto: true }))!
const rias = (cmd: string, cfg = RIA) => correggi(bash(cmd, false, 600000), cfg)?.command

test('riassunto: spento di default, acceso aggiunge -q --tb=line dopo pytest', () => {
  expect(POKE.riassunto).toBe(false)
  expect(RIA.riassunto).toBe(true)
  expect(configurazione('{"riassunto": "si"}')!.riassunto).toBe(false)
  expect(rias('pytest tests/a', POKE)).toBe(undefined)
  expect(rias('pytest tests/a')).toBe('pytest -q --tb=line tests/a')
  expect(rias('pytest')).toBe('pytest -q --tb=line')
  expect(rias('.venv/bin/python -m pytest tests/live -n 4')).toBe('.venv/bin/python -m pytest -q --tb=line tests/live -n 4')
  expect(rias('cd wt && uv run pytest -x')).toBe('cd wt && uv run pytest -q --tb=line -x')
  expect(rias('bash -c "pytest tests"')).toBe('bash -c "pytest -q --tb=line tests"')
  expect(rias('py.test tests')).toBe('py.test -q --tb=line tests')
  expect(rias('/x/bin/pytest tests')).toBe('/x/bin/pytest -q --tb=line tests')
})

test('riassunto: con timeout basso corregge entrambi', () => {
  expect(correggi(bash('pytest tests', false), RIA)).toEqual({ timeout: 600000, command: 'pytest -q --tb=line tests' })
})

test('riassunto: -q, --quiet, -v, --verbose, -xq presenti -> intatto; --tb presente -> solo -q', () => {
  for (const c of ['pytest -q tests', 'pytest --quiet', 'pytest -qq', 'pytest -xq', 'pytest -v', 'pytest -vv tests', 'pytest --verbose'])
    expect([c, rias(c)]).toEqual([c, undefined])
  expect(rias('pytest --tb=short tests')).toBe('pytest -q --tb=short tests')
  expect(rias('pytest --tb short tests')).toBe('pytest -q --tb short tests')
  expect(rias('pytest -k "q" tests')).toBe('pytest -q --tb=line -k "q" tests')
})

test('riassunto: altri comandi pesanti, pytest nominato più volte, nessuna pipe aggiunta', () => {
  expect(rias('tools/suite.sh tests')).toBe(undefined)
  expect(rias('"pytest" tests')).toBe(undefined)
  expect(rias("'pytest' tests")).toBe(undefined)
  expect(rias("bash -c 'pytest tests'")).toBe("bash -c 'pytest -q --tb=line tests'")
  expect(rias('pytest --verbosity=2 tests')).toBe(undefined)
  expect(rias('pytest -p pytest-xdist tests')).toBe('pytest -q --tb=line -p pytest-xdist tests')
  expect(rias('grep -n pytest conftest.py && pytest tests')).toBe(undefined)
  expect(rias('echo pytest; tools/suite.sh')).toBe(undefined)
  expect(rias('pytest tests 2>&1 | tail -5')).toBe('pytest -q --tb=line tests 2>&1 | tail -5')
  expect(rias('pytest tests')).not.toContain('|')
})

test('parti: virgolette, separatori, a capo, virgolette non chiuse', () => {
  expect(parti('pgrep -f "python -m pytest|suite.sh"')).toEqual([['pgrep', '-f', 'python -m pytest|suite.sh']])
  expect(parti("a 'b c'; d|e && f\ng")).toEqual([['a', 'b c'], ['d'], ['e'], ['f'], ['g']])
  expect(parti('echo $(pytest -q)').some(p => p[0] === 'pytest')).toBe(true)
  expect(parti('echo "non chiusa | pytest')).toEqual([['echo', '"non', 'chiusa'], ['pytest']])
})

test('default generici: pytest, npm test, vitest, cargo test/build', () => {
  const n = (cmd: string) => quantiPesanti(cmd, DEF)
  expect(['pytest -q', 'npm test', 'npm run test -- --watch=false', 'npx vitest run', 'cargo test -p x', 'cargo build --release',
    'uv run pytest', 'poetry run pytest -x', 'python3 -m pytest', 'CI=1 npm test', 'time cargo test'].map(n))
    .toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
  expect(['npm install', 'cargo check', 'cargo fmt', 'grep vitest package.json', 'cat .venv/bin/pytest', 'npm run build'].map(n))
    .toEqual([0, 0, 0, 0, 0, 0])
  expect(n('cargo build && cargo test')).toBe(2)
  expect(n('bash -c "pytest -q"')).toBe(1)
  expect(n('sh tools/x.sh; bash -lc "ls"')).toBe(0)
})

test('configurazione: assente, non valida, aggiungi, valori', () => {
  expect(configurazione(undefined)).toBe(null)
  expect(configurazione('{ rotto')).toBe(null)
  expect(configurazione('[]')).toBe(null)
  expect(DEF.timeoutMinimo).toBe(600000)
  expect(DEF.maxSullaMacchina).toBe(3)
  expect(DEF.controlloProcessi).toBe(true)
  const c = configurazione(JSON.stringify({ aggiungi: ['make check'], timeoutMinimo: 300000, maxSullaMacchina: 0, controlloProcessi: false }))!
  expect([quantiPesanti('make check', c), quantiPesanti('pytest', c), quantiPesanti('make', c)]).toEqual([1, 1, 0])
  expect([c.timeoutMinimo, c.maxSullaMacchina, c.controlloProcessi]).toEqual([300000, 0, false])
  expect(correggi(bash('make check', false, 200000), c)).toEqual({ timeout: 300000 })
  expect(correggi(bash('make check', false, 300000), c)).toBe(undefined)
  // Oltre il massimo del Bash (600000) non si potrebbe obbedire: si tiene 600000.
  expect(configurazione(JSON.stringify({ timeoutMinimo: 900000 }))!.timeoutMinimo).toBe(600000)
  const solo = configurazione(JSON.stringify({ comandi: ['make check'] }))!
  expect(quantiPesanti('pytest', solo)).toBe(0)
})

test('età di ps', () => {
  expect([etaSecondi('05'), etaSecondi('02:05'), etaSecondi('1:02:05'), etaSecondi('2-01:02:05')]).toEqual([5, 125, 3725, 176525])
  expect([etaLeggibile(125), etaLeggibile(3725)]).toEqual(['2m05s', '1h02m'])
})

test('principale: il processo radice, non worker né shell -c', () => {
  expect(principale('/x/.venv/bin/python -m pytest tests/render -q', POKE)).toBe(true)
  expect(principale('/bin/sh tools/suite.sh --nome x', POKE)).toBe(true)
  expect(principale('python -c from xdist worker pytest', POKE)).toBe(false)
  expect(principale('zsh -c python -m pytest tests', POKE)).toBe(false)
  expect(principale('grep pytest', POKE)).toBe(false)
  expect(principale('node /p/node_modules/.bin/vitest run', DEF)).toBe(true)
})

test('dirComando: cd in testa sposta la cartella', () => {
  expect(dirComando('cd /w/a && pytest', '/w/b')).toBe('/w/a')
  expect(dirComando('cd wt; pytest', '/w/b')).toBe('/w/b/wt')
  expect(dirComando('pytest', '/w/b')).toBe('/w/b')
})

const P1: Processo[] = [{ pid: 4242, ppid: 1, eta: 125, albero: '/w/a', cmd: '/x/.venv/bin/python -m pytest tests/render -q' }]
const P3: Processo[] = [
  { pid: 11, ppid: 1, eta: 5, albero: '/w/a', cmd: 'python -m pytest x' },
  { pid: 12, ppid: 1, eta: 6, albero: '/w/c', cmd: 'python -m pytest y' },
  { pid: 13, ppid: 1, eta: 7, albero: '/w/d', cmd: 'python -m pytest z' },
]
const PX: Processo[] = [
  { pid: 21, ppid: 1, eta: 5, albero: '/w/a', cmd: 'python -m pytest -n 4' },
  { pid: 22, ppid: 21, eta: 5, albero: '/w/a', cmd: 'python -c from xdist worker pytest' },
  { pid: 23, ppid: 21, eta: 5, albero: '/w/a', cmd: 'python -m pytest worker' },
  { pid: 24, ppid: 1, eta: 9, albero: '/w/c', cmd: 'zsh -c python -m pytest tests' },
]

test('parità: occupanti (provap)', () => {
  expect(occupanti(P1, '/w/a', POKE)).toContain('PID 4242')
  expect(occupanti(P1, '/w/a', POKE)).toContain('2m05s')
  expect(occupanti(P1, '/w/b', POKE)).toBe(undefined)
  expect(occupanti(P3, '/w/b', POKE)).toContain('3')
  expect(occupanti(P3, '/w/b', POKE)).toContain('PID 13')
  expect(occupanti(PX, '/w/b', POKE)).toBe(undefined)
  expect(occupanti(P3, null, POKE)).toContain('PID 13')
})

test('occupanti: nonContati fuori dal tetto ma non dallo stesso albero; tetto 0 spento', () => {
  const gal: Processo[] = [
    ...P3.slice(0, 2),
    { pid: 14, ppid: 1, eta: 9, albero: '/w/e', cmd: 'python -m footmon.render.gallery x' },
  ]
  expect(occupanti(gal, '/w/b', POKE)).toBe(undefined)
  expect(occupanti(gal, '/w/e', POKE)).toContain('PID 14')
  const zero = configurazione(JSON.stringify({ maxSullaMacchina: 0 }))!
  expect(occupanti(P3, '/w/b', zero)).toBe(undefined)
})

test('review: flag tra interprete e comando, wrapper con argomenti, parole chiave', () => {
  const n = (cmd: string) => quantiPesanti(cmd, POKE)
  expect(['python -u -m pytest', 'python -W ignore -m pytest', 'python3 -X dev -m pytest', 'bash -x tools/suite.sh',
    'timeout 900 pytest', 'sudo pytest', 'xargs -n1 pytest', 'env -i pytest', 'nice -n 10 pytest', 'time -p pytest',
    'for d in a b; do pytest $d; done', 'if true; then pytest; fi', '! pytest', '{ pytest; }'].map(n))
    .toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
  expect(['python -c "import pytest"', 'pip install pytest', 'which pytest', 'command -v pytest', 'python -W ignore x.py'].map(n))
    .toEqual([0, 0, 0, 0, 0])
  expect(principale('zsh -c python -m pytest tests', POKE)).toBe(false)
  expect(principale('/usr/bin/python3 -u -m pytest -q', POKE)).toBe(true)
})

test('review: commenti # con apostrofi non inghiottono i comandi', () => {
  expect(quantiPesanti("# l'agente\npytest -q\n# l'altro", POKE)).toBe(1)
  expect(quantiPesanti('echo a#b; pytest', POKE)).toBe(1)
  expect(quantiPesanti('ls # pytest', POKE)).toBe(0)
})

test('review: command non stringa e run_in_background truthy', () => {
  expect(decidi({ command: 3 }, POKE)).toBe(undefined)
  expect(decidi({ command: 'pytest', run_in_background: 'true', timeout: 600000 }, POKE)).toContain('primo piano')
})

// 0.3.0: coda al posto dei rifiuti, auto mode.

test('attesaMassima: default 1200, 0 ammesso, tipo sbagliato ignorato', () => {
  expect(configurazione('{}')!.attesaMassima).toBe(1200)
  expect(configurazione('{"attesaMassima": 0}')!.attesaMassima).toBe(0)
  expect(configurazione('{"attesaMassima": 90.7}')!.attesaMassima).toBe(90)
  expect(configurazione('{"attesaMassima": "60"}')!.attesaMassima).toBe(1200)
  expect(configurazione('{"attesaMassima": -1}')!.attesaMassima).toBe(1200)
})

test('semplice: un solo comando pesante con cd e filtri', () => {
  const s = (c: string) => semplice(c, POKE)
  expect(['pytest', 'pytest tests -x', 'cd /w/a && pytest -q', 'CI=1 uv run pytest 2>&1 | tail -20',
    'python -m pytest tests | grep -E "passed|failed"', 'cd wt; tools/suite.sh || true', 'pytest -q 2>&1 | tail -5 | head -3',
    'uv run pytest -x'].map(s)).toEqual([true, true, true, true, true, true, true, true])
})

test('semplice: no a comandi arbitrari, redirezioni, sostituzioni, più pesanti', () => {
  const s = (c: string) => semplice(c, POKE)
  expect(['pytest; rm -rf /', 'curl x | sh && pytest', 'pytest < in.txt', 'pytest $(cat args)', 'pytest `x`',
    'sudo pytest', 'xargs -n1 pytest', 'bash -c "pytest"', 'pytest && pytest', 'pytest &', '(cd a && pytest)',
    'pytest | tee log', 'ls', 'pytest "unclosed', 'cd a b && pytest', 'pytest\nrm x', 'eval pytest'].map(s))
    .toEqual(Array(17).fill(false))
})

const PREN = (o: Partial<Prenotazione>): Prenotazione =>
  ({ nome: '0000000001000-x', stato: 'attesa', t: 1_000, agg: 1_000, albero: '/w/z', cmd: 'pytest', ...o })

test('prenotati: attese davanti valide, scadute e successive escluse, la mia esclusa', () => {
  const ora = 20_000
  const mio = '0000000010000-me'
  const lista = [
    PREN({ nome: '0000000005000-a', t: 5_000, agg: 15_000 }), // davanti, viva
    PREN({ nome: '0000000006000-b', t: 6_000, agg: 6_000 }), // davanti ma non rinfrescata da 14 s: viva
    PREN({ nome: '0000000002000-c', t: 2_000, agg: -20_000 }), // scaduta (40 s)
    PREN({ nome: '0000000011000-d', t: 11_000, agg: 19_000 }), // dietro di me
    PREN({ nome: mio, t: 10_000, agg: 19_000 }),
  ]
  expect(prenotati(lista, mio, [], ora).map(p => p.cmd + p.eta)).toEqual(['pytest15', 'pytest14'])
})

test('prenotati: partito conta finché non compare in ps (stesso albero, età compatibile) o scade', () => {
  const ora = 20_000
  const mio = '0000000019000-me'
  const p = PREN({ nome: '0000000025000-p', stato: 'partito', t: 10_000, agg: 10_000, albero: '/w/a' })
  expect(prenotati([p], mio, [], ora)).toHaveLength(1) // un partito conta anche se arrivato dopo
  const visto: Processo = { pid: 7, ppid: 1, eta: 8, cmd: 'pytest', albero: '/w/a' }
  expect(prenotati([p], mio, [visto], ora)).toHaveLength(0)
  expect(prenotati([p], mio, [{ ...visto, eta: 100 }], ora)).toHaveLength(1) // processo vecchio: non è lui
  expect(prenotati([p], mio, [{ ...visto, albero: '/w/b' }], ora)).toHaveLength(1)
  expect(prenotati([{ ...p, t: -20_000 }], mio, [], ora)).toHaveLength(0) // scaduto
})

test('occupanti con prenotati: contano per albero e tetto, motivo senza PID', () => {
  const pr: Processo[] = [{ pid: 0, ppid: 0, eta: 4, cmd: 'pytest -q', albero: '/w/a' }]
  const m = occupanti([], '/w/a', POKE, undefined, pr)
  expect(m).toContain('stesso albero')
  expect(m).toContain('in coda o appena partito')
  expect(m).not.toContain('PID 0')
  expect(occupanti(P3.slice(0, 2), '/w/b', POKE, undefined, pr)).toContain('3 comandi pesanti')
  expect(occupanti(P3.slice(0, 2), '/w/b', POKE, undefined, [])).toBe(undefined)
})

test('review: semplice rifiuta prefissi che nascondono comandi, variabili pericolose, percorsi, filtri che scrivono', () => {
  const s = (c: string) => semplice(c, POKE)
  expect(['nice sudo -u root pytest', 'env sudo npm test', 'timeout 5 xargs -I{} pytest', 'env bash pytest',
    'command sudo pytest', "env -S 'sh -c evil' pytest", 'LD_PRELOAD=/tmp/x.so pytest', 'PYTEST_ADDOPTS="-p evil" pytest',
    'PATH=/tmp/evil:$PATH pytest', './pytest', '/tmp/x/pytest', 'python pytest', 'node pytest', 'bash tools/suite.sh',
    'pytest | sort -o ~/.zshrc', 'pytest | uniq a b', 'pytest | tail -f', 'pytest -p evil', 'pytest -c conf.ini',
    'pytest ${x@P}', 'pytest $X', 'evil/tools/suite.sh', '/tmp/python -m pytest', 'nohup pytest'].map(s))
    .toEqual(Array(24).fill(false))
  expect(['CI=1 pytest', 'timeout 900 pytest -q', 'time pytest', '.venv/bin/python -m pytest -q', 'python3 -u -m pytest',
    'tools/suite.sh --nome x', './tools/suite.sh', 'pytest -p no:cacheprovider', 'pytest -q 2>&1 | grep -E "passed|failed" | tail -n 5',
    'pytest | head -50 | wc -l'].map(s)).toEqual(Array(10).fill(true))
})

test("review: un'attesa bloccata sullo stesso albero di un occupante non conta nel tetto", () => {
  const cfg = configurazione('{}')!
  const run: Processo[] = [{ pid: 9, ppid: 1, eta: 50, albero: '/w/x', cmd: 'pytest' }]
  const att = (albero: string): Processo => ({ pid: 0, ppid: 0, eta: 5, albero, cmd: 'pytest', attesa: true })
  expect(occupanti(run, '/w/y', cfg, undefined, [att('/w/x'), att('/w/x')])).toBe(undefined)
  expect(occupanti(run, '/w/y', cfg, undefined, [att('/w/z'), att('/w/k')])).toContain('3 comandi pesanti')
})

test('re-review: argomenti del comando pesante a whitelist', () => {
  const s = (c: string) => semplice(c, POKE)
  const npm = configurazione('{}')!
  expect(['pytest -cevil.ini', 'pytest -xpevil', 'pytest -o addopts=-pevil', 'pytest --override-ini addopts=x',
    'pytest --rootdir=/tmp', 'tools/suite.sh --config=x', 'pytest -n auto --dist=x', 'tools/suite.sh --config x',
    'tools/suite.sh --require x'].map(s)).toEqual(Array(9).fill(false))
  expect(['npm test --userconfig=/tmp/x', 'cargo test --manifest-path /tmp/x/Cargo.toml', 'npm test -- --globalconfig=x']
    .map(c => semplice(c, npm))).toEqual([false, false, false])
  expect(['pytest -xq tests/a.py::t -k "a and not b"', 'pytest -vv --tb=short --maxfail=1 -m slow', 'pytest -n 4 --lf',
    'pytest -p no:cacheprovider --durations=10', 'tools/suite.sh --nome martello --attendi -q'].map(s)).toEqual(Array(5).fill(true))
  expect(['npm test', 'npm test -- -t foo', 'cargo test --release', 'cargo build --release -q'].map(c => semplice(c, npm)))
    .toEqual([true, true, true, true])
})

// 0.3.1: semplice più largo per i timeout espliciti riscritti in auto mode.
test('0.3.1 semplice: variabili in cd e assegnazioni, redirezioni sicure, più righe', () => {
  const s = (c: string) => semplice(c, POKE)
  expect(['cd $W && pytest -q > out 2>&1', 'W=$PWD; cd $W && pytest -q > out.txt 2>&1', 'cd "${W}/sub" && pytest',
    'cd $W\npytest -q 2>&1 | tail -5', 'pytest > out.txt', 'pytest >> log/run.log 2>&1', 'pytest >out 2>/dev/null',
    'pytest 2> err.txt', 'pytest 1>out', 'w=/tmp/x; cd $w && pytest', 'W="/a b"\ncd "$W"\npytest -x > o 2>&1',
    'CI=1; pytest'].map(s)).toEqual(Array(12).fill(true))
})

test('0.3.1 semplice: no a variabili negli argomenti, bersagli pericolosi, assegnazioni che cambiano l\'esecuzione', () => {
  const s = (c: string) => semplice(c, POKE)
  expect(['pytest $ARGS', 'pytest -k "$K"', 'pytest > $OUT', 'pytest > ../x', 'pytest > /etc/passwd', 'pytest > .zshrc',
    'pytest > a/.git/hooks/pre-commit', 'PATH=/tmp; pytest', 'PYTHONPATH=x; pytest', 'LD_PRELOAD=x; pytest', 'cd ${W:-/}; pytest',
    'cd $1 && pytest', 'cd $(pwd) && pytest', 'pytest &> out', 'W=$(curl x); cd $W && pytest', 'export W=1; pytest',
    'cd $W && pytest\nrm -rf x', 'pytest > -p', 'pytest >', 'pytest > out > /etc/x', 'IFS=x; pytest', 'cd $$ && pytest',
    'X=1 Y=$Z; pytest $X'].map(s)).toEqual(Array(23).fill(false))
})

test('0.3.1 correggi: con un timeout predefinito abbastanza alto non tocca il timeout assente', () => {
  const cfg = POKE
  expect(correggi({ command: 'pytest -q' }, cfg, 600000)).toBe(undefined)
  expect(correggi({ command: 'pytest -q' }, cfg, 120000)).toEqual({ timeout: 600000 })
  expect(correggi({ command: 'pytest -q' }, cfg)).toEqual({ timeout: 600000 })
  expect(correggi({ command: 'pytest -q', timeout: 300000 }, cfg, 600000)).toEqual({ timeout: 600000 })
})
