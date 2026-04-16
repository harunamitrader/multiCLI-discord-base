import { CodexAdapter } from "./codex-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { GeminiAdapter } from "./gemini-adapter.js";
import { CopilotAdapter } from "./copilot-adapter.js";
import { formatUsage } from "./pricing.js";

const MAX_AGENTS = 10;
const SUPPORTED_AGENT_TYPES = new Set(["claude", "gemini", "copilot", "codex"]);

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
  constructor({ name, type, model, config, settings = {}, source = "config" }) {
    this.name = name;
    this.type = type;           // "claude" | "codex" | "gemini"
    this.model = model || "";
    this.settings = { ...settings, source };
    this.source = source;
    this.status = "idle";       // "stopped" | "idle" | "running" | "error"
    this.lastError = null;
    this._runPromise = null;

    // Session state per workspace: { [workspaceId]: providerSessionRef }
    this._sessionRefs = new Map();
    // Current active workspace
    this._workspaceId = null;

    const adapterConfig = { ...config, claudeModel: model, geminiModel: model, copilotModel: model };

    switch (type) {
      case "claude":
        this.adapter = new ClaudeAdapter(adapterConfig);
        break;
      case "gemini":
        this.adapter = new GeminiAdapter(adapterConfig);
        break;
      case "copilot":
        this.adapter = new CopilotAdapter(adapterConfig);
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
      settings: { ...this.settings },
      source: this.source,
      editable: true,
      status: this.status,
      sessionRef: this.sessionRef,
      workspaceId: this._workspaceId,
      lastError: this.lastError,
    };
  }

  applyPersistedConfig({ model, settings = {} }) {
    if (model != null) {
      this.model = model;
    }
    this.settings = {
      ...this.settings,
      ...settings,
      source: settings?.source || this.source,
    };
    this.source = this.settings.source || this.source;
  }
}

/**
 * AgentRegistry manages a pool of named agents.
 *
 * Agent definitions are loaded from config\agents.json.
 */
export class AgentRegistry {
  constructor(config) {
    this._agents = new Map();
    this._config = config;
    this._activeWorkspaceId = null;
    this._store = null;  // injected after construction via setStore()
    this._loadConfiguredAgents();
  }

