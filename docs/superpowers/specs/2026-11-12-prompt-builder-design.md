# prompt-builder: design

Data: 2026-11-12 · Stato: in revisione · Repo: `IndjiWR/claude-plugins`, cartella `mods/prompt-builder/`

## 1. Scopo

Prima che un prompt lungo e complesso arrivi alla sessione, trasformarlo in un **brief** chiaro (obiettivo, criteri di completamento, metodo, vincoli, contesto, piano subagent, verifica), così il lavoro che segue parte senza ambiguità e consuma meno token.

**Criterio di successo:** la sessione che riceve il brief non ha bisogno di chiedere chiarimenti a metà lavoro, e il lavoro con subagent non spreca token in riesplorazioni o resoconti lunghi.

**Requisiti dell'utente (dal brainstorm):**
- Si attiva con `/prompt-builder` o automaticamente su prompt lunghi e complessi.
- Linea guida fissa delle preferenze **più** intervista mirata solo su ciò che la linea guida non può dedurre.
- Ottimizzazione dei consumi come requisito primario, soprattutto nel lavoro subagent-driven.
- Rilevamento automatico con regole fisse (zero token); conferma prima di partire; prefisso `!raw` per saltarlo.
- Scatta solo sui prompt scritti dall'utente, mai su messaggi tra sessioni, subagent o plugin.
- Metodo di sviluppo scalato sulla taglia del lavoro.
- Linea guida globale più aggiunte per progetto.
- Skill e plugin non elencati a priori: il brief impone di valutarli a inizio sessione e a ogni sotto-task nuovo.
- Il brief può essere arricchito da proposte del modello (dimenticanze, miglioramenti) approvate dall'utente.

## 2. Architettura

Una mod (hook module), perché solo una mod può intercettare un prompt prima dell'invio e lavorare fuori dal contesto della sessione.

```
mods/prompt-builder/
  .claude-plugin/plugin.json      manifest, userConfig
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              filtro, flusso, comando
  hooks/trigger.ts                regole di rilevamento (funzioni pure)
  hooks/prompts.ts                testi delle chiamate al modello
  assets/linea-guida.md           linea guida predefinita
  assets/brief-template.md        struttura del brief
  skills/prompt-builder/SKILL.md  ripiego: lo stesso processo nella sessione principale
  tests/*.test.ts                 kit claude-code/testing
  README.md
```

API usate (verificate su Claude Code 2.1.322): `on('prompt.submit')` con `next({ ...e, text })`, `e.origin.kind`, `$.ui.ask` (2-4 opzioni, `multiSelect`, "Other" a testo libero, rifiuta se chiuso), `$.model.complete` (modello per alias, blocchi `{ text, cache: true }`, `timeoutMs`, `usage`), `$.command.register` + `command.run`, `$.fs`, `$.ui.log`.

## 3. Flusso

1. **Filtro** (hook `prompt.submit`). Il prompt passa intatto se:
   - `origin.kind !== 'composer'` (esclusi `peer`, `peer-send-message`, `plugin`, `scheduled-trigger`, `task-notification`, `coordinator`, `channel`, `bridge`, `sdk` e gli altri);
   - `e.command` è presente (comando slash);
   - `enabled` è falso;
   - non supera le regole di rilevamento (§4).

   Se il testo inizia con `!raw`, il prefisso viene tolto e il resto passa intatto.
2. **Conferma:** `$.ui.ask("Ottimizzo il prompt?", ["Sì", "No, invia così"])`.
3. **Analisi:** una chiamata `$.model.complete`. Il prompt è composto da:
   - `[linea guida globale + progetto]` (cache);
   - istruzioni di analisi;
   - il prompt dell'utente.

   Uscita JSON:
   ```json
   { "taglia": "piccolo|delimitato|progetto",
     "lacune": ["..."],
     "domande": [{ "testo": "...?", "opzioni": ["...", "..."], "header": "..." }],
     "proposte": [{ "testo": "...", "motivo": "...", "sezione": "Fatto quando|Verifica|Vincoli|..." }] }
   ```
   Al massimo `maxQuestions` domande e 8 proposte.
