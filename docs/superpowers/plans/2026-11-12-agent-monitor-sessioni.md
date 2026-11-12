# agent-monitor 0.3.0 — sessioni di progetto: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** il pannello `/agenti` mostra in cima le sessioni di progetto in background (stato, esito, Copia attach / Apri nel Terminale) e i subagent per descrizione.

**Architecture:** funzioni pure in un nuovo `hooks/sessions.ts` (parse e merge); `register.tsx` le alimenta nel `refresh` esistente con `$.process.run` e `$.fs.read`, salva il risultato in un nuovo atom `sessions` e disegna la sezione nel `Pane` esistente.

**Tech Stack:** mod Claude Code (TSX, `claude-code` API, `claude-code/testing`), `claude plugin test`, `claude plugin validate`, `tsc`.

**Spec:** `docs/superpowers/specs/2026-11-12-agent-monitor-sessioni-design.md`

## Global Constraints

- Cartella: `mods/agent-monitor/`; comandi da lanciare dalla radice del repo.
- Test: `claude plugin test mods/agent-monitor`; validazione: `claude plugin validate mods/agent-monitor`; tipi: `tsc -p mods/agent-monitor`.
- Registro di default: `/Users/indji/Documents/Lavoro/Claude/Projects/Indji/coordinatrice/sessioni.json`; opzione `sessionsRegistry` (stringa vuota = nessun registro).
- `claude agents --json` con `timeoutMs: 5000`.
- Finestra delle chiuse: 24 h (`86_400_000` ms).
- Comando di ingresso: `claude attach <id>`; id valido solo se `/^[0-9a-f]{6,}$/`.
- Testi UI, commit e commenti in italiano; niente `Co-Authored-By`, niente push.
- Ogni nuovo atom con `shape` propria; versione finale `0.3.0`.

## Review Focus

1. `claude agents --json` che stampa una riga prima del JSON (es. `Starting background service…`): `parseAgents` deve leggere dal primo `[` → test in Task 1.
2. Id malevolo o strano nel registro/elenco (`"x\"; do shell script \"rm"`): niente `osascript`, solo toast → test in Task 4.
3. Registro assente o non leggibile (`fs.read` rifiuta): sezione con le sole vive, senza "non aggiornate" → test in Task 3.
4. Ora non valida in `ora`/`esito_ora` di una chiusa: la voce viene esclusa, non lancia → test in Task 1.
5. Selezione di una sessione che poi sparisce: la selezione ricade sul primo agente attivo, nessun dettaglio rotto → test in Task 4.

---

### Task 1: modello delle sessioni (`hooks/sessions.ts`)

**Files:**
- Create: `mods/agent-monitor/hooks/sessions.ts`
- Test: `mods/agent-monitor/tests/sessions.test.ts`

**Interfaces:**
- Produces (esportati da `hooks/sessions.ts`):
  ```ts
  export type LiveSession = { id: string; name: string; cwd: string; state?: string; status?: string; waitingFor?: string; sessionId?: string }
  export type RegistryEntry = { project: string; name: string; id: string; stato: string; ora?: string; esito?: string; esitoOra?: string }
  export type SessionState = 'blocked' | 'working' | 'idle' | 'closed'
  export type ProjectSession = { id: string; name: string; project: string; cwd?: string; state: SessionState; reason?: string; esito?: string; esitoOra?: string }
  export const CLOSED_WINDOW_MS = 86_400_000
  export function parseAgents(text: string): LiveSession[]
  export function parseRegistry(text: string): RegistryEntry[]
  export function mergeSessions(live: readonly LiveSession[], registry: readonly RegistryEntry[], now: number, selfSessionId?: string): ProjectSession[]
  export function isAttachId(id: string): boolean   // /^[0-9a-f]{6,}$/
  export function attachCommand(id: string): string // `claude attach ${id}`
  ```

