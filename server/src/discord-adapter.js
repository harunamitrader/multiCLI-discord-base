import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
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

function buildSessionCommand() {
  return new SlashCommandBuilder()
    .setName("codex")
    .setDescription("CoDiCoDi commands.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("session")
        .setDescription("List sessions or bind this channel to one.")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("1-based session number from the /codex session list")
            .setMinValue(1)
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("new")
        .setDescription("Create and link a new session for this channel."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("rename")
        .setDescription("Rename the current session for this channel.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("New session name")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show the current linked session status."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("model")
        .setDescription("List models or switch the current session model.")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("1-based model number from the /codex model list")
            .setMinValue(1)
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("reasoning")
        .setDescription("List reasoning levels or switch the current session reasoning level.")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("1-based reasoning level number from the /codex reasoning list")
            .setMinValue(1)
            .setRequired(false),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("fast")
        .setDescription("Toggle fast mode for the current session.")
        .addSubcommand((subcommand) =>
          subcommand.setName("on").setDescription("Enable fast mode."),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName("off").setDescription("Disable fast mode."),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stop")
        .setDescription("Stop the current Codex generation for this channel."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("last-message")
        .setDescription("Recover the last missing AI message for the current session."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("restart")
        .setDescription("Restart the CoDiCoDi server."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("help")
        .setDescription("Show CoDiCoDi commands and examples."),
    );
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

function getChannelDisplayName(channel) {
  return channel?.name || null;
}

function getElapsedSeconds(startedAt) {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
}

function getWorkingDots() {
  const frames = [".", "..", "..."];
  return frames[Math.floor(Date.now() / 1000) % frames.length];
}

function formatWorkingStatusContent(startedAt) {
  return `> Working${getWorkingDots()} (${getElapsedSeconds(startedAt)}s)`;
}

function formatFinishedStatusContent(status, startedAt) {
  const seconds = getElapsedSeconds(startedAt);
  const label = status[0].toUpperCase() + status.slice(1);
  return `> ${label} (${seconds}s)`;
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

function formatLocalInputMessage(payload) {
  const lines = [];
  const text = String(payload.text || "").trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

  if (text) {
    lines.push("Local input:", `>>> ${text}`);
  } else {
    lines.push("Local input with attachments:");
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

/**
 * Parse a "?" agent command from Discord message content.
 *
 * Patterns:
 *   "hanako? <prompt>"  → { agent: "hanako", verb: null,      prompt: "<prompt>" }
 *   "hanako?"           → { agent: "hanako", verb: null,      prompt: "" }
 *   "hanako new?"       → { agent: "hanako", verb: "new",     prompt: null }
 *   "hanako stop?"      → { agent: "hanako", verb: "stop",    prompt: null }
 *   "stop?"             → { agent: null,     verb: "stop",    prompt: null }
 *   "agents?"           → { agent: null,     verb: "agents",  prompt: null }
 *
 * Returns null if no pattern matches.
 */
function parseAgentCommand(content, agentNames) {
  const trimmed = content.trim();

  // Global commands: "stop?" / "agents?" / "workspace?" / "cost?"
  if (/^stop\?$/i.test(trimmed)) return { agent: null, verb: "stop", prompt: null };
  if (/^agents?\?$/i.test(trimmed)) return { agent: null, verb: "agents", prompt: null };
  const wsMatch = trimmed.match(/^workspace\?\s*([\s\S]*)$/i);
  if (wsMatch) return { agent: null, verb: "workspace", prompt: wsMatch[1].trim() };
  const costMatch = trimmed.match(/^cost\?\s*(today|week|month|all)?$/i);
  if (costMatch) return { agent: null, verb: "cost", prompt: (costMatch[1] || "all").toLowerCase() };

  // "hanako new?" / "hanako stop?" — verb before ?
  const verbMatch = trimmed.match(/^(\S+)\s+(new|stop|reset)\?$/i);
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
        console.error("Discord slash command registration failed:", error);
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

    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
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

    const commands = [buildSessionCommand().toJSON()];

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

    if (interaction.commandName !== "codex") {
      return;
    }

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "session") {
      await this.handleSessionSlashCommand(interaction);
      return;
    }

    if (subcommand === "new") {
      await this.handleNewSessionSlashCommand(interaction);
      return;
    }

    if (subcommand === "rename") {
      await this.handleRenameSessionSlashCommand(interaction);
      return;
    }

    if (subcommand === "status") {
      await this.handleStatusSlashCommand(interaction);
      return;
    }

    if (subcommand === "model") {
      await this.handleModelSlashCommand(interaction);
      return;
    }

    if (subcommand === "reasoning") {
      await this.handleReasoningSlashCommand(interaction);
      return;
    }

    if (subcommandGroup === "fast") {
      await this.handleFastSlashCommand(interaction);
      return;
    }

    if (subcommand === "stop") {
      await this.handleStopSlashCommand(interaction);
      return;
    }

    if (subcommand === "last-message") {
      await this.handleLastMessageSlashCommand(interaction);
      return;
    }

    if (subcommand === "restart") {
      await this.handleRestartSlashCommand(interaction);
      return;
    }

    if (subcommand === "help") {
      await this.handleHelpSlashCommand(interaction);
    }
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
    const currentSession = this.getLinkedSession(interaction.channelId);
    const session = this.bridge.createSession({
      discordChannelId: interaction.channelId,
      discordChannelName: getChannelDisplayName(interaction.channel) || "unknown",
      model: currentSession?.model,
      reasoningEffort: currentSession?.reasoningEffort,
      profile: currentSession?.profile,
      serviceTier: currentSession?.serviceTier,
    });

    await interaction.reply({
      content: `Created and linked session \`${session.id}\` (${session.title}).`,
      ephemeral: true,
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
        "Restarting the CoDiCoDi server now. If it was launched via codicodi-server.cmd or scripts/start-server.cmd, it will come back automatically.",
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
      content:
        [
          "CoDiCoDi commands:",
          "/codex help - Show this help message",
          "/codex session - List connectable sessions",
          "/codex session number:1 - Link this channel to a session",
          "/codex new - Create and link a new session",
          "/codex rename name:Project Alpha - Rename the current session",
          "/codex status - Show the current session status",
          "/codex model - List available models",
          "/codex model number:1 - Switch the current session model",
          "/codex reasoning - List reasoning levels for the current model",
          "/codex reasoning number:2 - Switch the reasoning level",
          "/codex fast on - Enable fast mode",
          "/codex fast off - Disable fast mode",
          "/codex stop - Stop the current generation",
          "/codex last-message - Recover the last missing AI message for this session",
          "/codex restart - Restart the CoDiCoDi server",
          "",
          "Legacy text commands:",
          "!status - Show the linked session status",
          "!new - Create and link a new session",
          "!bind <sessionId> - Link this channel to an existing session",
        ].join("\n"),
      ephemeral: true,
    });
  }

  // ── Multi-agent command handler ───────────────────────────────────────────

  async handleAgentCommand(message, cmd) {
    const { agent: agentName, verb, prompt } = cmd;
    const registry = this.agentRegistry;
    const ab = this.agentBridge;

    // Global: "workspace?" — show or set channel↔workspace binding
    if (!agentName && verb === "workspace") {
      if (!ab) {
        await message.reply("AgentBridge が利用できません。");
        return;
      }
      const channelId = message.channelId;

      if (!prompt) {
        // Show current binding
        const binding = ab.getDiscordBinding(channelId);
        const ws = binding ? (ab.getWorkspace ? ab.store?.getWorkspace(binding.workspaceId) : null) : null;
        const wsName = ws?.name ?? binding?.workspaceId ?? "なし";
        const agentHint = binding?.defaultAgent ? ` (デフォルトエージェント: ${binding.defaultAgent})` : "";
        const workspaces = ab.listWorkspaces().map((w) => `• ${w.name}${w.isActive ? " ✓" : ""}`).join("\n");
        await message.reply(
          `**このチャンネルのワークスペース:** ${wsName}${agentHint}\n\n` +
          `**利用可能なワークスペース:**\n${workspaces}\n\n` +
          `変更するには: \`workspace? <名前>\``
        );
        return;
      }

      // Bind to workspace by name (create if not exists)
      let workspace = ab.getWorkspaceByName(prompt);
      if (!workspace) {
        workspace = ab.createWorkspace({ name: prompt });
      }
      ab.bindDiscordChannel({ discordChannelId: channelId, workspaceId: workspace.id });
      await message.reply(`✅ このチャンネルをワークスペース **${workspace.name}** に紐づけました。`);
      return;
    }

    // Global: "cost?" / "cost? today|week|month|all"
    if (!agentName && verb === "cost") {
      const period = prompt || "all";
      if (!ab) { await message.reply("AgentBridge が利用できません。"); return; }
      const rows = ab.getCostSummary({ period });
      if (rows.length === 0) {
        await message.reply(`📊 コスト記録なし（期間: ${period}）`);
        return;
      }
      const periodLabel = { today: "今日", week: "過去7日", month: "過去30日", all: "累計" }[period] || period;
      const lines = rows.map((r) =>
        `• **${r.agentName}**: ${r.runCount}回 / in ${r.totalInputTokens.toLocaleString()} + out ${r.totalOutputTokens.toLocaleString()} tokens / **¥${r.totalCostJpy} ($${r.totalCostUsd.toFixed(4)})**`
      );
      const total = rows.reduce((s, r) => ({ usd: s.usd + r.totalCostUsd, jpy: s.jpy + r.totalCostJpy }), { usd: 0, jpy: 0 });
      lines.push(`\n合計: **¥${total.jpy.toFixed(1)} ($${total.usd.toFixed(4)})**`);
      await message.reply(`📊 **コストサマリー（${periodLabel}）**\n${lines.join("\n")}`);
      return;
    }

    // Global: "stop?" — stop all agents
    if (!agentName && verb === "stop") {
      ab ? ab.stopAll() : registry.stopAll();
      await message.reply("⏹ 全エージェントを停止しました。");
      return;
    }

    // Global: "agents?" — list all agents
    if (!agentName && verb === "agents") {
      await message.reply(registry.formatList());
      return;
    }

    const agent = registry.get(agentName);
    if (!agent) {
      await message.reply(`エージェント \`${agentName}\` が見つかりません。\n\n${registry.formatList()}`);
      return;
    }

    // "hanako stop?" — stop agent
    if (verb === "stop") {
      ab ? ab.cancelAgent(agentName) : agent.cancel();
      await message.reply(`⏹ ${agentName} を停止しました。`);
      return;
    }

    // "hanako new?" / "hanako reset?" — reset session
    if (verb === "new" || verb === "reset") {
      ab ? ab.resetAgentSession(agentName) : agent.resetSession();
      await message.reply(`🆕 ${agentName} のセッションをリセットしました。`);
      return;
    }

    // "hanako?" (no prompt) — show status
    if (!prompt) {
      await message.reply(agent.getStatusLine());
      return;
    }

    // "hanako? <prompt>" — run prompt via AgentBridge (with CanonicalEvents)
    // Resolve workspace from Discord channel binding
    const channelId = message.channelId;
    let workspaceId = "default";
    if (ab) {
      const binding = ab.getDiscordBinding(channelId);
      if (binding?.workspaceId) workspaceId = binding.workspaceId;
    }

    const statusMsg = await message.reply(`> 🤔 ${agentName} thinking…`).catch(() => null);
    const startedAt = Date.now();

    // Track last tool name for live progress edits
    let lastProgressEdit = Date.now();

    const onProgress = statusMsg
      ? async (event) => {
          if (event.type === "tool.start") {
            const now = Date.now();
            // Throttle edits to max once per 2s to avoid rate limits
            if (now - lastProgressEdit < 2000) return;
            lastProgressEdit = now;
            await statusMsg
              .edit(`> 🔧 ${agentName}: \`${event.toolName}\` 実行中…`)
              .catch(() => null);
          }
        }
      : null;

    try {
      const workdir = this.config.codexWorkdir;

      // Use AgentBridge if available, fall back to direct agent.run()
      let result;
      if (ab) {
        result = await ab.runPrompt({
          agentName,
          prompt,
          workspaceId,
          workdir,
          source: "discord",
          discordMessageId: message.id,
          onProgress,
        });
      } else {
        const raw = await agent.run({ prompt, workdir });
        result = { text: raw.text, usage: raw.usage };
      }

      const elapsed = Math.round((Date.now() - startedAt) / 1000);

      const { formatUsage } = await import("./pricing.js");
      const usageLine = formatUsage(agent.model || agent.adapter?.defaultModel || "", result.usage);

      const parts = [];
      if (result.text) parts.push(result.text);
      parts.push(`\n> ✅ ${agentName} 完了 (${elapsed}s)${usageLine ? `\n> 📊 ${usageLine}` : ""}`);

      const replyText = parts.join("\n");
      const chunks = splitMessage(replyText, 1900);
      if (statusMsg) await statusMsg.delete().catch(() => null);
      for (const chunk of chunks) {
        await message.channel.send(chunk).catch(() => null);
      }
    } catch (err) {
      if (err.cancelled) {
        if (statusMsg) await statusMsg.edit(`> ⏹ ${agentName} キャンセルされました。`).catch(() => null);
        return;
      }
      const errText = `> ❌ ${agentName} エラー: ${err.message}`;
      if (statusMsg) await statusMsg.edit(errText).catch(() => null);
      else await message.reply(errText).catch(() => null);
    }
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
        await this.handleAgentCommand(message, cmd);
        return;
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    if (content === "!status") {
      const session = this.getLinkedSession(message.channelId);
      if (!session) {
        await message.reply("No session is linked to this channel yet.");
        return;
      }

      await message.reply(formatStatusMessage(session));
      return;
    }

    if (content === "!new") {
      const currentSession = this.getLinkedSession(message.channelId);
      const session = this.bridge.createSession({
        title: `Discord ${message.channel.name || message.channelId}`,
        discordChannelId: message.channelId,
        discordChannelName: getChannelDisplayName(message.channel) || "unknown",
        model: currentSession?.model,
        reasoningEffort: currentSession?.reasoningEffort,
        profile: currentSession?.profile,
        serviceTier: currentSession?.serviceTier,
      });

      await message.reply(`Created and linked session \`${session.id}\`.`);
      return;
    }

    if (content.startsWith("!bind ")) {
      const sessionId = content.slice("!bind ".length).trim();
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

    let session = this.getLinkedSession(message.channelId);
    if (!session) {
      session = this.bridge.createSession({
        title: message.content.slice(0, 48) || rawAttachments[0]?.name || "Discord attachment",
        discordChannelId: message.channelId,
        discordChannelName: getChannelDisplayName(message.channel) || "unknown",
      });

      await message.reply(`Started a new session: \`${session.id}\``);
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
