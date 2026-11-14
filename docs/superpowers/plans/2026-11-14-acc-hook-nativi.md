# auto-clear-context 0.8.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** togliere ogni hook `classic.*` dalla mod e rifare le stesse funzioni su eventi nativi, che il tier gestito (`cc-plugin-sec-default`) non salta.

**Architecture:** solo `mods/auto-clear-context/mod/hooks/register.tsx` cambia punto d'aggancio; testi, log e logica restano.

**Tech Stack:** TypeScript, API dei mod (`claude-code`, `claude-code/testing`); tipi in `/private/tmp/claude-501/bundled-skills/2.1.325/2f0107821c0fd0b6fb1491954c50dc03/plugin-authoring/types/claude-code.d.ts`.

**Spec:** `docs/superpowers/specs/2026-11-14-acc-hook-nativi-design.md`

## Global Constraints
- Test `claude plugin test mods/auto-clear-context/mod`, validazione `claude plugin validate mods/auto-clear-context/mod`, dalla radice, in primo piano, output filtrato.
- Alla fine `grep -n "classic" mods/auto-clear-context/mod/hooks/register.tsx` non trova hook (`on('classic.`); i test non chiamano più `$.classic.*`.
- Stessi testi delle note e stesse righe di log di oggi (salvo dove l'evento è nominato).
- Mai un tool eseguito due volte: nel hook `tool.call` generico il corpo dopo `next` non deve lanciare (try/catch interno), come nel hook Agent esistente.
- Testi e commit in italiano, niente trailer né firme, `git add <file>` per nome. Versione 0.8.0.
- TDD: test rosso, codice minimo, verde; a fine task la suite completa.

## Review Focus
- Tool rifiutato (`deny`): nessuna nota aggiunta, il deny passa intatto.
- `tool.call` di un plugin (`$.tool.call`) o del tool context_usage: nessun errore, nessuna nota doppia.
- Dopo un /clear non chiesto dalla mod (l'utente digita /clear): l'handoff validato si allega lo stesso al primo prompt, come faceva SessionStart(clear).
- Compact di un agente (`e.agentId` presente) o compact rifiutato (`skip`): nessun reset delle zone della principale, nessun allegato.
- Un plugin `prepend` che fa `next.to` sui classic non cambia nulla (se il kit di test permette un plugin di tier prepend, un test lo dimostra).

---

### Task 1: Note durante il turno su `tool.call`

**Files:** `mod/hooks/register.tsx` (hook `classic.PostToolUse` ~1125 → `tool.call` generico); test `mod/tests/agenti.test.ts`, `mod/tests/zone.test.ts`.

- [ ] Converti gli helper dei test (`agentAfter`, `after`, le chiamate `$.classic.PostToolUse`) in chiamate `$.tool.call`-equivalenti del kit (`tool.call` con `agentId` per gli agenti), con il fondo che risponde `{ result: … }`; le asserzioni leggono `result.context`.
- [ ] Test nuovi: tool con `deny` → nessuna nota e deny intatto; nota agente presente in `context` accanto al `context` già restituito dal fondo.
- [ ] Rosso, sposta la logica in `on('tool.call', …)` senza matcher (stesse funzioni `agentZoneContext`, `pauseContext`, controllo principale ogni `CHECK_EVERY_MS`), togli `classic.PostToolUse`, verde.
- [ ] Commit `fix(auto-clear-context): note durante il turno su tool.call invece di classic.PostToolUse`.

### Task 2: Allegato dell'handoff senza `classic.SessionStart`

**Files:** `mod/hooks/register.tsx` (`classic.SessionStart` ~1252, `session.end` ~1235, `prompt.submit` ~1185, nuovo `session.compact`); test `mod/tests/sessioni.test.ts`, `mod/tests/fase1.test.ts`, `mod/tests/zone.test.ts`.

**Interfaces:** variabile di modulo `attachFor: { owner: string; source: 'clear' | 'compact' } | undefined`.

- [ ] `session.end` con `reason === 'clear'` (chiesto dalla mod o no) imposta `attachFor = { owner: e.sessionId, source: 'clear' }`.
- [ ] `session.compact` della principale (`e.agentId === undefined`), dopo `next(e)` senza `skip`: `resetSignaled` + log `compact: le zone tornano da segnalare in questa sessione`; `attachFor = { owner: <id sessione>, source: 'compact' }`.
- [ ] `prompt.submit` della principale: se `attachFor` è impostato e l'handoff di `owner` è `validated`, archivia e aggiungi `attached(handoff, archived)` a `context` (insieme a un'eventuale nota di zona), log invariato `handoff … allegato alla sessione (<source>) e archiviato in …`; poi `attachFor = undefined`.
- [ ] Adatta i test che chiamano `$.classic.SessionStart` (clear e compact) al nuovo flusso: clear → `session.end` + `prompt.submit`; compact → `session.compact` + `prompt.submit`. Test nuovi dei punti 3–4 del Review Focus.
- [ ] Rosso, implementa, togli `classic.SessionStart`, suite verde, commit `fix(auto-clear-context): handoff allegato al prompt dopo clear e compact, senza classic.SessionStart`.

### Task 3: README e versione

- [ ] `mods/auto-clear-context/README.md` EN e IT: tabella degli hook (~161-165), sezione su come funziona la ripresa, Limiti noti: «una mod del tier user non gira sotto i hook classic che il tier gestito salta (`next.to`); dalla 0.8.0 la mod usa solo eventi nativi». Versione 0.8.0 in `mod/.claude-plugin/plugin.json`.
- [ ] validate + suite, commit `docs(auto-clear-context): hook nativi, versione 0.8.0`.

### Task 4: Prova dal vivo (coordinatore)
- [ ] `claude -p` in una cartella di prova con `--plugin-dir mods/auto-clear-context/mod`, soglie basse; `events.log` deve avere la nota durante il turno e la nota di un subagent.