- [ ] **Step 1: test che falliscono** in `tests/sessions.test.ts` (import da `../hooks/sessions`):
  - `parseAgents` tiene solo `kind: "background"`, mappa `id,name,cwd,state,status,waitingFor,sessionId`; testo `"Starting background service…\n[...]"` → legge dal primo `[`; `"non json"` e `"{}"` → `[]`; righe senza `id` scartate.
  - `parseRegistry('{"coordinatrice":{...},"pf":{"nome":"pf","id":"e003551f","stato":"avviata","ora":"2026-11-12T13:46:00","esito":"ok","esito_ora":"2026-11-12T14:00:00"}}')` → voce `{ project: 'pf', name: 'pf', id: 'e003551f', stato: 'avviata', ora, esito: 'ok', esitoOra }`; `coordinatrice` esclusa; JSON non valido → `[]`; voce senza `id` scartata.
  - `mergeSessions`:
    - viva con voce nel registro → `project` dalla chiave del registro, `esito` dal registro;
    - viva senza voce → `project` = ultimo segmento di `cwd` (`/a/b/claude-plugins` → `claude-plugins`);
    - `state: 'working'` → `working`; `state: 'blocked'` → `blocked` con `reason` = `waitingFor`; `status: 'waiting'` senza state → `blocked`; altro → `idle`;
    - voce del registro non viva con `esito_ora` 1 h prima di `now` → `closed`; 25 h prima → assente; `ora`/`esito_ora` non parsabili → assente;
    - viva con `sessionId === selfSessionId` → assente;
    - ordine `blocked`, `working`, `idle`, `closed`, a parità per `name`.
  - `isAttachId('e003551f')` true; `isAttachId('x"; rm')` false; `attachCommand('e003551f') === 'claude attach e003551f'`.
- [ ] **Step 2:** `claude plugin test mods/agent-monitor` → FAIL (modulo mancante).
- [ ] **Step 3:** implementa `hooks/sessions.ts`. Ora delle chiuse: `max(Date.parse(esito_ora), Date.parse(ora))` ignorando i `NaN`; nessuna ora valida → esclusa.
- [ ] **Step 4:** `claude plugin test mods/agent-monitor` → PASS (anche i test esistenti).
- [ ] **Step 5:** commit `feat(agent-monitor): modello puro delle sessioni di progetto`.

### Task 2: etichette dei subagent per descrizione

**Files:**
- Modify: `mods/agent-monitor/hooks/ledger.ts` (`agentLabel`, ~riga 61)
- Modify: `mods/agent-monitor/hooks/register.tsx` (`refresh`, ~righe 65-80; riga di dettaglio, ~righe 309-325)
- Test: `mods/agent-monitor/tests/ledger.test.ts`, `mods/agent-monitor/tests/pane.test.tsx`

**Interfaces:**
- Produces: `agentLabel(id, agents)` = `description` non vuota, altrimenti `name`, altrimenti `id` (troncata a 40 come oggi; `main` invariato). In `refresh`, lo snapshot `agents.list` conserva le voci precedenti assenti dalla nuova lista se il loro id ha ancora consumi in `usage` (stato preso dalla voce vecchia; se era attivo diventa `completed`).

- [ ] **Step 1: test che falliscono:**
  - `ledger.test.ts`: `agentLabel('a2', [{ id: 'a2', name: 'Figlio', description: 'Rivede il codice', ... }]) === 'Rivede il codice'`; con `description: ''` → `'Figlio'`; assente → `'a2'`.
  - `pane.test.tsx`: dopo un primo refresh con `a1` (descrizione `Cerca file`) e consumi per `a1`, un secondo refresh con lista vuota → la riga mostra ancora `Cerca file`, non `a1`; selezionando `a1` la riga di dettaglio contiene `id a1`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa: nuovo ordine in `agentLabel`; in `refresh` unisci lo snapshot precedente (letto con `read($, agentsAtom)`) come da Interfaces; nella riga di dettaglio antepone `id <id> · ` al testo dei token.
