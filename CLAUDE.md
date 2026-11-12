# claude-plugins

Marketplace di plugin per Claude Code: `skills/` (solo skill) e `mods/` (hook module).

- Ogni plugin nuovo va registrato in `.claude-plugin/marketplace.json` e nella tabella del README.
- Prima di ogni commit: `claude plugin validate <cartella plugin>`; per le mod anche `claude plugin test <cartella plugin>`.
- Alza la `version` in `plugin.json` a ogni modifica rilasciata.
- Testi delle skill e degli agent in italiano; descrizioni concise (contano nei token di ogni sessione).
