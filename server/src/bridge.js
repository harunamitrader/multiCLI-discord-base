import fs from "node:fs";
import path from "node:path";
import { browseForDirectory } from "./workdir-picker.js";

function isCancelledError(error) {
  return Boolean(error?.cancelled || error?.name === "CodexRunCancelledError");
}

const RECOVERABLE_SESSION_STATUSES = new Set(["queued", "running", "waiting_codex"]);
const IGNORED_WORKDIR_NAMES = new Set([
  ".git",
  "node_modules",
  "data",
  "dist",
  "build",
  "coverage",
  "target",
]);

function normalizeSessionReference(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
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

function readJsonFileSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function formatScheduleSpawnSessionTitle(scheduleName) {
  const normalizedName = String(scheduleName || "").trim() || "schedule";
  return `Schedule ${normalizedName} ${formatSessionTimestamp()}`;
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

function isSubPath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function formatRelativeWorkdir(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  if (!relative) {
    return ".";
  }

  return relative.replaceAll("\\", "/");
}

export class BridgeService {
  constructor({ store, bus, codex, config, attachments }) {
    this.store = store;
    this.bus = bus;
    this.codex = codex;
    this.config = config;
    this.attachments = attachments;
    this.sessionQueues = new Map();
    this.recoverStaleSessions();
  }

  listSessions() {
    return this.store.listSessions();
  }

  getScheduleDefaults() {
    const persisted = readJsonFileSafe(this.config.scheduleDefaultsPath, {}) || {};
    const baseDefaults = {
      model: this.config.codexDefaults.model,
      reasoningEffort: this.config.codexDefaults.reasoningEffort,
      profile: this.config.codexDefaults.profile,
      serviceTier: this.config.codexDefaults.serviceTier,
      fastMode: this.config.codexDefaults.serviceTier === "fast",
    };
    const settings = this.normalizeSessionSettings(persisted, baseDefaults);

    let workdir = this.config.codexDefaults.workdir;
    try {
      workdir = this.normalizeSessionWorkdir(persisted.workdir, null);
    } catch {
      workdir = this.normalizeSessionWorkdir(this.config.codexDefaults.workdir, null);
    }

    return {
      ...settings,
      workdir,
    };
  }

  updateScheduleDefaults(patch) {
    const current = this.getScheduleDefaults();
    const settings = this.normalizeSessionSettings(patch, current);
    const workdir = this.normalizeSessionWorkdir(
      patch.workdir == null ? current.workdir : patch.workdir,
      null,
    );
    const next = {
      ...settings,
      workdir,
    };

    writeJsonFile(this.config.scheduleDefaultsPath, {
      model: next.model,
      reasoningEffort: next.reasoningEffort,
      profile: next.profile,
      serviceTier: next.serviceTier,
      workdir: next.workdir,
    });

    return next;
  }

  getRuntimeInfo() {
    return {
      app: {
        version: this.config.appVersion,
      },
      codexVersion: this.config.codexVersion,
      workdir: this.config.codexWorkdir,
      baseWorkdir: this.config.codexWorkdir,
      defaultProfile: this.config.codexDefaults.profile,
      availableModels: this.config.availableModels,
      defaults: {
        model: this.config.codexDefaults.model,
        reasoningEffort: this.config.codexDefaults.reasoningEffort,
        fastMode: this.config.codexDefaults.serviceTier === "fast",
        serviceTier: this.config.codexDefaults.serviceTier,
        profile: this.config.codexDefaults.profile,
        workdir: this.config.codexDefaults.workdir,
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

  findSessionByReference(sessionReference) {
    const normalizedReference = normalizeSessionReference(sessionReference);
    if (!normalizedReference) {
      return null;
    }

    const directMatch = this.getSession(normalizedReference);
    if (directMatch) {
      return directMatch;
    }

    const normalizedLowercase = normalizedReference.toLowerCase();
    return (
      this.listSessions().find(
        (session) => String(session.title || "").trim().toLowerCase() === normalizedLowercase,
      ) || null
    );
  }

  resolveScheduledSession(sessionReference = null) {
    const normalizedReference = normalizeSessionReference(sessionReference);
    if (normalizedReference) {
      const matched = this.findSessionByReference(normalizedReference);
      if (matched) {
        return matched;
      }

      throw new Error(`Scheduled session not found: ${normalizedReference}`);
    }

    const fallback = this.listSessions()[0] || null;
    if (!fallback) {
      throw new Error("No available session for scheduled execution.");
    }

    return fallback;
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
      (input.fastMode == null ? undefined : input.fastMode ? "fast" : "flex") ??
      currentSession?.serviceTier ??
      this.config.codexDefaults.serviceTier;
    const serviceTier = serviceTierInput === "fast" ? "fast" : "flex";
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

  normalizeSessionWorkdir(inputWorkdir, currentSession = null) {
    const fallbackWorkdir =
      currentSession?.workdir ?? this.config.codexDefaults.workdir ?? this.config.codexWorkdir;
    const requestedWorkdir =
      inputWorkdir == null ? fallbackWorkdir : String(inputWorkdir).trim() || fallbackWorkdir;
    const resolvedRequestedPath = path.resolve(requestedWorkdir);
    if (!fs.existsSync(resolvedRequestedPath)) {
      throw new Error(`Selected working directory was not found: ${resolvedRequestedPath}`);
    }

    const requestedStat = fs.statSync(resolvedRequestedPath);
    if (!requestedStat.isDirectory()) {
      throw new Error(`Selected working directory is not a directory: ${resolvedRequestedPath}`);
    }

    const baseRealPath = fs.realpathSync(this.config.codexWorkdir);
    const requestedRealPath = fs.realpathSync(resolvedRequestedPath);
    if (!isSubPath(baseRealPath, requestedRealPath)) {
      throw new Error(
        `Selected working directory must stay inside ${baseRealPath}. Received: ${requestedRealPath}`,
      );
    }

    return requestedRealPath;
  }

  listSelectableWorkdirs() {
    const baseRealPath = fs.realpathSync(this.config.codexWorkdir);
    const seen = new Set([baseRealPath]);
    const queue = [{ dirPath: baseRealPath, depth: 0 }];
    const results = [];

    while (queue.length > 0 && results.length < 200) {
      const { dirPath, depth } = queue.shift();
      const workspaceState = this.codex.getGitWorkspaceState(dirPath);
      results.push({
        path: dirPath,
        relativePath: formatRelativeWorkdir(baseRealPath, dirPath),
        label: formatRelativeWorkdir(baseRealPath, dirPath),
        isGitRepo: workspaceState.ok,
        gitRoot: workspaceState.ok ? workspaceState.root : null,
      });

      if (depth >= 3) {
        continue;
      }

      let children = [];
      try {
        children = fs
          .readdirSync(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !IGNORED_WORKDIR_NAMES.has(entry.name))
          .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
      } catch {
        continue;
      }

      for (const child of children) {
        const childPath = path.join(dirPath, child.name);
        let childRealPath;
        try {
          childRealPath = fs.realpathSync(childPath);
        } catch {
          continue;
        }

        if (!isSubPath(baseRealPath, childRealPath) || seen.has(childRealPath)) {
          continue;
        }

        seen.add(childRealPath);
        queue.push({
          dirPath: childRealPath,
          depth: depth + 1,
        });
      }
    }

    return {
      baseWorkdir: baseRealPath,
      workdirs: results,
    };
  }

  async browseForSessionWorkdir(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const initialDirectory = session.workdir || this.config.codexWorkdir;
    const selection = await browseForDirectory({
      initialDirectory,
      title: "Select a working directory inside the configured base folder",
    });

    if (selection?.cancelled) {
      return {
        cancelled: true,
      };
    }

    return {
      cancelled: false,
      path: this.normalizeSessionWorkdir(selection.path, session),
    };
  }

  async browseForScheduleDefaultsWorkdir(initialPath = null) {
    const defaults = this.getScheduleDefaults();
    const normalizedInitialPath = String(initialPath || "").trim();
    const initialDirectory = normalizedInitialPath || defaults.workdir || this.config.codexWorkdir;
    const selection = await browseForDirectory({
      initialDirectory,
      title: "Select a default working directory for spawned schedule sessions",
    });

    if (selection?.cancelled) {
      return {
        cancelled: true,
      };
    }

    return {
      cancelled: false,
      path: this.normalizeSessionWorkdir(selection.path, null),
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
    workdir,
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
    const normalizedWorkdir = this.normalizeSessionWorkdir(workdir, null);
    const session = this.store.createSession({
      title: this.resolveSessionTitle(title),
      discordChannelId,
      discordChannelName,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      profile: settings.profile,
      workdir: normalizedWorkdir,
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

    const nextWorkdir = this.normalizeSessionWorkdir(
      patch.workdir == null ? currentSession.workdir : patch.workdir,
      currentSession,
    );
    const workdirChanged = nextWorkdir !== currentSession.workdir;
    if (workdirChanged) {
      const queueState = this.getQueueState(sessionId);
      const hasActiveWork = Boolean(
        queueState.processing || queueState.activeRun || queueState.items.length > 0,
      );
      if (hasActiveWork) {
        throw new Error(
          "Cannot change the working directory while this session is running or queued.",
        );
      }
    }

    const settings = this.normalizeSessionSettings(patch, currentSession);
    const updated = this.store.updateSession(sessionId, {
      ...settings,
      workdir: nextWorkdir,
      codexThreadId: workdirChanged ? null : currentSession.codexThreadId,
    });
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

  openDeveloperConsole() {
    return this.codex.openDeveloperConsole();
  }

  recoverSessionState(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return { recovered: false, reason: "not_found", session: null };
    }

    const queueState = this.getQueueState(sessionId);
    const hasActiveWork = Boolean(
      queueState.processing || queueState.activeRun || queueState.items.length > 0,
    );
    if (!RECOVERABLE_SESSION_STATUSES.has(session.status) || hasActiveWork) {
      return { recovered: false, reason: "not_stale", session };
    }

    const recoveredSession = this.store.updateSession(sessionId, {
      status: "stopped",
    });
    const statusEvent = this.store.addEvent({
      sessionId,
      source: "system",
      eventType: "status.changed",
      payload: {
        status: "stopped",
        meta: {
          reason: "recovered_after_restart",
          previousStatus: session.status,
        },
      },
    });
    const errorEvent = this.store.addEvent({
      sessionId,
      source: "system",
      eventType: "error.created",
      payload: {
        message:
          "CoDiCoDi restarted while this session was still marked active. The in-flight run was reset to stopped, so please review the latest messages before retrying.",
      },
    });

    this.bus.publish("session.updated", recoveredSession);
    this.bus.publish("status.changed", statusEvent);
    this.bus.publish("error.created", errorEvent);

    return { recovered: true, reason: "recovered_after_restart", session: recoveredSession };
  }

  recoverStaleSessions() {
    for (const session of this.store.listSessions()) {
      this.recoverSessionState(session.id);
    }
  }

  bindDiscordChannel(sessionId, channelId) {
    return this.bindDiscordChannelWithName(sessionId, channelId, null);
  }

  bindDiscordChannelWithName(sessionId, channelId, channelName = null) {
    const normalizedChannelId = typeof channelId === "string" ? channelId.trim() || null : null;
    const normalizedChannelName = normalizedChannelId ? channelName : null;
    const clearedSessions = normalizedChannelId
      ? this.reassignDiscordChannel(normalizedChannelId, sessionId)
      : [];
    const session = this.store.bindDiscordChannel(
      sessionId,
      normalizedChannelId,
      normalizedChannelName,
    );
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
    metadata = {},
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
        ...metadata,
      },
    });

    this.bus.publish("message.created", userEvent);

    const queueState = this.getQueueState(sessionId);
    const turnsAhead =
      queueState.items.length + (queueState.processing || queueState.activeRun ? 1 : 0);
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

    return {
      userEvent,
      queue: {
        turnsAhead,
        isQueuedBehindCurrentTurn: turnsAhead > 0,
        queuedCount: queueState.items.length,
      },
    };
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
    let didReceiveTurnCompleted = false;
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

        if (event.type === "turn.completed") {
          didReceiveTurnCompleted = true;
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
      workdir: session.workdir,
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

      if (pendingAssistantText) {
        const assistantEvent = this.store.addEvent({
          sessionId,
          source: "codex",
          eventType: "message.assistant",
          payload: buildAssistantPayload(job, pendingAssistantText, didReceiveTurnCompleted),
        });
        this.bus.publish("message.created", assistantEvent);
        pendingAssistantText = null;
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

  async triggerScheduledJob({ name, prompt, target }) {
    const normalizedTarget =
      target && target.type === "session"
        ? target
        : {
            type: "spawn",
          };
    const targetSession =
      normalizedTarget.type === "spawn"
        ? this.createSession({
            title: formatScheduleSpawnSessionTitle(name),
            ...this.getScheduleDefaults(),
          })
        : this.resolveScheduledSession(normalizedTarget.sessionId);
    const result = await this.handleIncomingMessage({
      sessionId: targetSession.id,
      text: prompt,
      source: "schedule",
      metadata: {
        scheduleName: name,
        schedulePrompt: prompt,
        scheduleTargetType: normalizedTarget.type,
      },
    });

    return {
      session: this.getSession(targetSession.id) || targetSession,
      queue: result.queue,
      userEvent: result.userEvent,
    };
  }
}
