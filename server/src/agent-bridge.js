/**
 * AgentBridge — multiCLI-discord-base マルチエージェント実行レイヤー
 *
 * PTY-first 設計 (Phase A):
 *   runPrompt() → DB 保存 → PtyService.sendPrompt() → PTY stdin
 *                ← PtyService 完了時に DB 保存 / SSE / Discord へ反映
 *
 * PTY key: workspaceId:agentName (PtyService 側で管理)
 */

import { normalizePersistedAssistantText } from "./pty-service.js";
import {
  buildContextBlock,
  resolveWorkspaceContextPolicy,
} from "./context-policy.js";

function normalizeAssistantMessageForStorage(agentType, text) {
  return normalizePersistedAssistantText(agentType, text);
}

const TERMINAL_TURN_SOURCES = new Set([
  "terminal",
  "ui",
  "discord",
  "discord-slash",
  "schedule",
]);

function normalizeTerminalTurnSource(source) {
  const normalized = String(source ?? "").trim().toLowerCase();
  return TERMINAL_TURN_SOURCES.has(normalized) ? normalized : "terminal";
}

export class AgentBridge {
  /**
   * @param {{ agentRegistry, store, bus, config, ptyService?, scheduler?, memoryService?, memoryAutomationService?, gitService?, skillManager? }} deps
   */
  constructor({ agentRegistry, store, bus, config, ptyService, scheduler, memoryService, memoryAutomationService, gitService, skillManager }) {
    this.agentRegistry = agentRegistry;
    this.store = store;
    this.bus = bus;
    this.config = config;
    this.ptyService = ptyService ?? null;
    this.scheduler = scheduler ?? null;
    this.memoryService = memoryService ?? null;
    this.memoryAutomationService = memoryAutomationService ?? null;
    this.gitService = gitService ?? null;
    this.skillManager = skillManager ?? null;

    agentRegistry.setStore(store);
    this.agentRegistry.hydrateFromStore?.();
    this._syncAgentsToDb();
    this.bus?.on?.("terminal.turn.done", (payload) => {
      this.recordTerminalTurn(payload).catch((error) => {
        console.warn("[agent-bridge] failed to persist terminal turn:", error);
      });
    });
    for (const approvalEventName of ["approval.requested", "approval.resolved", "approval.expired"]) {
      this.bus?.on?.(approvalEventName, (payload) => {
        try {
          this.store.addOperationAudit({
            workspaceId: payload?.workspaceId ?? null,
            agentName: payload?.agentName ?? null,
            operationType: approvalEventName,
            targetRef: payload?.approval?.id ?? null,
            status: payload?.approval?.status ?? "completed",
            source: "pty",
            details: payload ?? {},
          });
        } catch (error) {
          console.warn("[agent-bridge] failed to persist approval audit:", error);
        }
      });
    }
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

  _enrichWorkspace(workspace) {
    if (!workspace) return null;
    const workspaceAgentCount = this.store.countWorkspaceAgents(workspace.id);
    return {
      ...workspace,
      contextPolicy: resolveWorkspaceContextPolicy({
        workspace,
        workspaceAgentCount,
      }),
    };
  }

  getWorkspaceContextPolicy(workspaceId, { requestedIncludeContext = true } = {}) {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) return null;
    return resolveWorkspaceContextPolicy({
      workspace,
      workspaceAgentCount: this.store.countWorkspaceAgents(workspaceId),
      requestedIncludeContext,
    });
  }

