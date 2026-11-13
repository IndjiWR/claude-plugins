# auto-clear-context — soglie, handoff e ripartenza anche per subagent e teammate

## Obiettivo
Richiesta dell'utente: "estendi la mod a tutto quanto". Oggi la mod segue solo la sessione principale
(`register.tsx` ignora gli eventi con `agent_id` e rimanda il `/clear` finché c'è un agente attivo). Caso reale:
in pokefootleague il teammate Pose (Sonnet) è arrivato oltre 500k di contesto in 14 ore senza handoff (29,9 M token,
22% del giorno). Lo stesso ciclo (soglie → handoff validato → ripartenza pulita) deve valere per gli agenti.

## Cosa permette l'API delle mod (build 2.1.323)
| Serve | API | Esito |
|---|---|---|
| Contesto di un agente | `turn.step` (osservazione): `e.agentId` + `usage` della richiesta | sì (come agent-monitor) |
| Nota all'agente | `classic.PostToolUse` nel suo loop (`e.agent_id`) → `additionalContext` | sì, durante i suoi turni |
| Messaggio a un agente fermo | `$.session.send({ to: { agentId } })` | sì (lo sveglia) |
| `/clear` di un agente | — | **non esiste**: il contesto di un agente non si svuota |
| Fermare un teammate | `$.tool.call({ tool: 'TaskStop', task_id })` (accetta teammate e agenti con nome) | sì, se il permesso lo consente |
| Rilanciarlo | `$.tool.call({ tool: 'Agent', ...input originale, prompt })`, `$.agent.spawn` come riserva | sì |
| Validare l'handoff | `$.agent.spawn({ subagentType: 'auto-clear-context:handoff-validator' })` + `turn.complete` del validatore | sì |
| Sapere se un agente lavora | `$.agent.list()` → `status` (`idle` = teammate in attesa) | sì |

L'equivalente del `/clear` per un teammate è quindi: handoff → validazione della mod → stop → rilancio con lo stesso
nome, tipo e modello e l'handoff come prompt. Per un subagent normale (task singolo, risponde a chi l'ha lanciato) il
rilancio spetta al chiamante: l'handoff diventa la sua risposta.

## Approcci considerati
1. **Mod deterministica con riserva sul lead (scelto).** La mod misura, segnala, valida, ferma e rilancia da sola;
   se uno stop o un rilancio viene rifiutato (permessi, errore) passa il compito alla sessione principale con un
   prompt che dice esattamente cosa fare. Robusto: non dipende dal fatto che il lead noti la nota.
2. **Tutto al lead.** La mod segnala al teammate, lui scrive l'handoff, la mod avvisa il lead che fa stop e rilancio
   con i suoi tool. Più semplice, ma con un lead occupato o inattivo il rilancio può non arrivare mai: è il fallimento
   di oggi.
3. **Solo note all'agente** (nessun rilancio): riduce poco, il contesto del teammate non scende.

## Design

### Misura e zone degli agenti
- `turn.step`: per ogni richiesta di un agente (`e.agentId` presente) si salva in memoria del modulo
  `contesto[agentId] = input + cache_read + cache_creation`.
- Percentuale = token / finestra della principale (`$.session.usage().context.window`, letta e tenuta in memoria).
  La finestra di un modello diverso non è leggibile dall'API: si usa quella della principale (decisione mia).
- Soglie degli agenti: morbida = `agentThreshold` (nuova opzione, default 0 = come la principale); dura = morbida +
  (dura − morbida della principale); margine come oggi (dura + 15, max 95). Morbida della principale a 0 spegne
  anche gli agenti; opzione `agents: false` spegne solo l'estensione.
- Si considerano solo gli agenti presenti in `$.agent.list()` (niente agenti di workflow né fork di compattazione).
- **Subagent brevi non disturbati**: nessuna nota sotto la morbida; la nota parte al primo `PostToolUse` dell'agente
  dopo l'ingresso in zona, una per zona per agente (`signaledZone` con id `<sessione>:<agentId>`).

