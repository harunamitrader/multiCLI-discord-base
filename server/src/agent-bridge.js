/**
 * AgentBridge — multicodi マルチエージェント実行レイヤー
 *
 * PTY-first 設計 (Phase A):
 *   runPrompt() → DB 保存 → PtyService.sendPrompt() → PTY stdin
 *                ← PtyService 完了時に DB 保存 / SSE / Discord へ反映
 *
 * PTY key: workspaceId:agentName (PtyService 側で管理)
 */

import { calcCost } from "./pricing.js";

/** Cost period → ISO datetime */
function periodToSince(period) {
  if (!period || period === "all") return null;
  const d = new Date();
  if (period === "today") d.setHours(0, 0, 0, 0);
  else if (period === "week") d.setDate(d.getDate() - 7);
  else if (period === "month") d.setDate(d.getDate() - 30);
  else return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Format workspace messages as a context block for PTY input. */
function buildContextBlock(messages) {
  if (!messages || messages.length === 0) return null;
  const lines = messages.map((m) => {
    const speaker =
      m.role === "user"
        ? `You -> ${m.agentName}`
        : `${m.agentName}`;
    const body = (m.content || "").slice(0, 400); // truncate per message
    return `${speaker}: ${body}`;
  });
  return lines.join("\n");
}

export class AgentBridge {
  /**
   * @param {{ agentRegistry, store, bus, config, ptyService? }} deps
   */
  constructor({ agentRegistry, store, bus, config, ptyService }) {
    this.agentRegistry = agentRegistry;
    this.store = store;
    this.bus = bus;
    this.config = config;
    this.ptyService = ptyService ?? null;

    agentRegistry.setStore(store);
    this._syncAgentsToDb();
  }

  _syncAgentsToDb() {
    for (const { name, type, model } of this.agentRegistry.list()) {
      this.store.upsertAgent({ name, type, model });
    }
  }

  // ---------------------------------------------------------------------------
  // Main entry point (PTY-first)
  // ---------------------------------------------------------------------------

  /**
   * Run a prompt against a named agent via PTY.
   *
   * @param {object} opts
   * @param {string} opts.agentName
   * @param {string} opts.prompt
   * @param {string} [opts.workspaceId]
   * @param {string} [opts.workdir]
   * @param {string} [opts.source]          "discord" | "ui" | "schedule"
   * @param {string} [opts.discordMessageId]
   * @param {Function} [opts.onProgress]    called with CanonicalEvents (for Discord live updates)
   * @returns {Promise<{ text: string }>}
   */
  async runPrompt({
    agentName,
    prompt,
    workspaceId = "default",
    workdir,
    source = "ui",
    discordMessageId,
    onProgress,
  }) {
    if (!this.ptyService) {
      throw new Error("PtyService が初期化されていません。");
    }

    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      throw new Error(
        `エージェント "${agentName}" が見つかりません。\`agents?\` で確認してください。`
      );
    }

    // 1. Start run record in DB
    const run = this.store.startRun({ agentName, workspaceId, prompt, source });

    // 2. Save user message
    this.store.addMessage({
      agentName,
      workspaceId,
      runId: run.id,
      role: "user",
      content: prompt,
      source,
    });

    // 3. Emit user events to EventBus
    this._emit({ type: "message.user", agentName, content: prompt, source, runId: run.id, workspaceId });
    this._emit({ type: "status.change", agentName, status: "running", workspaceId, runId: run.id });

    // 4. Build context from recent workspace messages (excluding the message just added)
    const recentMessages = this.store.listWorkspaceMessages(workspaceId, 21)
      .filter((m) => !(m.role === "user" && m.runId === run.id)); // exclude current user msg
    const context = buildContextBlock(recentMessages.slice(-20));

    try {
      // 5. Send via PTY — waits until heuristic completion (5s silence)
      const result = await this.ptyService.sendPrompt({
        agentName,
        workspaceId,
        prompt,
        context,
        runId: run.id,
        workdir,
      });

      const text = result.text ?? "";

      // 6. Finalize run
      this.store.completeRun(run.id, { status: "completed" });

      // 7. Save assistant message
      if (text) {
        this.store.addMessage({
          agentName,
          workspaceId,
          runId: run.id,
          role: "assistant",
          content: text,
          source: "agent",
        });
      }

      this._emit({ type: "message.done", agentName, content: text, runId: run.id, workspaceId });
      this._emit({ type: "status.change", agentName, status: "idle", workspaceId });

      return { text };
    } catch (err) {
      const cancelled = Boolean(err.cancelled);

      this.store.completeRun(run.id, { status: cancelled ? "cancelled" : "error" });

      this._emit({
        type: "run.error",
        agentName,
        message: err.message,
        cancelled,
        runId: run.id,
        workspaceId,
      });
      this._emit({
        type: "status.change",
        agentName,
        status: cancelled ? "idle" : "error",
        workspaceId,
      });

      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Agent control
  // ---------------------------------------------------------------------------

  cancelAgent(agentName, workspaceId = "default") {
    // With PTY-first, "cancel" means killing the PTY for this agent×workspace
    const killed = this.ptyService?.killAgent(agentName, workspaceId) ?? false;
    // Also cancel any in-flight adapter run (legacy fallback)
    const agent = this.agentRegistry.get(agentName);
    if (agent) agent.cancel?.();
    this._emit({ type: "status.change", agentName, status: "idle", workspaceId });
    return killed;
  }

  resetAgentSession(agentName, workspaceId = "default") {
    // Kill PTY → next sendPrompt will spawn a fresh CLI session
    this.ptyService?.killAgent(agentName, workspaceId);
    const agent = this.agentRegistry.get(agentName);
    if (!agent) return false;
    agent.resetSession?.();
    this.store.upsertAgentSession({
      agentName,
      workspaceId,
      providerSessionRef: null,
      lastRunState: "idle",
    });
    this._emit({ type: "status.change", agentName, status: "idle", workspaceId });
    return true;
  }

  stopAll() {
    this.ptyService?.stopAll();
    this.agentRegistry.stopAll();
  }

  // ---------------------------------------------------------------------------
  // Workspace
  // ---------------------------------------------------------------------------

  async switchWorkspace(workspaceId) {
    const running = this.agentRegistry.list().filter((a) => a.status === "running");
    if (running.length > 0) {
      throw new Error(
        `実行中のエージェントがあります: ${running.map((a) => a.name).join(", ")}。停止してから切り替えてください。`
      );
    }
    await this.agentRegistry.switchWorkspace(workspaceId);
    this.store.setActiveWorkspace(workspaceId);
    this._emit({ type: "workspace.switched", workspaceId });
  }

  getActiveWorkspace() {
    return this.store.getActiveWorkspace();
  }

  listWorkspaces() {
    return this.store.listWorkspaces();
  }

  createWorkspace({ name, workdir, parentAgent }) {
    const ws = this.store.createWorkspace({ name, workdir });
    // Register parent agent membership
    if (parentAgent && ws) {
      this.store.addWorkspaceAgent({ workspaceId: ws.id, agentName: parentAgent, isParent: true });
    }
    return ws;
  }

  deleteWorkspace(id) {
    if (id === "default") throw new Error("default ワークスペースは削除できません。");
    const running = this.agentRegistry.list().filter((a) => a.status === "running");
    if (running.length > 0) {
      throw new Error("実行中のエージェントがあります。停止してから削除してください。");
    }
    return this.store.deleteWorkspace(id);
  }

  renameWorkspace(id, name) {
    return this.store.updateWorkspace(id, { name });
  }

  // ---------------------------------------------------------------------------
  // Workspace agent membership
  // ---------------------------------------------------------------------------

  listWorkspaceAgents(workspaceId) {
    return this.store.listWorkspaceAgents(workspaceId);
  }

  addWorkspaceAgent({ workspaceId, agentName }) {
    const MAX_WORKSPACE_AGENTS = 4;
    const count = this.store.countWorkspaceAgents(workspaceId);
    if (count >= MAX_WORKSPACE_AGENTS) {
      throw new Error(`workspace あたりの最大エージェント数 (${MAX_WORKSPACE_AGENTS}) に達しています。`);
    }
    return this.store.addWorkspaceAgent({ workspaceId, agentName, isParent: false });
  }

  removeWorkspaceAgent({ workspaceId, agentName }) {
    return this.store.removeWorkspaceAgent({ workspaceId, agentName });
  }

  getWorkspaceParentAgent(workspaceId) {
    return this.store.getWorkspaceParentAgent(workspaceId);
  }

  // ---------------------------------------------------------------------------
  // Info
  // ---------------------------------------------------------------------------

  listAgents() {
    return this.agentRegistry.list();
  }

  getAgent(name) {
    const a = this.agentRegistry.get(name);
    return a ? a.toJSON() : null;
  }

  listMessages(agentName, workspaceId = "default", limit = 100) {
    return this.store.listMessages(agentName, workspaceId, limit);
  }

  listWorkspaceMessages(workspaceId = "default", limit = 100) {
    return this.store.listWorkspaceMessages(workspaceId, limit);
  }

  listRuns(agentName, workspaceId = "default", limit = 20) {
    return this.store.listRuns(agentName, workspaceId, limit);
  }

  getCostSummary({ agentName, workspaceId, period = "all" } = {}) {
    const since = periodToSince(period);
    return this.store.getCostSummary({ agentName, workspaceId, since });
  }

  // ---------------------------------------------------------------------------
  // Discord channel ↔ workspace binding
  // ---------------------------------------------------------------------------

  bindDiscordChannel({ discordChannelId, workspaceId, defaultAgent }) {
    return this.store.upsertDiscordBinding({ discordChannelId, workspaceId, defaultAgent });
  }

  getDiscordBinding(discordChannelId) {
    return this.store.getDiscordBinding(discordChannelId);
  }

  getWorkspaceByName(name) {
    return this.store.getWorkspaceByName(name);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  _emit(event) {
    this.bus?.publish?.(event.type, event);
  }
}