  _resolvePromptTarget({ agentName, workspaceId = null, workdir }) {
    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      throw new Error(
        `エージェント "${agentName}" が見つかりません。\`agents!\` で確認してください。`
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
   * @param {string} [opts.inputMode]       "prompt" | "slash_command"
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
    inputMode = "prompt",
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

    if (inputMode === "slash_command") {
      return this.ptyService.sendRemoteCommand({
        agentName,
        workspaceId,
        command: prompt,
        workdir: effectiveWorkdir,
        source,
        metadata: { inputMode: "slash_command" },
      });
    }

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
      const contextPolicy = this.getWorkspaceContextPolicy(workspaceId, { requestedIncludeContext: includeContext });
      const recentMessages =
        contextPolicy?.effective
          ? this.store.listWorkspaceMessages(workspaceId, 21)
            .filter((message) => !(message.role === "user" && message.runId === run.id))
          : [];
      const contextBlock =
        contextPolicy?.effective
          ? buildContextBlock(recentMessages, agent.type)
          : null;
      const userMessageMetadata = {
        inputMode,
      };
      if (contextPolicy) {
        userMessageMetadata.context = {
          ...contextPolicy,
          used: Boolean(contextBlock?.text),
          messageCount: contextBlock?.messageCount ?? 0,
          totalChars: contextBlock?.totalChars ?? 0,
          maxTotalChars: contextBlock?.limits?.maxTotalChars ?? 0,
        };
      }

      // 2. Save user message
      this.store.addMessage({
        agentName,
        workspaceId,
        runId: run.id,
        role: "user",
        content: prompt,
        metadata: userMessageMetadata,
        source,
      });

      // 3. Emit user events to EventBus
      this._emit({
        type: "message.user",
        agentName,
        content: prompt,
        metadata: userMessageMetadata,
        source,
        runId: run.id,
        workspaceId,
        createdAt: new Date().toISOString(),
      });
      this._emit({ type: "status.change", agentName, status: "running", source, workspaceId, runId: run.id, createdAt: new Date().toISOString() });

      // 4. Send via PTY
      const result = await this.ptyService.sendPrompt({
        agentName,
        workspaceId,
        prompt,
        context: contextBlock?.text ?? null,
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

  getRestartEligibility(agentName, workspaceId = null, options = {}) {
    if (!workspaceId) {
      return { allowed: false, blockedReasons: ["workspaceId is required"] };
    }
    return this.ptyService?.getRestartEligibility?.(agentName, workspaceId, options) ?? {
      allowed: false,
      blockedReasons: ["unavailable"],
    };
  }

  async restartAgent(agentName, workspaceId = null, options = {}) {
    if (!workspaceId) {
      throw new Error("workspaceId is required");
    }
    const eligibility = this.getRestartEligibility(agentName, workspaceId, options);
    if (!eligibility.allowed) {
      throw new Error((eligibility.blockedReasons || []).join(" / ") || "restart blocked");
    }
    const prepared = this._resolvePromptTarget({ agentName, workspaceId, workdir: options.workdir });
    const state = await this.ptyService?.restartAgent?.(agentName, workspaceId, {
      ...options,
      workdir: prepared.effectiveWorkdir,
    });
    this.store.addOperationAudit({
      workspaceId,
      agentName,
      operationType: options.force ? "pty.restart.force" : "pty.restart",
      targetRef: `${workspaceId}:${agentName}`,
      status: "completed",
      requestedBy: options.requestedBy ?? "system",
      source: options.source ?? "ui",
      details: {
        force: Boolean(options.force),
        state,
      },
    });
    return state;
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
    return this.store.listWorkspaces().map((workspace) => this._enrichWorkspace(workspace));
  }

  getWorkspace(workspaceId) {
    return this._enrichWorkspace(this.store.getWorkspace(workspaceId));
  }

  createWorkspace({ name, workdir, parentAgent, contextInjectionEnabled = null }) {
    const ws = this.store.createWorkspace({ name, workdir, contextInjectionEnabled });
    // Register parent agent membership
    if (parentAgent && ws) {
      this.store.addWorkspaceAgent({ workspaceId: ws.id, agentName: parentAgent, isParent: true });
    }
    return this.getWorkspace(ws?.id);
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
    return this.updateWorkspace(id, { name });
  }

  updateWorkspace(id, patch = {}) {
    return this._enrichWorkspace(this.store.updateWorkspace(id, patch));
  }

  updateWorkspaceLayout(items = []) {
    const workspaces = this.store.listWorkspaces();
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    const submittedItems = Array.isArray(items) ? items : [];
    if (submittedItems.length !== workspaces.length) {
      throw new Error("workspace layout の件数が一致しません。");
    }

    const seenIds = new Set();
    const normalizedItems = submittedItems.map((item, index) => {
      const id = String(item?.id || "").trim();
      if (!id || !workspaceIds.has(id)) {
        throw new Error(`workspace "${id || index}" が見つかりません。`);
      }
      if (seenIds.has(id)) {
        throw new Error(`workspace "${id}" が重複しています。`);
      }
      seenIds.add(id);
      return {
        id,
        isSidebarActive: Boolean(item?.isSidebarActive),
        sortOrder: Math.max(0, Number(item?.sortOrder) || 0),
      };
    });

    const sortWithinSection = (left, right) => left.sortOrder - right.sortOrder;
    const active = normalizedItems.filter((item) => item.isSidebarActive).sort(sortWithinSection);
    const inactive = normalizedItems.filter((item) => !item.isSidebarActive).sort(sortWithinSection);
    const cappedActive = active.slice(0, 5).map((item, index) => ({
      ...item,
      isSidebarActive: true,
      sortOrder: index,
    }));
    const normalizedInactive = [...active.slice(5), ...inactive].map((item, index) => ({
      ...item,
      isSidebarActive: false,
      sortOrder: index,
    }));

    const saved = this.store.saveWorkspaceLayout([...cappedActive, ...normalizedInactive]);
    return saved.map((workspace) => this._enrichWorkspace(workspace));
  }

  async prewarmWorkspaceAgent(agentName, workspaceId, { workdir = null, waitForReadyMs = 4000 } = {}) {
    if (!workspaceId || !agentName) {
      throw new Error("workspaceId と agentName は必須です。");
    }
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`ワークスペース "${workspaceId}" が見つかりません。`);
    }
    const membership = this.store.listWorkspaceAgents(workspaceId).find((entry) => entry.agentName === agentName);
    if (!membership) {
      throw new Error(`${agentName} は workspace "${workspace.name}" に属していません。`);
    }
    const { effectiveWorkdir } = this._resolvePromptTarget({ agentName, workspaceId, workdir });
    return await this.ptyService.prewarmAgent({
      agentName,
      workspaceId,
      workdir: effectiveWorkdir,
      waitForReadyMs,
    });
  }

  listResumeBindings(workspaceId = null) {
    const sessions = workspaceId
      ? this.store.listAgentSessionsByWorkspace(workspaceId)
      : this.store.listAllAgentSessions();
    return sessions.map((session) => {
      const workspace = this.getWorkspace(session.workspaceId);
      const workspaceAgents = workspace ? this.store.listWorkspaceAgents(session.workspaceId) : [];
      const membership = workspaceAgents.find((entry) => entry.agentName === session.agentName) ?? null;
      const validation = this.ptyService?.validateStoredSessionBinding?.(
        session.agentName,
        session.workspaceId,
      ) ?? { valid: true, reasons: [] };
      return {
        ...session,
        workspaceName: workspace?.name ?? null,
        stale: !workspace || !membership || !validation.valid,
        reasons: [
          ...(workspace ? [] : ["workspace が存在しません。"]),
          ...(membership ? [] : ["workspace agent binding が存在しません。"]),
          ...(validation.reasons ?? []),
        ],
      };
    });
  }

  async resumeAgentSession(agentName, workspaceId, options = {}) {
    if (!workspaceId) {
      throw new Error("workspaceId is required");
    }
    const binding = this.listResumeBindings(workspaceId).find((entry) => entry.agentName === agentName);
    if (!binding) {
      throw new Error("resume binding が見つかりません。");
    }
    if (binding.stale) {
      throw new Error(binding.reasons.join(" / ") || "stale binding");
    }
    return this.prewarmWorkspaceAgent(agentName, workspaceId, options);
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

  listWorkspaceTerminalStates(workspaceId) {
    if (!workspaceId) {
      return [];
    }
    if (this.ptyService?.listWorkspaceTerminalStates) {
      return this.ptyService.listWorkspaceTerminalStates(workspaceId);
    }
    return this.listWorkspaceAgents(workspaceId).map((entry) => ({
      agentName: entry.agentName,
      workspaceId,
      ...this.getAgentTerminalState(entry.agentName, workspaceId),
    }));
  }

  getAgentTerminalOutput(agentName, workspaceId = null, options = {}) {
    if (this.ptyService?.getAgentTerminalOutput) {
      return this.ptyService.getAgentTerminalOutput(agentName, workspaceId, options);
    }
    return {
      ...this.getAgentTerminalState(agentName, workspaceId),
      text: "",
      totalLineCount: 0,
      lineLimit: Number.isFinite(options?.lineLimit) ? options.lineLimit : 50,
      truncated: false,
    };
  }

  sendTerminalInput(agentName, workspaceId = null, data = "", options = {}) {
    if (!workspaceId) {
      return { ok: false, reason: "workspace_required" };
    }
    if (this.ptyService?.sendTerminalInput) {
      return this.ptyService.sendTerminalInput(agentName, workspaceId, data, options);
    }
    return {
      ok: false,
      reason: "unavailable",
      state: this.getAgentTerminalState(agentName, workspaceId),
    };
  }

  async sendRemoteCommand(agentName, workspaceId = null, command = "", options = {}) {
    if (!workspaceId) {
      throw new Error("workspaceId is required");
    }
    const normalizedCommand = String(command ?? "").trim();
    if (!normalizedCommand.startsWith("/")) {
      throw new Error("slash command must start with /");
    }
    if (/[\r\n]/u.test(normalizedCommand)) {
      throw new Error("slash command must be a single line");
    }
    const prepared = await this.preparePrompt({
      agentName,
      workspaceId,
      workdir: options.workdir,
    });
    return this.ptyService?.sendRemoteCommand?.({
      agentName,
      workspaceId,
      command: normalizedCommand,
      workdir: prepared.effectiveWorkdir,
      source: options.source ?? "ui",
      metadata: options.metadata ?? { inputMode: "slash_command" },
    }) ?? { ok: false, reason: "unavailable" };
  }

  getAgentApprovalState(agentName, workspaceId = null) {
    return this.ptyService?.getAgentApprovalState?.(agentName, workspaceId) ?? null;
  }

  respondToApproval(agentName, workspaceId = null, decision, options = {}) {
    if (!workspaceId) {
      return { ok: false, reason: "workspace_required" };
    }
    return this.ptyService?.respondToApproval?.(agentName, workspaceId, decision, options) ?? {
      ok: false,
      reason: "unavailable",
      state: this.getAgentTerminalState(agentName, workspaceId),
    };
  }

  listOperationAudits(workspaceId = null, limit = 50) {
    return this.store.listOperationAudits(workspaceId, limit);
  }

  createWorkspaceCheckpoint(workspaceId, options = {}) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    return this.gitService?.createCheckpoint?.({
      workspaceId,
      workdir: workspace.workdir || this.config.codexWorkdir,
      agentName: options.agentName ?? null,
      runId: options.runId ?? null,
      kind: options.kind ?? "manual",
      label: options.label ?? "",
      requestedBy: options.requestedBy ?? "system",
      source: options.source ?? "ui",
    }) ?? null;
  }

  listWorkspaceCheckpoints(workspaceId, limit = 20) {
    return this.gitService?.listCheckpoints?.(workspaceId, { limit }) ?? [];
  }

  previewWorkspaceRollback(workspaceId, checkpointId, options = {}) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    return this.gitService?.previewRollback?.({
      workspaceId,
      checkpointId,
      workdir: workspace.workdir || this.config.codexWorkdir,
      source: options.source ?? "ui",
    }) ?? null;
  }

  applyWorkspaceRollback(workspaceId, checkpointId, options = {}) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    return this.gitService?.applyRollback?.({
      workspaceId,
      checkpointId,
      workdir: workspace.workdir || this.config.codexWorkdir,
      requestedBy: options.requestedBy ?? "system",
      source: options.source ?? "ui",
      approved: Boolean(options.approved),
      dryRun: Boolean(options.dryRun),
    }) ?? null;
  }

