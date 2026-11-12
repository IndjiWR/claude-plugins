# prompt-builder

Mod per Claude Code: prima che un prompt lungo arrivi alla sessione, lo trasforma in un brief chiaro. Fa qualche domanda sulle lacune, propone aggiunte che tu approvi, poi invia il brief al posto del testo originale.

## Cosa fa

- Intercetta solo i prompt che scrivi tu nel composer.
- Scatta quando il prompt ha almeno **400 caratteri**, almeno **2 segnali** di lavoro strutturato (verbo d'azione, elenco, più requisiti, percorsi, parole di progetto) e al massimo il **60%** di codice o log incollato.
- Non tocca i comandi slash né i prompt che iniziano con `!raw <testo>`: passano così come sono. Usa `!raw` quando vuoi inviare un testo lungo senza brief.
- Sotto la soglia il prompt passa senza modifiche.

## Flusso

1. Il modello analizza il prompt e individua le lacune.
2. Intervista: al massimo 5 domande, solo sulle lacune reali.
3. Proposte: fino a 8 aggiunte, approvabili in una domanda a scelta multipla.
4. Il brief viene composto (obiettivo, Fatto quando, taglia e metodo, vincoli, contesto, verifica, fuori ambito) e inviato alla sessione.
5. L'originale resta salvato in `.claude/prompt-builder/last.md`.

Se un passaggio fallisce (timeout, risposta non valida), il prompt originale viene inviato comunque, con una nota che rimanda alla skill di ripiego.

## Comando `/prompt-builder`

- `/prompt-builder <testo>` esegue il brief su richiesta, senza conferma.
- `/prompt-builder` senza testo mostra il messaggio d'uso.

## Linee guida

Il brief segue le regole che scrivi in:

- `~/.claude/prompt-builder/linea-guida.md`: globale, creata alla prima esecuzione dal modello di default.
- `.claude/prompt-builder.md`: di progetto, ha la precedenza.

Se nessuno dei due esiste, vengono usati i primi ~3000 caratteri di `CLAUDE.md`.

## Opzioni (`/config`)

| Opzione | Default | Significato |
|---|---|---|
| `enabled` | `true` | Attiva o disattiva la mod |
| `minChars` | `400` | Lunghezza minima del prompt per il brief |
| `minSignals` | `2` | Segnali minimi di lavoro strutturato |
| `model` | `sonnet` | Modello per intervista e stesura del brief |
| `maxQuestions` | `5` | Domande massime, da 0 a 8 (0 salta l'intervista) |

## Ripiego: skill `prompt-builder:prompt-builder`

La mod include una skill che esegue lo stesso lavoro dentro la sessione. Viene usata quando la composizione automatica non riesce, oppure quando chiedi un brief a mano. Segue le stesse linee guida e non inventa fatti: ciò che manca va in "Domande aperte".

## Installazione

```
/plugin install prompt-builder@indji-plugins
```

## Licenza

MIT, come il resto del repo.
