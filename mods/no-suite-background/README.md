# no-suite-background

Suite di test e build (i **comandi pesanti**) solo in primo piano, con `timeout` 600000, uno per Bash.

Un comando pesante finito in background lascia l'agente fermo: chiude il turno ad aspettare una notifica di fine
comando che non sveglia un subagent o un teammate inattivo. Succede anche senza `run_in_background`: in primo piano
col timeout predefinito (120 s) l'harness sposta il comando in background da solo, e due comandi pesanti nello stesso
Bash possono superare insieme i 10 minuti.

Per un comando pesante, in ogni sessione, subagent e teammate del progetto, la mod rifiuta il Bash con il motivo:

1. con `run_in_background`;
2. con più di un comando pesante nello stesso Bash (`pytest a && pytest b`);
3. se un comando pesante gira già nello stesso albero git (PID, età, albero e comando nel motivo), o se sulla macchina
   ne girano già `maxSullaMacchina`. Un errore nella lettura dei processi (`ps`, `lsof`, `git`) non blocca mai.

Con `timeout` assente, non numerico o sotto `timeoutMinimo` non rifiuta più (dalla 0.2.0): riscrive l'input del Bash
con `timeout` = `timeoutMinimo` e lo lascia passare, senza far perdere un turno all'agente.

Con `riassunto: true`, se l'unico comando pesante è pytest (`pytest`, `py.test`, `python -m pytest`, anche dietro
`uv run`, `cd x &&` o `bash -c`) senza `-q`/`--quiet`/`-v`/`--verbose` (anche combinati, `-xq`), aggiunge
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
| `maxSullaMacchina` | `3` | Comandi pesanti già in corso sulla macchina oltre i quali si rifiuta; `0` spegne il tetto |
| `controlloProcessi` | `true` | `false` spegne il punto 3 (niente `ps`) |
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
