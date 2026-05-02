# Legacy runtime audit

## Goal

Sprint 7 で、workspace-first / PTY-first 実装を主経路としつつ、まだ残している legacy session API を見える化する。

## Current split

### Primary path

- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\server\src\agent-bridge.js`
- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\server\src\pty-service.js`
- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\server\src\discord-adapter.js`
- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\ui\multiCLI-discord-base.html`
- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\ui\multiCLI-discord-base.js`

These surfaces use:

- workspace timeline
- shared PTY key `${workspaceId}:${agentName}`
- `command!` / `agentName? prompt`
- raw `/command` passthrough to the same PTY

### Legacy path still exposed

- `/api/sessions`
- `/api/sessions/:id`
- `/api/sessions/:id/messages`
- `/api/sessions/:id/settings`

These routes remain for compatibility with older bridge/session flows and old UI surfaces.

## Runtime visibility

`C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\server\src\http-server.js` now exposes `GET /api/runtime` with:

- `transportMode: "pty-first"`
- `legacy.sessionApiEnabled`
- `legacy.sessionCount`
- `legacy.routes`

This lets UI and tooling distinguish the primary architecture from compatibility leftovers without guessing from implementation details.

## Migration rule

1. New behavior goes through workspace APIs and `AgentBridge`.
2. Legacy session APIs stay read/compat only unless a bug fix is unavoidable.
3. UI and Discord features should prefer workspace runtime data, not legacy session state.
4. A future removal pass can delete the listed session routes after old UI dependencies are gone.
