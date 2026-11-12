# agent-monitor

Mod per Claude Code: un pannello live accanto alla chat con gli agenti della sessione. Per ognuno mostra stato, nome, modello, token, durata e turni, e avvisa quando un agente consuma troppo.

## Cosa mostra

- Una riga per ogni agente, sotto la radice **Sessione principale**.
- Per riga: stato, nome, modello, token in/out/cache, durata, turni.
- Una riga **Totale** in fondo con la somma di token e turni.
- Si aggiorna ogni `refreshMs` (default 2000 ms) solo mentre il pannello è aperto.
- Se la lista degli agenti non si legge, compare la nota "elenco non aggiornato".

## Comandi

- `/agenti` apre il pannello **Agenti**. Se non può essere posizionato, risponde con un riepilogo testuale.
- `/agenti chat` torna alla chat.

## Pulsanti

- **Transcript**: apre il transcript dell'agente.
- **Ferma**: compare solo per gli agenti attivi. Chiede conferma ("Fermo l'agente ...?") e poi usa `TaskStop`.

## Allarme

Quando un agente supera la soglia `alertTokens` (token di input + output), compare un avviso, una sola volta per ogni agente (esclusa la sessione principale). Con `0` l'allarme è spento.

## Opzioni (`/config`)

| Opzione | Default | Significato |
|---|---|---|
| `alertTokens` | `200000` | Soglia di token per agente. `0` spegne l'allarme |
| `refreshMs` | `2000` | Intervallo di aggiornamento in millisecondi. Minimo `500` |

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
