# auto-clear-context 0.10.0: soglie in token per la principale, validatore su Sonnet/low

Fonte: report della coordinatrice del 2026-11-16 (punti 1 e 4). Con una finestra da 1M il 40% scatta a 400k: il
lead di pokefootleague è stato in media a 190–209k, con picchi di 362k. Inoltre 16 validazioni su 28 sono girate su
Opus, perché il validatore eredita il modello del lead.

## Soglie in token
- `userConfig`: `mainSoftTokens` e `mainHardTokens`, default 0 (spente).
- `capByTokens(limits, soft, hard, window)` (pura, `hooks/agents.ts`): le soglie in token seguono la regola degli
  agenti (dura almeno morbida + 30k, margine 30k sopra la dura). Vengono convertite in percentuale della finestra e,
  per ogni livello, vale la più bassa. Con la morbida in percentuale a 0 (monitor spento) o la finestra ignota
  restano le percentuali.
- `effectiveLimits` le applica, quindi valgono per note, clear, `context_usage` e l'accensione degli agenti.
  `/soglia` continua a gestire solo le percentuali.

## Validatore
- In `agents/handoff-validator.md`, `model: sonnet` e `effort: low` nel frontmatter valgono sia per la skill sia per
  la mod.
- `$.agent.spawn` della mod passa `model: 'sonnet'` in modo esplicito (l'API non ha `effort`).
- Nella skill, al passo 4, si chiede `model: sonnet`.

## Fatto quando
Test: le soglie in token scattano prima della percentuale (18/25/28% su 1M); quelle più alte della percentuale non
cambiano nulla; col monitor spento non succede nulla; la nota arriva durante il turno; lo spawn del validatore ha
`model: sonnet`. Suite verde, validate ok.
