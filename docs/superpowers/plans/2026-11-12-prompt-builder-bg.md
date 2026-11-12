# prompt-builder spento in background — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nelle sessioni `claude --bg` l'hook `prompt.submit` non chiede mai "Ottimizzo il prompt?".

**Architecture:** funzione pura `isBackground` in `trigger.ts`; l'hook legge `CLAUDE_JOB_DIR` con `$.env.get` a ogni prompt.

**Tech Stack:** mod Claude Code (TypeScript), test con `claude-code/testing` (`claude plugin test`).

**Spec:** `docs/superpowers/specs/2026-11-12-prompt-builder-bg-design.md`

## Global Constraints
- Nome della variabile letterale: `$.env.get('CLAUDE_JOB_DIR')`; valore non vuoto = background.
- `/prompt-builder <testo>` e `!raw` invariati; nessuna nuova opzione `userConfig`.
- Se `$.env.get` lancia: comportamento di oggi (sessione interattiva).
- Commit in italiano, senza `Co-Authored-By`. Ramo: `feat/contesto-e-bg`.

## Review Focus
- `CLAUDE_JOB_DIR=''` (vuota): deve contare come interattiva → test in Task 1.
- `$.env.get` che rifiuta: la domanda resta → test in Task 1.
- `!raw` in background: prefisso tolto comunque → test in Task 1.

---

### Task 1: prompt-builder non interviene in background + rilascio

**Files:**
- Modify: `mods/prompt-builder/hooks/trigger.ts`, `mods/prompt-builder/hooks/register.tsx` (hook `prompt.submit`)
- Modify: `mods/prompt-builder/.claude-plugin/plugin.json` (`version` 0.1.0 → 0.2.0), `mods/prompt-builder/README.md`
- Test: `mods/prompt-builder/tests/trigger.test.ts`, `mods/prompt-builder/tests/register.test.ts`

**Interfaces:**
- Produces: `export function isBackground(jobDir: string | undefined): boolean` in `trigger.ts`.

- [ ] **Step 1: test che falliscono**
  - `trigger.test.ts`: `isBackground(undefined) === false`, `isBackground('') === false`, `isBackground('/Users/u/.claude/jobs/abc') === true`.
  - `register.test.ts`: aggiungi a `world` un parametro per l'ambiente (oggi `mock.env(on, { HOME: '/home/u' })`) e:
    - `'sessione in background: prompt lungo intatto, nessuna ask'` — env `{ HOME, CLAUDE_JOB_DIR: '/home/u/.claude/jobs/x' }`, `$.prompt.submit(typed(LONG))` → testo uguale a `LONG`, `st.asks` vuoto, nessuna chiamata al modello.
    - `'CLAUDE_JOB_DIR vuota: la domanda resta'` — env con `CLAUDE_JOB_DIR: ''` → `st.asks` contiene `'Ottimizzo il prompt?'`.
    - `'background con !raw: prefisso tolto'` → testo = `LONG`.
    - `'background: /prompt-builder compone ancora il brief'` — stesso flusso del test esistente del comando, con la variabile impostata.
    - `'env.get che rifiuta: la domanda resta'` — `on('env.get', () => { throw new Error('x') })` (o l'equivalente del mock) → la ask avviene.
- [ ] **Step 2:** `claude plugin test mods/prompt-builder 2>&1 | tail -15` → i nuovi test FAIL.
- [ ] **Step 3: implementa** `isBackground` e, nell'hook `prompt.submit`, subito dopo il ramo `stripRaw` e prima di `cfg.enabled`/`shouldTrigger`: legge la variabile in `try/catch` (errore → `undefined`) e con `isBackground(...)` vero fa `return next(e)`.
- [ ] **Step 4:** `claude plugin test mods/prompt-builder 2>&1 | tail -5` → tutti PASS; `claude plugin validate mods/prompt-builder` → nessun errore (elenca `CLAUDE_JOB_DIR` tra le variabili lette).
- [ ] **Step 5: rilascio** — `version` 0.2.0; README, sezione "Cosa fa", nuovo punto: "Non interviene nelle sessioni avviate in background (`claude --bg`): lì il prompt passa così com'è; `/prompt-builder <testo>` resta disponibile."
- [ ] **Step 6: commit** `git add mods/prompt-builder && git commit -m "feat(prompt-builder): nessuna domanda nelle sessioni in background (0.2.0)"`
