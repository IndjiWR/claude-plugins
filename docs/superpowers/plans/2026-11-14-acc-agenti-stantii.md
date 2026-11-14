# auto-clear-context 0.7.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agenti BUSY senza attività non trattengono più il clear della principale; gli handoff dei subagent ripresi vengono archiviati.

**Architecture:** funzioni pure in `mod/hooks/agents.ts`; stato del modulo e hook in `mod/hooks/register.tsx`
(mappa `lastSeen`, filtro in `activeAgents`, timer `$.clock.after`, archiviazione in `tool.call` Agent).

**Tech Stack:** TypeScript, API dei mod di Claude Code (`claude-code`, `claude-code/testing`).

**Spec:** `docs/superpowers/specs/2026-11-14-acc-agenti-stantii-design.md`

## Global Constraints
- Cartella: `mods/auto-clear-context/`. Test: `claude plugin test mods/auto-clear-context/mod`; validazione:
  `claude plugin validate mods/auto-clear-context/mod` (dalla radice del repo). Entrambi in primo piano, output filtrato con `tail`.
- Testi (log, README, commit) in italiano; commit senza `Co-Authored-By` né firme; `git add <file>` per nome.
- Opzione nuova `agentStaleMinutes`: numero, **default 30**, 0 = spenta (30 > avviso dei 20 minuti già esistente, > 10 minuti delle suite in primo piano).
- Versione `0.7.0` in `mod/.claude-plugin/plugin.json`.
- TDD: prima il test rosso, poi il codice minimo, poi verde.

## Review Focus
- Agente in un tool lungo (Bash di 10 min, nessun evento): non deve risultare stantio prima di `agentStaleMinutes`.
- Ricaricamento del modulo: un agente mai visto non è stantio subito; parte dal primo controllo.
- Agente stantio che torna attivo (nuovo `turn.step`): conta di nuovo come attivo; il log "stantio" può ripartire solo dopo un'altra scadenza.
- Timer che scatta con la principale in un turno, o con il clear già fatto/handoff cambiato: nessun /clear spurio (`tryClear` già controlla).
- Prompt di Agent che cita un handoff della **principale** o un file inesistente: nessuna archiviazione, nessun errore che blocchi lo spawn.

---

### Task 1: Funzioni pure

**Files:** Modify `mod/hooks/agents.ts`; Test `mod/tests/agenti-puri.test.ts`

**Interfaces — Produces:**
- `isStale(lastSeen: number, now: number, minutes: number): boolean` — `minutes > 0 && now - lastSeen >= minutes * 60_000`.
- `resumedHandoff(prompt: string): string | undefined` — il percorso `.claude/handoff/pending/<sessione>--<agente>.md`
  che segue «Riprendi dall'handoff » (anche se il percorso è assoluto: restituisce la parte da `.claude/handoff`); `undefined`
  se manca o se il file non ha `--` (handoff di una principale).

- [ ] Test: `isStale(0, 30*60_000, 30) === true`, `isStale(0, 30*60_000 - 1, 30) === false`, `isStale(0, 1e12, 0) === false`.
- [ ] Test: `resumedHandoff("Riprendi dall'handoff .claude/handoff/pending/s1--a7.md (repo /x)") === '.claude/handoff/pending/s1--a7.md'`;
  con prefisso assoluto `/Users/x/p/.claude/handoff/pending/s1--a7.md` → stesso risultato; `"Riprendi dall'handoff .claude/handoff/pending/s1.md"` → `undefined`; testo senza la frase → `undefined`.
- [ ] Rosso, implementa, verde, commit `feat(auto-clear-context): funzioni pure per agenti stantii e handoff ripresi`.

### Task 2: Agenti stantii nel clear rimandato

**Files:** Modify `mod/hooks/register.tsx`, `mod/.claude-plugin/plugin.json` (opzione); Test `mod/tests/agenti.test.ts`

**Interfaces — Consumes:** `isStale` (Task 1).