  restoreRuntimeSnapshot() {
    return this.ptyService?.restoreRuntimeSnapshot?.() ?? { restoredCount: 0, recoveredCount: 0 };
  }

  getGlobalMemory() {
    return this.memoryService?.getGlobalMemory?.() ?? { scope: "global", content: "", path: "" };
  }

  updateGlobalMemory(content = "") {
    return this.memoryService?.setGlobalMemory?.(content) ?? { scope: "global", content: "", path: "" };
  }

  getWorkspaceMemory(workspaceId) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    return this.memoryService?.getWorkspaceMemory?.(workspaceId) ?? {
      scope: "workspace",
      workspaceId,
      content: "",
      path: "",
    };
  }

  updateWorkspaceMemory(workspaceId, content = "") {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    return this.memoryService?.setWorkspaceMemory?.(workspaceId, content) ?? {
      scope: "workspace",
      workspaceId,
      content: "",
      path: "",
    };
  }

  getAgentMemory(agentName) {
    if (!this.agentRegistry.get(agentName)) {
      throw new Error(`エージェント "${agentName}" が見つかりません。`);
    }
    return this.memoryService?.getAgentMemory?.(agentName) ?? {
      scope: "agent",
      agentName,
      content: "",
      path: "",
    };
  }

  updateAgentMemory(agentName, content = "") {
    if (!this.agentRegistry.get(agentName)) {
      throw new Error(`エージェント "${agentName}" が見つかりません。`);
    }
    return this.memoryService?.setAgentMemory?.(agentName, content) ?? {
      scope: "agent",
      agentName,
      content: "",
      path: "",
    };
  }

  previewWorkspaceConsolidation(workspaceId) {
    return this.memoryAutomationService?.previewWorkspaceConsolidation?.(workspaceId) ?? null;
  }

  applyWorkspaceConsolidation(workspaceId, options = {}) {
    const result = this.memoryAutomationService?.applyWorkspaceConsolidation?.(workspaceId, options) ?? null;
    if (result) {
      this.store.addOperationAudit({
        workspaceId,
        operationType: "memory.consolidation",
        targetRef: workspaceId,
        status: "completed",
        requestedBy: options.requestedBy ?? "system",
        source: options.source ?? "ui",
        details: {
          backupPath: result.backupPath,
          tokenEstimate: result.tokenEstimate,
        },
      });
    }
    return result;
  }

  previewWorkspaceDiary(workspaceId) {
    return this.memoryAutomationService?.previewWorkspaceDiary?.(workspaceId) ?? null;
  }

  applyWorkspaceDiary(workspaceId, options = {}) {
    const result = this.memoryAutomationService?.applyWorkspaceDiary?.(workspaceId, options) ?? null;
    if (result) {
      this.store.addOperationAudit({
        workspaceId,
        operationType: "memory.ai_diary",
        targetRef: workspaceId,
        status: "completed",
        requestedBy: options.requestedBy ?? "system",
        source: options.source ?? "ui",
        details: {
          diaryPath: result.diaryPath,
          backupPath: result.backupPath,
          tokenEstimate: result.tokenEstimate,
        },
      });
    }
    return result;
  }

  getSkillRegistry() {
    return this.skillManager?.getRegistrySummary?.() ?? null;
  }

  planWorkspaceSkillSync(workspaceId, options = {}) {
    return this.skillManager?.planWorkspaceSync?.(workspaceId, options) ?? null;
  }

  applyWorkspaceSkillSync(workspaceId, options = {}) {
    const result = this.skillManager?.applyWorkspaceSync?.(workspaceId, options) ?? null;
    if (result) {
      this.store.addOperationAudit({
        workspaceId,
        operationType: "skills.sync",
        targetRef: workspaceId,
        status: "completed",
        requestedBy: options.requestedBy ?? "system",
        source: options.source ?? "ui",
        details: {
          appliedCount: Array.isArray(result.applied) ? result.applied.length : 0,
        },
      });
    }
    return result;
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
    source = "terminal",
    metadata = null,
  }) {
    const agent = this.agentRegistry.get(agentName);
    const workspace = this.getWorkspace(workspaceId);
    const normalizedPrompt = String(prompt ?? "").trim();
    const normalizedSource = normalizeTerminalTurnSource(source);
    if (!agent || !workspace || !normalizedPrompt) return;

    const run = this.store.startRun({
      agentName,
      workspaceId,
      prompt: normalizedPrompt,
      source: normalizedSource,
    });

    this.store.addMessage({
      agentName,
      workspaceId,
      runId: run.id,
      role: "user",
      content: normalizedPrompt,
      metadata,
      source: normalizedSource,
    });
    this._emit({
      type: "message.user",
      agentName,
      content: normalizedPrompt,
      metadata,
      source: normalizedSource,
      runId: run.id,
      workspaceId,
    });

    const runStatus =
      finalStatus === "waiting_input" ? "waiting_input" :
      finalStatus === "quota_wait"    ? "quota_wait" :
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
      source: normalizedSource,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  _emit(event) {
    this.bus?.publish?.(event.type, event);
  }
}
