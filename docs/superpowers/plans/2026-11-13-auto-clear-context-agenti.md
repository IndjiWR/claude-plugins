# auto-clear-context per subagent e teammate — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stesso ciclo soglie → handoff validato → ripartenza pulita anche per subagent e teammate; il clear della principale non resta rimandato all'infinito.

**Architecture:** funzioni pure in `mod/hooks/agents.ts`; hook nuovi in `mod/hooks/register.tsx` (misura con `turn.step`, note con `classic.PostToolUse` nel loop dell'agente, validazione con `$.agent.spawn` del validatore, stop/rilancio con `$.tool.call` di `TaskStop` e `Agent`, ricontrollo del clear della principale ai `turn.complete` degli agenti).

**Tech Stack:** hooks module TypeScript/TSX dell'API delle mod di Claude Code 2.1.323; test con `claude-code/testing` (`claude plugin test`).

**Spec:** `docs/superpowers/specs/2026-11-13-auto-clear-context-agenti-design.md`

## Global Constraints
- Cartella del plugin: `mods/auto-clear-context/mod`. Comandi: `claude plugin validate mods/auto-clear-context/mod` e `claude plugin test mods/auto-clear-context/mod` (filtra l'output con `tail -n 30`).
- Testi, commenti, commit in italiano; niente `Co-Authored-By` né firme.
- Il comportamento attuale della sessione principale non cambia: i test esistenti (`fase1`, `sessioni`, `soglia`, `zone`) restano verdi.
- File dell'handoff di un agente: `.claude/handoff/pending/<sessione>--<agentId>.md` (relativo alla root).
- Opzioni nuove in `plugin.json`: `agents` (boolean, default `true`), `agentThreshold` (number, default `0` = come la principale). Versione `0.5.0`.
- Tipi dell'API: `mods/auto-clear-context/mod/.claude-plugin/types/claude-code/index.d.ts` se presente, altrimenti `/private/tmp/claude-501/bundled-skills/2.1.323/afb300b192f3dd0f5833d28ca632b6e2/plugin-authoring/types/claude-code.d.ts` (grep mirati, mai lettura intera).
- Ogni hook nuovo ha `.catch(($, e, next) => next(e))` (o l'equivalente generatore per `turn.step`, come `mods/agent-monitor/hooks/register.tsx:262`): un errore della mod non blocca mai il motore.

## Review Focus
1. Un agente senza `usage` nei `turn.step` (risposta finta, errore API): nessuna nota, nessun errore.
2. Due `turn.complete` ravvicinati dello stesso teammate con file `ready`: un solo validatore lanciato (insieme in memoria `validating`).
3. Il validatore stesso, e ogni agente avviato dalla mod, non riceve note di zona né viene rilanciato (i suoi id stanno in `ownAgents`).
4. Rilancio rifiutato (`{ deny }` o eccezione di `TaskStop`/`Agent`): un solo `$.prompt.submit` alla principale per handoff, il file resta in `pending/` con `status: validated`.
5. Principale con handoff validato, ferma, ultimo teammate che torna `idle`: il `/clear` parte una volta sola (`isClearRequested`).

---

### Task 1: funzioni pure degli agenti

**Files:**
- Create: `mods/auto-clear-context/mod/hooks/agents.ts`
- Test: `mods/auto-clear-context/mod/tests/agenti-puri.test.ts`

**Interfaces:**
- Produces:
  - `type Limits = { soft: number; hard: number; margin: number }` (stessa forma di `register.tsx`, esportata da qui)
  - `agentLimits(main: Limits, agentThreshold: number): Limits` — soft = `agentThreshold > 0 ? agentThreshold : main.soft`; con `main.soft <= 0` restituisce `{ soft: 0, hard: 0, margin: 0 }`; hard = `min(95, soft + (main.hard - main.soft))`; margin = `min(95, hard + 15)`.
  - `agentHandoffPath(session: string, agentId: string): string` → `.claude/handoff/pending/<session>--<agentId>.md`
  - `type AgentKind = 'teammate' | 'subagent'`
  - `agentZoneNote(kind: AgentKind, zone: 1 | 2 | 3, percent: number, limits: Limits, path: string, type: string): string`
  - `pauseNote(): string` — la nota "la sessione principale riparte" della spec.
  - `parseVerdict(answer: string): { isComplete: boolean; gaps: string }` — `isComplete` se la riga `VERDETTO:` contiene `completo` e non `da integrare`; `gaps` = testo dopo `LACUNE:` fino a `VERDETTO:` (trim). Senza riga `VERDETTO:` → `isComplete: false`.
  - `setFront(text: string, fields: Record<string, string>): string` — sostituisce o aggiunge campi nel frontmatter `---`; senza frontmatter ne crea uno.
  - `appendGaps(text: string, gaps: string): string` — aggiunge in coda `\n\n## Lacune segnalate dal validatore\n<gaps>\n`.
  - `agentResume(handoff: string, archived: string): string` — prompt di ripresa per il teammate rilanciato: la riga di `RESUME` adattata ("Sei un teammate rilanciato dalla mod auto-clear-context …") seguita dall'handoff intero.
  - `leadFallback(name: string, path: string, reason: string): string` — istruzioni alla principale: `TaskStop` sul teammate `<name>`, poi `Agent` con lo stesso `name`, tipo e modello e prompt «Riprendi dall'handoff <path>».

- [ ] **Step 1: test** `agenti-puri.test.ts` con `test()` di `claude-code/testing` (il corpo ignora `$`/`on`):
  - `agentLimits({soft:40,hard:60,margin:75}, 0)` → `{40,60,75}`; con `15` → `{15,35,50}`; main soft 0 → tutto 0; `agentLimits({soft:80,hard:90,margin:95}, 0)` → margin 95.
  - `agentHandoffPath('s1','a7')` → `.claude/handoff/pending/s1--a7.md`.
  - nota teammate contiene il percorso, `status: ready` e "non lanciare il validatore"; nota subagent contiene `HANDOFF <percorso>` e il tipo; zona 3 dice "subito".
  - `parseVerdict('LACUNE:\n- manca X\nVERDETTO: da integrare')` → `{ isComplete:false, gaps:'- manca X' }`; `'LACUNE: nessuna\nVERDETTO: completo'` → `isComplete:true`.
  - `setFront('---\nstatus: ready\n---\n# H', { status:'validated', rounds:'1' })` contiene `status: validated` e `rounds: 1` una volta sola; `setFront('# H', {status:'x'})` inizia con `---\nstatus: x\n---`.
- [ ] **Step 2:** `claude plugin test mods/auto-clear-context/mod 2>&1 | tail -n 30` → FAIL (modulo mancante).
- [ ] **Step 3:** implementa `agents.ts` (testi in italiano, autosufficienti come le note di `register.tsx:118`).
- [ ] **Step 4:** stesso comando → PASS (anche i test esistenti).
- [ ] **Step 5:** commit `feat(auto-clear-context): funzioni pure per gli agenti`.

### Task 2: misura del contesto degli agenti e note di zona

**Files:**
- Modify: `mods/auto-clear-context/mod/hooks/register.tsx` (hook `turn.step` nuovo; ramo `agent_id` di `classic.PostToolUse` alla riga ~666), `mod/.claude-plugin/plugin.json` (opzioni `agents`, `agentThreshold`), `mod/types/index.d.ts` (nessuna chiave nuova se `signaledZone` basta).
- Test: `mods/auto-clear-context/mod/tests/agenti.test.ts`

**Interfaces:**
- Consumes: `agentLimits`, `agentZoneNote`, `agentHandoffPath` (Task 1); `readSignaled`/`markSignaled` esistenti con id `` `${session}:${agentId}` ``.
- Produces (variabili di modulo usate dai task dopo): `agentTokens: Map<string, number>`, `mainWindow: number | undefined` (aggiornata in `session.measure` da `e.context.window`), `ownAgents: Set<string>` (id avviati dalla mod), `agentsEnabled: boolean` (da `options.agents !== false`), funzione `findAgent($, agentId): Promise<AgentInfo | undefined>` (da `$.agent.list()`), `kindOf(info: AgentInfo): AgentKind` (`teammateId` → teammate).

- [ ] **Step 1: test** in `agenti.test.ts` (mondo come `zone.test.ts`, con `on('agent.list', …)` che dà `{ id:'a1', type:'general-purpose', description:'x', status:'running' }` e la variante con `teammateId:'pose@t'`):
  - `turn.step` dell'agente `a1` con usage 450k su finestra 1M (morbida 40) poi `$.classic.PostToolUse({ …, agent_id:'a1' })` → una nota che contiene `s1--a1.md`; un secondo PostToolUse → nessuna nota; usage 650k → nota della dura.
  - usage 300k → nessuna nota (subagent breve).
  - agente non in `agent.list` → nessuna nota.
  - `{ options: { agents: false } }` → nessuna nota; `{ options: { agentThreshold: 15 } }` con 160k → nota morbida.
  - il PostToolUse della principale (senza `agent_id`) si comporta come prima (test esistenti verdi).
  - Per raise di `turn.step` nel test: cerca nei tipi `TurnStepInput` e il noun `turn` di `claude-code/testing`; il fondo del test risponde con un `TurnStepResult` che ha `usage: { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens, model }`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa. Il ramo agente di `PostToolUse` non applica `CHECK_EVERY_MS`; percentuale = `round(tokens * 100 / mainWindow)` (senza `mainWindow`, leggi `$.session.usage()` una volta). Log con `short(agentId)`.
- [ ] **Step 4:** test → PASS; `claude plugin validate mods/auto-clear-context/mod` senza errori.
- [ ] **Step 5:** commit `feat(auto-clear-context): zone e note di handoff per subagent e teammate`.

### Task 3: validazione dell'handoff del teammate

**Files:**
- Modify: `mod/hooks/register.tsx` (hook `tool.call` su `Agent` in osservazione; ramo agente di `turn.complete`), `mod/types/index.d.ts` (chiave `agentInputs: StateFamily<AgentInput>` con `AgentInput = { name?: string; subagent_type?: string; model?: string; description: string; effort?: string }`).
- Test: `mod/tests/agenti.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseVerdict`, `setFront`, `appendGaps`, `agentHandoffPath`), Task 2 (`findAgent`, `kindOf`, `ownAgents`), `readHandoff` esistente.
- Produces: `validating: Map<string, { agentId: string; path: string; round: number }>` (chiave = id del validatore); `validatedAgents: Set<string>` non serve: lo stato è nel frontmatter. Funzione `restartAgent($, agentId, handoff)` chiamata qui, implementata nel Task 4 (in questo task uno stub che logga).

- [ ] **Step 1: test**:
  - `tool.call` di `Agent` con `name:'pose'`, risultato del fondo `{ status:'teammate_spawned', agent_id:'a1', agentId:'a1', teammate_id:'pose@t', name:'pose', prompt:'…' }` → `$.state` `agentInputs['a1']` ha `name:'pose'`.
  - teammate `a1` `idle`, file `s1--a1.md` con `status: ready`, `turn.complete` con `agentId:'a1'` → un `agent.spawn` con `subagentType:'auto-clear-context:handoff-validator'` e prompt = percorso assoluto; un secondo `turn.complete` di `a1` → nessun altro spawn.
  - `turn.complete` del validatore con `VERDETTO: completo` → file con `status: validated`, `rounds: 1`.
  - con `da integrare` al giro 1 → un `session.send` a `{ agentId:'a1' }` che contiene le lacune, file ancora `ready`→ resta; al giro 2 → `validated` e sezione «Lacune segnalate dal validatore».
  - subagent (senza `teammateId`) con file `ready` → nessun validatore.
- [ ] **Step 2:** FAIL. **Step 3:** implementa (il validatore va in `ownAgents`). **Step 4:** PASS. **Step 5:** commit `feat(auto-clear-context): la mod valida l'handoff dei teammate`.

### Task 4: stop e rilancio del teammate

**Files:**
- Modify: `mod/hooks/register.tsx` (`restartAgent`), `mod/types/index.d.ts` se serve.
- Test: `mod/tests/agenti.test.ts`

**Interfaces:**
- Consumes: `agentInputs` (Task 3), `agentResume`, `leadFallback` (Task 1), `archive` esistente, `maxClearsPerHour`.
- Produces: `restartAgent($: EngineInterface, agentId: string, handoff: Handoff): Promise<void>`; store `restarts: { at: number; agent: string; handoff: string }[]` (ultimi 20).

- [ ] **Step 1: test**:
  - handoff `validated` di `a1` (`idle`, input registrato) → `tool.call` `TaskStop` con `task_id:'a1'`, poi `tool.call` `Agent` con `name:'pose'`, stesso `subagent_type`/`model` e `prompt` che contiene l'handoff; il file pending è vuoto e c'è una copia in `archive/`.
  - stesso handoff (stessa impronta) non rilanciato due volte; oltre `maxClearsPerHour` rilanci di `a1` nell'ora → nessun rilancio, log.
  - teammate tornato `running` → nessun rilancio ora; al suo prossimo `turn.complete` sì.
  - senza input registrato → `agent.spawn` con `name`, `subagentType` (= `type` della lista) e `description`.
  - `TaskStop` che risponde `{ deny }` → nessun `Agent`, un `prompt.submit` alla principale con il testo di `leadFallback`; un secondo `turn.complete` → nessun altro prompt.
  - il nuovo id restituito dal rilancio non è in `ownAgents` (il teammate rilanciato torna sotto il monitor), il validatore sì.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS. **Step 5:** commit `feat(auto-clear-context): stop e rilancio del teammate con l'handoff validato`.

### Task 5: clear della principale con agenti attivi

**Files:**
- Modify: `mod/hooks/register.tsx` (`turn.start`/`turn.complete` della principale per `isMainBusy`; estrai il corpo del clear di `turn.complete` (righe ~693-721) in `tryClear($, reason)` chiamato anche dal `turn.complete` di un agente; note di pausa nel ramo agente di `PostToolUse`; avviso dopo 20 minuti).
- Test: `mod/tests/agenti.test.ts`

**Interfaces:**
- Consumes: `pauseNote` (Task 1), logica esistente di `turn.complete`.
- Produces: `tryClear($): Promise<void>`; variabili `isMainBusy`, `deferredSince: number | undefined`, `pausedFor: Map<string, string>` (agentId → impronta dell'handoff della principale), `isDeferWarned`.

- [ ] **Step 1: test**:
  - principale con handoff validato e `a1` `running` → nessun `/clear`; il prossimo `PostToolUse` di `a1` porta `pauseNote()` una volta sola.
  - poi `a1` diventa `idle` e arriva il suo `turn.complete` (principale ferma) → `/clear` una volta.
  - principale in un turno (`turn.start` senza `turn.complete`) → il `turn.complete` dell'agente non fa partire il clear.
  - dopo 20 minuti di rinvio (orologio mock) → un toast/log "clear rimandato da 20 minuti", una volta.
  - test esistenti di `fase1`/`sessioni` verdi.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS. **Step 5:** commit `fix(auto-clear-context): il clear della principale riparte quando gli agenti si fermano`.

### Task 6: skill, README, versione e collaudo

**Files:**
- Modify: `mod/skills/handoff/SKILL.md` (sezione «Variante agente»: file dal percorso della nota, `status: ready`, `agent: <id>`, niente validatore per i teammate, risposta `HANDOFF …` per i subagent; nella variante principale, in «Metodo di coordinamento», i teammate attivi e i loro nomi), `mods/auto-clear-context/README.md` (English e Italiano: come funziona per gli agenti, opzioni `agents` e `agentThreshold`, limiti noti: nessun /clear dentro un agente, finestra della principale usata per gli agenti, teammate in pannello separato esclusi), `mod/.claude-plugin/plugin.json` (`version: 0.5.0`), `.claude-plugin/marketplace.json` del repo se riporta la versione.

- [ ] **Step 1:** scrivi i testi (descrizioni concise).
- [ ] **Step 2:** `claude plugin validate mods/auto-clear-context/mod` → ok; `claude plugin test mods/auto-clear-context/mod 2>&1 | tail -n 15` → tutti verdi; `tsc -p mods/auto-clear-context/mod` se i tipi sono disponibili.
- [ ] **Step 3:** commit `docs(auto-clear-context): agenti nella skill e nel README, versione 0.5.0`.
