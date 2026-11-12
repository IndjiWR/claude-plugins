# agent-monitor 0.4.0, contesto usato — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** il pannello `/agenti` mostra il contesto usato (percentuale e zona) per principale, subagent e sessioni di progetto.

**Architecture:** modello puro in `hooks/context.ts`; `register.tsx` raccoglie i dati (`$.session.usage()`, hook `turn.step`, `$.config.list()`, file per sessione) in atom esistenti/nuovi; la vista aggiunge la colonna CTX.

**Tech Stack:** mod Claude Code (TypeScript/JSX), `claude-code/testing` (`claude plugin test mods/agent-monitor`).

**Spec:** `docs/superpowers/specs/2026-11-12-agent-monitor-contesto-design.md`

## Global Constraints
- Formula soglie identica ad auto-clear-context: `hard = min(95, max(hardThreshold, soft + 10))`, `margin = min(95, hard + 15)`; `soft <= 0` → nessuna zona.
- Righe `/config`: chiavi `auto-clear-context.threshold` e `auto-clear-context.hardThreshold`.
- Etichette zona brevi `nor` / `mor` / `dur` / `mar`; lunghe `zona normale` / `zona morbida` / `zona dura` / `margine di sicurezza superato`.
- File per sessione: `${HOME}/.claude/agent-monitor/contesto/<sessionId>.json`, contenuto `{ tokens, window, percent, zone, at }`.
- Contesto di una richiesta = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
- Percentuale di un subagent solo se il suo modello coincide (stringa identica) con quello dell'ultima richiesta della principale.
- Ogni lettura/scrittura è best-effort: un errore dà `—`, mai un pannello rotto. `turn.step` restituisce sempre il risultato di `next(e)` invariato.
- Nessuna migrazione: `shape` degli atom esistenti invariata, campi nuovi opzionali.
- Testi in italiano; commit senza `Co-Authored-By`. Ramo `feat/contesto-e-bg`.

## Review Focus
- Prima della prima risposta `context.tokens`/`percent` assenti: la riga principale mostra `—`, non `0%` → test Task 1 (`mainValue`).
- Righe `/config` con valori non numerici o stringhe ("40"): `limitsFrom` → `undefined` (o numero valido se è numero) → test Task 1.
- Percentuale oltre 100 (contesto oltre la finestra): zona `mar`, cella `104% mar` senza crash → test Task 1.
- File di contesto di un'altra sessione corrotto o di forma diversa: `—` per quella sessione, le altre invariate → test Task 4.
- `turn.step` con `usage: null` (nessuna risposta): nessun aggiornamento, risultato invariato → test Task 2.

---

### Task 1: modello puro `context.ts`

**Files:**
- Create: `mods/agent-monitor/hooks/context.ts`
- Modify: `mods/agent-monitor/types/index.d.ts` (tipi esportati, nessun atom ancora)
- Test: `mods/agent-monitor/tests/context.test.ts`

**Interfaces (Produces, tipi in `types/index.d.ts`, funzioni in `context.ts`):**
```ts
export type Limits = { soft: number; hard: number; margin: number }
export type Zone = 0 | 1 | 2 | 3
export type CtxValue = { percent?: number; tokens?: number; zone?: Zone }
export type MainContext = { tokens?: number; window: number; percent?: number }
export type SessionContext = { tokens?: number; window?: number; percent?: number; zone: Zone | null; at: number }
limitsFrom(rows: readonly { key: string; value: unknown }[]): Limits | undefined
zoneOf(percent: number, limits: Limits): Zone
contextTokens(u: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): number
mainValue(main: MainContext | undefined, limits: Limits | undefined): CtxValue
agentValue(u: AgentUsage | undefined, mainWindow: number | undefined, mainModel: string | undefined, limits: Limits | undefined): CtxValue
ctxCell(v: CtxValue): string     // "47% mor" | "47%" | "85k" | "—"
ctxText(v: CtxValue): string     // "ctx 47% (zona morbida)" | "ctx 47%" | "ctx 85k" | ""
parseContextFile(text: string): SessionContext | undefined
contextFilePath(home: string, sessionId: string): string
ZONE_SHORT, ZONE_LONG: readonly string[]
```
`AgentUsage` riceve campi opzionali `ctxTokens?: number; ctxModel?: string; ctxAt?: number` (in questo task).

