/**
 * PtyService — PTY-first Agent execution core (headless mode)
 *
 * Design:
 *   PTY key = `${workspaceId}:${agentName}`
 *
 * Each sendPrompt() spawns a new headless CLI process with -p "prompt".
 * The process exits naturally when done → no silence heuristics needed.
 * Session continuity: --resume latest (Gemini) / -c (Claude) / -c (Codex)
 *
 * Stdout → Terminal (raw WebSocket) + Chat transcript (ANSI-stripped + EventBus).
 * Process exit → run complete.
 */

import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { stripAnsi } from "./ansi-strip.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Hard limit per run (5 min) to prevent stuck promises */
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

// ── CLI command resolution ────────────────────────────────────────────────────

/**
 * Resolve the absolute path to an npm-installed CLI script.
 * On Windows, npm installs CLIs as:
 *   <npmPrefix>\<name>.cmd  → batch launcher for  <npmPrefix>\node_modules\...\<script>.js
 * We parse the .cmd file to find the actual node script path, then invoke node directly.
 * This avoids spawning via cmd.exe which can cause pipe/signal issues.
 *
 * @param {string} cliName  e.g. "gemini", "claude"
 * @returns {{ nodeExe: string, scriptPath: string } | null}
 */
function resolveNpmCliDirect(cliName) {
  if (process.platform !== "win32") return null; // Unix: just use the CLI name directly

  try {
    // Find the .cmd launcher
    const cmdPath = execSync(`where ${cliName}.cmd 2>nul`, { encoding: "utf8" }).trim().split("\n")[0].trim();
    if (!cmdPath) return null;

    const content = readFileSync(cmdPath, "utf8");

    // Parse: ... "%_prog%" --no-warnings=DEP0040 "path\to\script.js" %*
    const match = content.match(/"(%_prog%|node\.exe?|node)"\s+[^\s]+\s+"([^"]+\.js)"/i);
    if (!match) return null;

    const scriptPath = match[2].replace(/%dp0%/gi, cmdPath.replace(/[^\\]+$/, "")).replace(/\\/g, "\\");
    const nodeExe = process.execPath; // use the same node that runs the server

    return { nodeExe, scriptPath };
  } catch {
    return null;
  }
}

// Cache CLI resolutions
const _cliCache = new Map();
function getCachedCli(cliName) {
  if (!_cliCache.has(cliName)) {
    _cliCache.set(cliName, resolveNpmCliDirect(cliName));
  }
  return _cliCache.get(cliName);
}

/**
 * Returns the OS-appropriate CLI headless command for an agent type.
 * On Windows, invokes node directly (avoids cmd.exe pipe issues).
 *
 * @param {string} agentType
 * @param {string} prompt
 * @param {object} [options]
 * @param {boolean} [options.resume]  — true to resume the most recent session
 * @param {string}  [options.model]   — model override
 * @returns {{ cmd: string, args: string[] }}
 */
function resolveHeadlessCommand(agentType, prompt, options = {}) {
  const { resume = false, model } = options;

  switch (agentType) {
    case "gemini": {
      const cliArgs = ["-p", prompt, "-o", "text", "--screen-reader"];
      if (resume) cliArgs.push("-r", "latest");
      if (model) cliArgs.push("-m", model);
      const direct = getCachedCli("gemini");
      if (direct) return { cmd: direct.nodeExe, args: ["--no-warnings=DEP0040", direct.scriptPath, ...cliArgs] };
      return { cmd: "gemini", args: cliArgs };
    }
    case "claude": {
      const cliArgs = ["-p", prompt, "--output-format", "text"];
      if (resume) cliArgs.push("-c");
      if (model) cliArgs.push("--model", model);
      const direct = getCachedCli("claude");
      if (direct) return { cmd: direct.nodeExe, args: ["--no-warnings=DEP0040", direct.scriptPath, ...cliArgs] };
      return { cmd: "claude", args: cliArgs };
    }
    case "codex":
    default: {
      const cliArgs = ["-p", prompt];
      if (resume) cliArgs.push("-c");
      const direct = getCachedCli("codex");
      if (direct) return { cmd: direct.nodeExe, args: ["--no-warnings=DEP0040", direct.scriptPath, ...cliArgs] };
      return { cmd: "codex", args: cliArgs };
    }
  }
}

