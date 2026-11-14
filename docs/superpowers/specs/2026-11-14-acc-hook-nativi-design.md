# auto-clear-context 0.8.0 — via dagli hook classic, saltati dal tier gestito

## Perché
Dal login col nuovo account (14/11) la sessione mostra «auto-clear-context: its classic.PostToolUse hook was skipped.
"cc-plugin-sec-default" runs first and sent the event on past it.» (e lo stesso per classic.SessionStart).
In pokefootleague `events.log` non ha eventi dopo il 14/11 00:41 UTC e un agente Sonnet è arrivato a 168k senza nota.

Meccanismo (tipi dei mod, `Tier`/`TIERS`, `next.to`): i hook dello stesso evento si annidano per tier
`prepend → user → append → builtin → core`. `cc-plugin-sec-default@builtin` siede nel tier gestito dall'organizzazione
del nuovo account e sui due eventi classic chiama `next.to(e, <tier più interno>)`: ogni link del tier `user`, dove
gira la mod, è saltato (`reason: bypassed by …`). Una mod `user` non può salire di tier (con impostazioni gestite
`prependPlugins` personali sono ignorati) né impedire il salto. Nella stessa sessione i hook nativi della mod
(`tool.call` di Agent e di context_usage, `turn.*`, `session.*`, `prompt.submit`) girano: nessun avviso di salto.

## Obiettivo
Nessun hook `classic.*`: le stesse funzioni su eventi nativi, che il tier gestito non salta.

| Prima | Dopo |
| --- | --- |
| `classic.PostToolUse` → `additionalContext`: note di zona e pausa agli agenti (`agent_id`), controllo della principale durante un turno lungo | `tool.call` senza matcher: dopo `next(e)`, se il risultato non è un `deny`, le stesse note in `result.context` (stessa semantica: un promemoria dopo il risultato del tool); agente da `e.agentId` |
| `classic.SessionStart` (source `clear`/`compact`) → allega e archivia l'handoff validato | clear: `session.end(reason clear)` già noto alla mod → al primo `prompt.submit` della principale (il prompt di ripresa della mod) l'handoff va in `context`; compact: hook `session.compact` (principale, compattazione riuscita) → zone azzerate e allegato al prompt successivo |

## Approcci
- **A (scelto) — hook nativi equivalenti.** Stessi testi e stessi log; cambia solo il punto d'aggancio. Funziona
  con o senza il tier gestito.
- B — tenere i classic e aggiungere i nativi come riserva: doppio percorso, dedupe da mantenere, nessun vantaggio.
- C — chiedere all'organizzazione di seminare la mod nel tier gestito: fuori dal nostro controllo; resta nota nel README.

## Dettagli
- Hook `tool.call` generico registrato dopo quelli con matcher già presenti (Agent, context_usage); il catch richiama
  `next` solo se l'errore arriva prima di `next` (stesso schema del hook Agent: mai un tool eseguito due volte).
- Dopo un compact automatico a metà turno l'handoff arriva al prompt successivo, non subito (prima: subito). Accettato.
- README: tabella degli hook, limite "tier gestito" spiegato, versione 0.8.0.
- Prova dal vivo: `claude -p` in una cartella di prova con la mod da `--plugin-dir` e soglie basse; in `events.log`
  devono comparire la nota durante il turno e quella di un subagent.

## Lasciato al costruttore
Nomi interni, struttura dei test, come adattare i test che oggi chiamano `$.classic.*`.
