# prompt-builder — spento nelle sessioni in background

## Obiettivo
Nelle sessioni avviate con `claude --bg` (coordinatrice, launchd) prompt-builder non interviene mai: oggi al primo
prompt lungo chiede "Ottimizzo il prompt?" e la sessione resta ferma finché qualcuno non risponde. Nelle sessioni
interattive il comportamento non cambia.

## Decisioni (utente, 2026-11-12)
- Spenta per tutta la sessione in background, anche se l'utente entra con `claude attach` e scrive un prompt lungo.
- `/prompt-builder <testo>` a mano resta attivo ovunque (è una richiesta esplicita).
- Nessuna nuova opzione in `/config`.

## Riconoscere una sessione in background
- `claude --bg` mette `CLAUDE_JOB_DIR` nell'ambiente del processo (verificato in una sessione `--bg` reale:
  `CLAUDE_JOB_DIR=/Users/…/.claude/jobs/<id>`); nelle sessioni interattive non c'è.
- `isInteractive` di `session.start` non basta: una sessione `--bg` è una REPL. `e.origin.kind` del primo prompt
  `--bg` è `composer`, come un Invio vero.
- Lettura: `$.env.get('CLAUDE_JOB_DIR')` (nome letterale, come chiede `claude plugin validate`). Valore non vuoto →
  sessione in background.

## Modifiche
- `hooks/trigger.ts`: funzione pura `isBackground(jobDir: string | undefined): boolean` (stringa non vuota → true).
- `hooks/register.tsx`, hook `prompt.submit`: dopo i controlli esistenti su origine, comando e `!raw`, e prima di
  `shouldTrigger`, legge la variabile e se la sessione è in background passa `next(e)` senza chiedere.
  La lettura avviene a ogni prompt (costo trascurabile, nessuno stato da tenere tra i reload); se `$.env.get` lancia,
  si tratta come interattiva (comportamento di oggi).
- `!raw` continua a togliere il prefisso anche in background.
- `command.run` (`/prompt-builder`) invariato.

## Test (TDD, `claude plugin test mods/prompt-builder`)
- `trigger.test.ts`: `isBackground(undefined)`, `''` → false; un percorso → true.
- `register.test.ts`: con `CLAUDE_JOB_DIR` impostato e un prompt lungo che oggi scatta, nessuna `$.ui.ask` e il testo
  passa invariato; senza la variabile resta la domanda; in background `/prompt-builder <testo>` compone ancora il brief.

## Rilascio
`version` minor in `plugin.json`, README: punto "Non interviene nelle sessioni avviate in background
(`claude --bg`); lì resta `/prompt-builder` a mano".
