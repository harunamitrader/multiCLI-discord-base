# CoDiCoDi Handover 2026-04-01

## Summary

- The AI workspace was reorganized around `C:\Users\sgmxk\Desktop\AI`.
- GitHub-linked canonical repositories now live under `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader`.
- The canonical CoDiCoDi repository is now:
  - `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\codicodi`

## Workspace Rules Relevant to CoDiCoDi

- Global workspace rules live at:
  - `C:\Users\sgmxk\Desktop\AI\AGENTS.md`
- Codex global settings live at:
  - `C:\Users\sgmxk\.codex\config.toml`
- Codex trusts the new workspace root:
  - `C:\Users\sgmxk\Desktop\AI`

## Important Path Changes

- Old `projects`-based paths are obsolete.
- CoDiCoDi should be treated as living at:
  - `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\codicodi`
- The desktop shortcut now points to:
  - `C:\Users\sgmxk\Desktop\CoDiCoDi Browser.lnk`
  - target: `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\codicodi\launch-browser.cmd`

## Codex / Bridge Runtime Fix

- The previous launch error was:
  - `Configured CODEX_WORKDIR was not found: C:\Users\sgmxk\Desktop\AI\codex`
- Fixed by updating:
  - `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\codicodi\.env`
- Updated values:
  - `CODEX_WORKDIR=C:\Users\sgmxk\Desktop\AI`
  - `FILE_WATCH_ROOT=C:\Users\sgmxk\Desktop\AI`

## Current Runtime State

- Browser launch now starts the bridge server successfully.
- Confirmed runtime messages included:
  - Discord adapter connected
  - File watcher enabled for `C:\Users\sgmxk\Desktop\AI`
  - Bridge server running at `http://127.0.0.1:3087`
  - base workdir `C:\Users\sgmxk\Desktop\AI`
- Remaining console messages were warnings only:
  - SQLite experimental warning
  - Discord `ready` -> `clientReady` deprecation warning

## Related Workspace Decisions

- `projects` folder was removed after consolidating repositories.
- GitHub repos missing locally were cloned into:
  - `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader`
- Local folder names were aligned to remote repo names:
  - `github-trending-zenn-pages` -> `github_trend`
  - `weekend-monitor` -> `weekend_monitor`

## What To Watch Next

- CoDiCoDi repository still has many existing uncommitted changes unrelated to this handover.
- If future work touches launch or bridge behavior, check:
  - `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\codicodi\.env`
  - `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\codicodi\launch-browser.cmd`
  - `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\codicodi\server\src\config.js`

## Recommended Next Action

- Use `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\codicodi` as the only canonical CoDiCoDi working directory.
- If project-specific AI behavior is needed later, add:
  - `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\codicodi\AGENTS.md`
