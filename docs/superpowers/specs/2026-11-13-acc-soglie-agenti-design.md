# auto-clear-context 0.6.0 — soglie degli agenti in token, commit prima dell'handoff, rilancio robusto

## Perché

Incidente del 13/11 17:21 (pokefootleague): il teammate `animatore-grafica23` (Sonnet) ha ricevuto la zona morbida
dopo 12 minuti, ha scritto un handoff e si è fermato con 6 file non committati; non è ripartito finché il team-lead
non gli ha scritto.

## Diagnosi (dai transcript e da `.claude/handoff/events.log`)

- La percentuale di un agente si calcola sulla **finestra della principale** (1M): la nota è partita al 20% =
  **~196k token** (non ~40k). Il teammate è passato da 45k a 200k token in 7 minuti e ha poi superato i 224k, quindi
  la sua finestra non era da 200k. Le soglie erano quindi legate a quelle della principale (abbassate a 20/30 per lei),
  non alla finestra dell'agente: cambiare la principale sposta anche gli agenti.
- Il validatore l'ha avviato la mod (16:21:54), non il teammate.
- Il rilancio non è avvenuto perché alle 16:22:12 il team-lead (regola di pokefootleague 5bdcfe2: «la mod non fa
  ripartire i teammate») ha detto al teammate di riprendere; il teammate ha cancellato l'handoff e la mod, alla fine
  della validazione (16:22:40), ha trovato il file sparito: «nessun verdetto applicato». Senza l'intervento il rilancio
  sarebbe partito ~45 s dopo.
- Difetto latente trovato nel codice: se il teammate riscrive l'handoff mentre il validatore lavora, il suo fine turno
  non rilancia il controllo (`checking` è occupato) e alla fine della validazione la mod non ricontrolla: stallo.

## Obiettivi

1. Soglie degli agenti indipendenti dalla principale, in token assoluti, configurabili.
2. Prima di fermarsi per l'handoff l'agente committa i propri file (per nome, mai `git add -A` o `git add .`); se non
   può, lo scrive nell'handoff con il motivo.
3. Rilancio del teammate robusto a modifiche dell'handoff durante la validazione; chi legge l'ultima riga del
   teammate (il lead) sa che il rilancio è della mod.

Non obiettivi: soglie della principale (restano come sono); rilevare la finestra reale del modello dell'agente.

## Approcci per le soglie

- **A. Token assoluti (scelto).** `agentSoftTokens` (default 120000) e `agentHardTokens` (default 150000); margine di
  sicurezza = dura + 30000. Il costo di un agente cresce con i token per chiamata, non con la percentuale; il report
  del 12/11 raccomanda il riavvio dei teammate sopra ~150k; l'API dei plugin dà la finestra solo della principale
  (`session.usage`), non quella dell'agente (`AgentInfo` non ha modello né finestra; l'alias `sonnet` può valere 200k
  o 1M).
- B. Percentuale sulla finestra vera dell'agente: richiede una tabella modello→finestra da mantenere e un modello che
  `AgentInfo` non dà; scartato.
- C. Percentuale propria ma sulla finestra della principale (come `agentThreshold` oggi): resta legata a una finestra
  che non è quella dell'agente; scartato.

## Design

- `agentThreshold` (percentuale) è sostituita da `agentSoftTokens` e `agentHardTokens` in `plugin.json`. Valori non
  validi: morbida ≤ 0 spegne le note di zona agli agenti; dura ≤ morbida diventa morbida + 30000.
- La principale con morbida 0 (monitor spento) spegne anche gli agenti, come oggi; `agents: false` pure.
- `agentLimits(soft, hard)` e `agentZoneOf(tokens, limits)` puri in `agents.ts`; la nota dice i token
  («~196k token, soglie 120k/150k, margine 180k»), non la percentuale.
- Nota di zona (teammate e subagent) e skill (Variante agente): passo «commit dei tuoi file» prima di scrivere
  l'handoff: `git add <file>` per nome, mai `-A`/`.`, messaggio che dice il punto raggiunto, niente `.claude/handoff/`;
  se non può (test rossi, file condivisi, permesso negato, non è un repo), elenca nell'handoff i file non committati e
  il motivo. Il teammate chiude il turno con la riga `HANDOFF <percorso>: la mod valida e rilancia questo teammate,
  non riprendere da solo`.
- `concludeValidation`: handoff sparito → log «handoff rimosso durante la validazione: nessun rilancio»; handoff ancora
  `ready` ma con impronta diversa da quella validata → nuova validazione subito (non si aspetta un fine turno che è già
  passato). Per questo il job di validazione tiene l'impronta del testo validato.
- README (EN e IT): nuove opzioni, commit, limite documentato (se qualcuno cancella o cambia l'handoff durante la
  validazione il rilancio salta o si ripete; il lead non deve far riprendere il teammate da solo).
- Versione 0.6.0 (opzione rinominata: cambio di configurazione).

## Lasciato a chi implementa

Testi esatti delle note e del README, nel tono esistente; struttura dei test nel file `agenti.test.ts` esistente.