- [ ] **Step 1: test che falliscono** in `context.test.ts`:
  - `limitsFrom`: righe 40/60 → `{40,60,75}`; 50/55 → `{50,60,75}`; 85/95 → `{85,95,95}`; threshold 0 → `undefined`; righe assenti → `undefined`; valore `'40'` (stringa) → `undefined`.
  - `zoneOf` con `{40,60,75}`: 39→0, 40→1, 59→1, 60→2, 74→2, 75→3, 104→3.
  - `contextTokens({input_tokens:10, cache_read_input_tokens:100, cache_creation_input_tokens:5, output_tokens:7})` → 115.
  - `mainValue(undefined, L)` → `{}`; `mainValue({window:1000}, L)` → `{}`; `mainValue({tokens:470, window:1000, percent:47}, L40/60)` → `{percent:47, tokens:470, zone:1}`; senza limits → nessuna `zone`.
  - `agentValue`: `ctxModel` uguale a `mainModel`, `ctxTokens` 500, window 1000 → `{percent:50, tokens:500, zone:1}`; modello diverso → `{tokens:500}`; nessun `ctxTokens` → `{}`. Arrotondamento con `Math.round`.
  - `ctxCell`: `{percent:47,zone:1}`→`'47% mor'`; `{percent:47}`→`'47%'`; `{tokens:85000}`→ stesso formato di `formatCompact(85000)` di `ledger.ts`; `{}`→`'—'`; `{percent:104,zone:3}`→`'104% mar'`.
  - `ctxText`: `{percent:47,zone:1}`→`'ctx 47% (zona morbida)'`; `{}`→`''`.
  - `parseContextFile`: JSON valido → oggetto; JSON rotto, array, `at` mancante, `zone` fuori 0–3 → `undefined`.
  - `contextFilePath('/home/u','abc')` → `'/home/u/.claude/agent-monitor/contesto/abc.json'`.
- [ ] **Step 2:** `claude plugin test mods/agent-monitor 2>&1 | tail -15` → FAIL (modulo mancante).
- [ ] **Step 3:** implementa `context.ts` (puro, nessuna chiamata al motore) e i tipi.
- [ ] **Step 4:** `claude plugin test mods/agent-monitor 2>&1 | tail -5` → tutto PASS.
- [ ] **Step 5:** `git commit -m "feat(agent-monitor): modello del contesto e delle zone"`

### Task 2: raccolta in sessione (subagent, principale, soglie)

**Files:**
- Modify: `mods/agent-monitor/hooks/ledger.ts`, `mods/agent-monitor/hooks/register.tsx`, `mods/agent-monitor/types/index.d.ts`
- Test: `mods/agent-monitor/tests/events.test.ts`, `mods/agent-monitor/tests/ledger.test.ts`

**Interfaces:**
- Consumes: `contextTokens`, `limitsFrom`, tipi del Task 1.
- Produces:
  - `setContext(usage: UsageMap, agentId: string, tokens: number, model: string, now: number): UsageMap` in `ledger.ts` (crea la voce come `seedAgent` se manca; aggiorna `ctxTokens`, `ctxModel`, `ctxAt`; non tocca token cumulati né `turns`).
  - `export type ContextSnapshot = { main?: MainContext; limits: Limits | null; at: number }` e atom `context` nel contratto (`PluginState['agent-monitor'].context: Shaped<ContextSnapshot>`), `atom({ plugin: 'agent-monitor', key: 'context' }, { limits: null, at: 0 }, { shape: 'context-1' })`.
  - Funzione `refreshContext($)` in `register.tsx`: legge `$.session.usage()` → `main` a ogni giro di `refresh`; legge `$.config.list()` → `limits` al più ogni 10 s (riusa il passo di `maybeRefreshSessions` o un contatore proprio con `SESSIONS_MIN_MS`).

- [ ] **Step 1: test che falliscono**
  - `ledger.test.ts`: `setContext` su mappa vuota crea la voce con `ctxTokens`, `ctxModel`, `turns: 0`; su voce esistente conserva `input/output/turns`.
  - `events.test.ts` (estendi `world` con `on('session.usage', ...)` e `on('config.list', ...)` dove serve):
    - `'turn.step di un subagent salva il contesto dell ultima richiesta'`: due step per `a1` con usage diverse → in stato resta la seconda (`input+cache_read+cache_creation`) e il suo modello.
    - `'turn.step con usage null: nessun aggiornamento e risultato invariato'`.
    - `'turn.step: il risultato di next torna identico'` (stesso oggetto/valori dello step finto).
    - `'turn.step senza agentId: salva il modello sotto MAIN'`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa `setContext`, l'atom `context` e l'hook `on('turn.step', async ($, e, next) => { const r = await next(e); ...; return r }).catch(($, e, next) => next(e))`; l'aggiornamento di stato è in `try/catch` dopo `next` così un errore non cambia `r`. `refreshContext` dentro `refresh` (stesso timer del pannello), errori ignorati.
- [ ] **Step 4:** test PASS; `claude plugin validate mods/agent-monitor` senza errori (chiave `context` nel contratto).
- [ ] **Step 5:** `git commit -m "feat(agent-monitor): contesto dei subagent da turn.step e soglie da /config"`

### Task 3: pubblicazione del contesto della sessione

**Files:**
- Modify: `mods/agent-monitor/hooks/register.tsx` (hook `turn.complete`)
- Test: `mods/agent-monitor/tests/events.test.ts`

**Interfaces:**
- Consumes: `contextFilePath`, `limitsFrom`, `zoneOf`, `SessionContext`.
- Produces: file JSON `SessionContext` scritto da ogni sessione; letto dal Task 4.

