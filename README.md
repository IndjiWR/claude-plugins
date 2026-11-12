# claude-plugins

Skill e mod per Claude Code, pubblicate come un unico marketplace di plugin.

## Installazione

```
/plugin marketplace add IndjiWR/claude-plugins
/plugin install <nome>@indji-plugins
```

## Contenuto

| Plugin | Tipo | Cosa fa |
|---|---|---|
| [auto-clear-context](mods/auto-clear-context) | mod | Handoff validato e `/clear` automatico vicino alle soglie di contesto |
| [prompt-builder](mods/prompt-builder) | mod | Trasforma i prompt lunghi in un brief con intervista e proposte approvate prima che arrivino alla sessione |
| [agent-monitor](mods/agent-monitor) | mod | Pannello live degli agenti e delle sessioni di progetto: stato, token, durata e turni, con allarme di soglia e azioni Transcript/Ferma/attach |

## Struttura

```
.claude-plugin/marketplace.json   elenco dei plugin del marketplace
mods/<nome>/                      mod (hook module, eventuali skill e agent)
skills/<nome>/                    plugin fatti solo di skill
  .claude-plugin/plugin.json
  skills/<nome>/SKILL.md
```

## Aggiungere un plugin

1. Crea la cartella in `skills/` o `mods/` con il suo `.claude-plugin/plugin.json`.
2. Aggiungilo a `.claude-plugin/marketplace.json` e alla tabella qui sopra.
3. `claude plugin validate <cartella>` (e `claude plugin test <cartella>` per le mod) prima del commit.

Licenza: MIT.
