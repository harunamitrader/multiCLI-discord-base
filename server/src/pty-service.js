/**
 * PtyService — node-pty を使ったエージェント別ターミナル管理
 *
 * WebSocket (/api/pty?agent=<name>) で接続し、xterm.js と双方向通信する。
 * エージェントごとに PTY プロセスを 1 つ保持。複数クライアントが同一 PTY を共有できる。
 */

import pty from "node-pty";
import { WebSocketServer } from "ws";

/**
 * エージェント type に応じた PTY 起動コマンドを返す。
 * Windows では cmd.exe 経由で .cmd ラッパーを呼ぶ。
 */
function resolveCliCommand(type) {
  const isWin = process.platform === "win32";
  switch (type) {
    case "claude":
      return isWin
        ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", "claude.cmd"] }
        : { cmd: "claude", args: [] };
    case "gemini":
      return isWin
        ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", "gemini.cmd"] }
        : { cmd: "gemini", args: [] };
    case "codex":
    default:
      return isWin
        ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", "codex.cmd"] }
        : { cmd: "codex", args: [] };
  }
}

export class PtyService {
  /**
   * @param {{ agentRegistry, config }} deps
   */
  constructor({ agentRegistry, config }) {
    this.agentRegistry = agentRegistry;
    this.config = config;

    // agentName → pty.IPty
    this._ptys = new Map();
    // agentName → Set<WebSocket>
    this._clients = new Map();
  }

  /**
   * WebSocket サーバーを既存の HTTP サーバーにアタッチ。
   * @param {import("node:http").Server} httpServer
   */
  attach(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: "/api/pty" });

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url || "/", "http://localhost");
      const agentName = url.searchParams.get("agent") ?? "";

      if (!agentName) {
        ws.close(1008, "agent parameter required");
        return;
      }

      this._handleClient(ws, agentName);
    });

    console.log("[pty] WebSocket server attached at /api/pty");
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  _spawnPty(agentName) {
    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      console.warn(`[pty] agent "${agentName}" not found, cannot spawn PTY`);
      return null;
    }

    const workdir = this.config.codexWorkdir;
    const { cmd, args } = resolveCliCommand(agent.type);

    let ptyProc;
    try {
      ptyProc = pty.spawn(cmd, args, {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd: workdir,
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (err) {
      console.error(`[pty] Failed to spawn PTY for "${agentName}":`, err.message);
      return null;
    }

    console.log(`[pty] spawned ${cmd} for agent "${agentName}" (pid ${ptyProc.pid})`);

    this._ptys.set(agentName, ptyProc);
    if (!this._clients.has(agentName)) {
      this._clients.set(agentName, new Set());
    }

    // Broadcast PTY output to all connected clients
    ptyProc.onData((data) => {
      const clients = this._clients.get(agentName);
      if (!clients) return;
      for (const ws of clients) {
        if (ws.readyState === 1 /* OPEN */) {
          try { ws.send(data); } catch {}
        }
      }
    });

    ptyProc.onExit(({ exitCode }) => {
      console.log(`[pty] agent "${agentName}" exited (code ${exitCode})`);
      this._ptys.delete(agentName);

      const clients = this._clients.get(agentName);
      if (clients) {
        for (const ws of clients) {
          try { ws.close(1001, "PTY process exited"); } catch {}
        }
        this._clients.delete(agentName);
      }
    });

    return ptyProc;
  }

  _handleClient(ws, agentName) {
    // Reuse existing PTY or spawn a new one
    let ptyProc = this._ptys.get(agentName);
    if (!ptyProc) {
      ptyProc = this._spawnPty(agentName);
    }

    if (!ptyProc) {
      ws.close(1011, "Failed to start terminal");
      return;
    }

    const clients = this._clients.get(agentName) ?? new Set();
    clients.add(ws);
    this._clients.set(agentName, clients);

    ws.on("message", (raw) => {
      const data = raw.toString();
      // Check for resize control message: {"type":"resize","cols":N,"rows":N}
      if (data.startsWith("{")) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "resize" && msg.cols && msg.rows) {
            ptyProc.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
            return;
          }
        } catch {
          // Not JSON — fall through to write
        }
      }
      try { ptyProc.write(data); } catch {}
    });

    ws.on("close", () => {
      clients.delete(ws);
      // If no more clients, leave PTY running (background process persists)
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  }

  // ---------------------------------------------------------------------------
  // Public control
  // ---------------------------------------------------------------------------

  /** Kill PTY for one agent (e.g. on explicit stop). */
  killAgent(agentName) {
    const ptyProc = this._ptys.get(agentName);
    if (!ptyProc) return false;
    try { ptyProc.kill(); } catch {}
    this._ptys.delete(agentName);
    return true;
  }

  /** Kill all PTYs on shutdown. */
  stopAll() {
    for (const [name] of [...this._ptys]) {
      this.killAgent(name);
    }
  }

  /** Returns true if the agent has an active PTY. */
  isRunning(agentName) {
    return this._ptys.has(agentName);
  }
}
