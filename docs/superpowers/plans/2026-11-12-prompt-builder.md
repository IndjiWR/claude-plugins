# prompt-builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mod che intercetta i prompt lunghi e complessi scritti dall'utente e, dopo conferma, intervista e proposte approvate, li sostituisce con un brief strutturato composto da un modello fuori dalla sessione.

**Architecture:** La logica sta in moduli puri (`trigger`, `guideline`, `prompts`, `pipeline`) che non toccano `$`: la pipeline riceve le dipendenze (`ask`, `complete`) come funzioni, così i test la guidano con fake semplici. `register.tsx` è solo il cablaggio: filtro su `prompt.submit`, comando `/prompt-builder`, adattatori da `$.ui.ask` / `$.model.complete` / `$.fs` alle dipendenze.

**Tech Stack:** TypeScript, API mod di Claude Code 2.1.322 (`claude-code`), kit `claude-code/testing`.

**Spec:** `docs/superpowers/specs/2026-11-12-prompt-builder-design.md`

## Global Constraints

- Cartella: `mods/prompt-builder/` nel repo `claude-plugins`; test in `mods/prompt-builder/tests/`, eseguiti con `claude plugin test mods/prompt-builder`.
- Tipi dell'API: `/private/tmp/claude-501/bundled-skills/2.1.322/a45044ac50adc3d25b2d4277bc280dfa/plugin-authoring/types/claude-code.d.ts` (grep per nome); stile di test e di `world()` da `mods/auto-clear-context/mod/tests/fase1.test.ts`.
- Il modulo non ha Node: file, ambiente, modello e dialoghi solo tramite `$` (`$.fs`, `$.env.get("HOME")`, `$.plugin.root`, `$.model.complete`, `$.ui.ask`).
- Testi rivolti all'utente e al modello in italiano.
- Default `userConfig`: `enabled` true, `minChars` 400, `minSignals` 2, `model` "sonnet", `maxQuestions` 5 (0-8).
- Al massimo 8 proposte, 4 per finestra; brief massimo 6.000 caratteri; `timeoutMs` 60000 per chiamata.
- Il prompt dell'utente non va mai perso: ogni ramo d'errore invia l'originale.
- Commit senza trailer `Co-Authored-By`; `claude plugin validate mods/prompt-builder` e `claude plugin test mods/prompt-builder` puliti prima di ogni commit.

## Review Focus

- Prompt con `!raw` seguito solo da spazi: il filtro invia `""` senza pipeline né dialoghi, come l'utente l'ha scritto (Task 1, test `stripRaw("!raw   ")` → `""`).
- Risposta "Other" a testo libero nell'intervista che coincide con un'etichetta: va trattata come quell'etichetta, non come testo libero (Task 4, test `risposta libera uguale a un'etichetta`).
- Modello che restituisce JSON dentro un blocco ```json: va accettato (Task 3, test `parseAnalysis accetta il recinto json`).
- Proposte a scelta multipla con etichette contenenti virgole: la risposta torna comma-joined, quindi le etichette vanno numerate (`"1. …"`) e la risposta si interpreta per numero (Task 4).
- Progetto senza `.claude/prompt-builder.md` né `CLAUDE.md` e senza HOME leggibile: la pipeline parte con la sola linea guida predefinita del plugin (Task 2).

---

### Task 1: Scaffolding, manifest e regole di rilevamento

**Files:**
- Create: `mods/prompt-builder/.claude-plugin/plugin.json`, `mods/prompt-builder/hooks/hooks.json`, `mods/prompt-builder/hooks/trigger.ts`
- Test: `mods/prompt-builder/tests/trigger.test.ts`

**Interfaces:**
- Produces:
  - `type TriggerConfig = { minChars: number; minSignals: number }`
  - `countSignals(text: string): number` — conta i 5 segnali della spec §4 (ognuno vale al massimo 1)
  - `pastedRatio(text: string): number` — quota (0-1) di caratteri in blocchi recintati, righe indentate di 4+ spazi o tab, righe di log (`/^\s*(at |\d{4}-\d\d-\d\d|\[?(ERROR|WARN|INFO|DEBUG)\b|Traceback|File ")/`)
  - `stripRaw(text: string): string | undefined` — testo senza il prefisso `!raw` (e lo spazio dopo) se il prompt inizia con `!raw`, altrimenti `undefined`
  - `shouldTrigger(text: string, cfg: TriggerConfig): boolean` — lunghezza ≥ minChars, segnali ≥ minSignals, `pastedRatio` ≤ 0.6

