# Shared PTY routing

- `${workspaceId}:${agentName}` is the canonical PTY key.
- Chat, Terminal, Discord, and Schedule must reuse the same PTY stdin/stdout.
- Avoid one-shot headless execution as the primary path when an interactive PTY exists.
