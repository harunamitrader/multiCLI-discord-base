function isCancelledError(error) {
  return Boolean(error?.cancelled || error?.name === "CodexRunCancelledError");
}

function formatSessionTimestamp(value = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .format(value)
    .replace(" ", " ");
}

function splitAttachments(attachments = []) {
  const normalized = Array.isArray(attachments) ? attachments : [];
  return {
    images: normalized.filter((attachment) => attachment.kind === "image"),
    files: normalized.filter((attachment) => attachment.kind !== "image"),
  };
}

function buildPromptWithAttachments(text, attachments = []) {
  const trimmedText = String(text || "").trim();
  const { images, files } = splitAttachments(attachments);
  const sections = [];

  if (trimmedText) {
    sections.push(trimmedText);
  }

  if (files.length > 0) {
    sections.push(
      `Files:\n${files.map((attachment) => `- ${attachment.savedPath}`).join("\n")}`,
    );
  }

  if (!trimmedText && images.length > 0 && files.length === 0) {
    sections.push("Please inspect the attached image files.");
  }

  if (!trimmedText && images.length > 0 && files.length > 0) {
    sections.unshift("Please inspect the attached images and files.");
  }

  return sections.join("\n\n").trim();
}

function buildAssistantPayload(job, text, isFinal) {
  return {
    role: "assistant",
    text,
    isFinal,
    replyToDiscordMessageId:
      isFinal && job.source === "discord" ? job.discordMessageId || null : null,
  };
}

export class BridgeService {
  constructor({ store, bus, codex, config, attachments }) {
    this.store = store;
    this.bus = bus;
    this.codex = codex;
    this.config = config;
    this.attachments = attachments;
    this.sessionQueues = new Map();
  }

  listSessions() {
    return this.store.listSessions();
  }

  getRuntimeInfo() {
    return {
      codexVersion: this.config.codexVersion,
      workdir: this.config.codexWorkdir,
      defaultProfile: this.config.codexDefaults.profile,
      availableModels: this.config.availableModels,
      defaults: {
        model: this.config.codexDefaults.model,
        reasoningEffort: this.config.codexDefaults.reasoningEffort,
        fastMode: this.config.codexDefaults.serviceTier === "fast",
        serviceTier: this.config.codexDefaults.serviceTier,
        profile: this.config.codexDefaults.profile,
      },
      attachments: {
        maxAttachmentsPerMessage: this.config.maxAttachmentsPerMessage,
        maxAttachmentBytes: this.config.maxAttachmentBytes,
      },
    };
  }

  getSession(sessionId) {
    return this.store.getSession(sessionId);
  }

  getSessionDetail(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    return {
      session,
      events: this.store.listEvents(sessionId),
    };
  }

  findSessionByDiscordChannel(channelId) {
    return this.store.findSessionByDiscordChannel(channelId);
  }

  getModelDefinition(modelSlug) {
    return (
      this.config.availableModels.find((model) => model.slug === modelSlug) ||
      this.config.availableModels[0] ||
      null
    );
  }

  normalizeSessionSettings(input, currentSession = null) {
    const desiredModel =
      input.model || currentSession?.model || this.config.codexDefaults.model;
    const modelDefinition = this.getModelDefinition(desiredModel);
    if (!modelDefinition) {
      throw new Error(`Unsupported model: ${desiredModel}`);
    }

    const supportedReasoningLevels = modelDefinition.supportedReasoningLevels.map(
      (level) => level.effort,
    );
    const desiredReasoning =
      input.reasoningEffort ??
      currentSession?.reasoningEffort ??
      this.config.codexDefaults.reasoningEffort;
    const reasoningEffort = supportedReasoningLevels.includes(desiredReasoning)
      ? desiredReasoning
      : modelDefinition.defaultReasoningLevel;
    const serviceTierInput =
      input.serviceTier ??
      (input.fastMode == null ? undefined : input.fastMode ? "fast" : "auto") ??
      currentSession?.serviceTier ??
      this.config.codexDefaults.serviceTier;
    const serviceTier = serviceTierInput === "fast" ? "fast" : "auto";
    const profile =
      input.profile ??
      currentSession?.profile ??
      this.config.codexDefaults.profile ??
      "default";

    return {
      model: modelDefinition.slug,
      reasoningEffort,
      serviceTier,
      profile,
      fastMode: serviceTier === "fast",
    };
  }

  resolveSessionTitle(title) {
    const normalizedTitle = title?.trim();
    if (
      normalizedTitle &&
      normalizedTitle.toLowerCase() !== "new session"
    ) {
      return normalizedTitle;
    }

    return `Session ${formatSessionTimestamp()}`;
  }