- [ ] **Step 1: Write `plugin.json`** con `name` "prompt-builder", `version` "0.1.0", `description` "Prima che un prompt lungo arrivi alla sessione, lo trasforma in un brief chiaro con intervista e proposte approvate; ottimizza i consumi.", e `userConfig` con le 5 chiavi dei Global Constraints (tipo, `title` e `description` in italiano, `default`). `hooks.json`: `{ "modules": ["./register.tsx"] }`.
- [ ] **Step 2: Write the failing tests** in `trigger.test.ts`:
  - `countSignals("Implementa il login.\n- form\n- validazione\nInoltre deve salvare in src/auth.ts")` → `4` (verbo, elenco, requisiti, percorso)
  - `countSignals("ciao, come va?")` → `0`
  - `pastedRatio("guarda:\n```\n" + "x\n".repeat(50) + "```")` > `0.6`
  - `stripRaw("!raw fai questo")` → `"fai questo"`; `stripRaw("!raw   ")` → `""`; `stripRaw("fai !raw")` → `undefined`
  - `shouldTrigger` vero per un testo di 450 caratteri con 2 segnali; falso a 399 caratteri; falso con 1 segnale; falso con un log incollato di 2.000 caratteri e 2 segnali nella prima riga
- [ ] **Step 3: Run** `claude plugin test mods/prompt-builder` — Expected: FAIL (modulo mancante).
- [ ] **Step 4: Implement** `trigger.ts` (funzioni pure, regex per i segnali, verbi italiani e inglesi della spec §4).
- [ ] **Step 5: Run** `claude plugin test mods/prompt-builder` — Expected: PASS dei test di trigger (register.tsx non esiste ancora: crea uno stub `export const register: Register = () => {}` per far caricare il modulo).
- [ ] **Step 6: Commit** `feat(prompt-builder): add manifest and trigger rules`

### Task 2: Linee guida (predefinita, globale, progetto)

**Files:**
- Create: `mods/prompt-builder/assets/linea-guida.md`, `mods/prompt-builder/hooks/guideline.ts`
- Test: `mods/prompt-builder/tests/guideline.test.ts`

**Interfaces:**
- Produces:
  - `type FileIO = { read(path: string): Promise<string | undefined>; write(path: string, text: string): Promise<void> }`
  - `loadGuidelines(io: FileIO, paths: { pluginRoot: string; home: string | undefined; projectRoot: string }): Promise<{ text: string; createdGlobal: boolean }>`
- Regole: globale = `${home}/.claude/prompt-builder/linea-guida.md`; se assente la crea copiando `${pluginRoot}/assets/linea-guida.md` (`createdGlobal: true`); se `home` è undefined usa direttamente la predefinita. Poi aggiunge `\n\n## Progetto (prevale sulla globale)\n` + `${projectRoot}/.claude/prompt-builder.md`, oppure, se assente, i primi 3.000 caratteri di `${projectRoot}/CLAUDE.md` sotto `## Contesto del progetto (da CLAUDE.md)`.

- [ ] **Step 1: Write `assets/linea-guida.md`** con il contenuto predefinito della spec §6, in sezioni brevi: Metodo per taglia, Subagent (le 5 regole di §5 con modelli Haiku/Sonnet/Opus e formato `ESITO / FILE TOCCATI / PROBLEMI / PROSSIMO`), Strumenti (ricerca skill/plugin a inizio sessione e a ogni sotto-task nuovo), Token, Git (nessun trailer `Co-Authored-By` né firma "Generated with Claude Code"), Lingua (italiano, conciso). Sotto 3.000 caratteri.
- [ ] **Step 2: Write the failing tests** con un `FileIO` in memoria (Map):
  - `solo globale`: globale presente → `text` la contiene, `createdGlobal` false
  - `globale assente e creata`: → write sul percorso globale con il testo della predefinita, `createdGlobal` true
  - `globale + progetto`: testo contiene `## Progetto (prevale sulla globale)` dopo la globale
  - `globale + CLAUDE.md`: CLAUDE.md di 5.000 caratteri → incluso troncato a 3.000 sotto `## Contesto del progetto (da CLAUDE.md)`
  - `home assente`: `home` undefined → testo = predefinita, nessuna write
- [ ] **Step 3: Run** — Expected: FAIL.
- [ ] **Step 4: Implement** `loadGuidelines`.
- [ ] **Step 5: Run** — Expected: PASS.
- [ ] **Step 6: Commit** `feat(prompt-builder): load global and project guidelines`

### Task 3: Prompt per il modello e parsing dell'analisi

