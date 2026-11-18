# auto-clear-context: handoff di pausa (senza ripresa automatica)

Incidente 2026-11-18 00:17 (pokefootleague): un handoff scritto per lo spegnimento del PC è stato validato, la mod ha
fatto /clear e ha inviato il prompt di ripresa; la sessione ha ripreso review e suite, poi fermata a mano.

## Comportamento
- Nuovo campo facoltativo nel frontmatter della principale: `mode: pausa`. Assente (o altro valore) = ripresa come oggi.
- Con `mode: pausa` e `status: validated`: stesso percorso di oggi fino al /clear (limite orario, agenti attivi, un solo
  clear per handoff). Dopo il /clear la mod **non** invia il prompt di ripresa.
- L'handoff si archivia subito, al /clear (copia in `archive/`, file in `pending/` svuotato), così resta anche se il
  PC si spegne; il log nomina la copia da cui riprendere.
- Se la sessione resta aperta, il primo prompt dell'utente (non un comando) riceve l'handoff allegato, come dopo un
  /clear a mano.
- Skill handoff: documenta quando usare `mode: pausa` (chiusura, spegnimento, stop chiesto dall'utente).
- Fuori ambito: handoff dei teammate (il rilancio resta com'è).

## Piano (TDD)
1. Test rosso in `tests/fase1.test.ts`: pausa validata → un /clear, nessun prompt `plugin`, handoff archiviato e
   allegato al primo prompt scritto; il test esistente sull'handoff normale resta (ripresa sì).
2. `register.tsx`: campo `mode` in `Handoff`, `clearMode` fissato in `tryClear`, ramo pausa in `session.end`.
3. Skill, README (EN e IT), versione 0.11.0. Suite completa, validate/test del plugin, review, merge.

## Seguito (0.12.0): teammate e doppio /clear
- Teammate: un handoff `agent:` validato con `mode: pausa` non porta al rilancio. Quando il teammate è fermo, la mod
  fa la copia in `archive/`, `TaskStop`, svuota il file e lo toglie dal monitor; nessun prompt al lead.
  La nota di zona ai teammate spiega quando usare `mode: pausa`.
- Doppio /clear: l'handoff di pausa archiviato e non ancora allegato passa anche a un /clear successivo, fino al primo
  prompt scritto.
- TDD: test rossi in `tests/agenti.test.ts` (pausa: TaskStop, nessun rilancio; la nota cita `mode: pausa`) e in
  `tests/fase1.test.ts` (doppio /clear); il test del rilancio normale resta.
