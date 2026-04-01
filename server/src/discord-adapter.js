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

export class DiscordAdapter {
  constructor({ bridge, bus, config, attachments }) {
    this.bridge = bridge;
    this.bus = bus;
    this.config = config;
    this.attachments = attachments;
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
        this.syncDiscordChannelNameForSession(session).catch((error) => {
          console.error("Discord channel name sync failed:", error);
        });
      }),
    );

    this.unsubscribers.push(
      this.bus.on("session.deleted", ({ sessionId }) => {
        this.stopProgressTracker(sessionId);
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
    await tracker.channel
      .send(formatFinishedStatusContent(status, tracker.startedAt))
      .catch(() => null);
  }

  async publishProgressMessage(tracker, content) {
    if (tracker.messageId && !tracker.hasTrailingMessages) {
      const message = await tracker.channel.messages.fetch(tracker.messageId).catch(() => null);
      if (message) {
        await message.edit(content);
        return message;
      }
    }

    const message = await tracker.channel.send(content);
    tracker.messageId = message.id;
    tracker.hasTrailingMessages = false;
    return message;
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

    await interaction.reply({
      content: `Stopped session \`${session.id}\`.`,
      ephemeral: true,
    });
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
          "",
          "Legacy text commands:",
          "!status - Show the linked session status",
          "!new - Create and link a new session",
          "!bind <sessionId> - Link this channel to an existing session",
        ].join("\n"),
      ephemeral: true,
    });
  }

  async handleMessage(message) {
    if (!this.isAllowedMessage(message)) {
      return;
    }

    const content = message.content.trim();
    const rawAttachments = [...message.attachments.values()];
    if (!content && rawAttachments.length === 0) {
      return;
    }

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