**Files:**
- Create: `mods/prompt-builder/assets/brief-template.md`, `mods/prompt-builder/hooks/prompts.ts`
- Test: `mods/prompt-builder/tests/prompts.test.ts`

**Interfaces:**
- Produces:
  - `type Size = 'piccolo' | 'delimitato' | 'progetto'`
  - `type Question = { testo: string; opzioni: string[]; header?: string }`
  - `type Proposal = { testo: string; motivo: string; sezione: string }`
  - `type Analysis = { taglia: Size; lacune: string[]; domande: Question[]; proposte: Proposal[] }`
  - `type Block = { text: string; cache?: true }`
  - `analysisPrompt(guidelines: string, userText: string, maxQuestions: number, strict: boolean): Block[]` — primo blocco = linee guida con `cache: true`; poi istruzioni (JSON dello schema di spec §3 passo 3, al massimo `maxQuestions` domande con 2-4 opzioni e testo che finisce con "?", al massimo 8 proposte con `sezione` fra quelle del template, nessun fatto inventato; con `strict` aggiunge "Rispondi SOLO con il JSON, senza testo prima o dopo"); ultimo blocco = prompt utente tra `<prompt_utente>` tag
  - `compositionPrompt(guidelines: string, template: string, userText: string, answers: { domanda: string; risposta: string }[], openQuestions: string[], accepted: string[], size: Size): Block[]` — stesso primo blocco in cache, poi template e regole di spec §5
  - `shortenPrompt(brief: string): Block[]` — "Accorcia sotto 6.000 caratteri mantenendo tutte le sezioni"
  - `parseAnalysis(reply: string, maxQuestions: number): Analysis | undefined` — estrae il primo oggetto JSON (anche dentro un recinto ```json), valida i campi, tronca `domande` a `maxQuestions` e `proposte` a 8, scarta domande con meno di 2 opzioni, riduce le opzioni a 4; `undefined` se `taglia` non è valida o il JSON non si legge

- [ ] **Step 1: Write `brief-template.md`** con la struttura esatta di spec §5 (dieci sezioni e la riga finale `Prompt originale: .claude/prompt-builder/last.md`).
- [ ] **Step 2: Write the failing tests:**
  - `analysisPrompt` → il primo blocco ha `cache: true` e contiene le linee guida; l'ultimo contiene `<prompt_utente>`; con `strict` contiene "SOLO con il JSON"
  - `parseAnalysis accetta il recinto json`: "```json\n{…valido…}\n```" → oggetto
  - `parseAnalysis` con 7 domande e `maxQuestions` 5 → 5; con 10 proposte → 8; con una domanda da 1 opzione → scartata; con 6 opzioni → 4
  - `parseAnalysis("non è json")` → `undefined`; con `taglia: "enorme"` → `undefined`
  - `compositionPrompt` contiene il template, le risposte, le proposte accettate e la taglia
- [ ] **Step 3: Run** — Expected: FAIL.
- [ ] **Step 4: Implement** `prompts.ts`.
- [ ] **Step 5: Run** — Expected: PASS.
- [ ] **Step 6: Commit** `feat(prompt-builder): model prompts and analysis parsing`

### Task 4: Pipeline (analisi → intervista → proposte → composizione → anteprima)

**Files:**
- Create: `mods/prompt-builder/hooks/pipeline.ts`
- Test: `mods/prompt-builder/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 3 (`analysisPrompt`, `compositionPrompt`, `shortenPrompt`, `parseAnalysis`, tipi).
- Produces:
  - `type AskFn = (question: string, opts: { options: string[]; header?: string; multiSelect?: true }) => Promise<string | undefined>` — `undefined` = finestra chiusa
  - `type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }`
  - `type CompleteFn = (prompt: Block[]) => Promise<{ text?: string; usage: Usage }>` — `text` undefined = fallimento (api-error, empty-reply, aborted)
  - `type PipelineDeps = { ask: AskFn; complete: CompleteFn; guidelines: string; template: string; maxQuestions: number }`
  - `type Stats = { taglia: Size; domande: number; proposteAccettate: number; proposteTotali: number; usage: Usage }`
  - `type PipelineResult = { kind: 'brief'; text: string; stats: Stats } | { kind: 'original'; reason: string } | { kind: 'fallback'; reason: string }`
  - `runPipeline(userText: string, deps: PipelineDeps): Promise<PipelineResult>`
- Comportamento (spec §3 passi 3-7 e §8):
  - analisi: `complete(analysisPrompt(…, false))`; testo assente → `fallback`; parse fallito → secondo tentativo con `strict` true; fallito di nuovo → `fallback`
  - intervista: una `ask` per domanda con `header`; `undefined` → la domanda va in `openQuestions`; risposta uguale a un'etichetta → quell'etichetta
  - proposte: etichette `"${i+1}. ${testo}"`, finestre da 4 con `multiSelect`; la risposta si divide sulle virgole e si tengono le parti che iniziano con un numero valido di quella finestra; il resto (testo libero "Other") diventa una proposta accettata in più; finestra chiusa → nessuna accettata da quella finestra
  - composizione: `complete(compositionPrompt(…))`; testo assente → `fallback`; se > 6.000 caratteri, una `complete(shortenPrompt(brief))` e si tiene il risultato se presente, altrimenti il brief lungo
  - anteprima: `ask` con il riepilogo (taglia, numero di sezioni `##`, sotto-task nel Piano subagent) e opzioni `["Invia", "Invia l'originale"]`; "Invia" → `brief`; altro o `undefined` → `original` con reason `"anteprima rifiutata"`
  - `usage` sommato su tutte le chiamate

- [ ] **Step 1: Write the failing tests** con `ask` e `complete` finti che registrano le chiamate e rispondono da una coda:
  - `flusso completo`: analisi con 2 domande e 5 proposte → 2 ask di intervista, 2 finestre di proposte (4 + 1), composizione, anteprima "Invia" → `kind: 'brief'`, `stats.proposteAccettate` uguale alle scelte, `usage` sommato su 2 chiamate
  - `nessuna domanda né proposta`: solo analisi, composizione, anteprima
  - `risposta libera uguale a un'etichetta`
  - `proposte con virgole nel testo`: risposta `"1. usa a, b e c, 3. test"` → accettate 1 e 3
  - `Other nelle proposte`: `"2. x, aggiungi i log"` → accettate la 2 e "aggiungi i log"
  - `domanda chiusa` → finisce in `openQuestions` passate a `compositionPrompt`
  - `errore API all'analisi` → `fallback`
  - `JSON non valido poi valido` → 2 chiamate di analisi, poi prosegue
  - `JSON non valido due volte` → `fallback`
  - `brief troppo lungo` → una chiamata `shortenPrompt`; il brief finale è quello accorciato
  - `anteprima chiusa` → `original`
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `runPipeline`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(prompt-builder): brief pipeline with interview and proposals`

### Task 5: Cablaggio in register.tsx (filtro, conferma, comando, ripiego)

**Files:**
- Create: `mods/prompt-builder/hooks/register.tsx` (sostituisce lo stub del Task 1)
- Test: `mods/prompt-builder/tests/register.test.ts`

**Interfaces:**
- Consumes: Task 1 (`shouldTrigger`, `stripRaw`), Task 2 (`loadGuidelines`, `FileIO`), Task 4 (`runPipeline`, `PipelineResult`).
- Produces: `export const register: Register`.
- Cablaggio:
  - `options` → `Config` con i default dei Global Constraints (`maxQuestions` limitato a 0-8).
  - `on('session.start')`: `$.command.register({ name: 'prompt-builder', description: 'Trasforma il prompt in un brief chiaro (intervista e proposte)', argumentHint: '[testo]' })`, poi `next(e)`.
  - `on('prompt.submit')`, in quest'ordine: `origin.kind !== 'composer'` o `e.command` presente → `next(e)`; `stripRaw` definito → `next({ ...e, text: stripped })`; `!enabled` o `!shouldTrigger` → `next(e)`; `$.ui.ask("Ottimizzo il prompt?", ["Sì", "No, invia così"])` (rifiuto o non "Sì" → `next(e)`); poi `build($, e.text)`.
  - `build($, text)`: `loadGuidelines` con `FileIO` su `$.fs.read` (errore → undefined) / `$.fs.write`, `pluginRoot` `$.plugin.root`, `home` `await $.env.get("HOME")`, `projectRoot` `await $.session.root()`; legge `assets/brief-template.md`; `runPipeline` con `ask` = `$.ui.ask` con rifiuto → `undefined`, `complete` = `$.model.complete({ model, prompt, timeoutMs: 60000 })` mappato su `{ text, usage }`.
  - Esito `brief`: scrive l'originale in `${root}/.claude/prompt-builder/last.md`, aggiunge `.claude/prompt-builder/` a `.git/info/exclude` se `${root}/.git` esiste e la riga manca, `$.ui.log` con taglia, domande, proposte accettate/totali e token; `next({ ...e, text: brief })`.
  - Esito `original`: `next(e)`. Esito `fallback`: `next({ ...e, context: [...(e.context ?? []), "Il prompt-builder non ha potuto comporre il brief (<reason>): usa la skill prompt-builder:prompt-builder per chiarire obiettivo, criteri e metodo prima di iniziare."] })`.
  - Ogni hook ha `.catch(($, e, next) => next(e))`.
  - `on('command.run', { command: 'prompt-builder' })`: testo = `e.args.trim()`, se vuoto `$.ui.ask("Quale prompt vuoi ottimizzare?", ["Annulla"])` (testo libero via Other; "Annulla" o rifiuto → `{ text: 'Annullato.' }`); poi `build` senza conferma; con `brief` → `$.prompt.submit({ text: brief })` e `{}`; altrimenti `$.prompt.submit({ text })` con lo stesso `context` di ripiego quando `fallback`.

- [ ] **Step 1: Write the failing tests** con un `world(on)` sul modello di `auto-clear-context/mod/tests/fase1.test.ts` (bottom per `session.root`, `fs.read`/`fs.write`/`fs.stat`, `prompt.submit`, `command.run`, `mock.env` per HOME) più i bottom per `model.complete` (coda di risposte) e per il dialogo di `$.ui.ask` (cerca nel file dei tipi l'evento che `$.ui.ask` solleva — `tool.call` di `AskUserQuestion` — e il formato della risposta; coda di risposte):
  - ogni origine fra `plugin`, `peer`, `peer-send-message`, `scheduled-trigger`, `task-notification`, `coordinator` con un testo che farebbe scattare → testo intatto, nessuna ask
  - `!raw` + testo lungo → testo senza prefisso, nessuna ask
  - testo corto `composer` → intatto, nessuna ask
  - `enabled: false` → intatto
  - conferma "No, invia così" → intatto, nessuna chiamata al modello
  - flusso completo → il testo che entra è il brief; `last.md` contiene l'originale; `.git/info/exclude` contiene `.claude/prompt-builder/`
  - errore del modello → testo originale con il `context` di ripiego che nomina `prompt-builder:prompt-builder`
  - dialogo che rifiuta (nessuno a cui chiedere) → testo intatto
  - `/prompt-builder testo` → nessuna conferma, `$.prompt.submit` con il brief
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `register.tsx`.
- [ ] **Step 4: Run** `claude plugin test mods/prompt-builder` e `claude plugin validate mods/prompt-builder` — Expected: PASS e "Validation passed".
- [ ] **Step 5: Commit** `feat(prompt-builder): wire prompt filter, confirmation and command`

### Task 6: Skill di ripiego, README e marketplace

**Files:**
- Create: `mods/prompt-builder/skills/prompt-builder/SKILL.md`, `mods/prompt-builder/README.md`
- Modify: `.claude-plugin/marketplace.json`, `README.md` (tabella Contenuto)

- [ ] **Step 1: Write `SKILL.md`**: frontmatter `name: prompt-builder`, `description` (≤ 300 caratteri) "Trasforma una richiesta in un brief (obiettivo, Fatto quando, taglia e metodo, vincoli, contesto, strumenti, piano subagent, verifica, fuori ambito). Da usare quando la mod prompt-builder lo chiede come ripiego o l'utente chiede un brief."; corpo: leggi `~/.claude/prompt-builder/linea-guida.md` e `.claude/prompt-builder.md`, fai al massimo 5 domande con AskUserQuestion solo sulle lacune, proponi fino a 8 aggiunte in una domanda a scelta multipla, scrivi il brief col template di `assets/brief-template.md` (percorso `${CLAUDE_PLUGIN_ROOT}/assets/brief-template.md`), nessun fatto inventato, poi procedi col lavoro.
- [ ] **Step 2: Write `README.md`** (italiano, conciso): cosa fa, quando scatta (regole e `!raw`), flusso, `/prompt-builder`, linee guida (percorsi), opzioni di `/config`, ripiego, installazione `/plugin install prompt-builder@indji-plugins`.
- [ ] **Step 3: Add** la voce `{ "name": "prompt-builder", "source": "./mods/prompt-builder", "description": <quella di plugin.json> }` in `marketplace.json` e la riga nella tabella del README del repo (tipo `mod`).
- [ ] **Step 4: Run** `claude plugin validate .` e `claude plugin validate mods/prompt-builder` e `claude plugin test mods/prompt-builder` — Expected: tutto passa.
- [ ] **Step 5: Commit** `docs(prompt-builder): add fallback skill, README and marketplace entry`
