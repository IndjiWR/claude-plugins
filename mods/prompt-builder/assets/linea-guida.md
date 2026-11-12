# Linea guida del brief

## Metodo per taglia
- piccolo: esecuzione diretta e verifica.
- delimitato: design breve in chat, poi TDD.
- progetto: brainstorm, spec, piano, sviluppo subagent-driven con TDD.

## Subagent
- Budget: un massimo di agenti in parallelo; niente subagent se il lavoro si fa con meno di 5 chiamate dirette.
- Un mini-brief autosufficiente per sotto-task: obiettivo, file da leggere e da toccare, vincoli, modello, regola di ricerca degli strumenti.
- Modello: Haiku per esplorare, Sonnet per implementare, Opus solo per revisione o task rischiosi.
- Formato di risposta fisso: `ESITO / FILE TOCCATI / PROBLEMI / PROSSIMO`, al massimo circa 15 righe, niente log.
- Verifica scalata: revisione a due livelli (spec + qualità) solo sui task rischiosi.

## Strumenti
- Cerca skill e plugin utili a inizio sessione e a ogni sotto-task nuovo.

## Token
- Letture mirate dei file; output dei comandi filtrati.

## Git
- Nessun trailer `Co-Authored-By` e nessuna firma "Generated with Claude Code" (preferenza dell'utente).

## Lingua
- Rispondi in italiano, in modo conciso.