Comportamento:
- `lastSeen: Map<string, number>` del modulo, aggiornata a `$.clock.now()` in `turn.start`, `turn.step`, `classic.PostToolUse`, `turn.complete` quando c'è `agentId`/`agent_id`.
- `activeAgents`: per ogni agente BUSY senza `lastSeen`, lo registra con l'ora corrente; esclude quelli `isStale`. Al primo che esclude: log
  `agente <short id> senza attività da <N> minuti: non trattiene più il clear` una volta per agente (si ripulisce quando l'agente torna attivo).
- In `tryClear`, quando il clear resta rimandato e l'opzione > 0: un solo `$.clock.after` (cancella/ignora il precedente) alla scadenza più vicina tra gli agenti attivi, che chiama `tryClear($, 'agenti senza attività')` con catch che logga.
- Opzione `agentStaleMinutes` in `plugin.json` (titolo «Scadenza degli agenti (minuti)», descrizione: «Minuti senza attività dopo cui un agente dato ancora attivo non trattiene più il clear della principale. 0 la spegne.»), letta come le altre opzioni.

- [ ] Test `agente running senza attività da 30 minuti: log una volta e il clear parte dal timer, senza fini turno`: handoff principale validato, `running()`, `turn.complete(mainDone())` → nessun clear; `clock.advance(30*60_000)` + `settled()` → `commands` = `['clear']`, una riga di log con `senza attività da 30 minuti`.
- [ ] Test `agente con attività recente non è stantio`: `turn.step` di a1 a 25 min, avanza ancora 10 min (35 dal rinvio, 10 dall'attività) → nessun clear.
- [ ] Test `agentStaleMinutes 0: nessuna scadenza` (`{ options: { agentStaleMinutes: 0 } }`): 60 min → nessun clear.
- [ ] Test `timer con la principale in un turno: niente clear, parte alla sua fine turno`.
- [ ] Il test esistente `dopo 20 minuti di rinvio un solo avviso…` deve restare verde (21 min < 30); se un altro test esistente diventa rosso per la scadenza, aggiungi `{ options: { agentStaleMinutes: 0 } }` solo a quello e annotalo nel report.
- [ ] Rosso, implementa, suite completa verde, `claude plugin validate`, commit `fix(auto-clear-context): gli agenti senza attività non trattengono più il clear`.

### Task 3: Archiviazione degli handoff dei subagent ripresi

**Files:** Modify `mod/hooks/register.tsx`; Test `mod/tests/agenti.test.ts`

**Interfaces — Consumes:** `resumedHandoff` (Task 1); l'archiviazione esistente della principale (`archive/<stamp>-<id>.md`, riga ~316) — riusala.

Comportamento: nel `tool.call` Agent, dopo `next(e)`, se lo spawn è riuscito (nessun `deny`/errore nel risultato) e `resumedHandoff(e.prompt)` dà un file esistente: lo scrive in `archive/` con `status: resumed` e lo toglie da `pending/`; log `handoff dell'agente <short id> ripreso: archiviato in <percorso>`. Errori solo nel log, il risultato passa intatto (mai un secondo `next`). Il ramo teammate esistente resta com'è.

- [ ] Test `Agent con «Riprendi dall'handoff» di un subagent: pending vuoto, copia in archive con status resumed, una riga di log`.
- [ ] Test `Agent rifiutato (deny): l'handoff resta in pending`.
- [ ] Test `prompt con handoff della principale o file inesistente: nessuna archiviazione, nessun errore`.
- [ ] Rosso, implementa, suite completa verde, validate, commit `feat(auto-clear-context): archivia l'handoff del subagent ripreso`.

### Task 4: README e versione

**Files:** Modify `mods/auto-clear-context/README.md` (EN: Configuration, Subagents and teammates, Known limits; IT: Subagent e teammate, Uso, Limiti noti), `mod/.claude-plugin/plugin.json` (0.7.0), `README.md` della radice se riporta la versione.

- [ ] Documenta: subagent rilanciati da chi li ha lanciati, handoff archiviato al rilancio; scadenza `agentStaleMinutes` (default 30) e timer; rilancio automatico dei teammate non ancora collaudato dal vivo (o l'esito del Task 5).
- [ ] Validate + test, commit `docs(auto-clear-context): agenti stantii e handoff ripresi, versione 0.7.0`.

### Task 5: Collaudo dal vivo del rilancio teammate (best effort, coordinatore)

- [ ] Prova con `claude --plugin-dir mods/auto-clear-context/mod` in una cartella di prova, `agentSoftTokens` basso, un teammate che supera la soglia; leggi `events.log`. Tempo massimo 20 minuti. Se i team non sono disponibili in modo non interattivo, il limite resta documentato (Task 4) e va nel report.