### Nota all'agente
Autosufficiente (l'agente può non avere la skill caricata), con il percorso del suo file:
`.claude/handoff/pending/<sessione>--<agentId>.md`.
- **Teammate** (`teammateId` presente): handoff nel formato della skill con `status: ready`, `agent: <agentId>`,
  **senza** validatore (la mod lo valida); poi chiude il turno con una riga. La mod lo ferma e lo rilancia.
- **Subagent**: se il compito si chiude in pochi passi lo finisce e risponde; altrimenti handoff con
  `status: ready`, autocontrollo sui 12 punti del validatore, e come risposta finale una riga per il chiamante:
  `HANDOFF <percorso>: rilancia un subagent <tipo> con prompt «Riprendi dall'handoff <percorso>»`.
  Nessuna validazione della mod (il chiamante riceve la risposta subito).

### Validazione e rilancio del teammate
1. `turn.complete` con `agentId` di un teammate, file con `status: ready` → `$.agent.spawn` del validatore con il
   percorso assoluto; si ricorda `validatore → agente` in memoria del modulo.
2. `turn.complete` del validatore: `VERDETTO: completo` → `status: validated`. `da integrare` → al primo giro
   `$.session.send` al teammate con le LACUNE ("correggi e rimetti `status: ready`"); al secondo giro si accetta e le
   lacune si aggiungono al file nella sezione «Lacune segnalate dal validatore».
3. Handoff validato e teammate `idle` → `TaskStop`, poi rilancio con l'input originale dell'`Agent` (registrato da
   un hook `tool.call` su `Agent` in osservazione, in `$.state` per agentId) e `prompt` = testo di ripresa +
   handoff; senza input registrato, `$.agent.spawn` con nome, tipo e descrizione da `$.agent.list()`. Il file va in
   `archive/`. Se il teammate è tornato `running`, il rilancio aspetta il suo prossimo `turn.complete`.
4. Limite: `maxClearsPerHour` vale anche per i rilanci di ogni agente (store `restarts`).
5. Riserva: stop o rilancio rifiutati → `$.prompt.submit` alla principale con le istruzioni (TaskStop, Agent con lo
   stesso nome, prompt dall'handoff) e una riga nel log.

### Clear della principale con agenti attivi
Oggi il rinvio si ricontrolla solo al `turn.complete` della principale: con il lead fermo in attesa dei teammate
il clear non arriva più. Regola nuova:
- Contano solo gli agenti `pending`/`running`/`waiting`; un teammate `idle` non conta (già così).
- Handoff della principale validato e agenti attivi → la mod manda a ognuno, al suo prossimo `PostToolUse`, una
  nota "la sessione principale riparte: chiudi il turno al prossimo punto naturale e manda il report (se sei in
  zona, prima l'handoff)", una volta per handoff.
- Il clear si ricontrolla anche a ogni `turn.complete` di un agente: principale ferma (nessun suo turno in corso),
  handoff validato, nessun agente attivo → `/clear`.
- Oltre 20 minuti di rinvio: toast e riga di log "clear rimandato da N minuti: agenti attivi …" (una volta); il
  clear non viene forzato, perché l'effetto di `/clear` sugli agenti in corso non è garantito dall'API.

### File e versioni
- `mod/hooks/register.tsx` (hook nuovi), nuovo `mod/hooks/agents.ts` (funzioni pure: limiti degli agenti, percorso,
  note, parsing del verdetto, frontmatter), `mod/types/index.d.ts` (stato nuovo), test in `mod/tests/agenti.test.ts`.
- `plugin.json`: `agents` (boolean, default true), `agentThreshold` (number, default 0); versione 0.5.0.
- Skill `handoff`: sezione "Variante agente". README (italiano e inglese): sezione agenti.

## Non obiettivi
- Nessun `/clear` dentro un agente; nessuna validazione della mod per i subagent normali.
- Teammate in un pannello terminale separato (nessun loop nella sessione): esclusi, l'API non li misura.

## Rischi da verificare nel collaudo
- `additionalContext` di `PostToolUse` arriva all'agente che ha usato il tool (comportamento degli hook classici).
- `$.tool.call` di `TaskStop` e `Agent` passa il controllo dei permessi senza dialogo; altrimenti scatta la riserva.