/**
 * Returns the interactive CLI command (for Terminal tab manual use).
 * @param {string} agentType
 * @returns {{ cmd: string, args: string[] }}
 */
function resolveInteractiveCommand(agentType) {
  const isWin = process.platform === "win32";
  switch (agentType) {
    case "claude":
      return isWin ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", "claude.cmd"] } : { cmd: "claude", args: [] };
    case "gemini":
      return isWin ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", "gemini.cmd"] } : { cmd: "gemini", args: [] };
    case "codex":
    default:
      return isWin ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", "codex.cmd"] } : { cmd: "codex", args: [] };
  }
}

// ── Run state ─────────────────────────────────────────────────────────────────

function createRunState(agentName, workspaceId) {
  return {
    agentName,
    workspaceId,
    /** "idle" | "running" | "error" */
    status: "idle",
    lastOutputAt: null,
    /**
     * Raw PTY output for the current run.
     * Stripped in bulk at completion for cross-chunk ANSI accuracy.
     */
    rawBuffer: "",
    hardTimeoutTimer: null,
    /** resolve/reject for the sendPrompt() promise */
    pendingResolve: null,
    pendingReject: null,
    runId: null,
    /**
     * Number of completed runs for this key.
     * Used to decide whether to pass --resume / -c flags.
     */
    runCount: 0,
  };
}

// ── PtyService ────────────────────────────────────────────────────────────────

export class PtyService {
  /**
   * @param {{ agentRegistry, config, bus? }} deps
   */
  constructor({ agentRegistry, config, bus }) {
    this.agentRegistry = agentRegistry;
    this.config = config;
    this.bus = bus ?? null;

    /** PTY key → ChildProcess (current running headless process) */
    this._procs = new Map();
    /** PTY key → RunState */
    this._states = new Map();
    /** PTY key → Set<WebSocket> (Terminal tab clients) */
    this._clients = new Map();
    /** PTY key → IPty (persistent interactive terminal, optional) */
    this._termPtys = new Map();
  }

  // ── WebSocket attachment ───────────────────────────────────────────────────

