# agent-monitor 0.3.0 — sessioni di progetto nel pannello

## Obiettivo
Dal pannello `/agenti` l'utente vede anche le sessioni di progetto lanciate in background dalla coordinatrice
(stato, ultimo esito) e ha un modo rapido per entrarci. I subagent si leggono per descrizione, non per id.

## Fonti dati
1. `claude agents --json` (via `$.process.run`, timeout 5 s): array; si tengono le righe `kind: "background"`
   con `id`, `name`, `cwd`, `state` (`working` | `blocked` | …), `status`, `waitingFor?`, `sessionId`.
2. Registro della coordinatrice (via `$.fs.read`), default
   `/Users/indji/Documents/Lavoro/Claude/Projects/Indji/coordinatrice/sessioni.json`, configurabile con l'opzione
   `userConfig` `sessionsRegistry` (stringa vuota = nessun registro). Forma: oggetto progetto →
   `{ nome, id, stato: "avviata" | "chiusa", ora, esito?, esito_ora? }` (ore ISO-8601, `esito` ≤ ~120 caratteri).

## Modello: `hooks/sessions.ts` (funzioni pure)
```ts
type LiveSession = { id: string; name: string; cwd: string; state?: string; status?: string; waitingFor?: string; sessionId?: string }
type RegistryEntry = { project: string; name: string; id: string; stato: string; ora?: string; esito?: string; esitoOra?: string }
type ProjectSession = {
  id: string; name: string; project: string; cwd?: string
  state: 'blocked' | 'working' | 'idle' | 'closed'
  reason?: string        // waitingFor, per le bloccate
  esito?: string; esitoOra?: string
}
parseAgents(text: string): LiveSession[]           // JSON non valido o non array → []
parseRegistry(text: string): RegistryEntry[]       // JSON non valido → []; voci senza id scartate
mergeSessions(live, registry, now: number, selfId?: string): ProjectSession[]
```
Regole di `mergeSessions`:
- Unione per `id`. Una sessione viva prende progetto ed esito dal registro; senza voce, progetto = ultimo segmento
  di `cwd`.
- Stato: `state === "working"` → `working`; `state === "blocked"` o `status === "waiting"` → `blocked` con
  `reason = waitingFor`; altrimenti `idle`. Voce del registro non viva (o `stato: "chiusa"` e non viva) → `closed`.
- Le `closed` restano solo se `max(esito_ora, ora)` è nelle ultime 24 ore rispetto a `now`.
- Esclusa la sessione con `id === selfId` (prefisso di `sessionId` della sessione corrente, se noto) e la voce
  `coordinatrice` del registro.
- Ordine: `blocked`, `working`, `idle`, `closed`; a parità, per nome.

## Stato e aggiornamento (`register.tsx`)
- Nuovo valore di stato `sessions: { list: ProjectSession[]; stale: boolean; at: number }`, dichiarato in
  `types/index.d.ts` sotto `agent-monitor`.
- `refresh($)` esistente legge anche le sessioni: `claude agents --json` + registro in parallelo. Se il comando
  fallisce (errore, exit ≠ 0, timeout) si tiene la lista precedente con `stale: true`; un registro illeggibile vale
  come vuoto (non rende stale).
- Stesso timer del pannello: nessun timer nuovo.

## Pannello
- Sezione "SESSIONI DI PROGETTO" sopra la tabella agenti, nascosta se la lista è vuota.
- Riga: glifo + etichetta di stato (`blocc`, `lav`, `ferma`, `chiusa`), nome, progetto, esito troncato alla
  larghezza disponibile. Glifi: `blocked` ◐ warning, `working` ● success, `idle` ○ subtle, `closed` ■ inactive
  (riga dimColor). Sotto `cols < 50` solo glifo e nome.
- Selezione condivisa con gli agenti (`selected` tiene l'id; le sessioni usano il prefisso `s:<id>` per non
  collidere).
- Dettaglio della sessione selezionata: `id · cwd`, motivo del blocco se c'è, esito intero con la sua ora.
  Per le sessioni non `closed`:
  - **Copia attach**: `$.ui.copy({ text: "claude attach <id>", surface: e.surface })`, toast di conferma o del
    motivo (`isCopied: false`).
  - **Apri nel Terminale** (solo `surface === "terminal"` su macOS): `$.process.run(["osascript", "-e",
    'tell application "Terminal" to do script "claude attach <id>"'])`, poi `activate`. Su errore: toast e copia del
    comando come ripiego. L'`id` è validato `^[0-9a-f]{6,}$` prima di comporlo nello script.
- Se `stale`: riga dim "sessioni non aggiornate".
- Fallback testuale (`/agenti` senza pannello): le sessioni compaiono in testa al riepilogo, una riga ciascuna.

## Etichette dei subagent
- `agentLabel`: `description` se non vuota, altrimenti `name`, altrimenti id (prima: `name || description`).
- Le righe orfane (consumi senza agente in `$.agent.list()`) usano la descrizione dall'ultimo snapshot noto
  `agents` (che la conserva già) prima di cadere sull'id; lo snapshot tiene anche gli agenti spariti dalla lista
  finché hanno consumi.
- L'id compare nella riga di dettaglio dell'agente selezionato.

## Errori
- Nessun errore di sessioni blocca il pannello agenti: ogni lettura è in try/catch, i hook restano con `.catch`.
- `osascript` assente o negato: toast + copia.

## Test (`claude plugin test mods/agent-monitor`)
- `tests/sessions.test.ts`: parse (JSON valido, non valido, righe non background), merge (unione per id, progetto
  da cwd, stati, finestra 24 h, esclusione self/coordinatrice, ordine).
- `tests/pane.test.tsx`: con `process.run` e `fs.read` agganciati nel test, la sezione appare con le righe attese;
  "Copia attach" chiama `ui.copy` con il comando giusto; errore del comando → "sessioni non aggiornate" e lista
  precedente; lista vuota → sezione assente; etichetta subagent = descrizione, id nel dettaglio.
- Test esistenti verdi; `claude plugin validate` e `tsc -p` puliti.

## Rilascio
`version` 0.3.0 in `plugin.json`, opzione `sessionsRegistry`, README (sezione sessioni, pulsanti, opzione).

## Fuori ambito
Passare la vista principale a un'altra sessione (l'API non lo consente: `$.ui.view` vale solo per gli agent di
questa sessione); terminali diversi da Terminal.app; azioni stop/rm sulle sessioni.
