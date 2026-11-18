# no-suite-background — spec e piano

Origine: hook `pokefootleague/.claude/hooks/no-suite-background.py` (commit 32ecc99d, 48160b9a), incidenti del
13, 15, 16 e 18/11: una suite finita in background lascia l'agente fermo ad aspettare una notifica che non arriva.

## Cosa fa
Mod (`mods/no-suite-background`), hook `tool.call` su `Bash` (sessione principale, subagent e teammate). Per un
comando pesante, nell'ordine dell'originale, rifiuta:
1. `run_in_background: true`;
2. più di un comando pesante nello stesso Bash;
3. `timeout` assente o sotto `timeoutMinimo` (600000);
4. un comando pesante già in corso nello stesso albero git (PID, età, albero, comando nel motivo), o `maxSullaMacchina`
   comandi pesanti già in corso sulla macchina (si conta solo il processo radice: worker e shell `-c` esclusi).
   Un errore nella lettura dei processi non blocca mai.

## Attivazione e configurazione per progetto
Attiva solo se esiste `<radice del progetto>/.claude/no-suite-background.json` (JSON non valido: inattiva, con
un avviso nel log). Campi, tutti facoltativi:
- `comandi`: sostituisce l'elenco predefinito (`pytest`, `py.test`, `npm test`, `npm run test`, `vitest`,
  `cargo test`, `cargo build`);
- `aggiungi`: comandi in più rispetto all'elenco in vigore;
- `nonContati`: comandi esclusi dal tetto sulla macchina (restano nel controllo dello stesso albero);
- `timeoutMinimo` (600000), `maxSullaMacchina` (3; 0 lo spegne), `controlloProcessi` (true).

## Lettura dei comandi
Tokenizzazione in stile `shlex` POSIX (virgolette singole/doppie, backslash), separatori `; & | ( )` e a capo;
virgolette non chiuse: split grezzo. Un comando semplice è pesante se, tolti i prefissi (`VAR=x`, `env`, `time`,
`nice`, `nohup`, `exec`, `command`, `npx`, `bunx`, `uv|poetry|pipenv|pdm run`, `sh|bash|zsh <script>`,
`python -m X` / `python <script>`, `node <script>`), inizia con un comando dell'elenco (nome base del primo
token, poi parole esatte). Le voci dell'elenco passano dalla stessa normalizzazione (`python -m pkg.mod` vale `pkg.mod`).

## Differenze volute dall'originale
- Elenco configurabile al posto di pytest/suite.sh/footmon.render.gallery fissi (pokefootleague: `comandi`
  = `["pytest","py.test","tools/suite.sh","python -m footmon.render.gallery"]`, `nonContati` = la galleria).
- Un percorso col nome di un comando pesante in posizione d'argomento (`cat .venv/bin/pytest`) non è più pesante.
- Motivi generici (nominano i comandi configurati).
- Riconosce anche `bash -c "…"` (letto dentro), opzioni tra interprete e comando (`python -u -m pytest`,
  `bash -x script`), wrapper con argomenti (`timeout 900`, `sudo`, `xargs`, `nice -n 10`), parole chiave della shell
  (`do`, `then`, `!`, `{`) e salta i commenti `#` (un apostrofo dentro non apre una virgoletta).

## Piano (TDD)
1. Test puri (`tests/logica.test.ts`): tokenizzazione, comandi pesanti, conteggio, processi, età — tutti i casi di
   `test_no_suite_background.sh` (32) con la configurazione di pokefootleague, più i default generici.
2. `hooks/logica.ts` fino al verde.
3. Test della mod (`tests/mod.test.ts`): attivazione per progetto, rifiuti, `ps` simulato via `process.run`.
4. `hooks/register.ts`, manifest, README, marketplace, tabella README; validate + test; review; merge.
