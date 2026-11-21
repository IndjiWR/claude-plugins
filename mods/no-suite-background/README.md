# no-suite-background

Suite di test e build (i **comandi pesanti**) solo in primo piano, con `timeout` 600000, uno per Bash, in coda se la
macchina o l'albero sono occupati.

Un comando pesante finito in background lascia l'agente fermo: chiude il turno ad aspettare una notifica di fine
comando che non sveglia un subagent o un teammate inattivo. Succede anche senza `run_in_background`: in primo piano
col timeout predefinito (120 s) l'harness sposta il comando in background da solo, e due comandi pesanti nello stesso
Bash possono superare insieme i 10 minuti.

Per un comando pesante, in ogni sessione, subagent e teammate del progetto, la mod rifiuta il Bash con il motivo:

1. con `run_in_background`;
2. con più di un comando pesante nello stesso Bash (`pytest a && pytest b`).

Se un comando pesante gira già nello stesso albero git, o sulla macchina ne girano già `maxSullaMacchina`, il Bash
**aspetta il suo turno** (dalla 0.3.0) invece di essere rifiutato: la mod ricontrolla ogni 5 secondi e lo lascia
partire appena c'è posto, senza turni né `sleep` a carico dell'agente. La coda è FIFO e vale tra sessioni, subagent e
teammate: ogni comando in attesa lascia una prenotazione in `~/.claude/no-suite-background/coda/` (tolta a comando
finito; un'attesa non rinfrescata da 30 s, di una sessione morta, non conta più). Dopo `attesaMassima` secondi senza
posto il Bash è rifiutato con il motivo (chi occupa il posto: PID, età, albero, comando) e il tempo atteso.
Un comando che ottiene il posto resta prenotato (`partito`) per 30 s, finché `ps` non lo mostra; un'attesa ferma
dietro un comando del suo stesso albero non conta nel tetto. Senza `HOME` la coda su file manca: si aspetta lo stesso,
ma solo in base a `ps`. Con `controlloProcessi: false` niente coda né controllo dei processi.
Un errore nella lettura dei processi (`ps`, `lsof`, `git`) o dei file della coda non blocca mai.

Con `timeout` assente, non numerico o sotto `timeoutMinimo` non rifiuta più (dalla 0.2.0): riscrive l'input del Bash
con `timeout` = `timeoutMinimo` e lo lascia passare, senza far perdere un turno all'agente.

**Consigliato (dalla 0.3.1):** `BASH_DEFAULT_TIMEOUT_MS` almeno pari a `timeoutMinimo` nelle settings del progetto,

```json
{ "env": { "BASH_DEFAULT_TIMEOUT_MS": "600000" } }
```

Con la variabile un Bash **senza** `timeout` non si riscrive più: il timeout predefinito basta già (prova del 21/11:
un comando di 150 s resta in primo piano, senza la variabile va in background a 120 s) e in auto mode il
classificatore giudica il comando vero. Un `timeout` esplicito più basso si riscrive come prima.

### Auto mode

In auto mode il classificatore non giudica un Bash il cui input è stato cambiato da un hook: lo nega con «a hook
changed this call's input» (anche se cambia solo `timeout`) e l'agente deve rilanciarlo. Dalla 0.3.0, se il comando
riscritto dalla mod è **semplice**, la mod risponde `allow` al posto del classificatore (hook `tool.judge`, quando il
verdetto sotto è `ask`, cioè nessun verdetto; un `deny` resta). Semplice vuol dire:

- un solo comando pesante col nome esatto della voce (`./voce` solo per le voci con un percorso, come
  `./tools/suite.sh`), con davanti al più `CI=`, `FORCE_COLOR=`, `NO_COLOR=`, `PYTHONUNBUFFERED=`,
  `PYTHONDONTWRITEBYTECODE=`, `TERM=`, `COLUMNS=`, e i prefissi `time`, `timeout N`, `npx`, `bunx`,
  `uv|poetry|pipenv|pdm run`, `[.venv/bin/]python[3] [-u] -m`, senza altre opzioni; come argomenti solo posizionali,
  `--` e opzioni note che non caricano configurazioni o codice (`-q`, `-v`, `-x`, `-s`, `-l` anche uniti, `--lf`,
  `--ff`, `--co`, `--release`, `--no-header`, `-k|-m|-n|-t valore`, `--tb=`, `--maxfail=`, `--durations=`,
  `-p no:…`); per gli script con un percorso anche `--parola` senza valore, salvo nomi con config, shell, plugin, rc,
  preload, require;
- al più `cd <dir>` e filtri in pipe che leggono solo l'input: `tail`/`head` (`-n N`, `-N`), `wc -l`, `grep` con un
  solo motivo e opzioni di sola lettura, `echo`, `true`; uniti da `&&`, `||`, `;`, `|` o a capo (dalla 0.3.1);
- dalla 0.3.1 anche assegnazioni a sé (`W=$PWD;`) con nomi di una lettera maiuscola o minuscoli (mai `PATH`,
  `PYTHONPATH`, `LD_*` & co.); `$NOME` / `${NOME}` solo nell'argomento di `cd` e nei valori di queste assegnazioni;
  redirezioni dell'uscita `>`, `>>`, `1>`, `2>`, `2>>` verso `/dev/null` o un percorso relativo senza `..`, `$` né
  componenti nascosti (`cd $W && pytest -q > out 2>&1`);
- niente `$(…)`, `${x:-…}`, `$1`, graffe, backtick, `<`, `&>`, `&`, sottoshell, variabili negli argomenti del comando
  pesante.

Un comando con il solo `timeout` cambiato ma non semplice resta al classificatore (rilancio): la mod non risponde
`allow` su comandi arbitrari solo perché contengono un `pytest`, perché il classificatore non li ha visti. Con
`BASH_DEFAULT_TIMEOUT_MS` nelle settings il caso più comune (nessun `timeout`) non si pone.

Ogni altro comando resta al classificatore: il motore chiede all'agente di rilanciarlo con l'input già corretto.
Limite: un comando pesante esegue per natura codice del progetto (`conftest.py`, script di `package.json`,
`build.rs`) nella cartella in cui gira, anche dopo un `cd`; la mod non lo vaglia, come non lo vagliava la 0.2.0
fuori dall'auto mode.

Con `riassunto: true`, se l'unico comando pesante è pytest (`pytest`, `py.test`, `python -m pytest`, anche dietro
`uv run`, `cd x &&` o `bash -c`) senza `-q`/`--quiet`/`-v`/`--verbose`/`--verbosity` sulla riga (anche combinati, `-xq`; `addopts` di
`pytest.ini` non è letto), aggiunge
`-q --tb=line` subito dopo `pytest` (solo `-q` se c'è già `--tb`). Nessuna pipe aggiunta: il codice d'uscita resta
quello di pytest. Se la parola `pytest` compare più volte nel comando (`grep pytest x && pytest`) non tocca niente.

I comandi si leggono rispettando le virgolette: `pgrep -f "python -m pytest"` o `grep pytest conftest.py` non sono
comandi pesanti; `cd wt && pytest`, `CI=1 npm test`, `uv run pytest`, `python -m pytest`, `npx vitest`,
`bash -c "pytest -q"` sì.

## Attivazione per progetto

La mod è spenta finché il progetto non crea `.claude/no-suite-background.json` nella sua radice. Un oggetto vuoto
accende i default:

```json
{}
```

Campi, tutti facoltativi:

| Campo | Default | Cosa fa |
|---|---|---|
| `comandi` | `pytest`, `py.test`, `npm test`, `npm run test`, `vitest`, `cargo test`, `cargo build` | Sostituisce l'elenco dei comandi pesanti |
| `aggiungi` | — | Comandi pesanti in più rispetto a `comandi` |
| `nonContati` | — | Comandi esclusi dal tetto sulla macchina (restano nel controllo dello stesso albero) |
| `timeoutMinimo` | `600000` | Timeout a cui la mod porta un comando pesante in primo piano (al massimo 600000, il tetto del Bash) |
| `maxSullaMacchina` | `3` | Comandi pesanti già in corso sulla macchina oltre i quali si aspetta in coda; `0` spegne il tetto |
| `attesaMassima` | `1200` | Secondi di attesa in coda prima del rifiuto; `0` rifiuta subito come la 0.2.0 |
| `controlloProcessi` | `true` | `false` spegne coda e controllo dei processi (niente `ps`) |
| `riassunto` | `false` | `true` aggiunge `-q --tb=line` a pytest (vedi sopra) |

Un comando dell'elenco è il nome del programma (confrontato sul nome base: `tools/suite.sh` vale anche per
`./tools/suite.sh` e `wt/tools/suite.sh`) seguito dalle parole che devono seguirlo (`cargo test`). `python -m pkg.mod`
vale per `pkg.mod` lanciato con qualunque Python.

