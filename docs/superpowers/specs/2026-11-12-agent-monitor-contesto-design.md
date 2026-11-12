# agent-monitor — contesto usato nel pannello

## Obiettivo
Richiesta dell'utente: "fai segnare anche il contesto usato". Per la sessione principale, per i subagent e per le
sessioni di progetto il pannello `/agenti` mostra quanto è pieno il contesto: percentuale della finestra e, quando
auto-clear-context è configurata, la zona (normale / morbida / dura / margine).

## Decisioni (utente, 2026-11-12)
- **Zona**: soglie lette da `/config` di auto-clear-context, stessa formula; auto-clear-context non si tocca.
  Limite accettato: gli override che `/soglia` salva nel `$.store` di quella mod (solo quando `/config` rifiuta la
  scrittura) non si vedono.
- **Subagent con modello diverso dalla principale**: niente percentuale, solo i token di contesto.

## Fonti
1. **Principale**: `$.session.usage()` → `context.{tokens, window, percent}` (assente prima della prima risposta).
2. **Subagent**: hook `turn.step` in osservazione; `await next(e)` dà la risposta della richiesta con `usage`
   (per richiesta, non sommata come in `turn.complete`). Contesto = `input + cache_read + cache_creation` di
   quella richiesta, con `usage.model`. Si tiene l'ultimo valore per `e.agentId` (assente = principale; per la
   principale si tiene solo il modello, il dato viene da 1).
   Percentuale del subagent = token / `window` della principale, solo se `usage.model` coincide con il modello
   dell'ultima richiesta della principale; altrimenti si mostrano i token.
3. **Sessioni di progetto**: `claude agents --json` non dà il contesto. Ogni sessione con agent-monitor scrive il
   proprio in `~/.claude/agent-monitor/contesto/<sessionId>.json` (`HOME` da `$.env.get`):
   `{ "tokens": n, "window": n, "percent": n, "zone": 0-3 | null, "at": ms }`, a ogni `turn.complete` della
   principale (scrittura best-effort, errori ignorati). Il pannello, nella lettura delle sessioni (al più ogni
   10 s), legge il file del `sessionId` di ogni sessione viva o chiusa; manca o non valido → nessun dato.
   Serve agent-monitor installato nelle sessioni di progetto (scope utente: già così).
4. **Soglie**: `$.config.list()`, righe `auto-clear-context.threshold` e `auto-clear-context.hardThreshold`
   (numeri). Assenti → nessuna zona, solo percentuale. Lette al più ogni 10 s insieme alle sessioni.

## Modello puro: `hooks/context.ts`
```ts
type Limits = { soft: number; hard: number; margin: number }
type Zone = 0 | 1 | 2 | 3                     // normale, morbida, dura, margine superato
limitsFrom(rows): Limits | undefined          // soft<=0 → undefined (monitor spento)
// hard = min(95, max(hard, soft+10)); margin = min(95, hard+15)  — come auto-clear-context
zoneOf(percent, limits): Zone                 // percent<soft → 0; >=margin → 3; >=hard → 2; altrimenti 1
contextTokens(usage): number                  // input + cache_read + cache_creation
ctxCell(c: { percent?: number; tokens?: number; zone?: Zone }): string   // "47% mor", "47%", "85k", "—"
parseContextFile(text): SessionContext | undefined
```
Etichette brevi: `nor`, `mor`, `dur`, `mar`. Colori: normale come il testo, morbida giallo, dura rosso,
margine rosso in grassetto (stessa palette di `usageLevel`).

## Stato
- `UsageMap`: per agente campi nuovi opzionali `ctxTokens?`, `ctxModel?`, `ctxAt?` (nessuna migrazione: i vecchi
  valori restano validi; `shape` invariata).
- `ProjectSession`: campo nuovo `sessionId?` (da `claude agents --json`) e `context?: { percent?, tokens?, zone? }`.
- Nuovo atom `limits` (`Limits | null`) nel contratto `types/index.d.ts`.

## Vista
- **Tabella**: colonna `CTX` (larghezza 8) dopo `TOKEN`; resta sotto 70 colonne, sparisce sotto 50.
  Riga principale da fonte 1, subagent da fonte 2, `—` senza dato. Gli agenti finiti mostrano l'ultimo valore in grigio.
- **Sessioni di progetto**: `sessionLine` aggiunge `· ctx 47% mor` dopo il progetto (prima dell'esito), se c'è spazio.
- **Testo di `/agenti`** (fallback): `· ctx 47% (zona morbida)` nelle righe di agenti e sessioni.
- **Riepilogo**: invariato.

## Errori
Ogni lettura (usage, config, file) è best-effort: un errore lascia `—` e non tocca il resto del pannello.
`turn.step` non altera mai la richiesta: chiama `next(e)` e ne restituisce il risultato invariato, anche se il
proprio codice lancia (`.catch` → `next(e)`).

## Test (TDD, `claude plugin test mods/agent-monitor`)
- `context.test.ts`: `limitsFrom` (default 40/60 → 40/60/75; 50/55 → 50/60/75; 85/95 → 85/95/95; soft 0 → undefined;
  righe mancanti → undefined), `zoneOf` ai bordi, `contextTokens`, `ctxCell`, `parseContextFile` (valido, rotto).
- `events.test.ts`: `turn.step` di un subagent salva token e modello; il risultato di `next` torna invariato;
  `turn.complete` della principale scrive il file di contesto.
- `sessions.test.ts`: `sessionId` portato da `parseAgents` a `ProjectSession`.
- `pane.test.tsx`: colonna CTX con percentuale+zona per la principale, token per un subagent di altro modello,
  `—` senza dato; colonna assente sotto 50; `ctx` nella riga sessione.

## Rilascio
agent-monitor 0.4.0, README: sezione "Contesto" con fonti, zone e i due limiti (override di `/soglia`, file scritto
solo dalle sessioni con agent-monitor).
