/**
 * AgentBridge — multiCLI-discord-base マルチエージェント実行レイヤー
 *
 * PTY-first 設計 (Phase A):
 *   runPrompt() → DB 保存 → PtyService.sendPrompt() → PTY stdin
 *                ← PtyService 完了時に DB 保存 / SSE / Discord へ反映
 *
 * PTY key: workspaceId:agentName (PtyService 側で管理)
 */

import { calcCost } from "./pricing.js";
import { normalizePersistedAssistantText } from "./pty-service.js";

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

function getContextLimits(agentType) {
  switch (agentType) {
    case "codex":
      return { maxMessages: 8, maxCharsPerMessage: 180, maxTotalChars: 1200 };
    case "copilot":
      return { maxMessages: 10, maxCharsPerMessage: 220, maxTotalChars: 1600 };
    case "gemini":
      return { maxMessages: 12, maxCharsPerMessage: 240, maxTotalChars: 1800 };
    case "claude":
    default:
      return { maxMessages: 14, maxCharsPerMessage: 260, maxTotalChars: 2200 };
  }
}

function sanitizeContextMessageContent(content) {
  let cleaned = String(content || "")
    .replace(/\u0007/g, "")
    .replace(/\r/g, "");
  cleaned = cleaned.replace(/\[Context from recent workspace chat\][\s\S]*?\[User prompt\]/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)⚠\s*Heads up,[^\n]*(?:\nRun \/status[^\n]*)?/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)You've hit your usage limit[^\n]*/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)Codex の応答を抽出できませんでした。[^\n]*/g, "\n");
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

function filterContextMessages(messages) {
  const completedRunIds = new Set(
    messages
      .filter((message) => message.role === "assistant" && message.runId)
      .map((message) => message.runId),
  );
  return messages.filter((message) => {
    if (message.role !== "user") return true;
    if (!message.runId) return true;
    return completedRunIds.has(message.runId);
  });
}

function normalizeAssistantMessageForStorage(agentType, text) {
  return normalizePersistedAssistantText(agentType, text);
}

