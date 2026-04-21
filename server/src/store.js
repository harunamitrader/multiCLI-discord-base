import { randomUUID } from "node:crypto";

const MAX_ACTIVE_WORKSPACES = 5;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    // Legacy field — kept for backward compatibility with the legacy bridge
    codexThreadId: row.codex_thread_id,
    // Generalized session reference (all providers)
    providerSessionRef: row.provider_session_ref ?? row.codex_thread_id ?? null,
    status: row.status,
    discordChannelId: row.discord_channel_id,
    discordChannelName: row.discord_channel_name,
    model: row.model,
    reasoningEffort: row.model_reasoning_effort,
    profile: row.profile,
    workdir: row.workdir,
    serviceTier: row.service_tier === "fast" ? "fast" : "flex",
    fastMode: row.service_tier === "fast",
    userPromptCount: Number(row.user_prompt_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

function parseAgent(row) {
  if (!row) return null;
  let settings = {};
  try {
    settings = row.settings_json ? JSON.parse(row.settings_json) : {};
  } catch {
    settings = {};
  }
  return {
    name: row.name,
    type: row.type,
    model: row.model,
    status: row.status,
    enabled: row.enabled == null ? true : Boolean(row.enabled),
    themeColor: row.theme_color ?? null,
    settings,
    source: settings?.source || "env",
    createdAt: row.created_at,
  };
}

function parseWorkspace(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    workdir: row.workdir,
    contextInjectionEnabled:
      row.context_injection_enabled == null
        ? null
        : Boolean(row.context_injection_enabled),
    isSidebarActive: Boolean(row.is_sidebar_active),
    sortOrder: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

function parseAgentSession(row) {
  if (!row) return null;
  return {
    agentName: row.agent_name,
    workspaceId: row.workspace_id,
    providerSessionRef: row.provider_session_ref,
    model: row.model,
    workdir: row.workdir,
    lastRunState: row.last_run_state,
    updatedAt: row.updated_at,
  };
}

function parseRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentName: row.agent_name,
    workspaceId: row.workspace_id,
    prompt: row.prompt,
    status: row.status,
    source: row.source,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function parseMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentName: row.agent_name,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    role: row.role,
    content: row.content,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    source: row.source,
    createdAt: row.created_at,
  };
}

function parseDiscordBinding(row) {
  if (!row) return null;
  return {
    discordChannelId: row.discord_channel_id,
    workspaceId: row.workspace_id,
    defaultAgent: row.default_agent ?? null,
    createdAt: row.created_at,
  };
}

function parseGitCheckpoint(row) {
  if (!row) return null;
  let status = { entries: [], dirtyCount: 0, trackedCount: 0, untrackedCount: 0 };
  try {
    status = row.status_json ? JSON.parse(row.status_json) : status;
  } catch {
    status = { entries: [], dirtyCount: 0, trackedCount: 0, untrackedCount: 0 };
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentName: row.agent_name ?? null,
    runId: row.run_id ?? null,
    kind: row.kind,
    label: row.label ?? "",
    workdir: row.workdir ?? "",
    gitHeadSha: row.git_head_sha ?? "",
    stashRef: row.stash_ref ?? null,
    status,
    createdAt: row.created_at,
  };
}

