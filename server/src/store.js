import { randomUUID } from "node:crypto";

function parseSession(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    codexThreadId: row.codex_thread_id,
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
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

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
    this.createSessionStatement = db.prepare(`
      INSERT INTO sessions (
        id,
        title,
        codex_thread_id,
        status,
        discord_channel_id,
        discord_channel_name,
        model,
        model_reasoning_effort,
        profile,
        workdir,
        service_tier,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateSessionStatement = db.prepare(`
      UPDATE sessions
      SET
        title = ?,
        codex_thread_id = ?,
        status = ?,
        discord_channel_id = ?,
        discord_channel_name = ?,
        model = ?,
        model_reasoning_effort = ?,
        profile = ?,
        workdir = ?,
        service_tier = ?,
        updated_at = ?
      WHERE id = ?
    `);
    this.getSessionStatement = db.prepare(`
      SELECT ${sessionSelectColumns}
      FROM sessions
      WHERE id = ?
    `);
    this.listSessionsStatement = db.prepare(`
      SELECT ${sessionSelectColumns}
      FROM sessions
      ORDER BY updated_at DESC
    `);
    this.findByDiscordChannelStatement = db.prepare(`
      SELECT ${sessionSelectColumns}
      FROM sessions
      WHERE discord_channel_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    this.listByDiscordChannelStatement = db.prepare(`
      SELECT ${sessionSelectColumns}
      FROM sessions
      WHERE discord_channel_id = ?
      ORDER BY updated_at DESC
    `);
    this.deleteSessionEventsStatement = db.prepare(`
      DELETE FROM session_events WHERE session_id = ?
    `);
    this.deleteSessionStatement = db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `);
    this.insertEventStatement = db.prepare(`
      INSERT INTO session_events (id, session_id, source, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.listEventsStatement = db.prepare(`
      SELECT * FROM (
        SELECT * FROM session_events
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
      ORDER BY created_at ASC
    `);
  }

  createSession({
    title,
    discordChannelId = null,
    discordChannelName = null,
    model,
    reasoningEffort,
    profile,
    workdir,
    serviceTier,
  }) {
    const now = new Date().toISOString();
    const session = {
      id: randomUUID(),
      title: title || "Untitled session",
      codexThreadId: null,
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
      session.id,
      session.title,
      session.codexThreadId,
      session.status,
      session.discordChannelId,
      session.discordChannelName,
      session.model,
      session.reasoningEffort,
      session.profile,
      session.workdir,
      session.serviceTier,
      session.createdAt,
      session.updatedAt,
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
    if (!current) {
      return null;
    }

    const next = {
      ...current,
      ...patch,
      fastMode:
        patch.serviceTier != null
          ? patch.serviceTier === "fast"
          : current.serviceTier === "fast",
      updatedAt: new Date().toISOString(),
    };

    this.updateSessionStatement.run(
      next.title,
      next.codexThreadId,
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
    return this.updateSession(sessionId, {
      discordChannelId: channelId,
      discordChannelName: channelName,
    });
  }

  findSessionByDiscordChannel(channelId) {
    return parseSession(this.findByDiscordChannelStatement.get(channelId));
  }

  listSessionsByDiscordChannel(channelId) {
    return this.listByDiscordChannelStatement.all(channelId).map(parseSession);
  }

  deleteSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

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
      event.id,
      event.sessionId,
      event.source,
      event.eventType,
      JSON.stringify(event.payload),
      event.createdAt,
    );

    return event;
  }

  listEvents(sessionId, limit = 200) {
    return this.listEventsStatement.all(sessionId, limit).map(parseEvent);
  }
}