  /**
   * Attach a WebSocket server to the HTTP server.
   * URL format: /api/pty?agent=<name>&workspace=<id>
   * @param {import("node:http").Server} httpServer
   */
  attach(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: "/api/pty" });

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url || "/", "http://localhost");
      const agentName = url.searchParams.get("agent") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "default";

      if (!agentName) {
        ws.close(1008, "agent parameter required");
        return;
      }

      this._handleTerminalClient(ws, agentName, workspaceId);
    });

    console.log("[pty] WebSocket server attached at /api/pty");
  }

  // ── Core API ──────────────────────────────────────────────────────────────

  /**
   * Send a prompt to the agent via a headless CLI process.
   * Resolves when the process exits with the response text.
   *
   * @param {object} opts
   * @param {string} opts.agentName
   * @param {string} opts.workspaceId
   * @param {string} opts.prompt
   * @param {string} [opts.context]    — pre-built context block (recent workspace chat)
   * @param {string} [opts.runId]      — for event correlation
   * @param {string} [opts.workdir]    — working directory override
   * @returns {Promise<{ text: string }>}
   */
  async sendPrompt({ agentName, workspaceId, prompt, context = null, runId = null, workdir }) {
    const key = this._key(agentName, workspaceId);
    const state = this._ensureState(key, agentName, workspaceId);

    // If already running, reject
    if (state.status === "running") {
      throw new Error(`${agentName} は実行中です。停止してから送信してください。`);
    }

    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      throw new Error(`エージェント "${agentName}" が見つかりません。`);
    }

    // Kill any lingering process for this key
    this._killProc(key);

    // Build the full prompt (with context prepended if any)
    const fullPrompt = this._buildPrompt(prompt, context);

    // Resume session on subsequent runs
    const resume = state.runCount > 0;

    const { cmd, args } = resolveHeadlessCommand(agent.type, fullPrompt, {
      resume,
      model: agent.model || undefined,
    });

    const cwd = workdir || this.config.codexWorkdir;

    // Spawn the headless process
    let proc;
    try {
      proc = spawn(cmd, args, {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"], // stdin closed, capture stdout+stderr
      });
    } catch (err) {
      throw new Error(`CLIプロセスを起動できません (${agentName}): ${err.message}`);
    }

    console.log(`[pty] headless spawn for "${agentName}" ws="${workspaceId}" pid=${proc.pid} resume=${resume}`);

    this._procs.set(key, proc);

    // Setup run state
    state.rawBuffer = "";
    state.status = "running";
    state.lastOutputAt = Date.now();
    state.runId = runId;

    this._scheduleHardTimeout(key);

    const resultPromise = new Promise((resolve, reject) => {
      state.pendingResolve = resolve;
      state.pendingReject = reject;
    });

    // Pipe stdout → clients + buffer
    proc.stdout.on("data", (chunk) => {
      const raw = chunk.toString();
      this._handleOutput(key, raw);
    });

    // Pipe stderr → clients only (don't capture in transcript)
    proc.stderr.on("data", (chunk) => {
      const raw = chunk.toString();
      this._broadcastToClients(key, raw);
    });

    proc.on("error", (err) => {
      console.error(`[pty] process error for "${agentName}":`, err.message);
      this._rejectPending(key, err);
      this._procs.delete(key);
    });

    proc.on("close", (code) => {
      console.log(`[pty] "${agentName}" ws="${workspaceId}" exited (code ${code})`);
      this._procs.delete(key);
      this._completeRun(key, "completed");
    });

    return resultPromise;
  }

  // ── PTY control ────────────────────────────────────────────────────────────

  /**
   * Kill the running process for one agent×workspace pair.
   */
  killAgent(agentName, workspaceId) {
    const key = this._key(agentName, workspaceId);
    return this._killProc(key);
  }

  /** Kill all running processes (called on server shutdown). */
  stopAll() {
    for (const key of [...this._procs.keys()]) {
      this._killProc(key);
    }
    // Also kill interactive terminal PTYs
    for (const [key, pty] of this._termPtys) {
      try { pty.kill(); } catch {}
      this._termPtys.delete(key);
    }
  }

  /** Returns the run state for an agent×workspace pair. */
  getAgentTerminalState(agentName, workspaceId) {
    const key = this._key(agentName, workspaceId);
    const state = this._states.get(key);
    if (!state) return { status: "idle", hasProcess: false };
    return {
      status: state.status,
      hasProcess: this._procs.has(key),
      lastOutputAt: state.lastOutputAt,
      runId: state.runId,
    };
  }

  /** Returns true if the agent×workspace is running. */
  isRunning(agentName, workspaceId = "default") {
    const key = this._key(agentName, workspaceId);
    return this._states.get(key)?.status === "running";
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _key(agentName, workspaceId) {
    return `${workspaceId}:${agentName}`;
  }

  _ensureState(key, agentName, workspaceId) {
    if (!this._states.has(key)) {
      this._states.set(key, createRunState(agentName, workspaceId));
    }
    return this._states.get(key);
  }

  _handleOutput(key, rawData) {
    const state = this._states.get(key);
    this._broadcastToClients(key, rawData);

    if (!state || state.status !== "running") return;

    state.lastOutputAt = Date.now();
    state.rawBuffer += rawData;

    // Emit a best-effort stripped delta for real-time Chat UI streaming
    const plain = stripAnsi(rawData);
    if (plain.trim()) {
      this._emit("message.delta", {
        agentName: state.agentName,
        workspaceId: state.workspaceId,
        runId: state.runId,
        content: plain,
      });
    }
  }

  _broadcastToClients(key, rawData) {
    const clients = this._clients.get(key);
    if (!clients) return;
    for (const ws of clients) {
      if (ws.readyState === 1 /* OPEN */) try { ws.send(rawData); } catch {}
    }
  }

  _scheduleHardTimeout(key) {
    const state = this._states.get(key);
    if (!state) return;
    clearTimeout(state.hardTimeoutTimer);
    state.hardTimeoutTimer = setTimeout(() => {
      const s = this._states.get(key);
      if (s?.status === "running") {
        console.warn(`[pty] hard timeout for "${s.agentName}" ws="${s.workspaceId}"`);
        this._killProc(key);
        this._completeRun(key, "timeout");
      }
    }, HARD_TIMEOUT_MS);
  }

  _completeRun(key, finalStatus) {
    const state = this._states.get(key);
    if (!state || !state.pendingResolve) return;

    clearTimeout(state.hardTimeoutTimer);
    state.hardTimeoutTimer = null;

    // Strip ANSI from full buffer (handles cross-chunk sequences correctly)
    const text = this._cleanOutput(stripAnsi(state.rawBuffer));
    state.rawBuffer = "";
    state.status = "idle";
    state.runId = null;
    state.runCount++;

    this._emit("status.change", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      status: "idle",
    });

    this._emit("run.done", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      text,
      finalStatus,
    });

    state.pendingResolve({ text, finalStatus });
    state.pendingResolve = null;
    state.pendingReject = null;
  }

  _rejectPending(key, err) {
    const state = this._states.get(key);
    if (!state) return;
    clearTimeout(state.hardTimeoutTimer);
    state.hardTimeoutTimer = null;
    state.status = "idle";
    if (state.pendingReject) {
      state.pendingReject(err);
      state.pendingResolve = null;
      state.pendingReject = null;
    }
  }

  _killProc(key) {
    const proc = this._procs.get(key);
    if (!proc) return false;
    try { proc.kill("SIGTERM"); } catch {}
    this._procs.delete(key);
    this._rejectPending(key, Object.assign(new Error("PTY killed"), { cancelled: true }));
    return true;
  }

  /**
   * Clean CLI status lines from the response output.
   * Removes known non-content lines output by CLI tools.
   * @param {string} text
   * @returns {string}
   */
  _cleanOutput(text) {
    return text
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        if (!t) return false; // blank lines handled by final trim
        // Gemini: skip credential/status lines
        if (/^Loaded cached credentials\.$/.test(t)) return false;
        if (/^Using session:/.test(t)) return false;
        if (/^Resuming session/.test(t)) return false;
        return true;
      })
      .join("\n")
      .trim();
  }

  // ── Prompt formatting ──────────────────────────────────────────────────────

  /**
   * Build the full prompt string, prepending context if provided.
   * @param {string} prompt
   * @param {string|null} context
   * @returns {string}
   */
  _buildPrompt(prompt, context) {
    if (!context) return prompt;
    return `[Context from recent workspace chat]\n${context}\n\n[User prompt]\n${prompt}`;
  }

  // ── Interactive Terminal (Terminal tab) ───────────────────────────────────

  /**
   * Handle a WebSocket client connecting to the Terminal tab.
   * Opens a persistent interactive CLI session for the agent.
   */
  _handleTerminalClient(ws, agentName, workspaceId) {
    const key = this._key(agentName, workspaceId);
    const clients = this._clients.get(key) ?? new Set();
    clients.add(ws);
    this._clients.set(key, clients);

    // Ensure an interactive PTY is running for this key
    this._ensureInteractivePty(agentName, workspaceId);

    ws.on("message", (raw) => {
      const data = raw.toString();
      // Resize: {"type":"resize","cols":N,"rows":N}
      if (data.startsWith("{")) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "resize" && msg.cols && msg.rows) {
            const pty = this._termPtys.get(key);
            if (pty) pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
            return;
          }
        } catch {}
      }
      // Forward keyboard input to interactive PTY
      const pty = this._termPtys.get(key);
      if (pty) try { pty.write(data); } catch {}
    });

    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  }

  /**
   * Ensure an interactive PTY session exists for the Terminal tab.
   * This is separate from the headless process used by sendPrompt().
   */
  async _ensureInteractivePty(agentName, workspaceId) {
    const key = this._key(agentName, workspaceId);
    if (this._termPtys.has(key)) return;

    const agent = this.agentRegistry.get(agentName);
    if (!agent) return;

    try {
      const { default: pty } = await import("node-pty");
      const { cmd, args } = resolveInteractiveCommand(agent.type);
      const cwd = this.config.codexWorkdir;

      const ptyProc = pty.spawn(cmd, args, {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd,
        env: { ...process.env, TERM: "xterm-256color" },
      });

      this._termPtys.set(key, ptyProc);

      ptyProc.onData((data) => this._broadcastToClients(key, data));

      ptyProc.onExit(() => {
        this._termPtys.delete(key);
        // Clients will auto-reconnect or we leave them connected
      });

      console.log(`[pty] interactive terminal started for "${agentName}" ws="${workspaceId}" pid=${ptyProc.pid}`);
    } catch (err) {
      console.error(`[pty] failed to start interactive terminal for "${agentName}":`, err.message);
    }
  }

  // ── EventBus ──────────────────────────────────────────────────────────────

  _emit(type, payload) {
    this.bus?.publish?.(type, { type, ...payload });
  }
}
