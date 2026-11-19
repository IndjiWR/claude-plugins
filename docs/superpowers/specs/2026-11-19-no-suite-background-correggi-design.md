# no-suite-background 0.2.0 — correggere invece di rifiutare

Origine: `coordinatrice/report/2026-11-18.md` §5 e §7. Il 18/11 la mod ha rifiutato 84 Bash, 60 per `timeout`
assente o 300000: ogni rifiuto costa un turno (~100k di contesto riletti).

## Comportamento

Per un Bash con un comando pesante, nell'ordine:

1. `run_in_background` → rifiuto (come 0.1.0).
2. Più di un comando pesante → rifiuto (come 0.1.0).
3. `timeout` assente, non numerico o sotto `timeoutMinimo` → **riscrittura**: `timeout = timeoutMinimo` (600000 di
   default), il comando passa. Nelle mod l'equivalente di `updatedInput` del PreToolUse è `next({ ...e, timeout })`.
4. Controllo processi (stesso albero, tetto sulla macchina) → rifiuto (come 0.1.0).
5. Opzione `riassunto` (default `false`): se l'unico comando pesante è pytest (`pytest`, `py.test`, `python -m
   pytest`, anche dietro `uv run`, `cd x &&`, `bash -c`) e non ha `-q`/`--quiet`/`-v`/`--verbose` (anche combinati,
   `-xq`), si inserisce `-q --tb=line` subito dopo la parola `pytest`; `--tb` già presente → solo `-q`. Niente pipe
   aggiunte: il codice d'uscita resta quello di pytest. Se la parola `pytest`/`py.test` compare più di una volta nel
   testo (es. `grep pytest x && pytest`), non si tocca niente.

Comandi non pesanti: passano intatti. Matcher su `Bash`, mod spenta senza `.claude/no-suite-background.json`.

## Piano

1. `logica.ts`: `decidi` restituisce solo i rifiuti 1–2; nuova `correggi(input, cfg)` → campi da riscrivere
   (`timeout`, `command`) o `undefined`; `configurazione` legge `riassunto`.
2. `register.ts`: dopo `decidi` e il controllo processi, `next({ ...e, ...modifica })`.
3. Test prima del codice: logica (timeout assente/basso/600000/non numerico, background, due pesanti, non pesante,
   riassunto on/off, `-q` già presente, `--tb` presente, doppia occorrenza) e mod (input riscritto che arriva al
   tool). I casi di parità 0.1.0 sul timeout diventano "corretto" invece di "rifiutato".
4. README, `version` 0.2.0, validate + test, review, merge.
