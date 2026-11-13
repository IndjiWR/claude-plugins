# auto-clear-context 0.6.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** soglie degli agenti in token assoluti, commit prima dell'handoff, rilancio del teammate robusto.

**Architecture:** funzioni pure in `mod/hooks/agents.ts`, cablaggio in `mod/hooks/register.tsx`, opzioni in
`mod/.claude-plugin/plugin.json`. Test con il kit `claude-code/testing`.

**Tech Stack:** TypeScript, mod di Claude Code (`claude plugin test`).

**Spec:** `docs/superpowers/specs/2026-11-13-acc-soglie-agenti-design.md`

## Global Constraints

- Radice mod: `mods/auto-clear-context/mod/`. Test: `claude plugin test mods/auto-clear-context/mod` (89 verdi oggi).
- Testi, commenti e commit in italiano; niente `Co-Authored-By`; `git add` per nome, mai `-A`.
- Default: `agentSoftTokens` 120000, `agentHardTokens` 150000, margine = dura + 30000.
- Le soglie della principale non cambiano comportamento.

## Review Focus

- Opzioni mancanti o stringhe (`options.agentSoftTokens` come `"120000"`): `Number(...)`, default se NaN.
- Dura ≤ morbida: dura = morbida + 30000 (test in Task 1).
- Morbida della principale 0 o `agents: false`: nessuna nota agli agenti (test esistenti, da mantenere).
- Handoff del teammate riscritto durante la validazione: nuova validazione, nessuno stallo (Task 3).
- Handoff cancellato durante la validazione: nessun rilancio, log esplicito (Task 3).

---

### Task 1: soglie degli agenti in token

**Files:**
- Modify: `mod/hooks/agents.ts` (`agentLimits`, `levels`, `agentZoneNote`), `mod/hooks/register.tsx`
  (`agentZoneContext` ~712, `register` ~1023 e ~1046), `mod/.claude-plugin/plugin.json` (sostituisce `agentThreshold`)
- Test: `mod/tests/agenti-puri.test.ts`, `mod/tests/agenti.test.ts` (test `agentThreshold` ~199 e test che
  presuppongono la percentuale sulla finestra 1M)

**Interfaces:**
- Produces: `agentLimits(isMainOn: boolean, soft: number, hard: number): Limits` (in token; `{0,0,0}` se
  `!isMainOn` o `soft <= 0`; `hard <= soft` → `soft + 30000`; `margin = hard + 30000`);
  `agentZoneOf(tokens: number, limits: Limits): 0 | 1 | 2 | 3`;
  `formatK(tokens: number): string` (`196526` → `"197k"`);
  `agentZoneNote(kind, zone, tokens: number, limits, path, type)` — quarto argomento ora token, non percentuale.

- [ ] **Step 1: test puri che falliscono**

```ts
test('agentLimits: token propri, indipendenti dalla principale', () => {
  expect(agentLimits(true, 120_000, 150_000)).toEqual({ soft: 120_000, hard: 150_000, margin: 180_000 })
  expect(agentLimits(true, 120_000, 100_000)).toEqual({ soft: 120_000, hard: 150_000, margin: 180_000 })
  expect(agentLimits(false, 120_000, 150_000)).toEqual({ soft: 0, hard: 0, margin: 0 })
  expect(agentLimits(true, 0, 150_000)).toEqual({ soft: 0, hard: 0, margin: 0 })
})
test('agentZoneOf: zone in token', () => {
  const l = agentLimits(true, 120_000, 150_000)
  expect([119_999, 120_000, 150_000, 180_000].map(t => agentZoneOf(t, l))).toEqual([0, 1, 2, 3])
})
test('agentZoneNote: token e soglie in k', () => {
  expect(agentZoneNote('teammate', 1, 196_526, agentLimits(true, 120_000, 150_000), path, 'general-purpose'))
    .toContain('~197k token (soglie 120k/150k, margine di sicurezza a 180k)')
})
```
Aggiorna i test puri esistenti alla nuova firma.

- [ ] **Step 2:** `claude plugin test mods/auto-clear-context/mod` → FAIL sui nuovi test.
- [ ] **Step 3:** implementa in `agents.ts`; in `register.tsx` la zona dell'agente usa i token (non serve più
  `mainWindow` in `agentZoneContext`), `isMainOn = (await effectiveLimits(...)).soft > 0`; legge
  `options.agentSoftTokens`/`agentHardTokens` con default se NaN. Log: `agente X a ~197k token (zona morbida)`.
  `plugin.json`: due opzioni number con title/description italiane brevi, rimuovi `agentThreshold`.