- [ ] **Step 1: test che falliscono**
  - `'turn.complete della principale scrive il file di contesto'`: mock `env` `{ HOME: '/home/u' }`, `session.id` `'s1'`, `session.usage` con `context {tokens:470, window:1000, percent:47}`, `config.list` 40/60, `fs.write` che registra → un write su `/home/u/.claude/agent-monitor/contesto/s1.json` il cui JSON ha `percent:47, zone:1, window:1000, tokens:470` e `at` numerico.
  - `'turn.complete di un subagent non scrive'`.
  - `'fs.write che rifiuta: turn.complete risponde comunque'` (testo della risposta invariato).
  - `'senza auto-clear-context: zone null'`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** nell'hook `turn.complete`, solo se `e.agentId === undefined`, dopo `next(e)` e senza attendere oltre il necessario (`void` di una funzione `publishContext($)` con `try/catch` interno). Se `fs.write` non crea le cartelle, crea `.../contesto` con l'API di `$.fs` disponibile nei tipi (grep `mkdir` in `.claude-plugin/types/claude-code/index.d.ts`); senza `HOME` o `session.id` non scrive.
- [ ] **Step 4:** test PASS.
- [ ] **Step 5:** `git commit -m "feat(agent-monitor): ogni sessione pubblica il proprio contesto"`

### Task 4: contesto delle sessioni di progetto

**Files:**
- Modify: `mods/agent-monitor/hooks/sessions.ts`, `mods/agent-monitor/hooks/register.tsx` (`refreshSessions`), `mods/agent-monitor/types/index.d.ts` (`ProjectSession`)
- Test: `mods/agent-monitor/tests/sessions.test.ts`, `mods/agent-monitor/tests/pane.test.tsx`

**Interfaces:**
- Consumes: `parseContextFile`, `contextFilePath`, `CtxValue`.
- Produces: `ProjectSession` con `sessionId?: string; context?: CtxValue` (da `SessionContext`: `percent`, `tokens`, `zone ?? undefined`).

- [ ] **Step 1: test che falliscono**
  - `sessions.test.ts`: `mergeSessions` porta `sessionId` della `LiveSession` nella `ProjectSession`; le chiuse solo-registro non lo hanno.
  - `pane.test.tsx` (sezione sessioni, mock `fs.read` per i file di contesto): sessione viva con file valido → `context` = `{percent:47, tokens:470, zone:1}` nello stato `sessions`; file rotto per una sessione e valido per un'altra → solo la seconda ha `context`; nessun `HOME` → nessuna lettura.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** in `refreshSessions`, dopo `mergeSessions`, letture in parallelo (`Promise.all`) dei file delle sessioni con `sessionId`, ognuna con `.catch(() => undefined)`.
- [ ] **Step 4:** test PASS.
- [ ] **Step 5:** `git commit -m "feat(agent-monitor): contesto delle sessioni di progetto dai file pubblicati"`

### Task 5: vista, testo di `/agenti`, rilascio 0.4.0

**Files:**
- Modify: `mods/agent-monitor/hooks/register.tsx` (colonne, `sessionLine`, `rowLine`/`textSummary`), `mods/agent-monitor/README.md`, `mods/agent-monitor/.claude-plugin/plugin.json` (`version` 0.4.0)
- Test: `mods/agent-monitor/tests/pane.test.tsx`, `mods/agent-monitor/tests/events.test.ts`

**Interfaces:**
- Consumes: `mainValue`, `agentValue`, `ctxCell`, `ctxText`, atom `context`, `ProjectSession.context`.

- [ ] **Step 1: test che falliscono**
  - `pane.test.tsx`:
    - colonna `CTX` (header `CTX`, larghezza 8, dopo `TOKEN`): riga principale `47% mor` con colore giallo (zona 1); un subagent stesso modello `50% mor`; un subagent di altro modello token compatti; agente senza dato `—`; zona 2 rossa, zona 3 rossa in grassetto (stessi nomi colore di `usageLevel`).
    - aggiorna il test `'colonne: 120 tutto, 65 …, 45 …'`: CTX presente a 120 e 65, assente a 45.
    - riga sessione a 120 colonne: `… · <progetto> · ctx 47% mor · <esito>`; senza `context` nessun `ctx`; a 40 colonne invariata.
  - `events.test.ts`: il testo di `/agenti` contiene `ctx 47% (zona morbida)` sulla riga principale e nella riga della sessione.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa; `rowLine` riceve il `CtxValue` della riga e accoda `· ${ctxText(v)}` solo se non vuoto.
- [ ] **Step 4:** `claude plugin test mods/agent-monitor 2>&1 | tail -5` PASS; `claude plugin validate mods/agent-monitor` OK; `tsc -p mods/agent-monitor` se i tipi sono posati.
- [ ] **Step 5: README**: in "Cosa mostra" la colonna CTX; nuova sezione `## Contesto` con le tre fonti, le zone (soglie da `/config` di auto-clear-context, formula), percentuale dei subagent solo a parità di modello, e i limiti: override di `/soglia` non visti; sessioni di progetto solo se hanno agent-monitor; file in `~/.claude/agent-monitor/contesto/`. `version` 0.4.0.
- [ ] **Step 6:** `git commit -m "feat(agent-monitor): colonna CTX e rilascio 0.4.0"`