- [ ] **Step 4:** test → PASS (aggiorna le attese esistenti che dipendono dal vecchio ordine `name || description`, es. `a2` che ora mostra `x`: cambia la fixture in `description: 'Figlio desc'` e l'attesa di conseguenza).
- [ ] **Step 5:** commit `feat(agent-monitor): subagent etichettati per descrizione, id nel dettaglio`.

### Task 3: lettura delle sessioni nel refresh

**Files:**
- Modify: `mods/agent-monitor/types/index.d.ts` (nuovo `SessionsSnapshot`, chiave `sessions` in `PluginState`)
- Modify: `mods/agent-monitor/hooks/register.tsx` (`Ctx`, `refresh`, opzioni in `register`)
- Modify: `mods/agent-monitor/.claude-plugin/plugin.json` (`userConfig.sessionsRegistry`)
- Test: `mods/agent-monitor/tests/pane.test.tsx`

**Interfaces:**
- Consumes: `parseAgents`, `parseRegistry`, `mergeSessions`, `ProjectSession` (Task 1).
- Produces:
  - `types/index.d.ts`: `export type SessionsSnapshot = { list: ProjectSession[]; stale: boolean; at: number }` (definisci `ProjectSession` anche qui o importala da `../hooks/sessions`, una sola fonte); `PluginState['agent-monitor'].sessions: Shaped<SessionsSnapshot>`.
  - `register.tsx`: `const sessionsAtom = atom({ plugin: 'agent-monitor', key: 'sessions' } as const, { list: [], stale: false, at: 0 } as SessionsSnapshot, { shape: 'sessions-1' })`; `async function refreshSessions($: Ctx, registryPath: string): Promise<void>`, chiamata da `refresh` (che riceve il percorso) senza mai far fallire il refresh degli agenti.
  - `plugin.json`: `sessionsRegistry` `{ "type": "string", "title": "Registro sessioni", "description": "sessioni.json della coordinatrice; vuoto = nessun registro", "default": "/Users/indji/Documents/Lavoro/Claude/Projects/Indji/coordinatrice/sessioni.json" }`.

- [ ] **Step 1: test che falliscono** in `pane.test.tsx`: estendi `world` con `cfg.agentsJson?: string`, `cfg.failAgentsCmd?: boolean`, `cfg.registry?: string | null` (null = `fs.read` rifiuta), agganciando `process.run` (risponde `{ value: { exitCode: 0, stdout, stderr: '' } }` per `argv[0]==='claude'`, registra le chiamate) e `fs.read`; poi:
  - `sessions refresh: legge claude agents --json e il registro` → `argv` uguale a `['claude','agents','--json']`, `timeoutMs` 5000, `fs.read` sul percorso di default; `read(sessionsAtom)` (via `$.state` del test) ha la sessione attesa.
  - `sessions refresh: comando fallito tiene la lista e segna stale` → primo refresh ok, poi `failAgentsCmd` → stessa lista, `stale: true`; exit code ≠ 0 vale come fallimento.
  - `sessions refresh: registro illeggibile` → `registry: null` → solo le vive, `stale: false`.
  - `sessions refresh: opzione vuota` → con `sessionsRegistry: ''` nessuna chiamata a `fs.read`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa. `selfSessionId` da `$.session.id()` (se rifiuta, `undefined`). Il percorso viene da `opts.sessionsRegistry` (default come sopra; stringa vuota → registro `[]`).
- [ ] **Step 4:** test → PASS; `tsc -p mods/agent-monitor` pulito.
- [ ] **Step 5:** commit `feat(agent-monitor): legge le sessioni di progetto a ogni aggiornamento`.

### Task 4: sezione "Sessioni di progetto" nel pannello e nel riepilogo testuale

**Files:**
- Modify: `mods/agent-monitor/hooks/register.tsx` (render del `Pane`, fallback testuale di `/agenti`)
- Test: `mods/agent-monitor/tests/pane.test.tsx`

**Interfaces:**
- Consumes: `sessionsAtom`/`SessionsSnapshot` (Task 3), `isAttachId`, `attachCommand` (Task 1), `selectedAtom` esistente.
- Produces: selezione delle sessioni come `s:<id>` in `selectedAtom`; chiavi `sess-row-<id>`, `sess-sel-<id>`, `attach-copy-<id>`, `attach-open-<id>` (i test le usano).
- Copie fisse: intestazione `SESSIONI DI PROGETTO`; stati `◐ blocc` (warning), `● lav` (success), `○ ferma` (subtle), `■ chiusa` (inactive, riga dimColor); pulsanti `Copia attach`, `Apri nel Terminale`; riga `sessioni non aggiornate`; toast `Copiato: claude attach <id>`, `Copia non riuscita (<reason>)`, `Terminale non aperto: comando copiato`, `Id non valido: <id>`.

- [ ] **Step 1: test che falliscono** (loop su `['terminal','desktop'] as const` dove il comportamento non dipende dalla superficie):
  - sezione con una bloccata e una che lavora: intestazione presente, la bloccata prima, testo con nome, progetto ed esito; nessuna sessione → intestazione assente.
  - `bodyColumns: 40` → riga sessione con solo glifo e nome.
  - premi `sess-sel-<id>` poi `attach-copy-<id>` → `ui.copy` riceve `{ text: 'claude attach e003551f' }` e toast `Copiato: claude attach e003551f`; `ui.copy` che risponde `{ isCopied: false, reason: 'no-clipboard' }` → toast `Copia non riuscita (no-clipboard)`.
  - `attach-open-<id>` solo su `terminal`: `process.run` riceve `argv[0] === 'osascript'` con lo script che contiene `claude attach e003551f`; se `process.run` rifiuta → toast `Terminale non aperto: comando copiato` e `ui.copy` chiamato.
  - id non valido (`x"; rm`): pulsanti presenti, premerli dà toast `Id non valido: x"; rm`, nessun `ui.copy` né `osascript` (Review Focus 2).
  - sessione chiusa: riga presente, dettaglio senza pulsanti.
  - `stale: true` → riga `sessioni non aggiornate`.
  - selezione `s:<id>` di una sessione poi sparita → nessun dettaglio di sessione, selezione sul primo agente attivo (Review Focus 5).
  - fallback testuale (`placed: false`): il testo inizia con le righe delle sessioni prima del riepilogo agenti.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa. Script di `Apri nel Terminale`: `['osascript', '-e', 'tell application "Terminal" to do script "claude attach <id>"', '-e', 'tell application "Terminal" to activate']`, eseguito solo se `isAttachId(id)`. L'esito si tronca alla larghezza residua con `…`.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** commit `feat(agent-monitor): sezione sessioni di progetto con Copia attach e Apri nel Terminale`.

### Task 5: rilascio 0.3.0

**Files:**
- Modify: `mods/agent-monitor/.claude-plugin/plugin.json` (`version` → `0.3.0`, descrizione che cita le sessioni)
- Modify: `mods/agent-monitor/README.md` (sezione "Sessioni di progetto": fonti, stati, pulsanti, limite di `$.ui.view`, opzione `sessionsRegistry`)
- Modify: `README.md` del repo e `.claude-plugin/marketplace.json` solo se riportano versione o descrizione della mod.

- [ ] **Step 1:** aggiorna i file.
- [ ] **Step 2:** `claude plugin validate mods/agent-monitor` → nessun errore; `claude plugin test mods/agent-monitor` → tutti PASS; `tsc -p mods/agent-monitor` → pulito.
- [ ] **Step 3:** `git log --grep -i co-authored-by` sul ramo → vuoto.
- [ ] **Step 4:** commit `chore(agent-monitor): rilascio 0.3.0 con le sessioni di progetto`.
