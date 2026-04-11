import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    // Legacy field — kept for backward compat with codicodi bridge
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
  return {
    name: row.name,
    type: row.type,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
  };
}

function parseWorkspace(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    workdir: row.workdir,
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

    // ---- Legacy session statements (codicodi互換) ----
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
      INSERT INTO agents (name, type, model, status, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET type=excluded.type, model=excluded.model
    `);
    this.updateAgentStatusStatement = db.prepare(
      `UPDATE agents SET status=? WHERE name=?`
    );
    this.getAgentStatement = db.prepare(`SELECT * FROM agents WHERE name=?`);
    this.listAgentsStatement = db.prepare(`SELECT * FROM agents ORDER BY name`);

    // ---- Workspace statements ----
    this.insertWorkspaceStatement = db.prepare(`
      INSERT INTO workspaces (id, name, workdir, is_active, created_at)
      VALUES (?, ?, ?, 0, datetime('now'))
    `);
    this.getWorkspaceStatement = db.prepare(`SELECT * FROM workspaces WHERE id=?`);
    this.getWorkspaceByNameStatement = db.prepare(`SELECT * FROM workspaces WHERE name=?`);
    this.listWorkspacesStatement = db.prepare(`SELECT * FROM workspaces ORDER BY name`);
    this.getActiveWorkspaceStatement = db.prepare(
      `SELECT * FROM workspaces WHERE is_active=1 LIMIT 1`
    );
    this.setActiveWorkspaceStatement = db.prepare(
      `UPDATE workspaces SET is_active=CASE WHEN id=? THEN 1 ELSE 0 END`
    );
    this.updateWorkspaceStatement = db.prepare(
      `UPDATE workspaces SET name=?, workdir=? WHERE id=?`
    );
    this.deleteWorkspaceStatement = db.prepare(`DELETE FROM workspaces WHERE id=?`);

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

    // ---- Run statements ----
    this.insertRunStatement = db.prepare(`
      INSERT INTO runs (id, agent_name, workspace_id, prompt, status, source, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, datetime('now'))
    `);
    this.completeRunStatement = db.prepare(`
      UPDATE runs SET status=?, input_tokens=?, output_tokens=?, cost_usd=?, completed_at=datetime('now')
      WHERE id=?
    `);
    this.getRunStatement = db.prepare(`SELECT * FROM runs WHERE id=?`);
    this.listRunsStatement = db.prepare(
      `SELECT * FROM runs WHERE agent_name=? AND workspace_id=? ORDER BY started_at DESC LIMIT ?`
    );
    this.costSummaryStatement = db.prepare(`
      SELECT
        agent_name,
        COUNT(*) AS run_count,
        COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(cost_usd), 0)      AS total_cost_usd
      FROM runs
      WHERE status='completed'
        AND (? IS NULL OR agent_name=?)
        AND (? IS NULL OR workspace_id=?)
        AND (? IS NULL OR started_at >= ?)
      GROUP BY agent_name
      ORDER BY total_cost_usd DESC
    `);

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

    // ---- Workspace-level messages (cross-agent timeline) ----
    this.listWorkspaceMessagesStatement = db.prepare(`
      SELECT * FROM (
        SELECT rowid, * FROM messages WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?
      ) ORDER BY created_at ASC, rowid ASC
    `);
  }

  // ---------------------------------------------------------------------------
  // Legacy session methods (codicodi互換 — bridge.js が使う)
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

  upsertAgent({ name, type, model }) {
    this.upsertAgentStatement.run(name, type, model ?? null, "stopped");
    return parseAgent(this.getAgentStatement.get(name));
  }

  updateAgentStatus(name, status) {
    this.updateAgentStatusStatement.run(status, name);
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

  createWorkspace({ id, name, workdir }) {
    this.insertWorkspaceStatement.run(id ?? randomUUID(), name, workdir ?? null);
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

  setActiveWorkspace(id) {
    this.setActiveWorkspaceStatement.run(id);
    return this.getWorkspace(id);
  }

  updateWorkspace(id, { name, workdir }) {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    this.updateWorkspaceStatement.run(name ?? ws.name, workdir ?? ws.workdir, id);
    return this.getWorkspace(id);
  }

  deleteWorkspace(id) {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    this.deleteWorkspaceStatement.run(id);
    return ws;
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

  listRuns(agentName, workspaceId, limit = 50) {
    return this.listRunsStatement.all(agentName, workspaceId, limit).map(parseRun);
  }

  /**
   * Aggregate cost summary.
   * @param {{ agentName?: string, workspaceId?: string, since?: string }} opts  since = ISO date string
   */
  getCostSummary({ agentName, workspaceId, since } = {}) {
    const rows = this.costSummaryStatement.all(
      agentName ?? null, agentName ?? null,
      workspaceId ?? null, workspaceId ?? null,
      since ?? null, since ?? null,
    );
    return rows.map((r) => ({
      agentName: r.agent_name,
      runCount: r.run_count,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalCostUsd: r.total_cost_usd,
      totalCostJpy: Math.round(r.total_cost_usd * 150 * 10) / 10,
    }));
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
}
