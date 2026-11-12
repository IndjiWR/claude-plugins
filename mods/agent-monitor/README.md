# agent-monitor

Mod per Claude Code: un pannello live accanto alla chat con gli agenti della sessione e le sessioni di progetto in background. Per ognuno mostra stato, nome, modello, token, durata e turni, e avvisa quando un agente consuma troppo.

## Cosa mostra

- **Riepilogo** in un riquadro: conteggi per gruppo (attivi, in attesa, in coda, finiti, errori; solo quelli non zero), token totali con barra sul budget di sessione (se `sessionBudget` > 0) e token per modello.
- **Tabella** con una riga per agente sotto la **Sessione principale**: stato, nome ad albero, modello, token con barra (colorata per soglia: verde, giallo, rosso rispetto ad `alertTokens`), **CTX** (contesto usato, vedi sotto), durata e turni. Gli agenti finiti sono in grigio.
- **Selezione**: il pulsante a sinistra della riga (`▸` selezionato, `○` altrimenti) sceglie l'agente. All'apertura è selezionato il primo agente attivo. Sotto la tabella la barra azioni mostra **Transcript** e **Ferma** per l'agente scelto, con il dettaglio `in · out · cache`.
- Su pannelli stretti la tabella si riduce: sotto 70 colonne spariscono TURNI e la barra dei token; sotto 53 sparisce CTX; sotto 50 restano solo glifo di stato, nome e token.
- Si aggiorna ogni `refreshMs` (default 2000 ms) solo mentre il pannello è aperto.
- Se la lista degli agenti non si legge, compare la nota "elenco non aggiornato".

## Sessioni di progetto

Sotto il riepilogo e sopra la tabella degli agenti la sezione **SESSIONI DI PROGETTO** elenca le sessioni in background.

- **Fonti**: `claude agents --json` (sessioni vive) e il registro della coordinatrice `sessioni.json` (opzione `sessionsRegistry`; vuota = nessun registro). Si vedono le sessioni vive e quelle chiuse nelle ultime 24 ore.
- **Stati**: `blocc` (in attesa di te, con il motivo), `lav`, `ferma`, `chiusa`; per le chiuse c'è l'esito.
- **Lettura**: in parallelo agli agenti e al più ogni 10 s, per non lanciare `claude` a ogni aggiornamento.
- **Dettaglio** della sessione scelta: `id · cwd`, motivo del blocco, esito.
- **Copia attach**: copia `claude attach <id>` negli appunti. Gli id sono validati come esadecimali.
- **Apri nel Terminale**: solo nella superficie terminale; apre una nuova finestra di Terminal.app con `osascript`. Se fallisce, avviso e copia dell'attach.
- Il testo di `/agenti` (fallback) elenca prima le sessioni.
- I subagent sono etichettati per descrizione (poi nome, poi id); l'id è nella riga di dettaglio.

**Limite del motore**: `$.ui.view` può passare solo agli agenti di questa sessione, quindi una mod non può portare la vista su un'altra sessione; si entra con `claude attach <id>`.

## Contesto

La colonna **CTX** (8 caratteri, dopo TOKEN) mostra quanto contesto usa ogni riga, per esempio `47% mor`; la riga delle sessioni di progetto aggiunge `ctx 47% mor`, il testo di `/agenti` `ctx 47% (zona morbida)`.

- **Tre fonti**: la sessione principale legge la finestra dal motore (`$.session.usage()`); i subagent dall'ultima richiesta del modello (`turn.step`: input + cache letta + cache scritta); le sessioni di progetto dal file che ognuna pubblica a ogni turno (nome = id del job, cioè l'`id` di `claude agents --json`).
- **Zone**: `nor`, `mor` (morbida), `dur` (dura), `mar` (margine di sicurezza superato), calcolate con le soglie di auto-clear-context lette da `/config`: morbida = `threshold`, dura = max(`hardThreshold`, morbida + 10) fino a 95, margine = dura + 15 fino a 95. Colori: zona normale col testo normale, morbida gialla, dura rossa, margine rosso in grassetto. Senza auto-clear-context (o con soglia morbida <= 0) non c'è zona: solo la percentuale.
- **Subagent**: la percentuale si mostra solo a parità di modello con la sessione principale (stessa finestra); con un altro modello compaiono i token compatti, senza dato `—`.
- **Limiti**: gli override di `/soglia` non sono visti (valgono solo le soglie di `/config`); le sessioni di progetto compaiono con il contesto solo se hanno agent-monitor installato; i file stanno in `~/.claude/agent-monitor/contesto/<id del job>.json`.

## Comandi

- `/agenti` apre il pannello **Agenti**. Se non può essere posizionato, risponde con un riepilogo testuale.
- `/agenti chat` torna alla chat.

## Pulsanti

- **Transcript**: apre il transcript dell'agente selezionato.
- **Ferma**: compare solo se l'agente selezionato è attivo. Chiede conferma ("Fermo l'agente ...?") e poi usa `TaskStop`.

## Allarme

Quando un agente supera la soglia `alertTokens` (token di input + output), compare un avviso, una sola volta per ogni agente (esclusa la sessione principale). Con `0` l'allarme è spento.

## Opzioni (`/config`)

| Opzione | Default | Significato |
|---|---|---|
| `alertTokens` | `200000` | Soglia di token per agente. `0` spegne l'allarme |
| `refreshMs` | `2000` | Intervallo di aggiornamento in millisecondi. Minimo `500` |
| `sessionBudget` | `0` | Budget di token della sessione per la barra del riepilogo; `0` la nasconde |
| `sessionsRegistry` | percorso di `sessioni.json` della coordinatrice | Registro delle sessioni; vuoto = nessun registro |

## Limiti

- Mostra solo gli agenti di questa sessione e le sue teammate, più le sessioni di progetto lette da `claude agents --json` e dal registro.
- L'uso dei token sopravvive ai reload della mod, perché è salvato nello stato di sessione.
- Il pulsante **Ferma** passa da `TaskStop`. Il comportamento dal vivo di `TaskStop` lanciato da una mod va ancora provato.

## Installazione

```
/plugin install agent-monitor@indji-plugins
```

## Licenza

MIT, come il resto del repo.
