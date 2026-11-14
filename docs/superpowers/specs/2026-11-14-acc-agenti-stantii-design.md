# auto-clear-context 0.7.0 — agenti stantii e handoff dei subagent ripresi

## Perché
Incidente del 14/11 01:08 (pokefootleague): handoff della principale a69ab81e2322 validato alle 01:08, clear
rimandato senza fine. La mod contava attivo a5b6db75 («Animatore: ripresa lotto Brock 1»): subagent in background
che aveva già consegnato il report alle 22:53 (meta `finished: true`), ma `$.agent.list()` lo dava ancora in uno stato
BUSY. Nessun turno finiva più (principale ferma), quindi `tryClear` non veniva più richiamato.

Nello stesso progetto due handoff di agenti (a33e6c50, ae22f90b) restano in `pending/` con `status: ready`.
Dai transcript: sono **subagent** (non teammate) e la principale li ha rilanciati come previsto, con prompt
«Riprendi dall'handoff …» (a33e6c50 → a5b6db75 alle 22:32, ae22f90b → nuovo subagent alle 00:20). Il rilancio dei
subagent funziona (lo fa chi li ha lanciati, per progetto); manca la chiusura: il file resta `ready` per sempre e
sembra un rilancio mancato. Il rilancio automatico dei **teammate** (0.6.0) non è stato esercitato: in pokefootleague
non ci sono teammate.

## Obiettivi
1. Un agente BUSY senza attività da N minuti non trattiene più il clear; evento nel log, una volta per agente.
2. Il clear rimandato si ricontrolla anche senza fini turno (timer alla scadenza del primo agente).
3. Quando un Agent parte con «Riprendi dall'handoff <percorso in pending/>», la mod archivia quell'handoff.
4. README: subagent rilanciati da chi li ha lanciati; scadenza degli agenti; esito del collaudo del rilancio teammate.

Non obiettivi: forzare il clear con agenti davvero attivi; validare gli handoff dei subagent (resta all'agente).

## Approcci
- **A (scelto) — attività osservata dalla mod.** Mappa `agentId → ultimo evento` aggiornata da `turn.start`,
  `turn.step`, `classic.PostToolUse` e `turn.complete` con `agentId`. Un agente mai visto dal caricamento del modulo
  parte dal primo controllo (un ricaricamento non lo rende subito stantio). Solo API dei mod, nessun file interno.
- B — mtime del transcript `<progetto>/<sessione>/subagents/agent-<id>.jsonl` con `$.fs.stat`: stesso segnale, ma
  dipende dal formato interno dei percorsi di Claude Code e fallisce per i teammate in pannello.
- C — leggere `finished` dal `.meta.json` dell'agente: segnale esatto per l'incidente ma formato interno, solo subagent.

## Design
- Nuova opzione `agentStaleMinutes` (numero, default 20, 0 = spenta): «Minuti senza attività dopo cui un agente dato
  ancora attivo non trattiene più il clear della principale». 20 > 10 minuti, il tetto delle suite in primo piano.
- `activeAgents` esclude gli agenti stantii; al primo che esclude, log
  `agente <id> senza attività da N minuti: non trattiene più il clear` (una volta per agente).
- Al rinvio del clear: `$.clock.after` alla scadenza più vicina tra gli agenti attivi → `tryClear('agenti stantii')`
  (un solo timer, rifatto a ogni rinvio; nessuno con l'opzione a 0). `tryClear` già controlla `isMainBusy`.
- Funzioni pure in `agents.ts`: `isStale(lastSeen, now, minutes)`, `resumedHandoff(prompt)` (estrae il percorso
  `.claude/handoff/pending/<sessione>--<agente>.md` da «Riprendi dall'handoff …»).
- `tool.call` Agent: dopo `next`, se lo spawn è riuscito e il prompt cita un handoff di agente in `pending/`, lo
  sposta in `archive/` (come per la principale) con `status: resumed`; log
  `handoff dell'agente <id> ripreso da <nuovo id>: archiviato in …`. Errori solo nel log.
- Versione 0.7.0; README (EN/IT): scadenza, opzione, archiviazione, limite del rilancio teammate.

## Collaudo dal vivo del rilancio teammate
Ultimo task: tentativo con `claude --plugin-dir` e un team di prova a soglie agente basse. Se l'ambiente non lo
permette (team non disponibili senza sessione interattiva), il limite va nel README e nel report.

## Lasciato al costruttore
Nomi interni, struttura dei test, testo esatto dei log.
