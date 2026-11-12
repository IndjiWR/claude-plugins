# agent-monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mod con pannello live `/agenti` che mostra gli agenti della sessione ad albero con stato, modello, token, durata e turni, totale e allarme di soglia, e azioni Transcript / Ferma (con conferma).

**Architecture:** `ledger.ts` puro (accumulo, albero, totali, soglia, formattazione) testato a parte; `register.tsx` cabla eventi (`turn.complete`, `agent.spawn`), `$.state`, comando, pannello (`$.ui.open` + `ui.render` su `Pane`), refresh con `$.clock`, azioni via `$.ui.view`, `$.ui.ask`, `$.tool.call('TaskStop')`.

**Tech Stack:** TypeScript/TSX, API mod Claude Code 2.1.322, kit `claude-code/testing`.

**Spec:** `docs/superpowers/specs/2026-11-12-agent-monitor-design.md`

## Global Constraints

- Cartella `mods/agent-monitor/`; test con `claude plugin test mods/agent-monitor`, validazione `claude plugin validate mods/agent-monitor`.
- Tipi API: `/private/tmp/claude-501/bundled-skills/2.1.322/a45044ac50adc3d25b2d4277bc280dfa/plugin-authoring/types/claude-code.d.ts` (grep per nome). Esempi completi di pannello, contratto e test: `/private/tmp/claude-501/bundled-skills/2.1.322/a45044ac50adc3d25b2d4277bc280dfa/plugin-authoring/examples/` (`pane.tsx`, `pane-state.d.ts`, `pane.test.tsx`); guida lunga `reference.md` accanto.
- Nessun Node nel modulo: tutto tramite `$`.
- Testi utente in italiano. Comando `agenti`; id pannello `agenti`, titolo `Agenti`.
- `userConfig`: `alertTokens` default 200000 (0 spegne), `refreshMs` default 2000 (minimo 500).
- Chiave `"main"` = sessione principale (turni senza `agentId`), etichetta "Sessione principale".
- Ferma solo per stato pending|running|waiting|idle; conferma `$.ui.ask("Fermo l'agente <label>?", ["Ferma", "Annulla"])`.
- Ogni hook con `.catch` che passa a `next(e)`.
- Commit senza trailer `Co-Authored-By`; validate e test puliti prima di ogni commit.

## Review Focus

