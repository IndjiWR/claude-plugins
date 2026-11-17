# auto-clear-context: modello d'handoff nella nota di zona agli agenti

## Problema
La nota di zona a un teammate dice solo «nel formato della skill auto-clear-context:handoff (stato, decisioni, …)».
Il teammate non ha la skill caricata, scrive un handoff a memoria e il validatore lo rimanda indietro per lacune di
forma (incidente 2026-11-16 09:34 e 10:07, pokefootleague: giro 2 con lacune annotate in events.log).
Lo stesso vale per il subagent, a cui la nota chiede di controllarsi «sui punti del validatore» senza elencarli.

## Soluzione
- La nota agli agenti (teammate e subagent) include il modello d'handoff letto a runtime dalle stesse fonti del flusso:
  - `skills/handoff/SKILL.md`, sezione `## Formato`: il preambolo (sezioni obbligatorie, «nessuno» se vuote) e il blocco
    markdown del modello; il frontmatter è adattato all'agente (`status: ready`, `agent: <id>` al posto di `session`);
  - `agents/handoff-validator.md`: l'elenco numerato dei punti che il validatore controlla (fra cui «Prossimo passo
    immediato: una sola azione concreta»).
- Lettura con `$.fs.read(${$.plugin.root}/…)` a ogni nota (evento raro): nessuna copia nel codice, quindi nessuna
  divergenza se cambiano skill o validatore.
- Se un file manca o non ha i marcatori, la nota resta quella di oggi (rimando alla skill) e il log lo dice.

## Funzioni
- `handoffModel(skillText, validatorText, agentId): string` (pura, in `hooks/agents.ts`): `''` se manca qualcosa.
- `agentZoneNote(…, model = '')`: con `model` non vuoto rimanda al «modello qui sotto» e lo accoda.
- `register.tsx`: `agentZoneContext` legge le due fonti e passa il modello.

## Fatto quando
- Test della mod: estrazione dalle fonti, nota con modello per teammate e subagent, ripiego senza fonti, lettura dai
  percorsi sotto `$.plugin.root` (test d'integrazione col mondo simulato). Suite verde.
- Prova end-to-end: un agente fresco che riceve solo la nota generata dalle fonti reali scrive un handoff che il
  validatore reale (`auto-clear-context:handoff-validator`) dà `VERDETTO: completo` al primo giro.

## Piano (TDD)
1. Test rossi per `handoffModel` e per `agentZoneNote` con modello → implementazione in `agents.ts`.
2. Test rosso d'integrazione (fs.read sotto la radice del plugin) → `register.tsx`.
3. README, `version` 0.9.0, validate + test.
4. Prova end-to-end con agenti reali; review; merge e push.

## Esito della prova end-to-end (2026-11-17)
Scenario: repo sandbox (stats/core.py, media fatta e committata, mediana da fare), teammate simulato Sonnet medium che
riceve solo il brief del lavoro e la nota generata dalle fonti reali; validatore con le istruzioni di
`agents/handoff-validator.md`.
- Nota vecchia (rimando alla skill): «da integrare», 9 lacune di forma (sezioni mancanti, frontmatter senza branch/head).
- Nota con il solo modello: «da integrare», 2 lacune (stato «committato» senza comando, «Fatto quando» non verificabile).
- Aggiunti dalla skill il passo «Raccogli i fatti» e «## Regole»: 1 completo su 2; l'altro con «Fatto quando» che
  rimanda a una verifica della sola parte fatta.
- Reso esplicito nella fonte comune (segnaposto del modello in SKILL.md e punto 2 del validatore) che «Fatto quando» ha
  comando ed esito e copre anche la parte da fare: 2 completi su 2, nessuna lacuna.
