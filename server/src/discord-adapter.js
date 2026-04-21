import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

function splitMessage(text, maxLength = 1800) {
  if (!text || text.length <= maxLength) {
    return [text];
  }

  const parts = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < 0) {
      splitAt = maxLength;
    }

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

const WORKING_STATUSES = new Set(["queued", "running", "waiting_codex"]);

function formatFastMode(session) {
  return session.fastMode ? "on" : "off";
}

function formatStatusMessage(session) {
  return [
    `Session: ${session.title}`,
    `Status: ${session.status}`,
    `Model: ${session.model}`,
    `Reasoning: ${session.reasoningEffort}`,
    `Fast mode: ${formatFastMode(session)}`,
  ].join("\n");
}

function formatWorkspaceStatusMessage(workspace, agentName) {
  return [
    `Workspace: ${workspace?.name || "unknown"}`,
    `Workspace ID: ${workspace?.id || "unknown"}`,
    `Agent: ${agentName || "unassigned"}`,
  ].join("\n");
}

function formatRelativeTimeLabel(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === "") {
    return "never";
  }
  const atMs =
    typeof timestamp === "number"
      ? timestamp
      : new Date(timestamp).getTime();
  if (!Number.isFinite(atMs)) {
    return "unknown";
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - atMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }
  if (elapsedSeconds < 3600) {
    return `${Math.floor(elapsedSeconds / 60)}m ago`;
  }
  if (elapsedSeconds < 86400) {
    return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  }
  return `${Math.floor(elapsedSeconds / 86400)}d ago`;
}

function formatAgentRuntimeStatusLine({
  agentName,
  isParent = false,
  isDefault = false,
  terminalState = {},
  queuedCount = 0,
}) {
  const roleLabels = [];
  if (isParent) roleLabels.push("parent");
  if (isDefault) roleLabels.push("default");
  const header = roleLabels.length > 0
    ? `${agentName} [${roleLabels.join(", ")}]`
    : agentName;
  const parts = [
    `status=${terminalState.status || "idle"}`,
    `pty=${terminalState.hasProcess ? "on" : "off"}`,
  ];
  if (terminalState.status !== "waiting_input") {
    parts.push(`ready=${terminalState.readyForPrompt ? "yes" : "no"}`);
  }
  if (queuedCount > 0) {
    parts.push(`queue=${queuedCount}`);
  }
  if (terminalState.manualInputDirty) {
    parts.push("draft=yes");
  }
  if (terminalState.approvalRequest?.status === "pending") {
    parts.push("approval=pending");
  }
  if (terminalState.quotaNotice?.summary) {
    parts.push("quota=wait");
  }
  if (terminalState.configStale) {
    parts.push("config=stale");
  }
  if (terminalState.warningCode && terminalState.warningCode !== "quota_wait") {
    parts.push(`warning=${terminalState.warningCode}`);
  }
  if (terminalState.lastOutputAt) {
    parts.push(`last=${formatRelativeTimeLabel(terminalState.lastOutputAt)}`);
  }
  return `- ${header} :: ${parts.join(" | ")}`;
}

function formatWorkspaceRuntimeStatusMessage({
  workspace,
  defaultAgent,
  agentStatuses = [],
  focusedAgentName = "",
}) {
  const lines = [
    `Workspace: ${workspace?.name || "unknown"}`,
    `Workspace ID: ${workspace?.id || "unknown"}`,
    `Default agent: ${defaultAgent || "unassigned"}`,
  ];
  if (focusedAgentName) {
    lines.push(`Filter: ${focusedAgentName}`);
  }
  lines.push("", "Agents:");
  if (agentStatuses.length === 0) {
    lines.push("（agent status はまだありません）");
  } else {
    lines.push(...agentStatuses);
  }
  return lines.join("\n");
}