  /** Inject store for session persistence. */
  setStore(store) {
    this._store = store;
    this._activeWorkspaceId = store?.getActiveWorkspace?.()?.id ?? store?.listWorkspaces?.()?.[0]?.id ?? null;
    for (const agent of this._agents.values()) {
      agent.switchWorkspace(this._activeWorkspaceId);
    }
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  _serializeConfiguredAgents() {
    return this.list().map((agent) => ({
      name: agent.name,
      type: agent.type,
      model: agent.model || "",
      settings: {
        ...(agent.settings ?? {}),
      },
    }));
  }

  _persistConfiguredAgents() {
    if (typeof this._config?.saveAgentDefinitions !== "function") {
      return;
    }
    this._config.saveAgentDefinitions(this._serializeConfiguredAgents());
  }

  _loadConfiguredAgents() {
    const definitions = Array.isArray(this._config?.configuredAgents)
      ? this._config.configuredAgents
      : [];

    let count = 0;
    for (const definition of definitions) {
      if (count >= MAX_AGENTS) {
        console.warn(`[agent-registry] max ${MAX_AGENTS} agents reached, skipping "${definition?.name}"`);
        break;
      }
      const name = String(definition?.name || "").trim().toLowerCase();
      const type = String(definition?.type || "").trim().toLowerCase();
      if (!name || !type) {
        continue;
      }
      this._register(name, type, String(definition?.model || "").trim(), {
        settings: {
          ...(definition?.settings ?? {}),
          source: "config",
        },
        source: "config",
      });
      count++;
    }

    if (this._agents.size === 0) {
      console.log("[agent-registry] no configured agents found. Use config\\agents.json or the UI to add agents.");
    } else {
      console.log(`[agent-registry] loaded ${this._agents.size} agent(s): ${[...this._agents.keys()].join(", ")}`);
    }
  }

  _register(name, type, model, { settings = {}, source = "config" } = {}) {
    const instance = new AgentInstance({ name, type, model, config: this._config, settings, source });
    this._agents.set(name, instance);

    // Upsert into DB if store is available
    this._store?.upsertAgent({
      name,
      type,
      model,
      status: "stopped",
      enabled: true,
      settings: {
        ...settings,
        source,
      },
    });
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

  hydrateFromStore() {
    if (!this._store) return;
    const persistedAgents = this._store.listAgents();
    for (const persisted of persistedAgents) {
      const key = persisted.name.toLowerCase();
      const existing = this._agents.get(key);
      if (existing) {
        existing.applyPersistedConfig({
          model: persisted.model,
          settings: persisted.settings,
        });
        continue;
      }
      if (persisted.enabled === false) continue;
      if (!["custom", "config"].includes(persisted.source || persisted.settings?.source || "config")) continue;
      this._register(persisted.name, persisted.type, persisted.model, {
        settings: persisted.settings,
        source: persisted.source || persisted.settings?.source || "config",
      });
    }
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
      if (this._activeWorkspaceId && agent.sessionRef) {
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

    if (!workspaceId) {
      for (const agent of this._agents.values()) {
        agent.switchWorkspace(null, null);
      }
      console.log("[agent-registry] switched to workspace \"none\"");
      return;
    }

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
      return "エージェントが定義されていません。config\\agents.json を作成するか、UI の agent 作成を使ってください。";
    }
    const header = `**Agents** (workspace: ${this._activeWorkspaceId})`;
    const lines = [...this._agents.values()].map((a) => a.getStatusLine());
    return [header, ...lines].join("\n");
  }

  createCustomAgent({ name, type, model, settings = {} }) {
    const normalizedName = String(name || "").trim().toLowerCase();
    const normalizedType = String(type || "").trim().toLowerCase();
    if (!normalizedName) {
      throw new Error("agent name is required");
    }
    if (!SUPPORTED_AGENT_TYPES.has(normalizedType)) {
      throw new Error(`Unsupported agent type: ${normalizedType}`);
    }
    if (this._agents.has(normalizedName)) {
      throw new Error(`agent "${normalizedName}" already exists`);
    }
    if (this._agents.size >= MAX_AGENTS) {
      throw new Error(`最大エージェント数 (${MAX_AGENTS}) に達しています。`);
    }
    const normalizedSettings = {
      ...settings,
      source: "config",
    };
    this._register(normalizedName, normalizedType, model || "", {
      settings: normalizedSettings,
      source: "config",
    });
    this._persistConfiguredAgents();
    return this.get(normalizedName)?.toJSON() ?? null;
  }

  updateAgentConfig(name, patch = {}) {
    const agent = this.get(name);
    if (!agent) {
      throw new Error(`agent "${name}" not found`);
    }
    if (patch.type && String(patch.type).trim().toLowerCase() !== agent.type) {
      throw new Error("CLI type cannot be changed after creation.");
    }
    if (patch.name && String(patch.name).trim().toLowerCase() !== agent.name.toLowerCase()) {
      throw new Error("Agent rename is not supported in this build.");
    }
    if (patch.model != null) {
      agent.model = String(patch.model).trim();
    }
    if (patch.settings) {
      agent.applyPersistedConfig({
        model: agent.model,
        settings: {
          ...agent.settings,
          ...patch.settings,
          source: agent.source,
        },
      });
    }
    if (this._store) {
      this._store.updateAgent(agent.name, {
        model: agent.model,
        enabled: patch.enabled == null ? true : Boolean(patch.enabled),
        settings: {
          ...agent.settings,
          source: agent.source,
        },
      });
    }
    this._persistConfiguredAgents();
    return agent.toJSON();
  }

  deleteAgent(name) {
    const agent = this.get(name);
    if (!agent) {
      throw new Error(`agent "${name}" not found`);
    }
    this._agents.delete(agent.name.toLowerCase());
    this._store?.deleteAgent?.(agent.name);
    this._persistConfiguredAgents();
    return agent.toJSON();
  }
}

export { formatUsage };