Esempio (pokefootleague):

```json
{
  "comandi": ["pytest", "py.test", "tools/suite.sh", "python -m footmon.render.gallery"],
  "nonContati": ["python -m footmon.render.gallery"]
}
```

Le voci passano dalla stessa lettura dei comandi: `uv run pytest` e `pytest` sono la stessa voce. Il confronto è
per parole esatte: `cargo test` non copre `cargo +nightly test` né `npm run test:unit`, che vanno aggiunti a parte.

Un JSON non valido lascia la mod spenta, con un avviso nel log di debug. Un campo col tipo sbagliato (`"comandi":
"pytest"` al posto di un array, `"timeoutMinimo": "300000"` come stringa) è ignorato e vale il default;
`"comandi": []` lascia la mod accesa ma senza comandi pesanti, quindi non rifiuta niente.

## Installazione

```
/plugin marketplace add IndjiWR/claude-plugins
/plugin install no-suite-background@indji-plugins
```

## Sviluppo

```
claude plugin validate mods/no-suite-background
claude plugin test mods/no-suite-background
```

Logica pura in `hooks/logica.ts` (test in `tests/logica.test.ts`, con tutti i casi dell'hook originale di
pokefootleague), hook in `hooks/register.ts` (test in `tests/mod.test.ts`, processi simulati).