- [ ] **Step 4:** test d'integrazione in `agenti.test.ts`: con default, 119_000 token → nessuna nota, 125_000 →
  `Zona morbida`; con `{ threshold: 20 }` (principale) e 160_000 token → nota di zona dura (indipendente dalla
  principale); con `{ agentSoftTokens: 50000, agentHardTokens: 80000 }` e 60_000 → `soglie 50k/80k`. Sostituisci il test
  `agentThreshold`; adatta gli altri che usano token come percentuale del milione.
- [ ] **Step 5:** test tutti verdi; commit `feat(auto-clear-context): soglie degli agenti in token assoluti`.

### Task 2: commit prima dell'handoff e riga finale del teammate

**Files:**
- Modify: `mod/hooks/agents.ts` (`agentZoneNote`), `mod/skills/handoff/SKILL.md` (sezione «Variante agente»)
- Test: `mod/tests/agenti-puri.test.ts`

**Interfaces:**
- Consumes: `agentZoneNote` di Task 1. Esporta `COMMIT_STEP: string` da `agents.ts`.

- [ ] **Step 1: test che falliscono**

```ts
test('agentZoneNote: commit dei propri file prima dell\'handoff', () => {
  for (const kind of ['teammate', 'subagent'] as const) {
    const note = agentZoneNote(kind, 1, 130_000, limits, path, 'general-purpose')
    expect(note).toContain('git add <file>')
    expect(note).toContain('mai git add -A')
    expect(note).toContain('non committati')
  }
  expect(agentZoneNote('teammate', 1, 130_000, limits, path, 'x')).toContain(`HANDOFF ${path}: la mod valida e rilancia questo teammate, non riprendere da solo`)
})
```

- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** `COMMIT_STEP` (testo fisso): «Prima di scrivere l'handoff committa i file che hai modificato tu, per
  nome (git add <file>…; mai git add -A né git add .; mai i file di .claude/handoff/), con un messaggio che dica il punto
  raggiunto. Se non puoi (test rossi, file in comune con altri, permesso negato, niente repo git), elenca nell'handoff, in
  «File toccati», i file non committati e il motivo.» Inseriscilo in entrambe le note dopo la riga della zona. Il teammate
  chiude il turno con la riga «HANDOFF <path>: la mod valida e rilancia questo teammate, non riprendere da solo».
  SKILL.md, «Variante agente»: punto **Commit** con lo stesso contenuto e la riga finale del teammate.
- [ ] **Step 4:** test verdi; `claude plugin validate mods/auto-clear-context/mod`; commit
  `feat(auto-clear-context): l'agente committa i propri file prima dell'handoff`.

### Task 3: validazione del teammate robusta

**Files:**
- Modify: `mod/hooks/register.tsx` (`validating` ~192, `checkTeammate` ~858, `concludeValidation` ~890)
- Test: `mod/tests/agenti.test.ts` (sezione «Validazione dell'handoff di un teammate»)

**Interfaces:**
- `validating` value diventa `{ agentId; path; round; id: string }` con `id` = `handoff.id` (impronta) al lancio.

- [ ] **Step 1: test che falliscono**
  - `handoff riscritto durante la validazione: nuova validazione subito`: teammate pronto, fine turno → validatore v1;
    mentre v1 lavora il file cambia testo (resta `status: ready`) e il teammate chiude un turno (bloccato da `checking`);
    fine turno di v1 con `VERDETTO: completo` → nessun `validated` scritto, un secondo spawn del validatore, nessuno stop.
  - `handoff cancellato durante la validazione: nessun rilancio`: il file sparisce; fine turno di v1 → nessuno spawn
    né TaskStop, log contiene `handoff del teammate a1 rimosso durante la validazione: nessun rilancio`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** `concludeValidation`: file assente → log sopra; `status !== 'ready'` → log attuale; impronta diversa
  da `job.id` → log `cambiato durante la validazione: nuova validazione`, e dopo il `finally` (checking libero)
  `await checkTeammate($, job.agentId)`. Il giro non avanza (stesso `round`).
- [ ] **Step 4:** test verdi; commit `fix(auto-clear-context): nuova validazione se l'handoff del teammate cambia`.

### Task 4: documentazione e versione (sessione principale)

- README EN e IT: opzioni `agentSoftTokens`/`agentHardTokens` al posto di `agentThreshold`, commit prima
  dell'handoff, limite: se qualcuno cancella l'handoff durante la validazione il rilancio salta; il lead non deve far
  riprendere il teammate da solo. `version` 0.6.0. `claude plugin validate` e `claude plugin test`. Commit.
- Review finale del ramo (high).
