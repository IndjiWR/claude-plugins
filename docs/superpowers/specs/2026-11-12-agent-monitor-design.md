# agent-monitor: design

Data: 2026-11-12 · Stato: in revisione · Repo `IndjiWR/claude-plugins`, cartella `mods/agent-monitor/` · Origine: brief approvato (prompt-builder)

## 1. Scopo

Pannello live accanto alla chat che mostra gli agenti della sessione (subagent, agenti in background, teammate) con stato e consumi, per tenere sotto controllo i costi del lavoro subagent-driven, con azioni per aprire il transcript di un agente o fermarlo.

**Requisiti dell'utente:** pannello accanto alla chat; per agente token (in/out/cache), modello, durata e numero di turni; ambito sessione + teammate; azioni "apri transcript + ferma"; albero padre/figlio; conferma prima di fermare; consumi che sopravvivono al reload; totale e soglia di allarme.

**Fuori ambito:** costo in $, storico tra sessioni, modifica dell'agent view nativa, agenti di altre sessioni.

## 2. Architettura

```
mods/agent-monitor/
  .claude-plugin/plugin.json   manifest, userConfig, "types": "./types/index.d.ts"
  types/index.d.ts             contratto di $.state (PluginState)
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/ledger.ts              funzioni pure: accumulo consumi, albero, totali, formattazione
  hooks/register.tsx           eventi, pannello, comando, azioni
  tests/*.test.ts(x)
  README.md
```

API (Claude Code 2.1.322, verificate nei tipi): `$.agent.list()` → `AgentInfo { id, parentId?, type, status, name?, description, teammateId? }`, `AgentStatus` = pending|running|waiting|idle|completed|failed|killed; `turn.complete` con `agentId?` e `usage?: TurnUsage` (include `model`); `agent.spawn` (input con `model?`); `$.ui.open` + `ui.render` su `{ component: 'Pane', requestId }` (esempio `pane.tsx` della skill plugin-authoring); `$.ui.view({ agentId })` / `$.ui.view({})`; `$.ui.toast`; `$.ui.ask`; `$.tool.call` (per `TaskStop`); `$.state` con contratto; `$.clock`; `$.command.register` + `command.run`.

## 3. Dati

`$.state` (sessione, sopravvive al reload), dichiarato nel contratto:
- `usage: Record<agentId, AgentUsage>` con `AgentUsage = { model?: string; input: number; output: number; cacheRead: number; cacheWrite: number; turns: number; firstAt: number; lastAt: number }`. La chiave `"main"` è la sessione principale (turni con `agentId` assente).
- `alerted: Record<agentId, true>`: agenti già segnalati oltre soglia.

`ledger.ts` (puro, testato a parte):
- `addTurn(usage, agentId | undefined, turnUsage, now) → usage` — somma token, `turns + 1`, aggiorna `model`, `firstAt`/`lastAt`.
- `buildTree(agents: AgentInfo[], usage) → Row[]` — `Row = { id, depth, label, status, model?, tokens: {input, output, cacheRead, cacheWrite}, durationMs, turns }`; radice "Sessione principale", figli per `parentId` (assente → figlio della radice), ordine per `firstAt`.
- `totals(usage) → { input, output, cacheRead, cacheWrite, turns }`.
- `overThreshold(usage, alerted, limit) → agentId[]` — agenti con `input + output` ≥ limit non ancora segnalati.
- `formatTokens(n) → string` — `"850"`, `"12,3k"`, `"1,2M"`.

## 4. Flusso

- `turn.complete`: dopo `next(e)`, `addTurn` su `$.state.usage`; poi `overThreshold` → `$.ui.toast("Agente <label> oltre <soglia> token")` e marca `alerted`.
- `agent.spawn`: dopo `next(e)`, se l'input porta `model`, lo registra per il nuovo agente.
- Aggiornamento live: mentre il pannello è aperto, un `$.clock` ogni `refreshMs` rilegge `$.agent.list()` e aggiorna un atom letto dal render; i cambi di `$.state.usage` ridisegnano subito.
- `/agenti`: apre il pannello (`$.ui.open({ id: 'agenti', title: 'Agenti', focus: true })`). `/agenti chat`: `$.ui.view({})` torna alla chat.
- Pannello: una riga per agente, indentata per profondità: stato (icona testuale), nome o descrizione, modello, token in/out/cache, durata, turni; in fondo la riga del totale. Per ogni agente che non sia "main": pulsante **Transcript** → `$.ui.view({ agentId })`; pulsante **Ferma**, solo se lo stato è pending/running/waiting/idle → `$.ui.ask("Fermo l'agente <label>?", ["Ferma", "Annulla"])` → con "Ferma" `$.tool.call` di `TaskStop` con `task_id: <id>`; esito con toast.

## 5. Configurazione (`userConfig`)

| Chiave | Tipo | Default | Note |
|---|---|---|---|
| `alertTokens` | number | 200000 | soglia per agente (input + output); 0 spegne l'allarme |
| `refreshMs` | number | 2000 | intervallo di aggiornamento del pannello, minimo 500 |

## 6. Errori

- `$.agent.list()` rifiuta → il pannello mostra l'ultimo elenco noto con la nota "elenco non aggiornato".
- `turn.complete` senza `usage` → conta il turno, token invariati.
- `TaskStop` fallisce o non è consentito → toast con il motivo; nessun altro effetto.
- `$.ui.open` non piazza il pannello (terminale stretto) → `/agenti` risponde con un riepilogo testuale (righe dell'albero e totale).
- Ogni hook ha `.catch` che passa a `next(e)`: la mod non blocca mai il motore.

## 7. Test (`claude plugin test`)

- `ledger.ts`: accumulo su più turni e agenti, `main` per `agentId` assente, albero con nipoti e padre mancante, totali, soglia (sotto, sopra, già segnalato, limite 0), formattazione.
- Integrazione: `turn.complete` aggiorna `$.state`; toast una sola volta oltre soglia; `/agenti` apre il pannello e, se non piazzato, risponde col riepilogo; render del pannello con albero e totale (superficie terminale); Transcript chiama `$.ui.view({ agentId })`; Ferma chiede conferma e con "Annulla" non chiama `TaskStop`, con "Ferma" lo chiama con l'id giusto; stato persistente dopo un reload simulato (valore pre-esistente in `$.state`).

## 8. Da verificare dal vivo

- `$.tool.call` di `TaskStop` da una mod (permessi e id: l'id dell'agente coincide con il `task_id`?).
- Leggibilità del pannello su terminale stretto.

## 9. Rilascio

Versione 0.1.0; voce in `.claude-plugin/marketplace.json` e nel README del repo; README della mod in italiano; validate e test puliti; nessun trailer `Co-Authored-By`.
