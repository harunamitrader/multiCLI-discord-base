import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");
const codexHome = path.join(os.homedir(), ".codex");

function parseIdList(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseStringList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseOptionalString(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readCodexConfigValue(key) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
  const pattern = new RegExp(`^${key}\\s*=\\s*"(.*)"\\s*$`);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) {
      continue;
    }

    const match = trimmed.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function loadAvailableModels() {
  const cachePath = path.join(codexHome, "models_cache.json");
  const cache = readJsonFile(cachePath, { models: [] });
  const models = (cache.models || [])
    .filter((model) => model.visibility === "list")
    .map((model) => ({
      slug: model.slug,
      displayName: model.display_name || model.slug,
      description: model.description || "",
      defaultReasoningLevel: model.default_reasoning_level || "medium",
      supportedReasoningLevels: (model.supported_reasoning_levels || []).map((level) => ({
        effort: level.effort,
        description: level.description || "",
      })),
    }));

  if (models.length > 0) {
    return models;
  }

  return [
    {
      slug: "gpt-5.4",
      displayName: "gpt-5.4",
      description: "Fallback model list entry.",
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth" },
        { effort: "high", description: "Greater reasoning depth for complex problems" },
        { effort: "xhigh", description: "Extra high reasoning depth" },
      ],
    },
  ];
}

function loadCodexVersion() {
  const versionPath = path.join(codexHome, "version.json");
  const versionInfo = readJsonFile(versionPath, {});
  return versionInfo.latest_version || "unknown";
}

export function loadConfig() {
  const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || "data");
  const uiDir = path.resolve(projectRoot, "ui");
  const uploadsDir = path.join(dataDir, "uploads");
  const codexWorkdir = path.resolve(
    process.env.CODEX_WORKDIR || path.join(os.homedir(), "Desktop", "codex"),
  );
  const availableModels = loadAvailableModels();
  const defaultModel =
    process.env.CODEX_MODEL ||
    readCodexConfigValue("model") ||
    availableModels[0]?.slug ||
    "gpt-5.4";
  const defaultReasoningEffort =
    process.env.CODEX_REASONING_EFFORT ||
    readCodexConfigValue("model_reasoning_effort") ||
    "medium";
  const defaultServiceTier =
    process.env.CODEX_SERVICE_TIER ||
    readCodexConfigValue("service_tier") ||
    "auto";
  const defaultProfile = process.env.CODEX_PROFILE || "default";
  const discordAllowedGuildIds = parseIdList(process.env.DISCORD_ALLOWED_GUILD_IDS);
  const fileWatchEnabled = parseBoolean(process.env.FILE_WATCH_ENABLED, false);
  const fileWatchRoot = parseOptionalString(process.env.FILE_WATCH_ROOT);
  const fileLogChannelId = parseOptionalString(process.env.FILE_LOG_CHANNEL_ID);
  if (discordAllowedGuildIds.size !== 1) {
    throw new Error(
      "DISCORD_ALLOWED_GUILD_IDS must contain exactly one guild ID.",
    );
  }

  if (fileWatchEnabled) {
    if (!fileWatchRoot) {
      throw new Error("FILE_WATCH_ROOT is required when FILE_WATCH_ENABLED is true.");
    }

    if (!fileLogChannelId) {
      throw new Error("FILE_LOG_CHANNEL_ID is required when FILE_WATCH_ENABLED is true.");
    }

    if (!fs.existsSync(fileWatchRoot)) {
      throw new Error(`Configured FILE_WATCH_ROOT was not found: ${fileWatchRoot}`);
    }

    if (!fs.statSync(fileWatchRoot).isDirectory()) {
      throw new Error(`Configured FILE_WATCH_ROOT is not a directory: ${fileWatchRoot}`);
    }

    if (!(process.env.DISCORD_BOT_TOKEN || "").trim()) {
      throw new Error("DISCORD_BOT_TOKEN is required when FILE_WATCH_ENABLED is true.");
    }
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  return {
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 3087),
    dataDir,
    uploadsDir,
    databasePath: path.join(dataDir, "bridge.sqlite"),
    uiDir,
    codexCommand: process.env.CODEX_COMMAND || "codex",
    codexWorkdir,
    codexSearchEnabled: parseBoolean(process.env.CODEX_ENABLE_SEARCH, true),
    codexApprovalPolicy: parseOptionalString(process.env.CODEX_APPROVAL_POLICY),
    codexSandboxMode: parseOptionalString(process.env.CODEX_SANDBOX_MODE),
    codexBypassApprovalsAndSandbox: parseBoolean(
      process.env.CODEX_BYPASS_APPROVALS_AND_SANDBOX,
      true,
    ),
    codexVersion: loadCodexVersion(),
    codexDefaults: {
      model: defaultModel,
      reasoningEffort: defaultReasoningEffort,
      serviceTier: defaultServiceTier,
      profile: defaultProfile,
    },
    availableModels,
    discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
    discordAllowedGuildIds,
    discordAllowedChannelIds: parseIdList(process.env.DISCORD_ALLOWED_CHANNEL_IDS),
    discordStatusUpdates: parseBoolean(process.env.DISCORD_STATUS_UPDATES, true),
    maxAttachmentsPerMessage: Number(process.env.MAX_ATTACHMENTS_PER_MESSAGE || 5),
    maxAttachmentBytes: Number(process.env.MAX_ATTACHMENT_BYTES || 20 * 1024 * 1024),
    fileWatchEnabled,
    fileWatchRoot: fileWatchRoot ? path.resolve(fileWatchRoot) : null,
    fileLogChannelId,
    fileWatchDebounceMs: Number(process.env.FILE_WATCH_DEBOUNCE_MS || 1000),
    fileWatchMaxAttachmentBytes: Number(
      process.env.FILE_WATCH_MAX_ATTACHMENT_BYTES || 8 * 1024 * 1024,
    ),
    fileWatchIgnore: parseStringList(
      process.env.FILE_WATCH_IGNORE || ".git,node_modules,dist,.next,coverage",
    ),
  };
}