/** Format workspace messages as a context block for PTY input. */
function buildContextBlock(messages, agentType = "claude") {
  if (!messages || messages.length === 0) return null;
  const limits = getContextLimits(agentType);
  const filteredMessages = filterContextMessages(messages);
  const lines = [];
  let totalChars = 0;
  for (const m of filteredMessages.slice(-limits.maxMessages)) {
    const speaker =
      m.role === "user"
        ? `You -> ${m.agentName}`
        : `${m.agentName}`;
    const body = sanitizeContextMessageContent(m.content).slice(0, limits.maxCharsPerMessage);
    if (!body) continue;
    const line = `${speaker}: ${body}`;
    if (totalChars + line.length > limits.maxTotalChars) {
      if (lines.length === 0) {
        lines.push(line.slice(0, limits.maxTotalChars));
      }
      break;
    }
    lines.push(line);
    totalChars += line.length + 1;
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export class AgentBridge {
  /**
   * @param {{ agentRegistry, store, bus, config, ptyService?, scheduler? }} deps
   */
  constructor({ agentRegistry, store, bus, config, ptyService, scheduler }) {
    this.agentRegistry = agentRegistry;
    this.store = store;
    this.bus = bus;
    this.config = config;
    this.ptyService = ptyService ?? null;
    this.scheduler = scheduler ?? null;

    agentRegistry.setStore(store);
    this.agentRegistry.hydrateFromStore?.();
    this._syncAgentsToDb();
    this.bus?.on?.("terminal.turn.done", (payload) => {
      this.recordTerminalTurn(payload).catch((error) => {
        console.warn("[agent-bridge] failed to persist terminal turn:", error);
      });
    });
  }

  _syncAgentsToDb() {
    for (const agent of this.agentRegistry.list()) {
      this.store.upsertAgent({
        name: agent.name,
        type: agent.type,
        model: agent.model,
        status: agent.status ?? "stopped",
        enabled: true,
        settings: {
          ...(agent.settings ?? {}),
          source: agent.source ?? "env",
        },
      });
    }
  }

  _resolvePromptTarget({ agentName, workspaceId = null, workdir }) {
    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      throw new Error(
        `エージェント "${agentName}" が見つかりません。\`agents?\` で確認してください。`
      );
    }
    const workspace = workspaceId ? this.store.getWorkspace(workspaceId) : null;
    const appSettings = this.store?.getAppSettings?.() ?? {};
    const effectiveWorkdir =
      String(workdir || "").trim() ||
      String(agent.settings?.workdir || "").trim() ||
      String(workspace?.workdir || "").trim() ||
      String(appSettings.defaultWorkdir || "").trim() ||
      undefined;
    return { agent, workspace, effectiveWorkdir };
  }

  async preparePrompt({ agentName, workspaceId = null, workdir }) {
    if (!this.ptyService) {
      throw new Error("PtyService が初期化されていません。");
    }
    const resolved = this._resolvePromptTarget({ agentName, workspaceId, workdir });
    await this.ptyService.assertPromptReady({
      agentName,
      workspaceId,
      workdir: resolved.effectiveWorkdir,
    });
    return resolved;
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
   * @param {string} [opts.source]          "discord" | "ui" | "schedule" | "terminal"
   * @param {boolean} [opts.includeContext]
   * @param {string} [opts.discordMessageId]
   * @param {Function} [opts.onProgress]    called with CanonicalEvents (for Discord live updates)
   * @returns {Promise<{ text: string }>}
   */
  async runPrompt({
    agentName,
    prompt,
    workspaceId = null,
    workdir,
    source = "ui",
    includeContext = true,
    discordMessageId,
    onProgress,
    prepared = null,
  }) {
    if (!this.ptyService) {
      throw new Error("PtyService が初期化されていません。");
    }

    const { agent, effectiveWorkdir } = prepared ?? await this.preparePrompt({
      agentName,
      workspaceId,
      workdir,
    });

    // 1. Start run record in DB
    const run = this.store.startRun({ agentName, workspaceId, prompt, source });
    const progressUnsubscribers = [];
    const relayProgress = typeof onProgress === "function"
      ? (event) => {
          if (!event || event.agentName !== agentName || event.workspaceId !== workspaceId) {
            return;
          }
          if (event.runId && event.runId !== run.id) {
            return;
          }
          try {
            onProgress(event);
          } catch (error) {
            console.error("Agent progress callback failed:", error);
          }
        }
      : null;

    if (relayProgress && this.bus?.on) {
      for (const eventName of [
        "status.change",
        "message.delta",
        "tool.start",
        "tool.done",
        "message.done",
        "run.done",
        "run.error",
      ]) {
        progressUnsubscribers.push(this.bus.on(eventName, relayProgress));
      }
    }

    try {
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
      this._emit({ type: "message.user", agentName, content: prompt, source, runId: run.id, workspaceId, createdAt: new Date().toISOString() });
      this._emit({ type: "status.change", agentName, status: "running", source, workspaceId, runId: run.id, createdAt: new Date().toISOString() });

      // 4. Build context from recent workspace messages (excluding the message just added)
      const recentMessages = includeContext
        ? this.store.listWorkspaceMessages(workspaceId, 21)
          .filter((m) => !(m.role === "user" && m.runId === run.id))
        : [];
      const context = includeContext ? buildContextBlock(recentMessages, agent.type) : null;

      // 5. Send via PTY — waits until heuristic completion (5s silence)
      const result = await this.ptyService.sendPrompt({
        agentName,
        workspaceId,
        prompt,
        context,
        runId: run.id,
        workdir: effectiveWorkdir,
      });

      const text = normalizeAssistantMessageForStorage(agent.type, result.text ?? "");

      // 6. Finalize run — preserve finalStatus from PTY
      const runStatus =
        result.finalStatus === "waiting_input" ? "waiting_input" :
        result.finalStatus === "timeout"       ? "timeout"       :
        result.finalStatus === "error"         ? "error"         :
        "completed";
      this.store.completeRun(run.id, { status: runStatus });

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

      this._emit({ type: "message.done", agentName, content: text, source, finalStatus: runStatus, runId: run.id, workspaceId, createdAt: new Date().toISOString() });
      this._emit({
        type: "status.change",
        agentName,
        status:
          this.ptyService?.getAgentTerminalState?.(agentName, workspaceId)?.status ??
          (result.finalStatus === "waiting_input"
            ? "waiting_input"
            : result.finalStatus === "timeout"
              ? "running"
              : "idle"),
        source,
        workspaceId,
        runId: run.id,
        createdAt: new Date().toISOString(),
      });

      return { text };
    } catch (err) {
      const cancelled = Boolean(err.cancelled);
      const authRequired = Boolean(err.authRequired);

      this.store.completeRun(run.id, {
        status: cancelled ? "cancelled" : authRequired ? "waiting_input" : "error",
      });

      this._emit({
        type: "run.error",
        agentName,
        message: err.message,
        cancelled,
        source,
        runId: run.id,
        workspaceId,
        createdAt: new Date().toISOString(),
      });
      this._emit({
        type: "status.change",
        agentName,
        status: cancelled ? "idle" : authRequired ? "waiting_input" : "error",
        source,
        workspaceId,
        runId: run.id,
        createdAt: new Date().toISOString(),
      });

      throw err;
    } finally {
      for (const unsubscribe of progressUnsubscribers) {
        unsubscribe();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Agent control
  // ---------------------------------------------------------------------------

  cancelAgent(agentName, workspaceId = null) {
    if (!workspaceId) return false;
    // With PTY-first, "cancel" means killing the PTY for this agent×workspace
    const killed = this.ptyService?.killAgent(agentName, workspaceId) ?? false;
    // Also cancel any in-flight adapter run (legacy fallback)
    const agent = this.agentRegistry.get(agentName);
    if (agent) agent.cancel?.();
    this._emit({ type: "status.change", agentName, status: "idle", workspaceId });
    return killed;
  }

  resetAgentSession(agentName, workspaceId = null) {
    if (!workspaceId) return false;
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

  getAppSettings() {
    return this.store.getAppSettings();
  }

  updateAppSettings(patch = {}) {
    return this.store.updateAppSettings(patch);
  }

  listWorkspaces() {
    return this.store.listWorkspaces();
  }

  getWorkspace(workspaceId) {
    return this.store.getWorkspace(workspaceId);
  }

  createWorkspace({ name, workdir, parentAgent }) {
    const ws = this.store.createWorkspace({ name, workdir });
    // Register parent agent membership
    if (parentAgent && ws) {
      this.store.addWorkspaceAgent({ workspaceId: ws.id, agentName: parentAgent, isParent: true });
    }
    return ws;
  }

  async deleteWorkspace(id) {
    const ws = this.store.getWorkspace(id);
    if (!ws) return null;
    const running = this.agentRegistry.list().filter((a) => a.status === "running");
    if (running.length > 0) {
      throw new Error("実行中のエージェントがあります。停止してから削除してください。");
    }
    await this.scheduler?.removeJobsReferencingWorkspace?.(id);
    this.ptyService?.killWorkspace?.(id);
    const deleted = this.store.deleteWorkspace(id);
    const nextWorkspaceId = this.store.getActiveWorkspace()?.id ?? null;
    await this.agentRegistry.switchWorkspace(nextWorkspaceId);
    this._emit({ type: "workspace.switched", workspaceId: nextWorkspaceId });
    return deleted;
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

    if (!this.getWorkspace(workspaceId)) {
      throw new Error(`ワークスペース "${workspaceId}" が見つかりません。`);
    }

    // Validate agent exists in registry
    if (!this.agentRegistry.get(agentName)) {
      throw new Error(`エージェント "${agentName}" が見つかりません。`);
    }

    // Idempotent: if already a member, return success without counting
    const existing = this.store.listWorkspaceAgents(workspaceId);
    if (existing.some((a) => a.agentName === agentName)) {
      return existing.find((a) => a.agentName === agentName);
    }

    // Enforce max AFTER dedup check
    if (existing.length >= MAX_WORKSPACE_AGENTS) {
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

  getAgentTerminalState(agentName, workspaceId = null) {
    if (this.ptyService?.getAgentTerminalState) {
      return this.ptyService.getAgentTerminalState(agentName, workspaceId);
    }
    return {
      status: this.agentRegistry.get(agentName)?.status ?? "idle",
      hasProcess: false,
      lastOutputAt: null,
      runId: null,
      readyForPrompt: false,
    };
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

  createAgent({ name, type, model, settings = {} }) {
    return this.agentRegistry.createCustomAgent({ name, type, model, settings });
  }

  async updateAgent(name, patch = {}) {
    const updated = this.agentRegistry.updateAgentConfig(name, patch);
    let liveSessionWarningCount = 0;
    let liveSessionWarningWorkspaceIds = [];
    if (this.ptyService) {
      try {
        const warning = await Promise.resolve(this.ptyService.markAgentConfigUpdated(name));
        liveSessionWarningCount = Number(warning?.count || 0);
        liveSessionWarningWorkspaceIds = Array.isArray(warning?.workspaceIds) ? warning.workspaceIds : [];
      } catch {}
    }
    return {
      ...updated,
      liveSessionWarningCount,
      liveSessionWarningWorkspaceIds,
    };
  }

  async deleteAgent(name) {
    const agent = this.agentRegistry.get(name);
    if (!agent) {
      return null;
    }
    this.ptyService?.killAgent(name);
    await this.scheduler?.removeJobsReferencingAgent?.(name);
    const deleted = this.agentRegistry.deleteAgent(name);
    this._emit({ type: "agent.deleted", agentName: name });
    return deleted;
  }

  listMessages(agentName, workspaceId = null, limit = 100) {
    return this.store.listMessages(agentName, workspaceId, limit);
  }

  listWorkspaceMessages(workspaceId = null, limit = 100) {
    return this.store.listWorkspaceMessages(workspaceId, limit);
  }

  listRuns(agentName, workspaceId = null, limit = 20) {
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
    if (!this.getWorkspace(workspaceId)) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    if (defaultAgent && !this.agentRegistry.get(defaultAgent)) {
      throw new Error(`defaultAgent "${defaultAgent}" が見つかりません。`);
    }
    this.store.deleteDiscordBindingsByWorkspace(workspaceId);
    return this.store.upsertDiscordBinding({ discordChannelId, workspaceId, defaultAgent });
  }

  getDiscordBinding(discordChannelId) {
    return this.store.getDiscordBinding(discordChannelId);
  }

  listWorkspaceDiscordBindings(workspaceId) {
    if (!this.getWorkspace(workspaceId)) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    return this.store.listDiscordBindingsByWorkspace(workspaceId);
  }

  setWorkspaceDiscordBinding(workspaceId, { channelId = null, defaultAgent = null }) {
    if (!this.getWorkspace(workspaceId)) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    const normalizedDefaultAgent = defaultAgent ? String(defaultAgent).trim().toLowerCase() : "";
    if (normalizedDefaultAgent) {
      const workspaceAgents = this.store.listWorkspaceAgents(workspaceId);
      if (!workspaceAgents.some((entry) => entry.agentName === normalizedDefaultAgent)) {
        throw new Error(`agent "${normalizedDefaultAgent}" は workspace "${workspaceId}" に紐づいていません。`);
      }
    }
    this.store.deleteDiscordBindingsByWorkspace(workspaceId);
    const normalizedChannelId = channelId ? String(channelId).trim() : "";
    if (normalizedChannelId) {
      this.store.upsertDiscordBinding({
        discordChannelId: normalizedChannelId,
        workspaceId,
        defaultAgent: normalizedDefaultAgent || null,
      });
    }
    return this.store.listDiscordBindingsByWorkspace(workspaceId);
  }

  getWorkspaceByName(name) {
    return this.store.getWorkspaceByName(name);
  }

  resolveScheduleAgentTarget(target) {
    if (!target || String(target.type || "").trim().toLowerCase() !== "agent") {
      return null;
    }

    const workspaceId = String(target.workspaceId || "").trim() || "default";
    if (!this.getWorkspace(workspaceId)) {
      throw new Error(`Schedule target workspace "${workspaceId}" が見つかりません。`);
    }
    let agentName = String(target.agentName || "").trim();
    if (!agentName) {
      agentName =
        this.getWorkspaceParentAgent(workspaceId) ||
        (this.agentRegistry.list().length === 1 ? this.agentRegistry.list()[0].name : "");
    }

    if (!agentName) {
      throw new Error(`Schedule target "${workspaceId}" に agentName が必要です。`);
    }
    if (!this.agentRegistry.get(agentName)) {
      throw new Error(`Schedule target agent "${agentName}" が見つかりません。`);
    }

    return { workspaceId, agentName };
  }

  async runScheduledJob({ name, prompt, target, workdir }) {
    const resolved = this.resolveScheduleAgentTarget(target);
    if (!resolved) {
      throw new Error(`Unsupported schedule target for "${name}".`);
    }

    const result = await this.runPrompt({
      agentName: resolved.agentName,
      prompt,
      workspaceId: resolved.workspaceId,
      workdir,
      source: "schedule",
    });
    const workspace = this.getWorkspace(resolved.workspaceId);

    return {
      workspaceId: resolved.workspaceId,
      agentName: resolved.agentName,
      text: result.text,
      session: {
        id: workspace?.id ?? resolved.workspaceId,
        title: workspace?.name ?? resolved.workspaceId,
      },
    };
  }

  async recordTerminalTurn({
    agentName,
    workspaceId = null,
    prompt,
    text = "",
    finalStatus = "completed",
  }) {
    const agent = this.agentRegistry.get(agentName);
    const workspace = this.store.getWorkspace(workspaceId);
    const normalizedPrompt = String(prompt ?? "").trim();
    if (!agent || !workspace || !normalizedPrompt) return;

    const run = this.store.startRun({
      agentName,
      workspaceId,
      prompt: normalizedPrompt,
      source: "terminal",
    });

    this.store.addMessage({
      agentName,
      workspaceId,
      runId: run.id,
      role: "user",
      content: normalizedPrompt,
      source: "terminal",
    });
    this._emit({
      type: "message.user",
      agentName,
      content: normalizedPrompt,
      source: "terminal",
      runId: run.id,
      workspaceId,
    });

    const runStatus =
      finalStatus === "waiting_input" ? "waiting_input" :
      finalStatus === "timeout"       ? "timeout" :
      finalStatus === "error"         ? "error" :
      "completed";
    this.store.completeRun(run.id, { status: runStatus });

    const normalizedText = normalizeAssistantMessageForStorage(agent.type, text ?? "");
    const recentAgentMessages = this.store.listMessages(agentName, workspaceId, 6);
    const previousAssistant = [...recentAgentMessages].reverse().find((message) => message.role === "assistant");
    const previousUser = [...recentAgentMessages].reverse().find((message) => message.role === "user");
    const looksLikeStaleCopilotWaitingReply =
      finalStatus === "waiting_input" &&
      agent.type === "copilot" &&
      Boolean(normalizedText) &&
      previousAssistant?.content === normalizedText &&
      String(previousUser?.content ?? "").trim() !== normalizedPrompt;
    const shouldPersistAssistantText = Boolean(normalizedText) && !looksLikeStaleCopilotWaitingReply;
    if (shouldPersistAssistantText) {
      this.store.addMessage({
        agentName,
        workspaceId,
        runId: run.id,
        role: "assistant",
        content: normalizedText,
        source: "agent",
      });
    }

    this._emit({
      type: "message.done",
      agentName,
      content: shouldPersistAssistantText ? normalizedText : "",
      runId: run.id,
      workspaceId,
      source: "terminal",
    });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  _emit(event) {
    this.bus?.publish?.(event.type, event);
  }
}
