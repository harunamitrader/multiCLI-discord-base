/**
 * AgentBridge — multicodi の新マルチエージェント実行レイヤー
 *
 * 既存の BridgeService (Codex専用) と並列で動作する。
 * AgentRegistry を通じて Claude / Gemini / Codex を実行し、
 * CanonicalEvent を EventBus に流す。
 *
 * 将来的に BridgeService を置き換えることを想定しているが、
 * Phase 1 では共存させて既存機能への影響をゼロにする。
 */

import { calcCost } from "./pricing.js";

export class AgentBridge {
  /**
   * @param {{ agentRegistry, store, bus, config }} deps
   */
  constructor({ agentRegistry, store, bus, config }) {
    this.agentRegistry = agentRegistry;
    this.store = store;
    this.bus = bus;
    this.config = config;

    // Inject store into registry for session persistence
    agentRegistry.setStore(store);

    // Ensure default workspace row exists in agents table
    this._syncAgentsToDb();
  }

  _syncAgentsToDb() {
    for (const { name, type, model } of this.agentRegistry.list()) {
      this.store.upsertAgent({ name, type, model });
    }
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  /**
   * Run a prompt against a named agent.
   *
   * @param {object} opts
   * @param {string} opts.agentName
   * @param {string} opts.prompt
   * @param {string} [opts.workspaceId]   defaults to "default"
   * @param {string} [opts.workdir]
   * @param {string} [opts.source]        "discord" | "ui" | "schedule"
   * @param {string} [opts.discordMessageId]  for Discord reply threading
   * @returns {Promise<{ text: string, usage: object, sessionRef: string }>}
   */
  async runPrompt({ agentName, prompt, workspaceId = "default", workdir, source = "ui", discordMessageId, onProgress }) {
    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      throw new Error(`エージェント "${agentName}" が見つかりません。\`agents?\` で確認してください。`);
    }

    const resolvedWorkdir = workdir || this.config.codexWorkdir;

    // Start run record
    const run = this.store.startRun({
      agentName,
      workspaceId,
      prompt,
      source,
    });

    // Record user message
    this.store.addMessage({
      agentName,
      workspaceId,
      runId: run.id,
      role: "user",
      content: prompt,
      source,
    });

    // Emit user message event to bus
    this._emit({ type: "message.user", agentName, content: prompt, source, runId: run.id, workspaceId });
    this._emit({ type: "status.change", agentName, status: "running", workspaceId });

    let fullText = "";

    try {
      const result = await agent.run({
        prompt,
        workdir: resolvedWorkdir,
        onCanonicalEvent: (event) => {
          // Attach run context to events
          const enriched = { ...event, runId: run.id, workspaceId };
          this._emit(enriched);
          onProgress?.(enriched);

          // Accumulate text for storage
          if (event.type === "message.delta") fullText += event.content;
          if (event.type === "message.done") fullText = event.content;
        },
      });

      // Compute cost
      const costUsd = result.usage?.costUsd ?? calcCost(agent.model || agent.adapter.defaultModel, result.usage)?.usd ?? null;

      // Finalize run record
      this.store.completeRun(run.id, {
        status: "completed",
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        costUsd,
      });

      // Store assistant message (final text)
      if (fullText || result.text) {
        this.store.addMessage({
          agentName,
          workspaceId,
          runId: run.id,
          role: "assistant",
          content: fullText || result.text,
          metadata: { usage: result.usage },
          source: "agent",
        });
      }

      // Persist session ref
      this.store.upsertAgentSession({
        agentName,
        workspaceId,
        providerSessionRef: result.sessionRef,
        model: agent.model || null,
        workdir: resolvedWorkdir,
        lastRunState: "completed",
      });

      this._emit({ type: "status.change", agentName, status: "idle", workspaceId });

      return { text: fullText || result.text, usage: result.usage, sessionRef: result.sessionRef };
    } catch (err) {
      const cancelled = Boolean(err.cancelled);

      this.store.completeRun(run.id, {
        status: cancelled ? "cancelled" : "error",
      });

      this._emit({
        type: "run.error",
        agentName,
        message: err.message,
        cancelled,
        runId: run.id,
        workspaceId,
      });
      this._emit({ type: "status.change", agentName, status: cancelled ? "idle" : "error", workspaceId });

      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Agent control
  // ---------------------------------------------------------------------------

  cancelAgent(agentName) {
    const agent = this.agentRegistry.get(agentName);
    if (!agent) return false;
    agent.cancel();
    this._emit({ type: "status.change", agentName, status: "idle" });
    return true;
  }

  resetAgentSession(agentName, workspaceId = "default") {
    const agent = this.agentRegistry.get(agentName);
    if (!agent) return false;
    agent.resetSession();
    // Clear from DB too
    this.store.upsertAgentSession({
      agentName,
      workspaceId,
      providerSessionRef: null,
      lastRunState: "idle",
    });
    this._emit({ type: "status.change", agentName, status: "idle" });
    return true;
  }

  stopAll() {
    this.agentRegistry.stopAll();
  }

  // ---------------------------------------------------------------------------
  // Workspace
  // ---------------------------------------------------------------------------

  async switchWorkspace(workspaceId) {
    // Check no agent is running
    const running = this.agentRegistry.list().filter((a) => a.status === "running");
    if (running.length > 0) {
      throw new Error(`実行中のエージェントがあります: ${running.map((a) => a.name).join(", ")}。停止してから切り替えてください。`);
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

  createWorkspace({ name, workdir }) {
    return this.store.createWorkspace({ name, workdir });
  }

  deleteWorkspace(id) {
    if (id === "default") throw new Error("defaultワークスペースは削除できません。");
    const running = this.agentRegistry.list().filter((a) => a.status === "running");
    if (running.length > 0) throw new Error("実行中のエージェントがあります。停止してから削除してください。");
    return this.store.deleteWorkspace(id);
  }

  renameWorkspace(id, name) {
    return this.store.updateWorkspace(id, { name });
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

  listRuns(agentName, workspaceId = "default", limit = 20) {
    return this.store.listRuns(agentName, workspaceId, limit);
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
