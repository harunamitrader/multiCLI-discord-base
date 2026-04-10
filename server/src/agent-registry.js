import { CodexAdapter } from "./codex-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { GeminiAdapter } from "./gemini-adapter.js";
import { formatUsage } from "./pricing.js";

const MAX_AGENTS = 10;

const STATUS_EMOJI = {
  stopped: "⚪",
  idle: "🟢",
  running: "🟠",
  error: "🔴",
};

/**
 * AgentInstance wraps one named agent with its adapter, session state, and workspace awareness.
 */
class AgentInstance {
  constructor({ name, type, model, config }) {
    this.name = name;
    this.type = type;           // "claude" | "codex" | "gemini"
    this.model = model || "";
    this.status = "idle";       // "stopped" | "idle" | "running" | "error"
    this.lastError = null;
    this._runPromise = null;

    // Session state per workspace: { [workspaceId]: providerSessionRef }
    this._sessionRefs = new Map();
    // Current active workspace
    this._workspaceId = "default";

    const adapterConfig = { ...config, claudeModel: model, geminiModel: model };

    switch (type) {
      case "claude":
        this.adapter = new ClaudeAdapter(adapterConfig);
        break;
      case "gemini":
        this.adapter = new GeminiAdapter(adapterConfig);
        break;
      case "codex":
      default:
        this.adapter = new CodexAdapter(adapterConfig);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Session / workspace management
  // -------------------------------------------------------------------------

  get sessionRef() {
    return this._sessionRefs.get(this._workspaceId) ?? null;
  }

  set sessionRef(ref) {
    if (ref == null) {
      this._sessionRefs.delete(this._workspaceId);
    } else {
      this._sessionRefs.set(this._workspaceId, ref);
    }
  }

  /**
   * Switch to a different workspace.
   * @param {string} workspaceId
   * @param {string|null} providerSessionRef  — saved ref for this workspace
   */
  switchWorkspace(workspaceId, providerSessionRef = null) {
    this._workspaceId = workspaceId;
    if (providerSessionRef != null) {
      this._sessionRefs.set(workspaceId, providerSessionRef);
    }
  }

  /**
   * Restore session refs for all workspaces from Store data.
   * @param {Array<{ workspaceId: string, providerSessionRef: string }>} sessions
   */
  restoreSessions(sessions) {
    for (const s of sessions) {
      if (s.providerSessionRef) {
        this._sessionRefs.set(s.workspaceId, s.providerSessionRef);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Running prompts
  // -------------------------------------------------------------------------

  /**
   * Run a prompt, emitting CanonicalEvents via onCanonicalEvent.
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {string} [opts.workdir]
   * @param {Function} [opts.onCanonicalEvent]
   * @returns {Promise<{ text: string, usage: object, sessionRef: string }>}
   */
  async run({ prompt, workdir, onCanonicalEvent }) {
    if (this.status === "running") {
      throw new Error(`${this.name} は実行中です。\`${this.name} stop?\` でキャンセルしてください。`);
    }

    this.status = "running";
    this.lastError = null;
    const model = this.model || this.adapter.defaultModel || "";

    try {
      this._runPromise = this.adapter.runTurn({
        threadId: this.sessionRef,
        prompt,
        agentName: this.name,
        onCanonicalEvent,
        sessionConfig: { model },
        workdir,
      });

      const result = await this._runPromise;
      const newRef = result.threadId || this.sessionRef;
      this.sessionRef = newRef;
      this.status = "idle";
      return { text: result.text, usage: result.usage || {}, sessionRef: newRef };
    } catch (err) {
      this.status = err.cancelled ? "idle" : "error";
      this.lastError = err.cancelled ? null : err.message;
      throw err;
    } finally {
      this._runPromise = null;
    }
  }

  /** Cancel the running turn. */
  cancel() {
    if (this._runPromise?.cancel) {
      this._runPromise.cancel();
    }
    this.status = "idle";
  }

  /** Reset session for current workspace (forget context). */
  resetSession() {
    this.cancel();
    this.sessionRef = null;
    this.status = "idle";
    this.lastError = null;
  }

  /** Returns a human-readable status line (Discord-friendly). */
  getStatusLine() {
    const emoji = STATUS_EMOJI[this.status] ?? "❓";
    const ref = this.sessionRef ? ` | session: ${this.sessionRef.slice(0, 8)}…` : "";
    const err = this.lastError ? ` | ⚠️ ${this.lastError.slice(0, 60)}` : "";
    const model = this.model || "(default)";
    return `${emoji} **${this.name}** [${this.type} / ${model}] — ${this.status}${ref}${err}`;
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      model: this.model,
      status: this.status,
      sessionRef: this.sessionRef,
      workspaceId: this._workspaceId,
      lastError: this.lastError,
    };
  }
}

/**
 * AgentRegistry manages a pool of named agents.
 *
 * Env vars (case-insensitive name):
 *   AGENT_HANAKO_TYPE=claude
 *   AGENT_HANAKO_MODEL=claude-sonnet-4-6
 *   AGENT_TARO_TYPE=gemini
 *   AGENT_TARO_MODEL=gemini-2.5-flash
 *   AGENT_JIRO_TYPE=codex
 */
export class AgentRegistry {
  constructor(config) {
    this._agents = new Map();
    this._config = config;
    this._activeWorkspaceId = "default";
    this._store = null;  // injected after construction via setStore()
    this._loadFromEnv();
  }

  /** Inject store for session persistence. */
  setStore(store) {
    this._store = store;
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  _loadFromEnv() {
    const prefix = "AGENT_";
    const names = new Set();

    for (const key of Object.keys(process.env)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const underIdx = rest.lastIndexOf("_");
      if (underIdx < 1) continue;
      const name = rest.slice(0, underIdx).toLowerCase();
      names.add(name);
    }

    let count = 0;
    for (const name of names) {
      if (count >= MAX_AGENTS) {
        console.warn(`[agent-registry] max ${MAX_AGENTS} agents reached, skipping "${name}"`);
        break;
      }
      const envPrefix = `AGENT_${name.toUpperCase()}_`;
      const type = (process.env[`${envPrefix}TYPE`] || "codex").toLowerCase();
      const model = process.env[`${envPrefix}MODEL`] || "";
      this._register(name, type, model);
      count++;
    }

    if (this._agents.size === 0) {
      console.log("[agent-registry] no AGENT_* env vars found. Using legacy single-agent mode.");
    } else {
      console.log(`[agent-registry] loaded ${this._agents.size} agent(s): ${[...this._agents.keys()].join(", ")}`);
    }
  }

  _register(name, type, model) {
    const instance = new AgentInstance({ name, type, model, config: this._config });
    this._agents.set(name, instance);

    // Upsert into DB if store is available
    this._store?.upsertAgent({ name, type, model });
  }

  // -------------------------------------------------------------------------
  // Agent access
  // -------------------------------------------------------------------------

  get(name) {
    return this._agents.get(name.toLowerCase()) ?? null;
  }

  names() {
    return [...this._agents.keys()];
  }

  hasAgents() {
    return this._agents.size > 0;
  }

  list() {
    return [...this._agents.values()].map((a) => a.toJSON());
  }

  // -------------------------------------------------------------------------
  // Workspace switching
  // -------------------------------------------------------------------------

  /**
   * Switch all agents to a new workspace.
   * Saves current session refs, loads new workspace refs from DB.
   * @param {string} workspaceId
   */
  async switchWorkspace(workspaceId) {
    if (!this._store) {
      this._activeWorkspaceId = workspaceId;
      for (const agent of this._agents.values()) {
        agent.switchWorkspace(workspaceId);
      }
      return;
    }

    // Save current session refs
    for (const agent of this._agents.values()) {
      if (agent.sessionRef) {
        this._store.upsertAgentSession({
          agentName: agent.name,
          workspaceId: this._activeWorkspaceId,
          providerSessionRef: agent.sessionRef,
          model: agent.model || null,
          lastRunState: agent.status === "idle" ? "completed" : agent.status,
        });
      }
    }

    this._activeWorkspaceId = workspaceId;

    // Load new workspace session refs
    const sessions = this._store.listAgentSessionsByWorkspace(workspaceId);
    const sessionMap = new Map(sessions.map((s) => [s.agentName, s.providerSessionRef]));

    for (const agent of this._agents.values()) {
      agent.switchWorkspace(workspaceId, sessionMap.get(agent.name) ?? null);
    }

    console.log(`[agent-registry] switched to workspace "${workspaceId}"`);
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /** Stop all running agents. */
  stopAll() {
    for (const agent of this._agents.values()) {
      if (agent.status === "running") agent.cancel();
    }
  }

  /** Persist all current session refs to DB. */
  saveAllSessions() {
    if (!this._store) return;
    for (const agent of this._agents.values()) {
      if (agent.sessionRef) {
        this._store.upsertAgentSession({
          agentName: agent.name,
          workspaceId: this._activeWorkspaceId,
          providerSessionRef: agent.sessionRef,
          model: agent.model || null,
          lastRunState: agent.status,
        });
      }
    }
  }

  /** Discord-friendly status list. */
  formatList() {
    if (this._agents.size === 0) {
      return "エージェントが定義されていません。.envに `AGENT_<名前>_TYPE=claude` などを追加してください。";
    }
    const header = `**Agents** (workspace: ${this._activeWorkspaceId})`;
    const lines = [...this._agents.values()].map((a) => a.getStatusLine());
    return [header, ...lines].join("\n");
  }
}

export { formatUsage };
