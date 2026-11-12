# agent-monitor

Mod per Claude Code: un pannello live accanto alla chat con gli agenti della sessione. Per ognuno mostra stato, nome, modello, token, durata e turni, e avvisa quando un agente consuma troppo.

## Cosa mostra

- **Riepilogo** in un riquadro: conteggi per gruppo (attivi, in attesa, in coda, finiti, errori; solo quelli non zero), token totali con barra sul budget di sessione (se `sessionBudget` > 0) e token per modello.
- **Tabella** con una riga per agente sotto la **Sessione principale**: stato, nome ad albero, modello, token con barra (colorata per soglia: verde, giallo, rosso rispetto ad `alertTokens`), durata e turni. Gli agenti finiti sono in grigio.
- **Selezione**: il pulsante a sinistra della riga (`▸` selezionato, `○` altrimenti) sceglie l'agente. All'apertura è selezionato il primo agente attivo. Sotto la tabella la barra azioni mostra **Transcript** e **Ferma** per l'agente scelto, con il dettaglio `in · out · cache`.
- Su pannelli stretti la tabella si riduce: sotto 70 colonne spariscono TURNI e la barra dei token; sotto 50 restano solo glifo di stato, nome e token.
- Si aggiorna ogni `refreshMs` (default 2000 ms) solo mentre il pannello è aperto.
- Se la lista degli agenti non si legge, compare la nota "elenco non aggiornato".

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

## Limiti

- Mostra solo gli agenti di questa sessione e le sue teammate.
- L'uso dei token sopravvive ai reload della mod, perché è salvato nello stato di sessione.
- Il pulsante **Ferma** passa da `TaskStop`. Il comportamento dal vivo di `TaskStop` lanciato da una mod va ancora provato.

## Installazione

```
/plugin install agent-monitor@indji-plugins
```

## Licenza

MIT, come il resto del repo.