  createSession({
    title,
    discordChannelId = null,
    discordChannelName = null,
    model,
    reasoningEffort,
    profile,
    serviceTier,
    fastMode,
  }) {
    const clearedSessions = discordChannelId
      ? this.reassignDiscordChannel(discordChannelId)
      : [];
    const settings = this.normalizeSessionSettings({
      model,
      reasoningEffort,
      profile,
      serviceTier,
      fastMode,
    });
    const session = this.store.createSession({
      title: this.resolveSessionTitle(title),
      discordChannelId,
      discordChannelName,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      profile: settings.profile,
      serviceTier: settings.serviceTier,
    });

    for (const clearedSession of clearedSessions) {
      this.bus.publish("session.updated", clearedSession);
    }
    this.bus.publish("session.created", session);
    return session;
  }

  renameSession(sessionId, title) {
    const normalizedTitle = title?.trim();
    if (!normalizedTitle) {
      throw new Error("title is required");
    }

    const updated = this.store.updateSession(sessionId, {
      title: normalizedTitle,
    });
    if (!updated) {
      return null;
    }

    this.bus.publish("session.updated", updated);
    return updated;
  }

  updateSessionSettings(sessionId, patch) {
    const currentSession = this.getSession(sessionId);
    if (!currentSession) {
      return null;
    }

    const settings = this.normalizeSessionSettings(patch, currentSession);
    const updated = this.store.updateSession(sessionId, settings);
    this.bus.publish("session.updated", updated);
    return updated;
  }

  deleteSession(sessionId) {
    this.stopSession(sessionId);

    const session = this.store.deleteSession(sessionId);
    if (!session) {
      return null;
    }

    this.attachments?.deleteSessionAttachments(sessionId).catch(() => null);
    this.sessionQueues.delete(sessionId);
    this.bus.publish("session.deleted", { sessionId, session });
    return session;
  }

  stopSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return { stopped: false, reason: "not_found" };
    }

    const queueState = this.getQueueState(sessionId);
    const clearedQueuedCount = queueState.items.length;
    queueState.items = [];

    let cancelledRunning = false;
    if (queueState.activeRun?.cancel) {
      cancelledRunning = queueState.activeRun.cancel();
    }

    if (!cancelledRunning && clearedQueuedCount === 0) {
      return { stopped: false, reason: "idle" };
    }

    this.updateStatus(sessionId, "stopped", {
      cancelledRunning,
      clearedQueuedCount,
    });

    return {
      stopped: true,
      cancelledRunning,
      clearedQueuedCount,
    };
  }

  bindDiscordChannel(sessionId, channelId) {
    return this.bindDiscordChannelWithName(sessionId, channelId, null);
  }

  bindDiscordChannelWithName(sessionId, channelId, channelName = null) {
    const clearedSessions = this.reassignDiscordChannel(channelId, sessionId);
    const session = this.store.bindDiscordChannel(sessionId, channelId, channelName);
    if (!session) {
      return null;
    }

    for (const clearedSession of clearedSessions) {
      this.bus.publish("session.updated", clearedSession);
    }
    this.bus.publish("session.updated", session);
    return session;
  }

  updateDiscordChannelName(sessionId, channelName) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    const updated = this.store.updateSession(sessionId, {
      discordChannelName: channelName,
    });
    this.bus.publish("session.updated", updated);
    return updated;
  }

  reassignDiscordChannel(channelId, nextSessionId = null) {
    const sessions = this.store.listSessionsByDiscordChannel(channelId);
    const clearedSessions = [];

    for (const session of sessions) {
      if (session.id === nextSessionId) {
        continue;
      }

      const updated = this.store.updateSession(session.id, {
        discordChannelId: null,
        discordChannelName: null,
      });

      if (updated) {
        clearedSessions.push(updated);
      }
    }

    return clearedSessions;
  }

  async handleIncomingMessage({
    sessionId,
    text,
    source,
    discordMessageId = null,
    attachments = [],
  }) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const normalizedText = String(text || "").trim();
    const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
    if (!normalizedText && normalizedAttachments.length === 0) {
      throw new Error("Either text or attachments are required.");
    }

    const userEvent = this.store.addEvent({
      sessionId,
      source,
      eventType: "message.user",
      payload: {
        role: "user",
        text: normalizedText,
        discordMessageId,
        attachments: normalizedAttachments,
      },
    });

    this.bus.publish("message.created", userEvent);

    const queueState = this.getQueueState(sessionId);
    queueState.items.push({
      text: normalizedText,
      source,
      discordMessageId,
      attachments: normalizedAttachments,
    });

    this.updateStatus(sessionId, "queued", {
      queuedCount: queueState.items.length,
    });

    this.processQueue(sessionId).catch((error) => {
      this.publishError(sessionId, error, "system");
    });

    return userEvent;
  }

  getQueueState(sessionId) {
    if (!this.sessionQueues.has(sessionId)) {
      this.sessionQueues.set(sessionId, {
        processing: false,
        items: [],
        activeRun: null,
      });
    }

    return this.sessionQueues.get(sessionId);
  }

  async processQueue(sessionId) {
    const queueState = this.getQueueState(sessionId);
    if (queueState.processing) {
      return;
    }

    queueState.processing = true;

    try {
      while (queueState.items.length > 0) {
        const job = queueState.items.shift();
        await this.runJob(sessionId, job);

        if (queueState.items.length > 0) {
          this.updateStatus(sessionId, "queued", {
            queuedCount: queueState.items.length,
          });
        }
      }
    } finally {
      queueState.processing = false;
    }
  }

  async runJob(sessionId, job) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.updateStatus(sessionId, "running", { source: job.source });

    const queueState = this.getQueueState(sessionId);
    const publishedAssistantItemIds = new Set();
    const publishedCommandItemIds = new Set();
    let pendingAssistantText = null;
    const prompt = buildPromptWithAttachments(job.text, job.attachments);
    const imagePaths = splitAttachments(job.attachments).images.map(
      (attachment) => attachment.savedPath,
    );
    const activeRun = this.codex.runTurn({
      threadId: session.codexThreadId,
      prompt,
      imagePaths,
      sessionConfig: {
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        profile: session.profile,
        serviceTier: session.serviceTier,
      },
      onEvent: (event) => {
        if (event.type === "turn.started") {
          this.updateStatus(sessionId, "waiting_codex", {});
        }

        if (
          event.type === "item.started" &&
          event.item?.type === "command_execution" &&
          event.item?.id &&
          !publishedCommandItemIds.has(event.item.id)
        ) {
          if (pendingAssistantText) {
            const assistantEvent = this.store.addEvent({
              sessionId,
              source: "codex",
              eventType: "message.assistant",
              payload: buildAssistantPayload(job, pendingAssistantText, false),
            });
            this.bus.publish("message.created", assistantEvent);
            pendingAssistantText = null;
          }

          publishedCommandItemIds.add(event.item.id);
          const commandEvent = this.store.addEvent({
            sessionId,
            source: "codex",
            eventType: "command.started",
            payload: {
              command: event.item.command || "",
            },
          });
          this.bus.publish("message.created", commandEvent);
        }

        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          event.item?.id &&
          event.item?.text &&
          !publishedAssistantItemIds.has(event.item.id)
        ) {
          publishedAssistantItemIds.add(event.item.id);
          if (pendingAssistantText) {
            const assistantEvent = this.store.addEvent({
              sessionId,
              source: "codex",
              eventType: "message.assistant",
              payload: buildAssistantPayload(job, pendingAssistantText, false),
            });
            this.bus.publish("message.created", assistantEvent);
          }

          pendingAssistantText = event.item.text;
        }
      },
    });

    queueState.activeRun = activeRun;

    try {
      const result = await activeRun;
      const latestSession = this.getSession(sessionId);

      if (result.threadId && result.threadId !== latestSession?.codexThreadId) {
        const updated = this.store.updateSession(sessionId, {
          codexThreadId: result.threadId,
        });
        this.bus.publish("session.updated", updated);
      }

      if (pendingAssistantText) {
        const assistantEvent = this.store.addEvent({
          sessionId,
          source: "codex",
          eventType: "message.assistant",
          payload: buildAssistantPayload(job, pendingAssistantText, true),
        });

        this.bus.publish("message.created", assistantEvent);
      } else if (publishedAssistantItemIds.size === 0) {
        const assistantEvent = this.store.addEvent({
          sessionId,
          source: "codex",
          eventType: "message.assistant",
          payload: buildAssistantPayload(
            job,
            result.text || "(No assistant message returned)",
            true,
          ),
        });

        this.bus.publish("message.created", assistantEvent);
      }
      this.updateStatus(sessionId, "completed", {});
    } catch (error) {
      if (isCancelledError(error)) {
        return;
      }

      this.publishError(sessionId, error, "codex");
      this.updateStatus(sessionId, "error", {});
    } finally {
      queueState.activeRun = null;
    }
  }

  updateStatus(sessionId, status, meta) {
    const session = this.store.updateSession(sessionId, { status });
    if (!session) {
      return;
    }

    const event = this.store.addEvent({
      sessionId,
      source: "system",
      eventType: "status.changed",
      payload: { status, meta },
    });

    this.bus.publish("session.updated", session);
    this.bus.publish("status.changed", event);
  }

  publishError(sessionId, error, source) {
    const event = this.store.addEvent({
      sessionId,
      source,
      eventType: "error.created",
      payload: {
        message: error instanceof Error ? error.message : String(error),
      },
    });

    this.bus.publish("error.created", event);
    return event;
  }
}