function formatQuotedBlock(text) {
  const normalized = String(text || "").replace(/\r/g, "").trim();
  if (!normalized) {
    return "> (no output)";
  }
  return normalized
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatTerminalOutputMessage({
  workspace,
  agentName,
  output,
}) {
  const lines = [
    `Latest PTY output: ${agentName}`,
    `Workspace: ${workspace?.name || "unknown"} (${workspace?.id || "unknown"})`,
    `Status: ${output.status || "idle"}`,
  ];
  if (output.truncated) {
    lines.push(`Showing last ${output.lineLimit} of ${output.totalLineCount} line(s)`);
  }
  lines.push("", formatQuotedBlock(output.text));
  return lines.join("\n");
}

function formatDiscordHelpText() {
  return [
    "multiCLI-discord-base commands:",
    "help! - このヘルプを表示",
    "new! - このチャンネル名で新しい workspace を作成して紐づけ",
    "status! [agent] - workspace と PTY 状態を表示",
    "output! [agent] - 最新 PTY 出力を再掲",
    "enter! [agent] - shared PTY に Enter を送信",
    "approve! [agent] - 承認待ちに approve を送信",
    "deny! [agent] - 承認待ちに deny を送信",
    "bindings! - workspace の resume binding 一覧を表示",
    "resume! [agent] - 保存済み session ref で resume を試行",
    "restart! [agent] - shared PTY を再起動",
    "checkpoints! - checkpoint 一覧を表示",
    "checkpoints! create [label] - checkpoint を作成",
    "rollback! preview <checkpointId> - rollback preview を表示",
    "rollback! apply <checkpointId> - checkpoint へ rollback",
    "skills! [agent] - skill sync plan を表示",
    "skills! apply [agent] - skill sync を適用",
    "workspace! <名前> - 既存 workspace に紐づけ、なければ新規作成",
    "agents! - 利用可能 agent を表示",
    "stop! - 進行中 agent を停止",
    "agentName? <prompt> - 指定 agent に送信",
    "/command - CLI の / コマンドを shared PTY にそのまま送信",
    "<prompt> - 紐づけ済み workspace の parent agent に送信",
  ].join("\n");
}

function parseLeadingBangCommand(content) {
  const trimmed = String(content ?? "").trim();
  const bangIndex = trimmed.indexOf("!");
  if (bangIndex <= 0) return null;
  return {
    raw: trimmed.slice(0, bangIndex + 1),
    command: trimmed.slice(0, bangIndex + 1).toLowerCase(),
    args: trimmed.slice(bangIndex + 1).trim(),
    trimmed,
  };
}

function getChannelDisplayName(channel) {
  return channel?.name || null;
}

function getElapsedSeconds(startedAt) {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
}

function formatElapsedLabel(startedAt, { compactMinutes = false } = {}) {
  const seconds = getElapsedSeconds(startedAt);
  if (compactMinutes && seconds >= 60) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${seconds}s`;
}

function formatWorkingStatusContent(startedAt, label = "Working") {
  return `> ${label}... (${formatElapsedLabel(startedAt, { compactMinutes: true })})`;
}

function formatFinishedStatusContent(status, startedAt) {
  const labelMap = {
    quota_wait: "Quota wait",
    waiting_input: "Waiting input",
  };
  const label = labelMap[status] || (status[0].toUpperCase() + status.slice(1));
  return `> ${label} (${formatElapsedLabel(startedAt)})`;
}

function formatQueuedNotice(turnsAhead) {
  if (!Number.isFinite(turnsAhead) || turnsAhead <= 0) {
    return null;
  }

  if (turnsAhead === 1) {
    return "☑ Queued as next turn.";
  }

  return `☑ Queued. ${turnsAhead} turns ahead.`;
}

function getProgressUpdateDelayMs(updateStep) {
  return updateStep < 4 ? 15000 : 60000;
}

function commonPrefixLength(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function getUnsyncedSuffix(fullText, syncedText) {
  const normalizedFull = String(fullText ?? "");
  const normalizedSynced = String(syncedText ?? "");
  if (!normalizedSynced) {
    return normalizedFull;
  }
  if (normalizedFull.startsWith(normalizedSynced)) {
    return normalizedFull.slice(normalizedSynced.length);
  }
  const prefixLength = commonPrefixLength(normalizedFull, normalizedSynced);
  return normalizedFull.slice(prefixLength);
}

function formatRunningCommandMessage(command) {
  const fullCommand = String(command || "").trim();
  if (!fullCommand) {
    return "> Running command";
  }

  const quotedCommand = fullCommand
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

  return `> Running command\n${quotedCommand}`;
}

function formatAttachmentSummaryLines(attachments = []) {
  return attachments.map((attachment) => {
    const typeLabel = attachment.kind === "image" ? "image" : "file";
    return `- ${attachment.name} (${typeLabel})`;
  });
}

function isSlashPassthroughInput(text) {
  const normalized = String(text ?? "").trim();
  return normalized.startsWith("/") && !/[\r\n]/u.test(normalized);
}

function formatInputMetadataLines(metadata) {
  const lines = [];
  const normalized = metadata && typeof metadata === "object" ? metadata : null;
  if (!normalized) return lines;
  if (normalized.inputMode === "slash_command") {
    lines.push("Mode: / passthrough");
  }
  if (normalized.context?.used) {
    const count = Number(normalized.context.messageCount || 0);
    const chars = Number(normalized.context.totalChars || 0);
    lines.push(`Context: attached (${count} message(s), ${chars} chars)`);
  }
  return lines;
}

function formatLocalInputMessage(payload) {
  const lines = [];
  const text = String(payload.text || "").trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const metaLines = formatInputMetadataLines(payload.metadata);

  if (text) {
    lines.push("Local input:", `>>> ${text}`);
  } else {
    lines.push("Local input with attachments:");
  }

  if (metaLines.length > 0) {
    lines.push("", ...metaLines);
  }

  if (attachments.length > 0) {
    lines.push("", "Attachments:", ...formatAttachmentSummaryLines(attachments));
  }

  return lines.join("\n");
}

function formatScheduledInputMessage(payload) {
  const scheduleName = String(payload.scheduleName || "unnamed-job").trim() || "unnamed-job";
  const prompt = String(payload.schedulePrompt || payload.text || "").trim();
  const lines = [`⏰ ジョブ「${scheduleName}」を実行`];

  if (prompt) {
    lines.push(`>>> ${prompt}`);
  }

  return lines.join("\n");
}

function formatWorkspaceBulletList(workspaces = [], { maxItems = 10, maxChars = 1200 } = {}) {
  const normalized = Array.isArray(workspaces) ? workspaces : [];
  if (normalized.length === 0) {
    return "（ワークスペースはまだありません）";
  }

  const lines = [];
  let visibleCount = 0;
  for (const workspace of normalized) {
    if (visibleCount >= maxItems) {
      break;
    }
    const line =
      `• ${workspace.name}${workspace.isActive ? " ✓" : ""}` +
      `${workspace.id ? ` (\`${workspace.id}\`)` : ""}`;
    const nextText = [...lines, line].join("\n");
    if (nextText.length > maxChars) {
      break;
    }
    lines.push(line);
    visibleCount += 1;
  }

  const remainingCount = normalized.length - visibleCount;
  if (remainingCount > 0) {
    lines.push(`• …ほか ${remainingCount} 件`);
  }

  return lines.join("\n");
}

function buildPromptWithAttachmentPaths(text, attachments = []) {
  const normalizedText = String(text || "").trim();
  const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
  const imagePaths = normalizedAttachments
    .filter((attachment) => attachment?.kind === "image" && attachment?.savedPath)
    .map((attachment) => attachment.savedPath);
  const filePaths = normalizedAttachments
    .filter((attachment) => attachment?.kind !== "image" && attachment?.savedPath)
    .map((attachment) => attachment.savedPath);
  const sections = [];

  if (normalizedText) {
    sections.push(normalizedText);
  }

  if (imagePaths.length > 0) {
    sections.push(`Images:\n${imagePaths.map((savedPath) => `- ${savedPath}`).join("\n")}`);
  }

  if (filePaths.length > 0) {
    sections.push(`Files:\n${filePaths.map((savedPath) => `- ${savedPath}`).join("\n")}`);
  }

  if (!normalizedText && imagePaths.length > 0 && filePaths.length === 0) {
    sections.unshift("Please inspect the attached image files.");
  } else if (!normalizedText && imagePaths.length > 0 && filePaths.length > 0) {
    sections.unshift("Please inspect the attached images and files.");
  }

  return sections.join("\n\n").trim();
}

/**
 * Parse a Discord command from message content.
 *
 * Patterns:
 *   "hanako? <prompt>"  → { agent: "hanako", verb: null,      prompt: "<prompt>" }
 *   "hanako?"           → { agent: "hanako", verb: null,      prompt: "" }
 *   "hanako new!"       → { agent: "hanako", verb: "new",     prompt: null }
 *   "hanako stop!"      → { agent: "hanako", verb: "stop",    prompt: null }
 *   "stop!"             → { agent: null,     verb: "stop",    prompt: null }
 *   "agents!"           → { agent: null,     verb: "agents",  prompt: null }
 *
 * Returns null if no pattern matches.
 */
function parseAgentCommand(content, agentNames) {
  const trimmed = content.trim();
  const bang = parseLeadingBangCommand(trimmed);

  // Global commands: "stop!" / "agents!" / "workspace!"
  if (bang?.command === "stop!") return { agent: null, verb: "stop", prompt: null };
  if (bang?.command === "agents!") return { agent: null, verb: "agents", prompt: null };
  if (bang?.command === "workspace!") return { agent: null, verb: "workspace", prompt: bang.args };

  // "hanako new!" / "hanako stop!" — verb before !
  const verbMatch = bang?.raw.match(/^(\S+)\s+(new|stop|reset)!$/i);
  if (verbMatch) {
    const name = verbMatch[1].toLowerCase();
    if (agentNames.includes(name)) {
      return { agent: name, verb: verbMatch[2].toLowerCase(), prompt: null };
    }
  }

  // "hanako? <prompt>" or "hanako?" — name immediately before ?
  const promptMatch = trimmed.match(/^(\S+)\?\s*([\s\S]*)$/);
  if (promptMatch) {
    const name = promptMatch[1].toLowerCase();
    if (agentNames.includes(name)) {
      return { agent: name, verb: null, prompt: promptMatch[2].trim() };
    }
  }

  return null;
}

export class DiscordAdapter {
  constructor({ bridge, agentBridge, bus, config, attachments, restartServer, agentRegistry }) {
    this.bridge = bridge;
    this.agentBridge = agentBridge || null;
    this.bus = bus;
    this.config = config;
    this.attachments = attachments;
    this.restartServer = restartServer;
    this.agentRegistry = agentRegistry || null;
    this.client = null;
    this.unsubscribers = [];
    this.progressTrackers = new Map();
    this.workspaceProgressTrackers = new Map();
    this.workspacePromptQueues = new Map();
  }

  async start() {
    if (!this.config.discordBotToken) {
      console.log("Discord adapter disabled: DISCORD_BOT_TOKEN is not set.");
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.client.on("ready", async () => {
      console.log(`Discord adapter connected as ${this.client.user?.tag}`);
      try {
        await this.registerSlashCommands();
        await this.syncDiscordChannelNames();
      } catch (error) {
        console.error("Discord command bootstrap failed:", error);
      }
    });

    this.client.on("messageCreate", async (message) => {
      await this.handleMessage(message);
    });

    this.client.on("interactionCreate", async (interaction) => {
      await this.handleInteraction(interaction);
    });

    this.unsubscribers.push(
      this.bus.on("message.created", (event) => {
        this.handleBridgeMessage(event).catch((error) => {
          console.error("Discord message mirror failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("status.changed", (event) => {
        this.handleStatusEvent(event).catch((error) => {
          console.error("Discord status mirror failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("error.created", (event) => {
        this.handleErrorEvent(event).catch((error) => {
          console.error("Discord error mirror failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("session.updated", (session) => {
        this.handleSessionUpdated(session).catch((error) => {
          console.error("Discord session update handling failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("session.deleted", ({ sessionId }) => {
        this.discardProgressTracker(sessionId, { deleteMessage: true }).catch((error) => {
          console.error("Discord progress tracker cleanup failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("message.user", (event) => {
        this.handleWorkspaceMessageUser(event).catch((error) => {
          console.error("Discord workspace user mirror failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("message.done", (event) => {
        this.handleWorkspaceMessageDone(event).catch((error) => {
          console.error("Discord workspace assistant mirror failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("status.change", (event) => {
        this.handleWorkspaceStatusChange(event).catch((error) => {
          console.error("Discord workspace status mirror failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("run.error", (event) => {
        this.handleWorkspaceRunError(event).catch((error) => {
          console.error("Discord workspace error mirror failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("observer.notice", (event) => {
        this.handleWorkspaceObserverNotice(event).catch((error) => {
          console.error("Discord workspace observer notice failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("approval.requested", (event) => {
        this.handleWorkspaceApprovalEvent("requested", event).catch((error) => {
          console.error("Discord workspace approval notice failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("approval.expired", (event) => {
        this.handleWorkspaceApprovalEvent("expired", event).catch((error) => {
          console.error("Discord workspace approval expiry failed:", error);
        });
      }),
    );

    await this.client.login(this.config.discordBotToken);
  }

  async stop() {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];

    for (const tracker of this.progressTrackers.values()) {
      clearTimeout(tracker.timeoutId);
    }
    this.progressTrackers.clear();
    for (const tracker of this.workspaceProgressTrackers.values()) {
      clearTimeout(tracker.timeoutId);
    }
    this.workspaceProgressTrackers.clear();
    this.workspacePromptQueues.clear();

    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
  }

  getWorkspacePromptQueueKey(workspaceId, agentName) {
    return `${String(workspaceId ?? "").trim()}:${String(agentName ?? "").trim()}`;
  }

  enqueueWorkspacePrompt({ workspaceId, agentName, task }) {
    const key = this.getWorkspacePromptQueueKey(workspaceId, agentName);
    const entry = this.workspacePromptQueues.get(key) ?? {
      tail: Promise.resolve(),
      pendingCount: 0,
    };
    const turnsAhead = entry.pendingCount;
    entry.pendingCount += 1;
    const previousTail = entry.tail.catch(() => undefined);
    entry.tail = previousTail
      .then(() => task())
      .finally(() => {
        entry.pendingCount = Math.max(0, entry.pendingCount - 1);
        if (entry.pendingCount === 0) {
          this.workspacePromptQueues.delete(key);
        }
      });
    this.workspacePromptQueues.set(key, entry);
    return { turnsAhead, promise: entry.tail };
  }

  getWorkspaceQueuedTurns(workspaceId, agentName) {
    const key = this.getWorkspacePromptQueueKey(workspaceId, agentName);
    const pendingCount = Number(this.workspacePromptQueues.get(key)?.pendingCount ?? 0);
    return Math.max(0, pendingCount - 1);
  }

  isAllowedTarget(guildId, channelId) {
    if (
      this.config.discordAllowedGuildIds.size > 0 &&
      !this.config.discordAllowedGuildIds.has(guildId)
    ) {
      return false;
    }

    if (
      this.config.discordAllowedChannelIds.size > 0 &&
      !this.config.discordAllowedChannelIds.has(channelId)
    ) {
      return false;
    }

    return true;
  }

  isAllowedMessage(message) {
    if (message.author?.bot) {
      return false;
    }

    return this.isAllowedTarget(message.guildId, message.channelId);
  }

  async registerSlashCommands() {
    if (!this.client?.application) {
      return;
    }

    const commands = [];

    if (this.config.discordAllowedGuildIds.size > 0) {
      for (const guildId of this.config.discordAllowedGuildIds) {
        const guild = await this.client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
          continue;
        }

        await guild.commands.set(commands);
      }
      return;
    }

    await this.client.application.commands.set(commands);
  }

  async syncDiscordChannelNames() {
    if (!this.client) {
      return;
    }

    for (const session of this.bridge.listSessions()) {
      await this.syncDiscordChannelNameForSession(session);
    }
  }

  async syncDiscordChannelNameForSession(session) {
    if (!this.client || !session?.discordChannelId) {
      return;
    }

    const channel = await this.client.channels
      .fetch(session.discordChannelId)
      .catch(() => null);
    const channelName = getChannelDisplayName(channel) || "unknown";

    if (session.discordChannelName !== channelName) {
      this.bridge.updateDiscordChannelName(session.id, channelName);
    }
  }

  async getSelectableChannels() {
    if (!this.client) {
      throw new Error("Discord client is not connected.");
    }

    const guildId = [...this.config.discordAllowedGuildIds][0];
    if (!guildId) {
      throw new Error("DISCORD_ALLOWED_GUILD_IDS must contain exactly one guild ID.");
    }

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      throw new Error(`Configured Discord guild not found: ${guildId}`);
    }

    const fetchedChannels = await guild.channels.fetch();
    const channels = [...fetchedChannels.values()]
      .filter(Boolean)
      .filter((channel) => channel.type === ChannelType.GuildText)
      .filter((channel) =>
        this.config.discordAllowedChannelIds.size === 0
          ? true
          : this.config.discordAllowedChannelIds.has(channel.id),
      )
      .map((channel) => ({
        id: channel.id,
        name: channel.name || "unknown",
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "ja"));

    return channels;
  }

  async getFileLogChannel() {
    if (!this.client || !this.config.fileLogChannelId) {
      return null;
    }

    const channel = await this.client.channels.fetch(this.config.fileLogChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return null;
    }

    return channel;
  }

  async sendFileLogNotification({ action, relativePath, absolutePath, attached, reason }) {
    const channel = await this.getFileLogChannel();
    if (!channel) {
      console.warn("File log channel is unavailable. Skipping file watch notification.");
      return;
    }

    const actionLabel =
      action === "created" ? "Created" : action === "modified" ? "Modified" : "Deleted";
    const timestamp = new Intl.DateTimeFormat("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date());
    const lines = [
      `[File Watch] ${actionLabel}`,
      `Path: \`${relativePath}\``,
      `Time: ${timestamp}`,
    ];

    if (reason) {
      lines.push(reason);
    }

    const payload = {
      content: lines.join("\n"),
    };

    if (attached && absolutePath) {
      const [{ AttachmentBuilder }, path] = await Promise.all([
        import("discord.js"),
        import("node:path"),
      ]);
      payload.files = [
        new AttachmentBuilder(absolutePath, {
          name: path.basename(absolutePath),
        }),
      ];
    }

    await channel.send(payload);
  }

  async sendFileLogSystemMessage(text) {
    const channel = await this.getFileLogChannel();
    if (!channel) {
      console.warn("File log channel is unavailable. Skipping file watch system message.");
      return;
    }

    await channel.send(text);
  }

  stopProgressTracker(sessionId) {
    const tracker = this.progressTrackers.get(sessionId);
    if (!tracker) {
      return;
    }

    clearTimeout(tracker.timeoutId);
    this.progressTrackers.delete(sessionId);
  }

  async discardProgressTracker(sessionId, { deleteMessage = false } = {}) {
    const tracker = this.progressTrackers.get(sessionId);
    if (!tracker) {
      return null;
    }

    this.stopProgressTracker(sessionId);

    if (deleteMessage && tracker.channel && tracker.messageId) {
      const message = await tracker.channel.messages.fetch(tracker.messageId).catch(() => null);
      if (message) {
        await message.delete().catch(() => null);
      }
    }

    return tracker;
  }

  async handleSessionUpdated(session) {
    const tracker = session ? this.progressTrackers.get(session.id) : null;
    const nextChannelId = session?.discordChannelId || null;
    const trackerChannelId = tracker?.channel?.id || null;
    const shouldResetTracker = Boolean(tracker && trackerChannelId !== nextChannelId);
    const trackerStartedAt = tracker?.startedAt || session?.updatedAt || new Date().toISOString();

    if (shouldResetTracker) {
      await this.discardProgressTracker(session.id, { deleteMessage: true });
    }

    await this.syncDiscordChannelNameForSession(session);

    if (
      shouldResetTracker &&
      nextChannelId &&
      this.config.discordStatusUpdates &&
      WORKING_STATUSES.has(session.status)
    ) {
      await this.startProgressTracker(session, {
        createdAt: trackerStartedAt,
      });
    }
  }

  markProgressTrackerHasTrailingMessages(sessionId) {
    const tracker = this.progressTrackers.get(sessionId);
    if (!tracker?.messageId) {
      return;
    }

    tracker.hasTrailingMessages = true;
  }

  async flushPendingFinishedProgress(sessionId) {
    const tracker = this.progressTrackers.get(sessionId);
    if (!tracker?.pendingFinishedStatus || !tracker.channel) {
      return;
    }

    const status = tracker.pendingFinishedStatus;
    tracker.pendingFinishedStatus = null;
    const content = formatFinishedStatusContent(status, tracker.startedAt);
    await this.replaceProgressMessage(tracker, content);
  }

  async replaceProgressMessage(tracker, content) {
    if (!tracker?.channel) {
      return null;
    }

    if (tracker.messageId) {
      const message = await tracker.channel.messages.fetch(tracker.messageId).catch(() => null);
      if (message) {
        await message.delete().catch(() => null);
      }
    }

    const message = await tracker.channel.send(content).catch(() => null);
    tracker.messageId = message?.id || null;
    tracker.hasTrailingMessages = false;
    return message;
  }

  async publishProgressMessage(tracker, content) {
    return this.replaceProgressMessage(tracker, content);
  }

  scheduleProgressTrackerRefresh(sessionId) {
    const tracker = this.progressTrackers.get(sessionId);
    if (!tracker) {
      return;
    }

    const delayMs = getProgressUpdateDelayMs(tracker.updateStep);
    tracker.timeoutId = setTimeout(() => {
      this.refreshProgressTracker(sessionId)
        .then(() => {
          const currentTracker = this.progressTrackers.get(sessionId);
          if (!currentTracker) {
            return;
          }

          currentTracker.updateStep += 1;
          this.scheduleProgressTrackerRefresh(sessionId);
        })
        .catch((error) => {
          console.error("Discord progress refresh failed:", error);
          this.stopProgressTracker(sessionId);
        });
    }, delayMs);
  }

  async refreshProgressTracker(sessionId) {
    const tracker = this.progressTrackers.get(sessionId);
    if (!tracker?.channel) {
      return;
    }

    try {
      const content = formatWorkingStatusContent(tracker.startedAt);
      await this.publishProgressMessage(tracker, content);
    } catch {
      this.stopProgressTracker(sessionId);
    }
  }

  async startProgressTracker(session, event) {
    if (!this.client || !session?.discordChannelId) {
      return;
    }

    const existing = this.progressTrackers.get(session.id);
    if (existing) {
      return;
    }

    const tracker = {
      startedAt: event.createdAt,
      channel: null,
      messageId: null,
      timeoutId: null,
      updateStep: 0,
      hasTrailingMessages: false,
      pendingFinishedStatus: null,
      finalMessagePending: false,
    };
    this.progressTrackers.set(session.id, tracker);

    const channel = await this.client.channels.fetch(session.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      this.stopProgressTracker(session.id);
      return;
    }

    tracker.channel = channel;
    this.scheduleProgressTrackerRefresh(session.id);
  }

  async finishProgressTracker(session, event) {
    if (!this.client || !session?.discordChannelId) {
      return;
    }

    const tracker = this.progressTrackers.get(session.id);
    if (!tracker) {
      const channel = await this.client.channels.fetch(session.discordChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        return;
      }

      await channel
        .send(formatFinishedStatusContent(event.payload.status, event.createdAt))
        .catch(() => null);
      return;
    }

    clearTimeout(tracker.timeoutId);
    tracker.pendingFinishedStatus = event.payload.status;

    if (tracker.finalMessagePending) {
      return;
    }

    await this.flushPendingFinishedProgress(session.id);
    this.progressTrackers.delete(session.id);
  }

  getWorkspaceDiscordBinding(workspaceId) {
    const normalizedWorkspaceId = String(workspaceId ?? "").trim();
    if (!normalizedWorkspaceId || !this.agentBridge?.store?.listDiscordBindingsByWorkspace) {
      return null;
    }
    return this.agentBridge.store.listDiscordBindingsByWorkspace(normalizedWorkspaceId)[0] ?? null;
  }

  async sendWorkspaceChannelNotice(workspaceId, content) {
    if (!this.client || !workspaceId || !content) {
      return;
    }
    const binding = this.getWorkspaceDiscordBinding(workspaceId);
    if (!binding?.discordChannelId) {
      return;
    }
    const channel = await this.client.channels.fetch(binding.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return;
    }
    for (const chunk of splitMessage(String(content || "").trim(), 1800)) {
      if (!chunk) continue;
      await channel.send(chunk).catch(() => null);
    }
    this.markWorkspaceProgressTrackerHasTrailingMessages(workspaceId);
  }

  stopWorkspaceProgressTracker(workspaceId) {
    const tracker = this.workspaceProgressTrackers.get(workspaceId);
    if (!tracker) {
      return;
    }
    clearTimeout(tracker.timeoutId);
    this.workspaceProgressTrackers.delete(workspaceId);
  }

  markWorkspaceProgressTrackerHasTrailingMessages(workspaceId) {
    const tracker = this.workspaceProgressTrackers.get(workspaceId);
    if (!tracker?.messageId) {
      return;
    }
    tracker.hasTrailingMessages = true;
  }

  async flushPendingWorkspaceProgress(workspaceId) {
    const tracker = this.workspaceProgressTrackers.get(workspaceId);
    if (!tracker?.pendingFinishedStatus || !tracker.channel) {
      return;
    }
    const status = tracker.pendingFinishedStatus;
    tracker.pendingFinishedStatus = null;
    await this.replaceProgressMessage(tracker, formatFinishedStatusContent(status, tracker.startedAt));
  }

  scheduleWorkspaceProgressTrackerRefresh(workspaceId) {
    const tracker = this.workspaceProgressTrackers.get(workspaceId);
    if (!tracker) {
      return;
    }
    const delayMs = getProgressUpdateDelayMs(tracker.updateStep);
    tracker.timeoutId = setTimeout(() => {
      this.refreshWorkspaceProgressTracker(workspaceId)
        .then(() => {
          const currentTracker = this.workspaceProgressTrackers.get(workspaceId);
          if (!currentTracker) {
            return;
          }
          currentTracker.updateStep += 1;
          this.scheduleWorkspaceProgressTrackerRefresh(workspaceId);
        })
        .catch((error) => {
          console.error("Discord workspace progress refresh failed:", error);
          this.stopWorkspaceProgressTracker(workspaceId);
        });
    }, delayMs);
  }

  async refreshWorkspaceProgressTracker(workspaceId) {
    const tracker = this.workspaceProgressTrackers.get(workspaceId);
    if (!tracker?.channel) {
      return;
    }
    try {
      await this.publishProgressMessage(tracker, formatWorkingStatusContent(tracker.startedAt, tracker.label || "Working"));
    } catch {
      this.stopWorkspaceProgressTracker(workspaceId);
    }
  }

  async startWorkspaceProgressTracker(workspaceId, agentName, createdAt) {
    if (!this.client || !this.config.discordStatusUpdates) {
      return;
    }
    const normalizedWorkspaceId = String(workspaceId ?? "").trim();
    if (!normalizedWorkspaceId || this.workspaceProgressTrackers.get(normalizedWorkspaceId)) {
      return;
    }
    const binding = this.getWorkspaceDiscordBinding(normalizedWorkspaceId);
    if (!binding?.discordChannelId) {
      return;
    }
    const tracker = {
      startedAt: createdAt || new Date().toISOString(),
      channel: null,
      messageId: null,
      timeoutId: null,
      updateStep: 0,
      hasTrailingMessages: false,
      pendingFinishedStatus: null,
      finalMessagePending: false,
      label: agentName || "Working",
    };
    this.workspaceProgressTrackers.set(normalizedWorkspaceId, tracker);
    const channel = await this.client.channels.fetch(binding.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      this.stopWorkspaceProgressTracker(normalizedWorkspaceId);
      return;
    }
    tracker.channel = channel;
    await this.replaceProgressMessage(tracker, formatWorkingStatusContent(tracker.startedAt, tracker.label));
    this.scheduleWorkspaceProgressTrackerRefresh(normalizedWorkspaceId);
  }

  async finishWorkspaceProgressTracker(workspaceId, status, createdAt) {
    const normalizedWorkspaceId = String(workspaceId ?? "").trim();
    if (!normalizedWorkspaceId) {
      return;
    }
    const tracker = this.workspaceProgressTrackers.get(normalizedWorkspaceId);
    if (!tracker) {
      const binding = this.getWorkspaceDiscordBinding(normalizedWorkspaceId);
      if (!this.client || !binding?.discordChannelId) {
        return;
      }
      const channel = await this.client.channels.fetch(binding.discordChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        return;
      }
      await channel.send(formatFinishedStatusContent(status, createdAt || new Date().toISOString())).catch(() => null);
      return;
    }
    clearTimeout(tracker.timeoutId);
    tracker.pendingFinishedStatus = status;
    if (tracker.finalMessagePending) {
      return;
    }
    await this.flushPendingWorkspaceProgress(normalizedWorkspaceId);
    this.workspaceProgressTrackers.delete(normalizedWorkspaceId);
  }

  async handleWorkspaceMessageUser(event) {
    if (!this.client || !event?.workspaceId || ["discord", "discord-slash"].includes(event.source)) {
      return;
    }
    const binding = this.getWorkspaceDiscordBinding(event.workspaceId);
    if (!binding?.discordChannelId) {
      return;
    }
    const channel = await this.client.channels.fetch(binding.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return;
    }
    if (event.source === "schedule") {
      await channel.send(formatScheduledInputMessage({ schedulePrompt: event.content })).catch(() => null);
      this.markWorkspaceProgressTrackerHasTrailingMessages(event.workspaceId);
      return;
    }
    await channel.send(formatLocalInputMessage({ text: event.content, metadata: event.metadata })).catch(() => null);
    this.markWorkspaceProgressTrackerHasTrailingMessages(event.workspaceId);
  }

  async handleWorkspaceMessageDone(event) {
    if (!this.client || !event?.workspaceId || event.source === "discord") {
      return;
    }
    const binding = this.getWorkspaceDiscordBinding(event.workspaceId);
    if (!binding?.discordChannelId) {
      return;
    }
    const channel = await this.client.channels.fetch(binding.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return;
    }
    const tracker = this.workspaceProgressTrackers.get(event.workspaceId);
    if (tracker) {
      tracker.finalMessagePending = true;
    }
    try {
      for (const chunk of splitMessage(String(event.content || "").trim())) {
        if (!chunk) continue;
        await channel.send(chunk).catch(() => null);
      }
      this.markWorkspaceProgressTrackerHasTrailingMessages(event.workspaceId);
    } finally {
      const currentTracker = this.workspaceProgressTrackers.get(event.workspaceId);
      if (currentTracker) {
        currentTracker.finalMessagePending = false;
      }
      await this.finishWorkspaceProgressTracker(event.workspaceId, event.finalStatus || "completed", event.createdAt);
    }
  }

  async handleWorkspaceStatusChange(event) {
    if (!event?.workspaceId || event.source === "discord" || !this.config.discordStatusUpdates) {
      return;
    }
    if (WORKING_STATUSES.has(event.status)) {
      await this.startWorkspaceProgressTracker(event.workspaceId, event.agentName, event.createdAt);
      return;
    }
    if (["waiting_input", "quota_wait", "error"].includes(event.status)) {
      await this.finishWorkspaceProgressTracker(event.workspaceId, event.status, event.createdAt);
    }
  }

  async handleWorkspaceRunError(event) {
    if (!this.client || !event?.workspaceId || event.source === "discord") {
      return;
    }
    const binding = this.getWorkspaceDiscordBinding(event.workspaceId);
    if (!binding?.discordChannelId) {
      return;
    }
    const channel = await this.client.channels.fetch(binding.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return;
    }
    await channel.send(`Error: ${event.message}`).catch(() => null);
    this.markWorkspaceProgressTrackerHasTrailingMessages(event.workspaceId);
    await this.finishWorkspaceProgressTracker(event.workspaceId, "error", event.createdAt);
  }

  async handleWorkspaceObserverNotice(event) {
    if (!event?.workspaceId || !this.config.discordStatusUpdates) {
      return;
    }
    await this.sendWorkspaceChannelNotice(event.workspaceId, `ℹ️ ${event.message}`);
  }

  async handleWorkspaceApprovalEvent(kind, event) {
    if (!event?.workspaceId || !this.config.discordStatusUpdates) {
      return;
    }
    const approval = event.approval ?? {};
    const agentName = event.agentName || "agent";
    if (kind === "requested") {
      const summary = approval.summary || "承認待ちが発生しました。";
      await this.sendWorkspaceChannelNotice(
        event.workspaceId,
        `🛂 ${agentName} が承認待ちです。\n${summary}\n\`approve! ${agentName}\` / \`deny! ${agentName}\` で応答できます。`,
      );
      return;
    }
    if (kind === "expired") {
      await this.sendWorkspaceChannelNotice(
        event.workspaceId,
        `⌛ ${agentName} の承認待ちが期限切れになりました。必要なら Terminal で状態を確認してください。`,
      );
    }
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!this.isAllowedTarget(interaction.guildId, interaction.channelId)) {
      await interaction.reply({
        content: "This command is not allowed in this channel.",
        ephemeral: true,
      });
        return;
    }

    await interaction.reply({
      content:
        "Slash commands は廃止されました。`new!`、`workspace! <名前>`、`agents!`、`stop!`、`agentName? <prompt>` を使ってください。",
      ephemeral: true,
    }).catch(() => null);
  }

  formatSessionLine(session, index, currentSessionId) {
    const currentMark = session.id === currentSessionId ? " [current]" : "";
    return `${index + 1}. ${session.title} - ${session.status}${currentMark}`;
  }

  getLinkedSession(channelId) {
    return this.bridge.findSessionByDiscordChannel(channelId);
  }

  async handleSessionSlashCommand(interaction) {
    const sessions = this.bridge.listSessions();
    const selectedNumber = interaction.options.getInteger("number");
    const currentSession = this.getLinkedSession(interaction.channelId);

    if (sessions.length === 0) {
      await interaction.reply({
        content: "No sessions are available yet.",
        ephemeral: true,
      });
      return;
    }

    if (selectedNumber == null) {
      const lines = sessions
        .slice(0, 20)
        .map((session, index) =>
          this.formatSessionLine(session, index, currentSession?.id || null),
        );

      const extra =
        sessions.length > 20
          ? `\n...and ${sessions.length - 20} more session(s).`
          : "";

      await interaction.reply({
        content: `Connectable sessions:\n${lines.join("\n")}${extra}`,
        ephemeral: true,
      });
      return;
    }

    const session = sessions[selectedNumber - 1];
    if (!session) {
      await interaction.reply({
        content: `Session number ${selectedNumber} is out of range.`,
        ephemeral: true,
      });
      return;
    }

    const updated = this.bridge.bindDiscordChannelWithName(
      session.id,
      interaction.channelId,
      getChannelDisplayName(interaction.channel) || "unknown",
    );
    await interaction.reply({
      content: `This channel is now linked to session ${selectedNumber}: \`${updated.id}\` (${updated.title}).`,
      ephemeral: true,
    });
  }

  async handleNewSessionSlashCommand(interaction) {
    const reply = async (content) => interaction.reply({ content, ephemeral: true });
    await this.createOrBindWorkspaceFromChannel({
      channelId: interaction.channelId,
      channelName: getChannelDisplayName(interaction.channel) || interaction.channelId,
      reply,
    });
  }

  async handleRenameSessionSlashCommand(interaction) {
    const session = this.getLinkedSession(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "No session is linked to this channel yet.",
        ephemeral: true,
      });
      return;
    }

    const name = interaction.options.getString("name", true).trim();
    if (!name) {
      await interaction.reply({
        content: "Session name cannot be empty.",
        ephemeral: true,
      });
      return;
    }

    const updated = this.bridge.renameSession(session.id, name);
    await interaction.reply({
      content: `Renamed session \`${updated.id}\` to "${updated.title}".`,
      ephemeral: true,
    });
  }

  async handleStatusSlashCommand(interaction) {
    const session = this.getLinkedSession(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "No session is linked to this channel yet.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: formatStatusMessage(session),
      ephemeral: true,
    });
  }

  async handleModelSlashCommand(interaction) {
    const runtime = this.bridge.getRuntimeInfo();
    const selectedNumber = interaction.options.getInteger("number");
    const session = this.getLinkedSession(interaction.channelId);

    if (selectedNumber == null) {
      const lines = runtime.availableModels.map((model, index) => {
        const currentMark = session?.model === model.slug ? " [current]" : "";
        return `${index + 1}. ${model.displayName}${currentMark} - ${model.description}`;
      });

      const suffix = session
        ? ""
        : "\nLink this channel to a session first before switching.";

      await interaction.reply({
        content: `Available models:\n${lines.join("\n")}${suffix}`,
        ephemeral: true,
      });
      return;
    }

    if (!session) {
      await interaction.reply({
        content: "No session is linked to this channel yet.",
        ephemeral: true,
      });
      return;
    }

    const model = runtime.availableModels[selectedNumber - 1];
    if (!model) {
      await interaction.reply({
        content: `Model number ${selectedNumber} is out of range.`,
        ephemeral: true,
      });
      return;
    }

    const updated = this.bridge.updateSessionSettings(session.id, {
      model: model.slug,
    });

    await interaction.reply({
      content: `Model switched to \`${updated.model}\` for session \`${updated.id}\`.`,
      ephemeral: true,
    });
  }

  async handleReasoningSlashCommand(interaction) {
    const selectedNumber = interaction.options.getInteger("number");
    const session = this.getLinkedSession(interaction.channelId);

    if (!session) {
      await interaction.reply({
        content: "No session is linked to this channel yet.",
        ephemeral: true,
      });
      return;
    }

    const modelDefinition = this.bridge.getModelDefinition(session.model);
    const levels = modelDefinition?.supportedReasoningLevels || [];

    if (selectedNumber == null) {
      const lines = levels.map((level, index) => {
        const currentMark = session.reasoningEffort === level.effort ? " [current]" : "";
        return `${index + 1}. ${level.effort}${currentMark} - ${level.description}`;
      });

      await interaction.reply({
        content: `Reasoning levels for \`${session.model}\`:\n${lines.join("\n")}`,
        ephemeral: true,
      });
      return;
    }

    const level = levels[selectedNumber - 1];
    if (!level) {
      await interaction.reply({
        content: `Reasoning number ${selectedNumber} is out of range.`,
        ephemeral: true,
      });
      return;
    }

    const updated = this.bridge.updateSessionSettings(session.id, {
      reasoningEffort: level.effort,
    });

    await interaction.reply({
      content: `Reasoning switched to \`${updated.reasoningEffort}\` for session \`${updated.id}\`.`,
      ephemeral: true,
    });
  }

  async handleFastSlashCommand(interaction) {
    const session = this.getLinkedSession(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "No session is linked to this channel yet.",
        ephemeral: true,
      });
      return;
    }

    const enabled = interaction.options.getSubcommand() === "on";
    const updated = this.bridge.updateSessionSettings(session.id, {
      fastMode: enabled,
    });

    await interaction.reply({
      content: `Fast mode set to \`${updated.fastMode ? "on" : "off"}\` for session \`${updated.id}\`.`,
      ephemeral: true,
    });
  }

  async handleStopSlashCommand(interaction) {
    const session = this.getLinkedSession(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "No session is linked to this channel yet.",
        ephemeral: true,
      });
      return;
    }

    const result = this.bridge.stopSession(session.id);
    if (!result.stopped) {
      await interaction.reply({
        content: "Nothing is currently running for this session.",
        ephemeral: true,
      });
      return;
    }

    const details = [];
    if (result.cancelledRunning) {
      details.push("cancelled current run");
    }
    if (result.clearedQueuedCount > 0) {
      details.push(`cleared ${result.clearedQueuedCount} queued turn(s)`);
    }

    await interaction.reply({
      content:
        details.length > 0
          ? `Stopped session \`${session.id}\` (${details.join(", ")}).`
          : `Stopped session \`${session.id}\`.`,
    });
  }

  async handleRestartSlashCommand(interaction) {
    if (typeof this.restartServer !== "function") {
      await interaction.reply({
        content: "Server restart is not available in this deployment.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content:
        "Restarting the multiCLI-discord-base server now. If it was launched via start-multiCLI-discord-base.bat or scripts/start-server.cmd, it will come back automatically.",
      ephemeral: true,
    });

    try {
      await this.restartServer({
        requestedBy: interaction.user?.tag || interaction.user?.id || "unknown",
        source: "discord",
      });
    } catch (error) {
      console.error("Discord restart command failed:", error);
      await interaction.followUp({
        content: `Restart failed: ${error instanceof Error ? error.message : String(error)}`,
        ephemeral: true,
      }).catch(() => null);
    }
  }

  async handleLastMessageSlashCommand(interaction) {
    const session = this.getLinkedSession(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "No session is linked to this channel yet.",
        ephemeral: true,
      });
      return;
    }

    const result = this.bridge.recoverMissingAssistantMessage(session.id);
    const text = String(result?.message?.text || "").trim();
    if (!text) {
      await interaction.reply({
        content: "No recoverable assistant message was found for this session.",
        ephemeral: true,
      });
      return;
    }

    const prefix =
      result?.recovered
        ? `Recovered the last missing AI message for \`${session.title}\`:\n`
        : `The latest AI message for \`${session.title}\` was already imported:\n`;
    const header = prefix;
    const chunks = splitMessage(text, 1800 - header.length);
    await interaction.reply({
      content: `${header}${chunks[0]}`,
      ephemeral: true,
    });

    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({
        content: chunk,
        ephemeral: true,
      });
    }
  }

  async handleHelpSlashCommand(interaction) {
    await interaction.reply({
      content: formatDiscordHelpText(),
      ephemeral: true,
    });
  }

  // ── Multi-agent command handler ───────────────────────────────────────────

  resolveDiscordWorkspaceContext(channelId, requestedAgentName = null) {
    const ab = this.agentBridge;
    const binding = ab?.getDiscordBinding(channelId) ?? null;
    const boundWorkspace = binding?.workspaceId
      ? (ab?.getWorkspace?.(binding.workspaceId) ?? null)
      : null;
    const invalidBinding = Boolean(binding && !boundWorkspace);
    const workspaceId = invalidBinding ? null : (boundWorkspace?.id || null);
    const workspaceParentAgent = workspaceId ? (ab?.getWorkspaceParentAgent?.(workspaceId) ?? null) : null;
    const registryAgents = this.agentRegistry?.list?.() ?? [];
    const singleAgentName = registryAgents.length === 1 ? registryAgents[0].name : null;
    const defaultAgent = invalidBinding
      ? null
      : (binding?.defaultAgent || workspaceParentAgent || (binding ? singleAgentName : null) || null);

    return {
      binding,
      workspaceId,
      defaultAgent,
      agentName: invalidBinding ? null : (requestedAgentName || defaultAgent || null),
      invalidBinding,
    };
  }

  async replyWorkspaceBindingRequired(message, { binding, invalidBinding } = {}) {
    const workspaces = this.agentBridge?.listWorkspaces?.() ?? [];
    const workspaceList = formatWorkspaceBulletList(workspaces);
    if (invalidBinding) {
      await message.reply(
        `⚠️ このチャンネルは削除済みワークスペース \`${binding?.workspaceId}\` に紐づいています。\n` +
        `\`workspace! <名前>\` で再設定してください。\n\n` +
        `**利用可能なワークスペース:**\n${workspaceList}`
      );
      return;
    }
    await message.reply(
      "⚠️ このチャンネルはまだ workspace に紐づいていません。\n" +
      "既存 workspace に接続するか、新しく作成してください。\n\n" +
      "**使い方:**\n" +
      "- `workspace! <名前>` : 既存 workspace に紐づけ、なければ新規作成\n" +
      "- `new!` : このチャンネル名で新しい workspace を作成して紐づけ\n\n" +
      `**利用可能なワークスペース:**\n${workspaceList}`
    );
  }

  async resolveDiscordRemoteOpTarget(message, requestedAgentName = "", commandName = "status!") {
    const normalizedRequestedAgentName = String(requestedAgentName || "").trim().toLowerCase();
    const context = this.resolveDiscordWorkspaceContext(
      message.channelId,
      normalizedRequestedAgentName || null,
    );
    if (!context.binding || context.invalidBinding || !context.workspaceId) {
      await this.replyWorkspaceBindingRequired(message, context);
      return null;
    }

    const workspace = this.agentBridge?.getWorkspace?.(context.workspaceId) ?? null;
    const workspaceAgents = this.agentBridge?.listWorkspaceAgents?.(context.workspaceId) ?? [];
    const candidateAgentName = context.agentName || null;
    if (!candidateAgentName) {
      const candidates =
        workspaceAgents.map((entry) => entry.agentName).join(", ") ||
        (this.agentRegistry?.names?.() ?? []).join(", ");
      await message.reply(
        `操作対象の agent を特定できません。 \`${commandName} <agent>\` のように指定してください。` +
        (candidates ? ` 候補: ${candidates}` : "")
      );
      return null;
    }

    if (
      normalizedRequestedAgentName &&
      workspaceAgents.length > 0 &&
      !workspaceAgents.some((entry) => entry.agentName === candidateAgentName)
    ) {
      await message.reply(
        `エージェント \`${candidateAgentName}\` は workspace \`${workspace?.name || context.workspaceId}\` に参加していません。`
      );
      return null;
    }

    const agent = this.agentRegistry?.get?.(candidateAgentName) ?? null;
    if (!agent) {
      await message.reply(`エージェント \`${candidateAgentName}\` が見つかりません。`);
      return null;
    }

    return {
      ...context,
      agentName: candidateAgentName,
      agent,
      workspace,
      workspaceAgents,
    };
  }

  resolveDiscordWorkspaceCreateAgent() {
    const ab = this.agentBridge;
    const registryAgents = this.agentRegistry?.list?.() ?? [];
    if (registryAgents.length === 1) {
      return registryAgents[0]?.name || null;
    }

    const workspaces = ab?.listWorkspaces?.() ?? [];
    const activeWorkspace = workspaces.find((workspace) => workspace?.isActive) ?? null;
    const activeParentAgent = activeWorkspace
      ? (ab?.getWorkspaceParentAgent?.(activeWorkspace.id) ?? null)
      : null;
    if (activeParentAgent) {
      return activeParentAgent;
    }

    const distinctWorkspaceParents = [...new Set(
      workspaces
        .map((workspace) => (workspace?.id ? (ab?.getWorkspaceParentAgent?.(workspace.id) ?? null) : null))
        .filter(Boolean),
    )];
    if (distinctWorkspaceParents.length === 1) {
      return distinctWorkspaceParents[0];
    }

    return null;
  }

  async createOrBindWorkspaceFromChannel({ channelId, channelName, reply }) {
    const ab = this.agentBridge;
    const registry = this.agentRegistry;
    if (!ab) {
      await reply("AgentBridge が利用できません。");
      return null;
    }

    const desiredName = String(channelName || channelId || "").trim() || `workspace-${channelId}`;
    let workspace = ab.getWorkspaceByName(desiredName);
    const context = this.resolveDiscordWorkspaceContext(channelId);
    let parentAgent =
      (workspace ? ab.getWorkspaceParentAgent(workspace.id) : null) ||
      context.defaultAgent ||
      this.resolveDiscordWorkspaceCreateAgent();

    if (!workspace) {
      if (!parentAgent) {
        const agentList = registry?.list?.().map((item) => item.name).join(", ") || "なし";
        await reply(
          `複数エージェント構成のため、workspace 作成時の parentAgent を自動決定できません。\n` +
          `\`workspace! <名前>\` を使ってください。候補 agent: ${agentList}`
        );
        return null;
      }
      workspace = ab.createWorkspace({ name: desiredName, parentAgent });
      ab.bindDiscordChannel({
        discordChannelId: channelId,
        workspaceId: workspace.id,
        defaultAgent: parentAgent || undefined,
      });
      await reply(`Started a new workspace: \`${workspace.id}\` (${workspace.name})`);
      return workspace;
    }

    parentAgent = ab.getWorkspaceParentAgent(workspace.id) || parentAgent;
    ab.bindDiscordChannel({
      discordChannelId: channelId,
      workspaceId: workspace.id,
      defaultAgent: parentAgent || undefined,
    });
    await reply(`✅ このチャンネルをワークスペース **${workspace.name}** に紐づけました。`);
    return workspace;
  }

  async saveDiscordMessageAttachments(storageKey, rawAttachments = []) {
    const normalized = Array.isArray(rawAttachments) ? rawAttachments : [];
    if (!this.attachments || normalized.length === 0) {
      return [];
    }
    return this.attachments.saveDiscordAttachments(
      storageKey,
      normalized.map((attachment) => ({
        url: attachment.url,
        name: attachment.name || "attachment",
        contentType: attachment.contentType || null,
      })),
    );
  }

  async runDiscordAgentPrompt({ message, agentName, workspaceId, prompt, rawAttachments = [] }) {
    const registry = this.agentRegistry;
    const ab = this.agentBridge;
    const agent = registry?.get?.(agentName);
    if (!agent) {
      await message.reply(`エージェント \`${agentName}\` が見つかりません。`);
      return;
    }
    const { turnsAhead, promise } = this.enqueueWorkspacePrompt({
      workspaceId,
      agentName,
      task: async () => {
        const startedAt = Date.now();
        const tracker = {
          progressMessage: null,
          streamedText: "",
          updateStep: 0,
          timeoutId: null,
          closed: false,
        };
        let progressQueue = Promise.resolve();
        const workingLabel = `${agentName} working`;

        const clearProgressTimer = () => {
          if (tracker.timeoutId) {
            clearTimeout(tracker.timeoutId);
            tracker.timeoutId = null;
          }
        };
        const enqueueProgressTask = (task) => {
          progressQueue = progressQueue
            .then(task)
            .catch((error) => {
              console.error("Discord live progress update failed:", error);
            });
          return progressQueue;
        };
        const replaceProgressMessage = async (content) => {
          if (tracker.progressMessage?.delete) {
            await tracker.progressMessage.delete().catch(() => null);
          }
          tracker.progressMessage = await message.channel.send(content).catch(() => null);
          return tracker.progressMessage;
        };
        const scheduleProgressRefresh = () => {
          clearProgressTimer();
          if (tracker.closed) {
            return;
          }
          const delayMs = getProgressUpdateDelayMs(tracker.updateStep);
          tracker.timeoutId = setTimeout(() => {
            tracker.updateStep += 1;
            void enqueueProgressTask(async () => {
              if (tracker.closed) {
                return;
              }
              await replaceProgressMessage(formatWorkingStatusContent(startedAt, workingLabel));
              scheduleProgressRefresh();
            });
          }, delayMs);
        };
        const refreshProgressTail = async () => {
          if (tracker.closed) {
            return;
          }
          await replaceProgressMessage(formatWorkingStatusContent(startedAt, workingLabel));
        };
        const sendSyncedText = async (content) => {
          const suffix = getUnsyncedSuffix(content, tracker.streamedText);
          if (!suffix.trim()) {
            return;
          }
          const chunks = splitMessage(suffix, 1900);
          for (const chunk of chunks) {
            await message.channel.send(chunk).catch(() => null);
          }
          tracker.streamedText = `${tracker.streamedText}${suffix}`;
          await refreshProgressTail();
        };
        const finishProgress = async (content) => {
          clearProgressTimer();
          tracker.closed = true;
          await replaceProgressMessage(content);
        };

        await enqueueProgressTask(async () => {
          await replaceProgressMessage(formatWorkingStatusContent(startedAt, workingLabel));
          scheduleProgressRefresh();
        });

        const onProgress = async (event) => {
          if (event.type === "message.delta") {
            await enqueueProgressTask(async () => {
              await sendSyncedText(event.content);
            });
            return;
          }

          if (event.type === "message.done") {
            await enqueueProgressTask(async () => {
              await sendSyncedText(event.content);
            });
          }
        };

        try {
          const workdir = this.config.codexWorkdir;
          const savedAttachments = await this.saveDiscordMessageAttachments(
            workspaceId || `discord-${message.channelId}`,
            rawAttachments,
          );
          const promptWithAttachments = buildPromptWithAttachmentPaths(prompt, savedAttachments);

          let result;
          if (ab) {
            result = await ab.runPrompt({
              agentName,
              prompt: promptWithAttachments,
              workspaceId,
              workdir,
              source: "discord",
              discordMessageId: message.id,
              onProgress,
            });
          } else {
            const raw = await agent.run({ prompt: promptWithAttachments, workdir });
            result = { text: raw.text, usage: raw.usage };
          }

          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          await enqueueProgressTask(async () => {
            await sendSyncedText(result.text);
            await finishProgress(`> ✅ ${agentName} 完了 (${elapsed}s)`);
          });
          await message.react("\u2611").catch(() => null);
        } catch (err) {
          clearProgressTimer();
          if (err.cancelled) {
            await enqueueProgressTask(async () => {
              await finishProgress(`> ⏹ ${agentName} キャンセルされました。`);
            });
            return;
          }
          const errText = `> ❌ ${agentName} エラー: ${err.message}`;
          await enqueueProgressTask(async () => {
            await finishProgress(errText);
          });
        }
      },
    });
    const queuedNotice = formatQueuedNotice(turnsAhead);
    if (queuedNotice) {
      await message.reply(queuedNotice).catch(() => null);
    }
    await promise;
  }

  async handleAgentCommand(message, cmd, rawAttachments = []) {
    const { agent: agentName, verb, prompt } = cmd;
    const registry = this.agentRegistry;
    const ab = this.agentBridge;
    const ensureValidWorkspaceContext = async (requestedAgentName = null) => {
      const context = this.resolveDiscordWorkspaceContext(message.channelId, requestedAgentName);
      if (context.binding && !context.invalidBinding && context.workspaceId) {
        return context;
      }
      await this.replyWorkspaceBindingRequired(message, context);
      return null;
    };

    // Global: "workspace!" — show or set channel↔workspace binding
    if (!agentName && verb === "workspace") {
      if (!ab) {
        await message.reply("AgentBridge が利用できません。");
        return;
      }
      const channelId = message.channelId;

      if (!prompt) {
        // Show current binding
        const context = this.resolveDiscordWorkspaceContext(channelId);
        const binding = context.binding;
        const ws = binding && !context.invalidBinding ? (ab.getWorkspace?.(binding.workspaceId) ?? null) : null;
        const wsName = context.invalidBinding
          ? `${binding?.workspaceId} (deleted)`
          : (ws?.name ?? binding?.workspaceId ?? "なし");
        const agentHint = binding?.defaultAgent ? ` (デフォルトエージェント: ${binding.defaultAgent})` : "";
        const workspaces = formatWorkspaceBulletList(ab.listWorkspaces());
        const invalidHint = context.invalidBinding
          ? "\n\n⚠️ この紐づけ先は削除済みです。`workspace! <名前>` で再設定してください。"
          : "";
        await message.reply(
          `**このチャンネルのワークスペース:** ${wsName}${agentHint}\n\n` +
          `**利用可能なワークスペース:**\n${workspaces}\n\n` +
          `変更するには: \`workspace! <名前>\`${invalidHint}`
        );
        return;
      }

      // Bind to workspace by name (create if not exists)
      const context = this.resolveDiscordWorkspaceContext(channelId);
      let workspace = ab.getWorkspaceByName(prompt);
      let parentAgent =
        (workspace ? ab.getWorkspaceParentAgent(workspace.id) : null) ||
        context.defaultAgent ||
        this.resolveDiscordWorkspaceCreateAgent();
      const created = !workspace;
      if (!workspace) {
        if (!parentAgent) {
          const agentList = registry.list().map((item) => item.name).join(", ");
          await message.reply(
            `複数エージェント構成のため、workspace 作成時の parentAgent を自動決定できません。利用する agent を明示してください。候補: ${agentList}`
          );
          return;
        }
        workspace = ab.createWorkspace({ name: prompt, parentAgent });
      }
      ab.bindDiscordChannel({
        discordChannelId: channelId,
        workspaceId: workspace.id,
        defaultAgent: parentAgent || undefined,
      });
      await message.reply(
        created
          ? `Started a new workspace: \`${workspace.id}\` (${workspace.name})`
          : `✅ このチャンネルをワークスペース **${workspace.name}** に紐づけました。`
      );
      return;
    }

    // Global: "stop!" — stop all agents
    if (!agentName && verb === "stop") {
      ab ? ab.stopAll() : registry.stopAll();
      await message.reply("⏹ 全エージェントを停止しました。");
      return;
    }

    // Global: "agents!" — list all agents
    if (!agentName && verb === "agents") {
      await message.reply(registry.formatList());
      return;
    }

    const agent = registry.get(agentName);
    if (!agent) {
      await message.reply(`エージェント \`${agentName}\` が見つかりません。\n\n${registry.formatList()}`);
      return;
    }

    // "hanako stop!" — stop agent
    if (verb === "stop") {
      const context = await ensureValidWorkspaceContext(agentName);
      if (!context) return;
      const { workspaceId } = context;
      ab ? ab.cancelAgent(agentName, workspaceId) : agent.cancel();
      await message.reply(`⏹ ${agentName} を停止しました。`);
      return;
    }

    // "hanako new!" / "hanako reset!" — reset session
    if (verb === "new" || verb === "reset") {
      const context = await ensureValidWorkspaceContext(agentName);
      if (!context) return;
      const { workspaceId } = context;
      ab ? ab.resetAgentSession(agentName, workspaceId) : agent.resetSession();
      await message.reply(`🆕 ${agentName} のセッションをリセットしました。`);
      return;
    }

    // "hanako?" (no prompt) — show status
    if (!prompt) {
      if (ab) {
        const context = await ensureValidWorkspaceContext(agentName);
        if (!context) return;
        const { workspaceId } = context;
        const workspace = ab.getWorkspace?.(workspaceId);
        const terminalState = ab.getAgentTerminalState(agentName, workspaceId);
        const workspaceLabel = workspace?.name ? `${workspace.name} (${workspaceId})` : workspaceId;
        await message.reply(`ℹ️ ${agentName} [${workspaceLabel}] status: ${terminalState.status}`);
        return;
      }
      await message.reply(agent.getStatusLine());
      return;
    }

    // "hanako? <prompt>" — run prompt via AgentBridge (with CanonicalEvents)
    // Resolve workspace from Discord channel binding
    const context = await ensureValidWorkspaceContext(agentName);
    if (!context) return;
    const { workspaceId } = context;

    if (isSlashPassthroughInput(prompt)) {
      try {
        await this.agentBridge.sendRemoteCommand(agentName, workspaceId, prompt, {
          source: "discord-slash",
        });
        await message.react("☑").catch(() => null);
        await message.reply(`↪ ${agentName} に \`${prompt}\` を送信しました。結果は shared PTY / Chat / Discord に流れます。`);
      } catch (error) {
        await message.reply(`⚠️ ${agentName}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    await this.runDiscordAgentPrompt({ message, agentName, workspaceId, prompt, rawAttachments });
  }

  // ─────────────────────────────────────────────────────────────────────────

  async handleMessage(message) {
    if (!this.isAllowedMessage(message)) {
      return;
    }

    const content = message.content.trim();
    const rawAttachments = [...message.attachments.values()];
    if (!content && rawAttachments.length === 0) {
      return;
    }

    // ── Multi-agent "?" command handling ──────────────────────────────────
    if (this.agentRegistry?.hasAgents()) {
      const agentNames = this.agentRegistry.names();
      const cmd = parseAgentCommand(content, agentNames);
      if (cmd) {
        await this.handleAgentCommand(message, cmd, rawAttachments);
        return;
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    const bangCommand = parseLeadingBangCommand(content);

    if (bangCommand?.command === "output!") {
      if (!this.agentBridge || !this.agentRegistry?.hasAgents()) {
        await message.reply("output! は PTY-first workspace でのみ利用できます。");
        return;
      }
      const target = await this.resolveDiscordRemoteOpTarget(message, bangCommand.args, "output!");
      if (!target) {
        return;
      }
      const output = this.agentBridge.getAgentTerminalOutput?.(target.agentName, target.workspaceId, {
        lineLimit: 50,
      }) ?? { text: "", status: "idle", totalLineCount: 0, lineLimit: 50, truncated: false };
      if (!output.text) {
        await message.reply(
          `ℹ️ ${target.agentName} の PTY 出力はまだありません。status=${output.status || "idle"}`
        );
        return;
      }
      const chunks = splitMessage(
        formatTerminalOutputMessage({
          workspace: target.workspace,
          agentName: target.agentName,
          output,
        }),
        1800,
      );
      await message.reply(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await message.channel.send(chunk).catch(() => null);
      }
      return;
    }

    if (bangCommand?.command === "enter!") {
      if (!this.agentBridge || !this.agentRegistry?.hasAgents()) {
        await message.reply("enter! は PTY-first workspace でのみ利用できます。");
        return;
      }
      const target = await this.resolveDiscordRemoteOpTarget(message, bangCommand.args, "enter!");
      if (!target) {
        return;
      }
      const result = this.agentBridge.sendTerminalInput?.(
        target.agentName,
        target.workspaceId,
        "\r",
        { workdir: target.workspace?.workdir },
      ) ?? { ok: false, reason: "unavailable" };
      if (!result.ok) {
        const detail =
          result.reason === "not_started"
            ? "PTY がまだ起動していません。Terminal タブを開くか prompt を送って開始してください。"
            : "Enter を送信できませんでした。";
        await message.reply(`⚠️ ${target.agentName}: ${detail}`);
        return;
      }
      await message.reply(`↵ ${target.agentName} に Enter を送信しました。`);
      return;
    }

    if (bangCommand?.command === "approve!" || bangCommand?.command === "deny!") {
      if (!this.agentBridge || !this.agentRegistry?.hasAgents()) {
        await message.reply(`${bangCommand.command} は PTY-first workspace でのみ利用できます。`);
        return;
      }
      const target = await this.resolveDiscordRemoteOpTarget(
        message,
        bangCommand.args,
        bangCommand.command,
      );
      if (!target) {
        return;
      }
      const result = this.agentBridge.respondToApproval?.(
        target.agentName,
        target.workspaceId,
        bangCommand.command === "approve!" ? "approve" : "deny",
        { workdir: target.workspace?.workdir },
      ) ?? { ok: false, reason: "unavailable" };
      if (!result.ok) {
        const detail =
          result.reason === "approval_not_pending"
            ? "現在 pending の承認待ちはありません。"
            : result.reason === "not_started"
              ? "PTY が起動していません。Terminal を開いて状態を確認してください。"
              : "承認応答を送信できませんでした。";
        await message.reply(`⚠️ ${target.agentName}: ${detail}`);
        return;
      }
      await message.reply(
        bangCommand.command === "approve!"
          ? `✅ ${target.agentName} に approve を送信しました。`
          : `🛑 ${target.agentName} に deny を送信しました。`,
      );
      return;
    }

    if (bangCommand?.command === "bindings!") {
      if (!this.agentBridge || !this.agentRegistry?.hasAgents()) {
        await message.reply("bindings! は PTY-first workspace でのみ利用できます。");
        return;
      }
      const context = this.resolveDiscordWorkspaceContext(message.channelId);
      if (!context.binding || context.invalidBinding || !context.workspaceId) {
        await this.replyWorkspaceBindingRequired(message, context);
        return;
      }
      const bindings = this.agentBridge.listResumeBindings?.(context.workspaceId) ?? [];
      const lines = [
        `Workspace: ${this.agentBridge.getWorkspace?.(context.workspaceId)?.name || context.workspaceId}`,
        `Workspace ID: ${context.workspaceId}`,
        "",
        ...(bindings.length > 0
          ? bindings.map((entry) => `- ${entry.agentName} :: ${entry.providerSessionRef || "none"} :: ${entry.bindingStatus || "unknown"}`)
          : ["- binding はまだありません。"]),
      ];
      const chunks = splitMessage(lines.join("\n"), 1800);
      await message.reply(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await message.channel.send(chunk).catch(() => null);
      }
      return;
    }

    if (bangCommand?.command === "resume!") {
      if (!this.agentBridge || !this.agentRegistry?.hasAgents()) {
        await message.reply("resume! は PTY-first workspace でのみ利用できます。");
        return;
      }
      const target = await this.resolveDiscordRemoteOpTarget(message, bangCommand.args, "resume!");
      if (!target) {
        return;
      }
      try {
        const result = await this.agentBridge.resumeAgentSession?.(target.agentName, target.workspaceId, {
          workdir: target.workspace?.workdir,
          waitForReadyMs: 4000,
        });
        await message.reply(
          result?.resumed
            ? `♻️ ${target.agentName} を resume しました。status=${result.terminalState?.status || "unknown"}`
            : `ℹ️ ${target.agentName} は resume できませんでした。`
        );
      } catch (err) {
        await message.reply(`⚠️ ${target.agentName}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (bangCommand?.command === "restart!") {
      if (!this.agentBridge || !this.agentRegistry?.hasAgents()) {
        await message.reply("restart! は PTY-first workspace でのみ利用できます。");
        return;
      }
      const target = await this.resolveDiscordRemoteOpTarget(message, bangCommand.args, "restart!");
      if (!target) {
        return;
      }
      try {
        const result = await this.agentBridge.restartAgent?.(target.agentName, target.workspaceId, {
          workdir: target.workspace?.workdir,
          waitForReadyMs: 4000,
          force: false,
          requestedBy: "Discord",
          source: "discord",
        });
        await message.reply(
          `🔁 ${target.agentName} を再起動しました。status=${result?.terminalState?.status || result?.status || "unknown"}`
        );
      } catch (err) {
        await message.reply(`⚠️ ${target.agentName}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (bangCommand?.command === "checkpoints!") {
      if (!this.agentBridge || !this.agentRegistry?.hasAgents()) {
        await message.reply("checkpoints! は PTY-first workspace でのみ利用できます。");
        return;
      }
      const context = this.resolveDiscordWorkspaceContext(message.channelId);
      if (!context.binding || context.invalidBinding || !context.workspaceId) {
        await this.replyWorkspaceBindingRequired(message, context);
        return;
      }
      const args = String(bangCommand.args || "").trim();
      if (args.toLowerCase().startsWith("create")) {
        const label = args.slice("create".length).trim();
        try {
          const checkpoint = this.agentBridge.createWorkspaceCheckpoint?.(context.workspaceId, {
            label,
            kind: "manual",
            requestedBy: "Discord",
            source: "discord",
          });
          await message.reply(`📸 checkpoint を作成しました: \`${checkpoint?.id || "unknown"}\`${label ? ` (${label})` : ""}`);
        } catch (err) {
          await message.reply(`⚠️ checkpoint 作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      const checkpoints = this.agentBridge.listWorkspaceCheckpoints?.(context.workspaceId, 8) ?? [];
      const lines = [
        `Workspace: ${this.agentBridge.getWorkspace?.(context.workspaceId)?.name || context.workspaceId}`,
        "",
        ...(checkpoints.length > 0
          ? checkpoints.map((entry) => `- ${entry.id} :: ${entry.kind || "manual"} :: ${entry.label || "(no label)"}`)
          : ["- checkpoint はまだありません。"]),
      ];
      const chunks = splitMessage(lines.join("\n"), 1800);
      await message.reply(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await message.channel.send(chunk).catch(() => null);
      }
      return;
    }

    if (bangCommand?.command === "rollback!") {
      if (!this.agentBridge || !this.agentRegistry?.hasAgents()) {
        await message.reply("rollback! は PTY-first workspace でのみ利用できます。");
        return;
      }
      const context = this.resolveDiscordWorkspaceContext(message.channelId);
      if (!context.binding || context.invalidBinding || !context.workspaceId) {
        await this.replyWorkspaceBindingRequired(message, context);
        return;
      }
      const [subcommandRaw = "", checkpointIdRaw = ""] = String(bangCommand.args || "").trim().split(/\s+/, 2);
      const subcommand = subcommandRaw.toLowerCase();
      const checkpointId = checkpointIdRaw.trim();
      if (!checkpointId || !["preview", "apply"].includes(subcommand)) {
        await message.reply("使い方: `rollback! preview <checkpointId>` または `rollback! apply <checkpointId>`");
        return;
      }
      try {
        const result =
          subcommand === "apply"
            ? this.agentBridge.applyWorkspaceRollback?.(context.workspaceId, checkpointId, {
                approved: true,
                requestedBy: "Discord",
                source: "discord",
              })
            : this.agentBridge.previewWorkspaceRollback?.(context.workspaceId, checkpointId, {
                source: "discord",
              });
        const lines = subcommand === "apply"
          ? [
              `↩ rollback を適用しました: ${checkpointId}`,
              `workspace=${context.workspaceId}`,
              `head=${result?.repository?.head || result?.head || "unknown"}`,
            ]
          : [
              `Preview: ${checkpointId}`,
              `workspace=${context.workspaceId}`,
              `blocked=${result?.blocked ? "yes" : "no"}`,
              `reasons=${(result?.reasons || []).join(", ") || "none"}`,
            ];
        await message.reply(lines.join("\n"));
      } catch (err) {
        await message.reply(`⚠️ rollback に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (bangCommand?.command === "skills!") {
      if (!this.agentBridge || !this.agentRegistry?.hasAgents()) {
        await message.reply("skills! は PTY-first workspace でのみ利用できます。");
        return;
      }
      const context = this.resolveDiscordWorkspaceContext(message.channelId);
      if (!context.binding || context.invalidBinding || !context.workspaceId) {
        await this.replyWorkspaceBindingRequired(message, context);
        return;
      }
      const tokens = String(bangCommand.args || "").trim().split(/\s+/).filter(Boolean);
      const apply = tokens[0]?.toLowerCase() === "apply";
      const agentName = apply ? (tokens[1] || "") : (tokens[0] || "");
      try {
        const result = apply
          ? this.agentBridge.applyWorkspaceSkillSync?.(context.workspaceId, {
              agentName,
              requestedBy: "Discord",
              source: "discord",
            })
          : this.agentBridge.planWorkspaceSkillSync?.(context.workspaceId, {
              agentName,
            });
        const changes = Array.isArray(result?.changes) ? result.changes : [];
        const lines = [
          apply ? "🧩 skill sync を適用しました。" : "🧩 skill sync plan:",
          `workspace=${context.workspaceId}`,
          ...(changes.length > 0
            ? changes.slice(0, 10).map((entry) => `- ${entry.action || "noop"} :: ${entry.target || entry.relativePath || "unknown"}`)
            : ["- 変更はありません。"]),
        ];
        await message.reply(splitMessage(lines.join("\n"), 1800)[0]);
      } catch (err) {
        await message.reply(`⚠️ skills 実行に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (bangCommand?.command === "status!") {
      if (this.agentBridge && this.agentRegistry?.hasAgents()) {
        const context = this.resolveDiscordWorkspaceContext(message.channelId);
        if (!context.binding || context.invalidBinding || !context.workspaceId) {
          await this.replyWorkspaceBindingRequired(message, context);
          return;
        }
        const workspace = this.agentBridge.getWorkspace?.(context.workspaceId) ?? null;
        const requestedAgentName = String(bangCommand.args || "").trim().toLowerCase();
        const workspaceAgents = this.agentBridge.listWorkspaceAgents?.(context.workspaceId) ?? [];
        const fallbackAgentEntries =
          workspaceAgents.length > 0
            ? workspaceAgents
            : (context.agentName ? [{ agentName: context.agentName, isParent: true }] : []);
        const agentEntries = requestedAgentName
          ? fallbackAgentEntries.filter((entry) => entry.agentName === requestedAgentName)
          : fallbackAgentEntries;
        if (requestedAgentName && agentEntries.length === 0) {
          const knownAgent = this.agentRegistry.get?.(requestedAgentName);
          await message.reply(
            knownAgent
              ? `エージェント \`${requestedAgentName}\` は workspace \`${workspace?.name || context.workspaceId}\` に参加していません。`
              : `エージェント \`${requestedAgentName}\` が見つかりません。`
          );
          return;
        }
        const defaultAgent = context.defaultAgent || context.agentName || null;
        const agentStatuses = agentEntries.map((entry) => {
          const terminalState = this.agentBridge.getAgentTerminalState(entry.agentName, context.workspaceId);
          return formatAgentRuntimeStatusLine({
            agentName: entry.agentName,
            isParent: Boolean(entry.isParent),
            isDefault: entry.agentName === defaultAgent,
            terminalState,
            queuedCount: this.getWorkspaceQueuedTurns(context.workspaceId, entry.agentName),
          });
        });
        await message.reply(
          formatWorkspaceRuntimeStatusMessage({
            workspace,
            defaultAgent,
            agentStatuses,
            focusedAgentName: requestedAgentName,
          })
        );
        return;
      }

      const session = this.getLinkedSession(message.channelId);
      if (!session) {
        await message.reply("No session is linked to this channel yet.");
        return;
      }

      await message.reply(formatStatusMessage(session));
      return;
    }

    if (bangCommand?.command === "help!") {
      await message.reply(formatDiscordHelpText());
      return;
    }

    if (bangCommand?.command === "new!") {
      await this.createOrBindWorkspaceFromChannel({
        channelId: message.channelId,
        channelName: getChannelDisplayName(message.channel) || message.channelId,
        reply: (content) => message.reply(content),
      });
      return;
    }

    if (bangCommand?.command === "bind!") {
      const sessionId = bangCommand.args;
      const session = this.bridge.bindDiscordChannelWithName(
        sessionId,
        message.channelId,
        getChannelDisplayName(message.channel) || "unknown",
      );
      if (!session) {
        await message.reply(`Session not found: \`${sessionId}\``);
        return;
      }

      await message.reply(`This channel is now linked to session \`${session.id}\`.`);
      return;
    }

    if (this.agentBridge && this.agentRegistry?.hasAgents()) {
      const context = this.resolveDiscordWorkspaceContext(message.channelId);
      if (!context.binding || context.invalidBinding || !context.workspaceId || !context.agentName) {
        await this.replyWorkspaceBindingRequired(message, context);
        return;
      }
      if (isSlashPassthroughInput(message.content)) {
        try {
          await this.agentBridge.sendRemoteCommand(context.agentName, context.workspaceId, message.content, {
            source: "discord-slash",
          });
          await message.react("☑").catch(() => null);
          await message.reply(`↪ ${context.agentName} に \`${message.content.trim()}\` を送信しました。結果は shared PTY / Chat / Discord に流れます。`);
        } catch (error) {
          await message.reply(`⚠️ ${context.agentName}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      await this.runDiscordAgentPrompt({
        message,
        agentName: context.agentName,
        workspaceId: context.workspaceId,
        prompt: message.content,
        rawAttachments,
      });
      return;
    }

    let session = this.getLinkedSession(message.channelId);
    if (!session) {
      await this.replyWorkspaceBindingRequired(message, this.resolveDiscordWorkspaceContext(message.channelId));
      return;
    }

    try {
      const savedAttachments = await this.attachments.saveDiscordAttachments(
        session.id,
        rawAttachments.map((attachment) => ({
          url: attachment.url,
          name: attachment.name || "attachment",
          contentType: attachment.contentType || null,
        })),
      );

      const result = await this.bridge.handleIncomingMessage({
        sessionId: session.id,
        text: message.content,
        source: "discord",
        discordMessageId: message.id,
        attachments: savedAttachments,
      });
      await message.react("\u2611").catch(() => null);
      const queuedNotice = formatQueuedNotice(result.queue?.turnsAhead);
      if (queuedNotice) {
        await message.reply(queuedNotice).catch(() => null);
      }
    } catch (error) {
      await message.reply(error instanceof Error ? error.message : String(error));
    }
  }

  async handleBridgeMessage(event) {
    const session = this.bridge.getSession(event.sessionId);
    if (!session?.discordChannelId || !this.client) {
      return;
    }

    if (event.eventType === "message.assistant" && event.payload.isFinal) {
      const tracker = this.progressTrackers.get(session.id);
      if (tracker) {
        tracker.finalMessagePending = true;
      }
    }

    const channel = await this.client.channels.fetch(session.discordChannelId);
    if (!channel || !channel.isTextBased()) {
      const tracker = this.progressTrackers.get(session.id);
      if (tracker && event.eventType === "message.assistant" && event.payload.isFinal) {
        tracker.finalMessagePending = false;
        await this.flushPendingFinishedProgress(session.id);
        this.progressTrackers.delete(session.id);
      }
      return;
    }

    if (event.eventType === "message.user" && event.source === "ui") {
      await channel.send(formatLocalInputMessage(event.payload));
      this.markProgressTrackerHasTrailingMessages(session.id);
      return;
    }

    if (event.eventType === "message.user" && event.source === "schedule") {
      await channel.send(formatScheduledInputMessage(event.payload));
      this.markProgressTrackerHasTrailingMessages(session.id);
      return;
    }

    if (event.eventType === "message.assistant") {
      const replyToDiscordMessageId = event.payload.replyToDiscordMessageId || null;
      const shouldReply = Boolean(event.payload.isFinal && replyToDiscordMessageId);
      try {
        for (const chunk of splitMessage(event.payload.text)) {
          if (!shouldReply) {
            await channel.send(chunk);
            continue;
          }

          await channel
            .send({
              content: chunk,
              reply: { messageReference: replyToDiscordMessageId },
              allowedMentions: { repliedUser: false },
            })
            .catch(() => channel.send(chunk));
        }
        this.markProgressTrackerHasTrailingMessages(session.id);
      } finally {
        if (event.payload.isFinal) {
          const currentTracker = this.progressTrackers.get(session.id);
          if (currentTracker) {
            currentTracker.finalMessagePending = false;
          }
          await this.flushPendingFinishedProgress(session.id);
          const latestTracker = this.progressTrackers.get(session.id);
          if (latestTracker && !latestTracker.pendingFinishedStatus) {
            this.progressTrackers.delete(session.id);
          }
        }
      }
      return;
    }

    if (event.eventType === "command.started") {
      for (const chunk of splitMessage(formatRunningCommandMessage(event.payload.command))) {
        await channel.send(chunk);
      }
      this.markProgressTrackerHasTrailingMessages(session.id);
    }
  }

  async handleStatusEvent(event) {
    if (!this.config.discordStatusUpdates) {
      return;
    }

    const session = this.bridge.getSession(event.sessionId);
    if (!session?.discordChannelId || !this.client) {
      return;
    }

    if (WORKING_STATUSES.has(event.payload.status)) {
      await this.startProgressTracker(session, event);
      return;
    }

    if (["completed", "error", "stopped"].includes(event.payload.status)) {
      await this.finishProgressTracker(session, event);
    }
  }

  async handleErrorEvent(event) {
    const session = this.bridge.getSession(event.sessionId);
    if (!session?.discordChannelId || !this.client) {
      return;
    }

    const channel = await this.client.channels.fetch(session.discordChannelId);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    await channel.send(`Error: ${event.payload.message}`);
    this.markProgressTrackerHasTrailingMessages(session.id);
  }
}

export const __testHooks = {
  formatWorkingStatusContent,
  getUnsyncedSuffix,
  formatDiscordHelpText,
  formatWorkspaceRuntimeStatusMessage,
  formatTerminalOutputMessage,
  formatLocalInputMessage,
  isSlashPassthroughInput,
};