function parseOperationAudit(row) {
  if (!row) return null;
  let details = {};
  try {
    details = row.details_json ? JSON.parse(row.details_json) : {};
  } catch {
    details = {};
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? null,
    agentName: row.agent_name ?? null,
    operationType: row.operation_type,
    targetRef: row.target_ref ?? null,
    status: row.status,
    dryRun: Boolean(row.dry_run),
    requestedBy: row.requested_by ?? null,
    source: row.source ?? null,
    details,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  constructor(db) {
    this.db = db;

    const sessionSelectColumns = `
      sessions.*,
      (
        SELECT COUNT(*)
        FROM session_events
        WHERE session_events.session_id = sessions.id
          AND session_events.event_type = 'message.user'
          AND session_events.source IN ('ui', 'discord')
      ) AS user_prompt_count
    `;

    // ---- Legacy session statements (legacy bridge compatibility) ----
    this.createSessionStatement = db.prepare(`
      INSERT INTO sessions (
        id, title, codex_thread_id, status,
        discord_channel_id, discord_channel_name,
        model, model_reasoning_effort, profile, workdir, service_tier,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateSessionStatement = db.prepare(`
      UPDATE sessions
      SET title=?, codex_thread_id=?, provider_session_ref=?, status=?,
          discord_channel_id=?, discord_channel_name=?,
          model=?, model_reasoning_effort=?, profile=?, workdir=?, service_tier=?,
          updated_at=?
      WHERE id=?
    `);
    this.getSessionStatement = db.prepare(
      `SELECT ${sessionSelectColumns} FROM sessions WHERE id=?`
    );
    this.listSessionsStatement = db.prepare(
      `SELECT ${sessionSelectColumns} FROM sessions ORDER BY updated_at DESC`
    );
    this.findByDiscordChannelStatement = db.prepare(
      `SELECT ${sessionSelectColumns} FROM sessions WHERE discord_channel_id=? ORDER BY updated_at DESC LIMIT 1`
    );
    this.listByDiscordChannelStatement = db.prepare(
      `SELECT ${sessionSelectColumns} FROM sessions WHERE discord_channel_id=? ORDER BY updated_at DESC`
    );
    this.deleteSessionEventsStatement = db.prepare(
      `DELETE FROM session_events WHERE session_id=?`
    );
    this.deleteSessionStatement = db.prepare(`DELETE FROM sessions WHERE id=?`);
    this.insertEventStatement = db.prepare(
      `INSERT INTO session_events (id, session_id, source, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.listEventsStatement = db.prepare(`
      SELECT * FROM (
        SELECT * FROM session_events WHERE session_id=? ORDER BY created_at DESC LIMIT ?
      ) ORDER BY created_at ASC
    `);

    // ---- Agent statements ----
    this.upsertAgentStatement = db.prepare(`
      INSERT INTO agents (name, type, model, status, enabled, settings_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        type=excluded.type,
        model=excluded.model,
        status=excluded.status,
        enabled=excluded.enabled,
        settings_json=excluded.settings_json
    `);
    this.updateAgentStatusStatement = db.prepare(
      `UPDATE agents SET status=? WHERE name=?`
    );
    this.updateAgentStatement = db.prepare(`
      UPDATE agents
      SET model=?, enabled=?, settings_json=?
      WHERE name=?
    `);
    this.deleteAgentStatement = db.prepare(`DELETE FROM agents WHERE name=?`);
    this.getAgentStatement = db.prepare(`SELECT * FROM agents WHERE name=?`);
    this.listAgentsStatement = db.prepare(`SELECT * FROM agents ORDER BY name`);
    this.deleteWorkspaceAgentsByAgentStatement = db.prepare(
      `DELETE FROM workspace_agents WHERE agent_name=?`
    );
    this.deleteAgentSessionsByAgentStatement = db.prepare(
      `DELETE FROM agent_sessions WHERE agent_name=?`
    );
    this.deleteRunsByAgentStatement = db.prepare(
      `DELETE FROM runs WHERE agent_name=?`
    );
    this.deleteMessagesByAgentStatement = db.prepare(
      `DELETE FROM messages WHERE agent_name=?`
    );
    this.clearDiscordDefaultAgentStatement = db.prepare(`
      UPDATE workspace_discord_bindings
      SET default_agent = NULL
      WHERE default_agent=?
    `);

    // ---- Workspace statements ----
    this.insertWorkspaceStatement = db.prepare(`
      INSERT INTO workspaces (
        id, name, workdir, context_injection_enabled,
        is_sidebar_active, sort_order, is_active, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this.getWorkspaceStatement = db.prepare(`SELECT * FROM workspaces WHERE id=?`);
    this.getWorkspaceByNameStatement = db.prepare(`SELECT * FROM workspaces WHERE name=?`);
    this.listWorkspacesStatement = db.prepare(`
      SELECT * FROM workspaces
      ORDER BY is_sidebar_active DESC, sort_order ASC, created_at ASC, name ASC
    `);
    this.getActiveWorkspaceStatement = db.prepare(
      `SELECT * FROM workspaces WHERE is_active=1 LIMIT 1`
    );
    this.setActiveWorkspaceStatement = db.prepare(
      `UPDATE workspaces SET is_active=CASE WHEN id=? THEN 1 ELSE 0 END`
    );
    this.clearActiveWorkspaceStatement = db.prepare(
      `UPDATE workspaces SET is_active=0`
    );
    this.updateWorkspaceStatement = db.prepare(
      `UPDATE workspaces
       SET name=?,
           workdir=?,
           context_injection_enabled=?,
           is_sidebar_active=?,
           sort_order=?
       WHERE id=?`
    );
    this.countSidebarActiveWorkspacesStatement = db.prepare(`
      SELECT COUNT(*) AS count
      FROM workspaces
      WHERE is_sidebar_active = 1
    `);
    this.maxWorkspaceSortOrderStatement = db.prepare(`
      SELECT MAX(sort_order) AS max_sort_order
      FROM workspaces
      WHERE is_sidebar_active = ?
    `);
    this.updateWorkspacePlacementStatement = db.prepare(`
      UPDATE workspaces
      SET is_sidebar_active=?, sort_order=?
      WHERE id=?
    `);
    this.deleteWorkspaceStatement = db.prepare(`DELETE FROM workspaces WHERE id=?`);
    this.getAppSettingStatement = db.prepare(`SELECT value FROM app_settings WHERE key=?`);
    this.upsertAppSettingStatement = db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=excluded.updated_at
    `);

    this._normalizeWorkspaceSidebarState();

    // ---- AgentSession statements ----
    this.upsertAgentSessionStatement = db.prepare(`
      INSERT INTO agent_sessions (agent_name, workspace_id, provider_session_ref, model, workdir, last_run_state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(agent_name, workspace_id) DO UPDATE SET
        provider_session_ref=excluded.provider_session_ref,
        model=COALESCE(excluded.model, model),
        workdir=COALESCE(excluded.workdir, workdir),
        last_run_state=COALESCE(excluded.last_run_state, last_run_state),
        updated_at=excluded.updated_at
    `);
    this.getAgentSessionStatement = db.prepare(
      `SELECT * FROM agent_sessions WHERE agent_name=? AND workspace_id=?`
    );
    this.listAgentSessionsByWorkspaceStatement = db.prepare(
      `SELECT * FROM agent_sessions WHERE workspace_id=?`
    );
    this.listAllAgentSessionsStatement = db.prepare(
      `SELECT * FROM agent_sessions ORDER BY updated_at DESC`
    );

    // ---- Run statements ----
    this.insertRunStatement = db.prepare(`
      INSERT INTO runs (id, agent_name, workspace_id, prompt, status, source, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, datetime('now'))
    `);
    this.completeRunStatement = db.prepare(`
      UPDATE runs SET status=?, input_tokens=?, output_tokens=?, cost_usd=?, completed_at=datetime('now')
      WHERE id=?
    `);
    this.recoverRunStatement = db.prepare(`
      UPDATE runs
      SET status=?,
          completed_at=COALESCE(completed_at, datetime('now'))
      WHERE id=? AND status='running'
    `);
    this.getRunStatement = db.prepare(`SELECT * FROM runs WHERE id=?`);
    this.listRunsStatement = db.prepare(
      `SELECT * FROM runs WHERE agent_name=? AND workspace_id=? ORDER BY started_at DESC LIMIT ?`
    );

    // ---- Message statements ----
    this.insertMessageStatement = db.prepare(`
      INSERT INTO messages (agent_name, workspace_id, run_id, role, content, metadata, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this.listMessagesStatement = db.prepare(`
      SELECT * FROM (
        SELECT rowid, * FROM messages WHERE agent_name=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?
      ) ORDER BY created_at ASC, rowid ASC
    `);

    // ---- Discord binding statements ----
    this.upsertDiscordBindingStatement = db.prepare(`
      INSERT INTO workspace_discord_bindings (discord_channel_id, workspace_id, default_agent, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(discord_channel_id) DO UPDATE SET
        workspace_id=excluded.workspace_id,
        default_agent=COALESCE(excluded.default_agent, default_agent)
    `);
    this.getDiscordBindingStatement = db.prepare(
      `SELECT * FROM workspace_discord_bindings WHERE discord_channel_id=?`
    );
    this.listDiscordBindingsByWorkspaceStatement = db.prepare(
      `SELECT * FROM workspace_discord_bindings WHERE workspace_id=? ORDER BY created_at ASC`
    );
    this.deleteDiscordBindingsByWorkspaceStatement = db.prepare(
      `DELETE FROM workspace_discord_bindings WHERE workspace_id=?`
    );

    // ---- Git checkpoint / audit statements ----
    this.insertGitCheckpointStatement = db.prepare(`
      INSERT INTO git_checkpoints (
        id, workspace_id, agent_name, run_id, kind, label, workdir,
        git_head_sha, stash_ref, status_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this.getGitCheckpointStatement = db.prepare(
      `SELECT * FROM git_checkpoints WHERE id=?`
    );
    this.listGitCheckpointsByWorkspaceStatement = db.prepare(`
      SELECT * FROM git_checkpoints
      WHERE workspace_id=?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.insertOperationAuditStatement = db.prepare(`
      INSERT INTO operation_audits (
        id, workspace_id, agent_name, operation_type, target_ref, status,
        dry_run, requested_by, source, details_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this.listOperationAuditsStatement = db.prepare(`
      SELECT * FROM operation_audits
      WHERE (? IS NULL OR workspace_id=?)
      ORDER BY created_at DESC
      LIMIT ?
    `);

    // ---- Workspace agents statements (PTY-first membership) ----
    this.upsertWorkspaceAgentStatement = db.prepare(`
      INSERT INTO workspace_agents (workspace_id, agent_name, is_parent, added_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(workspace_id, agent_name) DO UPDATE SET
        is_parent=CASE WHEN excluded.is_parent=1 THEN 1 ELSE is_parent END
    `);
    this.removeWorkspaceAgentStatement = db.prepare(
      `DELETE FROM workspace_agents WHERE workspace_id=? AND agent_name=? AND is_parent=0`
    );
    this.listWorkspaceAgentsStatement = db.prepare(
      `SELECT * FROM workspace_agents WHERE workspace_id=? ORDER BY is_parent DESC, added_at ASC`
    );
    this.getWorkspaceParentAgentStatement = db.prepare(
      `SELECT agent_name FROM workspace_agents WHERE workspace_id=? AND is_parent=1 LIMIT 1`
    );
    this.countWorkspaceAgentsStatement = db.prepare(
      `SELECT COUNT(*) AS cnt FROM workspace_agents WHERE workspace_id=?`
    );
    this.deleteWorkspaceAgentsByWorkspaceStatement = db.prepare(
      `DELETE FROM workspace_agents WHERE workspace_id=?`
    );
    this.deleteAgentSessionsByWorkspaceStatement = db.prepare(
      `DELETE FROM agent_sessions WHERE workspace_id=?`
    );
    this.deleteRunsByWorkspaceStatement = db.prepare(
      `DELETE FROM runs WHERE workspace_id=?`
    );
    this.deleteMessagesByWorkspaceStatement = db.prepare(
      `DELETE FROM messages WHERE workspace_id=?`
    );

    // ---- Workspace-level messages (cross-agent timeline) ----
    this.listWorkspaceMessagesStatement = db.prepare(`
      SELECT * FROM (
        SELECT rowid, * FROM messages WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?
      ) ORDER BY created_at ASC, rowid ASC
    `);
  }

  // ---------------------------------------------------------------------------
  // Legacy session methods (legacy bridge compatibility — bridge.js uses these)
  // ---------------------------------------------------------------------------

  createSession({ title, discordChannelId = null, discordChannelName = null, model, reasoningEffort, profile, workdir, serviceTier }) {
    const now = new Date().toISOString();
    const session = {
      id: randomUUID(),
      title: title || "Untitled session",
      codexThreadId: null,
      providerSessionRef: null,
      status: "idle",
      discordChannelId,
      discordChannelName,
      model,
      reasoningEffort,
      profile,
      workdir,
      serviceTier,
      fastMode: serviceTier === "fast",
      userPromptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.createSessionStatement.run(
      session.id, session.title, session.codexThreadId, session.status,
      session.discordChannelId, session.discordChannelName,
      session.model, session.reasoningEffort, session.profile, session.workdir, session.serviceTier,
      session.createdAt, session.updatedAt,
    );
    return session;
  }

  listSessions() {
    return this.listSessionsStatement.all().map(parseSession);
  }

  getSession(sessionId) {
    return parseSession(this.getSessionStatement.get(sessionId));
  }

  updateSession(sessionId, patch) {
    const current = this.getSession(sessionId);
    if (!current) return null;

    const next = {
      ...current,
      ...patch,
      fastMode: patch.serviceTier != null ? patch.serviceTier === "fast" : current.serviceTier === "fast",
      updatedAt: new Date().toISOString(),
    };

    this.updateSessionStatement.run(
      next.title,
      next.codexThreadId,
      next.providerSessionRef ?? next.codexThreadId,
      next.status,
      next.discordChannelId,
      next.discordChannelName,
      next.model,
      next.reasoningEffort,
      next.profile,
      next.workdir,
      next.serviceTier,
      next.updatedAt,
      next.id,
    );
    return next;
  }

  bindDiscordChannel(sessionId, channelId, channelName = null) {
    return this.updateSession(sessionId, { discordChannelId: channelId, discordChannelName: channelName });
  }

  findSessionByDiscordChannel(channelId) {
    return parseSession(this.findByDiscordChannelStatement.get(channelId));
  }

  listSessionsByDiscordChannel(channelId) {
    return this.listByDiscordChannelStatement.all(channelId).map(parseSession);
  }

  deleteSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    this.deleteSessionEventsStatement.run(sessionId);
    this.deleteSessionStatement.run(sessionId);
    return session;
  }

  addEvent({ sessionId, source, eventType, payload }) {
    const event = {
      id: randomUUID(),
      sessionId,
      source,
      eventType,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.insertEventStatement.run(
      event.id, event.sessionId, event.source, event.eventType,
      JSON.stringify(event.payload), event.createdAt,
    );
    return event;
  }

  listEvents(sessionId, limit = 200) {
    return this.listEventsStatement.all(sessionId, limit).map(parseEvent);
  }

  // ---------------------------------------------------------------------------
  // Agent methods
  // ---------------------------------------------------------------------------

  upsertAgent({ name, type, model, status = "stopped", enabled = true, settings = null }) {
    this.upsertAgentStatement.run(
      name,
      type,
      model ?? null,
      status ?? "stopped",
      enabled ? 1 : 0,
      settings ? JSON.stringify(settings) : null,
    );
    return parseAgent(this.getAgentStatement.get(name));
  }

  updateAgentStatus(name, status) {
    this.updateAgentStatusStatement.run(status, name);
  }

  updateAgent(name, { model, enabled, settings }) {
    const current = this.getAgent(name);
    if (!current) return null;
    this.updateAgentStatement.run(
      model ?? current.model ?? null,
      enabled == null ? (current.enabled ? 1 : 0) : (enabled ? 1 : 0),
      JSON.stringify(settings ?? current.settings ?? {}),
      name,
    );
    return this.getAgent(name);
  }

  deleteAgent(name) {
    const current = this.getAgent(name);
    if (!current) return null;
    this.deleteWorkspaceAgentsByAgentStatement.run(name);
    this.deleteAgentSessionsByAgentStatement.run(name);
    this.deleteRunsByAgentStatement.run(name);
    this.deleteMessagesByAgentStatement.run(name);
    this.clearDiscordDefaultAgentStatement.run(name);
    this.deleteAgentStatement.run(name);
    return current;
  }

  getAgent(name) {
    return parseAgent(this.getAgentStatement.get(name));
  }

  listAgents() {
    return this.listAgentsStatement.all().map(parseAgent);
  }

  // ---------------------------------------------------------------------------
  // Workspace methods
  // ---------------------------------------------------------------------------

  createWorkspace({ id, name, workdir, contextInjectionEnabled = null, isSidebarActive = null } = {}) {
    const isFirstWorkspace = this.listWorkspaces().length === 0 ? 1 : 0;
    const resolvedSidebarActive =
      isSidebarActive == null
        ? (isFirstWorkspace ? 1 : (this.countSidebarActiveWorkspaces() < MAX_ACTIVE_WORKSPACES ? 1 : 0))
        : (isSidebarActive ? 1 : 0);
    const sortOrder = this.getNextWorkspaceSortOrder(Boolean(resolvedSidebarActive));
    this.insertWorkspaceStatement.run(
      id ?? randomUUID(),
      name,
      workdir ?? null,
      contextInjectionEnabled == null ? null : (contextInjectionEnabled ? 1 : 0),
      resolvedSidebarActive,
      sortOrder,
      isFirstWorkspace,
    );
    return parseWorkspace(this.getWorkspaceByNameStatement.get(name));
  }

  getWorkspace(id) {
    return parseWorkspace(this.getWorkspaceStatement.get(id));
  }

  getWorkspaceByName(name) {
    return parseWorkspace(this.getWorkspaceByNameStatement.get(name));
  }

  getActiveWorkspace() {
    return parseWorkspace(this.getActiveWorkspaceStatement.get());
  }

  listWorkspaces() {
    return this.listWorkspacesStatement.all().map(parseWorkspace);
  }

  countSidebarActiveWorkspaces() {
    return Number(this.countSidebarActiveWorkspacesStatement.get()?.count || 0);
  }

  getNextWorkspaceSortOrder(isSidebarActive) {
    const row = this.maxWorkspaceSortOrderStatement.get(isSidebarActive ? 1 : 0);
    if (row?.max_sort_order == null) return 0;
    const value = Number(row?.max_sort_order);
    return Number.isFinite(value) ? value + 1 : 0;
  }

  setActiveWorkspace(id) {
    if (!id) {
      this.clearActiveWorkspaceStatement.run();
      return null;
    }
    this.setActiveWorkspaceStatement.run(id);
    return this.getWorkspace(id);
  }

  updateWorkspace(id, {
    name,
    workdir,
    contextInjectionEnabled,
    isSidebarActive,
    sortOrder,
  } = {}) {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    this.updateWorkspaceStatement.run(
      name ?? ws.name,
      workdir === undefined ? ws.workdir : (workdir ?? null),
      contextInjectionEnabled === undefined
        ? (ws.contextInjectionEnabled == null ? null : (ws.contextInjectionEnabled ? 1 : 0))
        : contextInjectionEnabled == null
          ? null
          : (contextInjectionEnabled ? 1 : 0),
      isSidebarActive === undefined ? (ws.isSidebarActive ? 1 : 0) : (isSidebarActive ? 1 : 0),
      sortOrder === undefined
        ? (Number.isFinite(Number(ws.sortOrder)) ? Number(ws.sortOrder) : 0)
        : Math.max(0, Number(sortOrder) || 0),
      id,
    );
    return this.getWorkspace(id);
  }

  saveWorkspaceLayout(layout = []) {
    const items = Array.isArray(layout) ? layout : [];
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        this.updateWorkspacePlacementStatement.run(
          item.isSidebarActive ? 1 : 0,
          Math.max(0, Number(item.sortOrder) || 0),
          item.id,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this._normalizeWorkspaceSidebarState();
    return this.listWorkspaces();
  }

  deleteWorkspace(id) {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    const remainingWorkspaces = this.listWorkspaces().filter((workspace) => workspace.id !== id);
    const fallbackWorkspace = remainingWorkspaces[0] ?? null;
    if (ws.isActive && fallbackWorkspace) {
      this.setActiveWorkspaceStatement.run(fallbackWorkspace.id);
    } else if (ws.isActive) {
      this.clearActiveWorkspaceStatement.run();
    }
    this.deleteDiscordBindingsByWorkspaceStatement.run(id);
    this.deleteMessagesByWorkspaceStatement.run(id);
    this.deleteRunsByWorkspaceStatement.run(id);
    this.deleteAgentSessionsByWorkspaceStatement.run(id);
    this.deleteWorkspaceAgentsByWorkspaceStatement.run(id);
    this.deleteWorkspaceStatement.run(id);
    this._normalizeWorkspaceSidebarState();
    return ws;
  }

  getAppSettings() {
    return {
      defaultWorkdir: this.getAppSettingStatement.get("default_workdir")?.value ?? "",
    };
  }

  updateAppSettings({ defaultWorkdir } = {}) {
    if (defaultWorkdir !== undefined) {
      this.upsertAppSettingStatement.run("default_workdir", defaultWorkdir ?? "");
    }
    return this.getAppSettings();
  }

  // ---------------------------------------------------------------------------
  // AgentSession methods
  // ---------------------------------------------------------------------------

  upsertAgentSession({ agentName, workspaceId, providerSessionRef, model, workdir, lastRunState }) {
    this.upsertAgentSessionStatement.run(
      agentName, workspaceId, providerSessionRef ?? null,
      model ?? null, workdir ?? null, lastRunState ?? null,
    );
    return parseAgentSession(this.getAgentSessionStatement.get(agentName, workspaceId));
  }

  getAgentSession(agentName, workspaceId) {
    return parseAgentSession(this.getAgentSessionStatement.get(agentName, workspaceId));
  }

  listAgentSessionsByWorkspace(workspaceId) {
    return this.listAgentSessionsByWorkspaceStatement.all(workspaceId).map(parseAgentSession);
  }

  listAllAgentSessions() {
    return this.listAllAgentSessionsStatement.all().map(parseAgentSession);
  }

  // ---------------------------------------------------------------------------
  // Run methods
  // ---------------------------------------------------------------------------

  startRun({ agentName, workspaceId, prompt, source }) {
    const id = randomUUID();
    this.insertRunStatement.run(id, agentName, workspaceId, prompt ?? null, source ?? null);
    return parseRun(this.getRunStatement.get(id));
  }

  completeRun(id, { status, inputTokens, outputTokens, costUsd }) {
    this.completeRunStatement.run(
      status ?? "completed",
      inputTokens ?? null,
      outputTokens ?? null,
      costUsd ?? null,
      id,
    );
    return parseRun(this.getRunStatement.get(id));
  }

  recoverRun(id, status = "interrupted") {
    this.recoverRunStatement.run(status ?? "interrupted", id);
    return parseRun(this.getRunStatement.get(id));
  }

  listRuns(agentName, workspaceId, limit = 50) {
    return this.listRunsStatement.all(agentName, workspaceId, limit).map(parseRun);
  }

  // ---------------------------------------------------------------------------
  // Message methods
  // ---------------------------------------------------------------------------

  addMessage({ agentName, workspaceId, runId, role, content, metadata, source }) {
    this.insertMessageStatement.run(
      agentName, workspaceId, runId ?? null, role,
      content ?? null,
      metadata ? JSON.stringify(metadata) : null,
      source ?? null,
    );
  }

  listMessages(agentName, workspaceId, limit = 200) {
    return this.listMessagesStatement.all(agentName, workspaceId, limit).map(parseMessage);
  }

  /** Cross-agent messages for a workspace, time-sorted. */
  listWorkspaceMessages(workspaceId, limit = 100) {
    return this.listWorkspaceMessagesStatement.all(workspaceId, limit).map(parseMessage);
  }

  // ---------------------------------------------------------------------------
  // Workspace agents methods (PTY-first membership)
  // ---------------------------------------------------------------------------

  addWorkspaceAgent({ workspaceId, agentName, isParent = false }) {
    this.upsertWorkspaceAgentStatement.run(workspaceId, agentName, isParent ? 1 : 0);
    return { workspaceId, agentName, isParent };
  }

  removeWorkspaceAgent({ workspaceId, agentName }) {
    // Only removes non-parent agents (parent is locked)
    const result = this.removeWorkspaceAgentStatement.run(workspaceId, agentName);
    return result.changes > 0;
  }

  listWorkspaceAgents(workspaceId) {
    return this.listWorkspaceAgentsStatement.all(workspaceId).map((row) => ({
      workspaceId: row.workspace_id,
      agentName: row.agent_name,
      isParent: Boolean(row.is_parent),
      addedAt: row.added_at,
    }));
  }

  getWorkspaceParentAgent(workspaceId) {
    const row = this.getWorkspaceParentAgentStatement.get(workspaceId);
    return row?.agent_name ?? null;
  }

  countWorkspaceAgents(workspaceId) {
    return this.countWorkspaceAgentsStatement.get(workspaceId)?.cnt ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Discord binding methods
  // ---------------------------------------------------------------------------

  upsertDiscordBinding({ discordChannelId, workspaceId, defaultAgent }) {
    this.upsertDiscordBindingStatement.run(discordChannelId, workspaceId, defaultAgent ?? null);
    return parseDiscordBinding(this.getDiscordBindingStatement.get(discordChannelId));
  }

  getDiscordBinding(discordChannelId) {
    return parseDiscordBinding(this.getDiscordBindingStatement.get(discordChannelId));
  }

  deleteDiscordBindingsByWorkspace(workspaceId) {
    this.deleteDiscordBindingsByWorkspaceStatement.run(workspaceId);
  }

  listDiscordBindingsByWorkspace(workspaceId) {
    return this.listDiscordBindingsByWorkspaceStatement.all(workspaceId).map(parseDiscordBinding);
  }

  createGitCheckpoint({
    id,
    workspaceId,
    agentName,
    runId,
    kind,
    label,
    workdir,
    gitHeadSha,
    stashRef,
    status,
  }) {
    this.insertGitCheckpointStatement.run(
      id,
      workspaceId,
      agentName ?? null,
      runId ?? null,
      kind,
      label ?? "",
      workdir ?? null,
      gitHeadSha ?? null,
      stashRef ?? null,
      JSON.stringify(status ?? {}),
    );
    return parseGitCheckpoint(this.getGitCheckpointStatement.get(id));
  }

  getGitCheckpoint(id) {
    return parseGitCheckpoint(this.getGitCheckpointStatement.get(id));
  }

  listGitCheckpointsByWorkspace(workspaceId, limit = 20) {
    return this.listGitCheckpointsByWorkspaceStatement.all(workspaceId, limit).map(parseGitCheckpoint);
  }

  addOperationAudit({
    workspaceId = null,
    agentName = null,
    operationType,
    targetRef = null,
    status,
    dryRun = false,
    requestedBy = null,
    source = null,
    details = {},
  }) {
    const id = randomUUID();
    this.insertOperationAuditStatement.run(
      id,
      workspaceId,
      agentName,
      operationType,
      targetRef,
      status,
      dryRun ? 1 : 0,
      requestedBy,
      source,
      JSON.stringify(details ?? {}),
    );
    return parseOperationAudit(this.db.prepare(`SELECT * FROM operation_audits WHERE id=?`).get(id));
  }

  listOperationAudits(workspaceId = null, limit = 50) {
    return this.listOperationAuditsStatement.all(workspaceId, workspaceId, limit).map(parseOperationAudit);
  }

  _normalizeWorkspaceSidebarState() {
    const rows = this.db.prepare(`
      SELECT id, is_sidebar_active, sort_order, is_active, created_at, name
      FROM workspaces
      ORDER BY is_active DESC, created_at ASC, name ASC
    `).all();
    if (!rows.length) return;

    const hasSidebarActive = rows.some((row) => Number(row.is_sidebar_active) === 1);
    const uniqueSortOrders = new Set(rows.map((row) => Number(row.sort_order)).filter(Number.isFinite));
    const sortLooksUninitialized = uniqueSortOrders.size <= 1;

    const normalizedRows = rows.map((row, index) => ({
      id: row.id,
      isSidebarActive: hasSidebarActive
        ? Boolean(row.is_sidebar_active)
        : index === 0,
      sortOrder: sortLooksUninitialized ? index : Math.max(0, Number(row.sort_order) || 0),
      createdAt: row.created_at,
      name: row.name,
    }));

    const byCurrentOrder = (left, right) =>
      left.sortOrder - right.sortOrder ||
      String(left.createdAt || "").localeCompare(String(right.createdAt || "")) ||
      String(left.name || "").localeCompare(String(right.name || ""));

    const active = normalizedRows.filter((row) => row.isSidebarActive).sort(byCurrentOrder);
    const inactive = normalizedRows.filter((row) => !row.isSidebarActive).sort(byCurrentOrder);
    const cappedActive = active.slice(0, MAX_ACTIVE_WORKSPACES).map((row, index) => ({
      ...row,
      isSidebarActive: true,
      sortOrder: index,
    }));
    const normalizedInactive = [...active.slice(MAX_ACTIVE_WORKSPACES), ...inactive].map((row, index) => ({
      ...row,
      isSidebarActive: false,
      sortOrder: index,
    }));

    this.db.exec("BEGIN");
    try {
      for (const row of [...cappedActive, ...normalizedInactive]) {
        this.updateWorkspacePlacementStatement.run(row.isSidebarActive ? 1 : 0, row.sortOrder, row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