- Turno con `usage` assente: conta il turno, token invariati (Task 1, test `addTurn senza usage`).
- Agente con `parentId` che non è in elenco (padre già rimosso): finisce sotto la radice, non sparisce (Task 1).
- Agente presente in `usage` ma non più in `$.agent.list()` (task rimosso): resta visibile con l'ultimo stato noto `completed` se aveva turni (Task 1, test `agente rimosso dall'elenco`).
- Reload della mod con valori già in `$.state`: il pannello li mostra senza azzerarli (Task 2).
- `/agenti` quando il pannello non si piazza: risposta testuale con albero e totale (Task 2).

---

### Task 1: Manifest, contratto di stato e ledger puro

**Files:**
- Create: `mods/agent-monitor/.claude-plugin/plugin.json`, `mods/agent-monitor/types/index.d.ts`, `mods/agent-monitor/hooks/hooks.json`, `mods/agent-monitor/hooks/ledger.ts`, stub `mods/agent-monitor/hooks/register.tsx`
- Test: `mods/agent-monitor/tests/ledger.test.ts`

**Interfaces:**
- Produces (in `types/index.d.ts`, importati da `../types`):
  - `type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number }`
  - `type AgentUsage = TokenCounts & { model?: string; turns: number; firstAt: number; lastAt: number }`
  - `type UsageMap = Record<string, AgentUsage>`; `type AlertedMap = Record<string, true>`
  - `interface PluginState` sotto il nome della mod con `usage: UsageMap` e `alerted: AlertedMap` (forma come in `pane-state.d.ts`)
- Produces (`ledger.ts`):
  - `type AgentLike = { id: string; parentId?: string; status: string; name?: string; description: string; type: string }`
  - `type Row = { id: string; depth: number; label: string; status: string; model?: string; tokens: TokenCounts; durationMs: number; turns: number }`
  - `type TurnUsageLike = { model?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }` (verifica i nomi reali dei campi di `TurnUsage` nei tipi e adegua)
  - `addTurn(usage: UsageMap, agentId: string | undefined, turn: TurnUsageLike | undefined, now: number): UsageMap`
  - `setModel(usage: UsageMap, agentId: string, model: string, now: number): UsageMap`
  - `buildTree(agents: readonly AgentLike[], usage: UsageMap, now: number): Row[]` — prima riga radice `main`; figli per `parentId` (mancante o sconosciuto → sotto la radice); fratelli per `firstAt` crescente; agenti solo in `usage` → stato `completed`; `label` = `name ?? description`, troncata a 40 caratteri; `durationMs` = `lastAt - firstAt` per agenti finiti, `now - firstAt` per quelli attivi
  - `totals(usage: UsageMap): TokenCounts & { turns: number }`
  - `overThreshold(usage: UsageMap, alerted: AlertedMap, limit: number): string[]` — `[]` se `limit <= 0`; esclude `main`
  - `formatTokens(n: number): string` — `850` → `"850"`, `12345` → `"12,3k"`, `1234567` → `"1,2M"`
  - `formatDuration(ms: number): string` — `"45s"`, `"3m 05s"`, `"1h 02m"`

- [ ] **Step 1:** `plugin.json` (`name` "agent-monitor", `version` "0.1.0", `description` "Pannello live degli agenti della sessione: stato, modello, token, durata e turni, con allarme di soglia e azioni Transcript/Ferma.", `types` "./types/index.d.ts", `userConfig` con le due chiavi dei Global Constraints, titoli e descrizioni in italiano), `hooks.json`, `types/index.d.ts`, stub `register.tsx`.
- [ ] **Step 2: Failing tests** in `ledger.test.ts`: `addTurn` somma su 2 turni dello stesso agente; `addTurn` con `agentId` undefined scrive in `main`; `addTurn senza usage` → `turns` +1, token invariati; `setModel`; `buildTree` con radice, figlio, nipote, padre sconosciuto sotto la radice, ordine per `firstAt`; `agente rimosso dall'elenco` → riga con stato `completed`; `totals`; `overThreshold` sotto/sopra/già segnalato/limite 0/`main` escluso; `formatTokens` e `formatDuration` con i valori sopra.
- [ ] **Step 3:** Run → FAIL. **Step 4:** implementa `ledger.ts`. **Step 5:** Run test + validate → PASS.
- [ ] **Step 6: Commit** `feat(agent-monitor): add manifest, state contract and ledger`

### Task 2: Eventi, stato, allarme e comando /agenti (risposta testuale)

**Files:**
- Modify: `mods/agent-monitor/hooks/register.tsx`
- Test: `mods/agent-monitor/tests/events.test.ts`

**Interfaces:**
- Consumes: Task 1 (`addTurn`, `setModel`, `overThreshold`, `buildTree`, `totals`, `formatTokens`, `formatDuration`, tipi).
- Produces: `textSummary(rows: Row[], tot): string` esportata da `register.tsx` o da `ledger.ts` (righe indentate di 2 spazi per livello: `<stato> <label> · <modello> · in <x> / out <y> / cache <r>+<w> · <durata> · <turni> turni`, poi `Totale: …`).
- Cablaggio:
  - `on('turn.complete')`: `const r = await next(e)`; poi aggiorna `$.state` `usage` con `addTurn(…, e.agentId, e.usage, now)`; `overThreshold` → `$.ui.toast("Agente <label> oltre <formatTokens(limit)> token")` e aggiorna `alerted`; ritorna `r`.
  - `on('agent.spawn')`: `const r = await next(e)`; se l'input ha `model` e il risultato porta l'id del nuovo agente (verifica `AgentSpawnResult`), `setModel`.
  - `on('session.start')`: `$.command.register({ name: 'agenti', description: 'Pannello live degli agenti: stato e consumi', argumentHint: '[chat]' })`.
  - `on('command.run', { command: 'agenti' })`: `args` "chat" → `$.ui.view({})`, `{}`; altrimenti in questo task risponde `{ text: textSummary(...) }` (il pannello arriva nel Task 3).