4. **Intervista:** un `$.ui.ask` per domanda, con 2-4 opzioni più "Other". Una domanda chiusa senza risposta va in "Domande aperte".
5. **Proposte:** `$.ui.ask` a scelta multipla, "Quali proposte aggiungo al brief?", 4 per finestra (fino a 2 finestre). Il testo libero in "Other" è un'aggiunta dell'utente. Le proposte scartate non entrano nel brief.
6. **Composizione:** seconda `$.model.complete` (stesso prefisso in cache). Input: il prompt, le risposte, le proposte approvate, il template. Uscita: il brief in markdown (§5).
7. **Anteprima:** riepilogo di 3-5 righe (taglia, sezioni, numero di sotto-task) e `$.ui.ask` con *Invia* / *Invia l'originale*.
8. **Invio:** `next({ ...e, text: brief })`. Il prompt originale viene salvato in `.claude/prompt-builder/last.md`, e la cartella viene aggiunta a `.git/info/exclude` se il progetto è un repo git.

`/prompt-builder [testo]` esegue i passi 3-8 sul testo dato, senza filtro né conferma. Senza testo, lo chiede con `$.ui.ask`.

## 4. Regole di rilevamento (zero token)

Il prompt è candidato se valgono tutte e tre:
- `text.length >= minChars` (default 400);
- almeno `minSignals` (default 2) tra:
  - verbo d'azione (implementa, crea, costruisci, aggiungi, refactor, migra, integra, progetta, sviluppa, correggi e gli equivalenti inglesi);
  - elenco puntato o numerato;
  - più requisiti ("e poi", "inoltre", "deve", "also", "must");
  - percorsi o nomi di file;
  - parole di progetto ("progetto", "feature", "app", "sistema");
- i blocchi di codice, recintati o indentati, e le righe di log non superano il 60% del testo.

Le regole sono funzioni pure in `trigger.ts`, testate a parte.

## 5. Il brief

In italiano, obiettivo 400-1.200 token, massimo 6.000 caratteri (se lo supera, una sola richiesta di accorciarlo).

```markdown
# Brief: <titolo>
## Obiettivo            cosa e perché, 2-4 righe
## Fatto quando         criteri verificabili
## Taglia e metodo      piccolo | delimitato | progetto → flusso da seguire
## Vincoli              dell'utente parola per parola + pertinenti della linea guida
## Contesto             percorsi e documenti (riferimenti, non contenuti)
## Strumenti            valuta skill e plugin disponibili ora e a ogni sotto-task nuovo
## Piano subagent       solo per taglia "progetto" o lavori paralleli
## Verifica             comandi di test e build ed esito atteso
## Fuori ambito         cosa non fare
## Domande aperte       solo se ne restano
---
Prompt originale: .claude/prompt-builder/last.md
```

**Metodo per taglia:**
- **piccolo:** esecuzione diretta e verifica;
- **delimitato:** design breve in chat, poi TDD;
- **progetto:** brainstorm, spec, piano, sviluppo subagent-driven con TDD.

**Piano subagent:**
- **budget:** un massimo di agenti in parallelo; niente subagent se il lavoro si fa con meno di 5 chiamate dirette;
- **un mini-brief per sotto-task**, autosufficiente:
  - obiettivo;
  - file da leggere e da toccare;
  - vincoli;
  - modello: Haiku per esplorare, Sonnet per implementare, Opus solo per revisione o task rischiosi;
  - regola di ricerca degli strumenti;
- **formato di risposta fisso:** `ESITO / FILE TOCCATI / PROBLEMI / PROSSIMO`, al massimo circa 15 righe, niente log;
- **verifica scalata:** revisione a due livelli (spec + qualità) solo sui task rischiosi.

