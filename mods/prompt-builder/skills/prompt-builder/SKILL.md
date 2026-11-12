---
name: prompt-builder
description: Trasforma una richiesta in un brief strutturato (obiettivo, criteri, metodo, vincoli, contesto, verifica). Usa quando l'utente chiede un brief o di strutturare/riscrivere un prompt, o quando la mod prompt-builder non è riuscita a comporlo.
---

# Prompt builder (ripiego)

Usa questa skill quando la mod prompt-builder non ha potuto comporre il brief, oppure quando l'utente chiede esplicitamente un brief per una richiesta.

## Procedura

1. Leggi le linee guida, se esistono: `~/.claude/prompt-builder/linea-guida.md` (globale) e `.claude/prompt-builder.md` (di progetto, che prevale). Se mancano, prosegui senza.
2. Individua le lacune: obiettivo, criteri "Fatto quando", taglia e metodo, vincoli, contesto, strumenti, verifica, fuori ambito. Fai al massimo 5 domande con AskUserQuestion (ogni domanda costa tempo e attenzione all'utente), e solo sulle lacune reali; non chiedere ciò che è già chiaro dal prompt o dalle linee guida.
3. Proponi fino a 8 aggiunte utili (di più disperde l'attenzione dell'utente) in una sola domanda a scelta multipla, così l'utente approva solo quelle che vuole.
4. Scrivi il brief seguendo il template `${CLAUDE_PLUGIN_ROOT}/assets/brief-template.md`. Il brief è al massimo di 6.000 caratteri.
5. Nessun fatto inventato: percorsi, comandi e stato del codice solo da prompt, risposte, linee guida o CLAUDE.md. Ciò che manca va in "Domande aperte".
6. Procedi col lavoro secondo il brief approvato.