- [ ] **Step 1: Failing tests** (world sul modello di `mods/auto-clear-context/mod/tests/fase1.test.ts`, con `mock.store`, bottom per `agent.list`, `ui.toast`, `ui.view`, `turn.complete`, `agent.spawn`, `command.run`): `turn.complete` di un subagent aggiorna `usage`; turno senza `agentId` va in `main`; toast una sola volta oltre soglia (due turni oltre → un toast); `alertTokens` 0 → nessun toast; `agent.spawn` con modello lo registra; `/agenti` risponde con l'albero e il totale; `/agenti chat` chiama `ui.view` con `{}`; valori pre-esistenti in `$.state` (reload) compaiono nel riepilogo.
- [ ] **Step 2:** Run → FAIL. **Step 3:** implementa. **Step 4:** Run test + validate → PASS.
- [ ] **Step 5: Commit** `feat(agent-monitor): track per-agent usage, alerts and /agenti summary`

### Task 3: Pannello live con azioni Transcript e Ferma

**Files:**
- Modify: `mods/agent-monitor/hooks/register.tsx`
- Test: `mods/agent-monitor/tests/pane.test.tsx`

**Interfaces:**
- Consumes: Task 1-2.
- Cablaggio (segui `examples/pane.tsx` per `$.ui.open`, `ui.render`, atom e `$.ui.resolve(e)`):
  - `/agenti` senza argomenti: `$.ui.open({ id: 'agenti', title: 'Agenti', focus: true })`; se `isPlaced` → `{}`; altrimenti `{ text: "Il pannello non si apre qui (<reason>).\n" + textSummary(...) }`.
  - Atom `agents` con l'ultimo `$.agent.list()` e un flag `stale`. Mentre il pannello è aperto, `$.clock` ogni `max(500, refreshMs)` ms rilegge l'elenco; rifiuto → `stale: true` e si tiene l'ultimo. Il timer si ferma quando il pannello si chiude (vedi negli esempi o nei tipi come si rileva la chiusura; se non rilevabile, ferma il timer quando `ui.render` del pannello non viene più chiesto per 3 intervalli).
  - Render: righe di `buildTree` indentate (2 spazi per livello), colonne come `textSummary`, riga Totale, nota "elenco non aggiornato" se `stale`. Per ogni riga non `main`: `Button` "Transcript" → `$.ui.view({ agentId: id })`; `Button` "Ferma" solo per pending|running|waiting|idle → `$.ui.ask` di conferma; "Ferma" → `$.tool.call` di `TaskStop` con `{ task_id: id }` (verifica la firma di `$.tool.call` nei tipi); esito o errore → `$.ui.toast`.

- [ ] **Step 1: Failing tests:** `/agenti` apre il pannello (`ui.open` con id `agenti`); non piazzato → testo con il riepilogo; render su superficie `terminal` contiene radice, figlio indentato, totale; `stale` mostra la nota; Transcript → `ui.view` con `agentId`; Ferma con "Annulla" → nessuna chiamata a `TaskStop`; con "Ferma" → `TaskStop` con `task_id` giusto e toast; agente `completed` non ha il pulsante Ferma.
- [ ] **Step 2:** Run → FAIL. **Step 3:** implementa. **Step 4:** Run test + validate → PASS.
- [ ] **Step 5: Commit** `feat(agent-monitor): live pane with transcript and stop actions`

### Task 4: README e marketplace

**Files:**
- Create: `mods/agent-monitor/README.md`
- Modify: `.claude-plugin/marketplace.json`, `README.md` (tabella Contenuto)

- [ ] **Step 1:** README della mod (italiano, conciso): cosa mostra, `/agenti` e `/agenti chat`, pulsanti, allarme e opzioni `/config`, stato che sopravvive al reload, limiti (solo agenti di questa sessione e teammate; `TaskStop` da provare dal vivo), installazione `/plugin install agent-monitor@indji-plugins`.
- [ ] **Step 2:** voce `{ "name": "agent-monitor", "source": "./mods/agent-monitor", "description": <quella di plugin.json> }` nel marketplace e riga `mod` nella tabella del README.
- [ ] **Step 3:** `claude plugin validate .`, `claude plugin validate mods/agent-monitor`, `claude plugin test mods/agent-monitor` → tutto passa.
- [ ] **Step 4: Commit** `docs(agent-monitor): add README and marketplace entry`