**Regole di composizione:**
- Nessun fatto inventato: percorsi, comandi e stato del codice vengono solo dal prompt, dall'intervista, dalla linea guida o dal `CLAUDE.md`. Ciò che manca va in "Domande aperte".
- Le proposte approvate entrano come requisiti nella sezione indicata.

## 6. Linea guida

- **Globale:** `~/.claude/prompt-builder/linea-guida.md`, creata da `assets/linea-guida.md` al primo uso se manca.
- **Progetto:** `.claude/prompt-builder.md` nella root del progetto. Viene aggiunta dopo la globale e vince sui conflitti.
- **Senza file di progetto:** si usano le prime ~3.000 battute del `CLAUDE.md` del progetto, se esiste.

**Contenuto predefinito della linea guida globale:**
- metodo scalato sulla taglia;
- le cinque regole sui subagent (§5);
- ricerca di skill e plugin a inizio sessione e sui sotto-task nuovi;
- ottimizzazione dei token: letture mirate, output filtrati;
- nessun trailer `Co-Authored-By` né firma "Generated with Claude Code";
- risposte in italiano e concise.

## 7. Configurazione (`userConfig`)

| Chiave | Tipo | Default | Note |
|---|---|---|---|
| `enabled` | boolean | true | spegne solo l'hook automatico; `/prompt-builder` resta attivo |
| `minChars` | number | 400 | |
| `minSignals` | number | 2 | |
| `model` | string | `sonnet` | alias o id, per analisi e composizione |
| `maxQuestions` | number | 5 | da 0 a 8 |

## 8. Errori

Principio: il prompt dell'utente non va mai perso.

| Caso | Comportamento |
|---|---|
| Conferma o anteprima chiuse | invia l'originale |
| Domanda chiusa | la domanda va in "Domande aperte" e si prosegue |
| `api-error`, `empty-reply`, `aborted` (`timeoutMs` 60.000) | invia l'originale con `context` che chiede di usare la skill `prompt-builder:prompt-builder` |
| JSON dell'analisi non valido | un tentativo con istruzioni più rigide, poi il ripiego |
| Linea guida globale assente | creata dalla predefinita, con una riga di log |
| Nessuno a cui chiedere (`$.ui.ask` rifiuta, `-p`/SDK) | invia l'originale senza modifiche |
| Brief oltre 6.000 caratteri | una richiesta di accorciarlo, poi lo invia com'è |

**Log:** una riga per brief (taglia, domande, proposte accettate/totali, token in ingresso/uscita/cache dai `usage`).

## 9. Test (`claude plugin test`)

- **Filtro:** ogni origine diversa da `composer` passa intatta; comandi slash e `!raw` passano; prompt sotto soglia e prevalentemente incollati passano; prompt sopra soglia scattano.
- **Flusso completo,** con modello e finestre simulati: conferma, analisi, intervista, proposte (accettate e scartate), composizione, anteprima, brief che sostituisce il testo, `last.md` scritto.
- **Ripieghi:** errore API, JSON non valido poi valido, JSON non valido due volte, finestre chiuse, brief troppo lungo.
- **Linee guida:** solo globale; globale + progetto; globale + `CLAUDE.md`; globale assente e creata.
- **Convivenza con auto-clear-context:** un prompt con `origin.kind: 'plugin'` non viene mai intercettato.
- **Comando:** `/prompt-builder testo` esegue il flusso senza conferma.

## 10. Rilascio

- Versione 0.1.0.
- Voce in `.claude-plugin/marketplace.json` e nella tabella del README del repo; README della mod in italiano.
- `claude plugin validate` e `claude plugin test` puliti prima del commit.
- Nessun trailer `Co-Authored-By`.

## 11. Fuori ambito (v0.1)

- Classificatore con modello per il rilevamento (si potrà aggiungere più avanti).
- Uso di `$.model.fork` per leggere il contesto della conversazione in corso.
- Pannello o UI dedicata oltre alle finestre di domanda.
- Statistiche dei consumi aggregate su più sessioni.
