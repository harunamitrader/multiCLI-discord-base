import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");
const configDir = path.join(projectRoot, "config");
const codexHome = path.join(os.homedir(), ".codex");

const DEFAULT_APP_SETTINGS = Object.freeze({
  discord: {
    statusUpdates: true,
    maxAttachmentsPerMessage: 5,
    maxAttachmentBytes: 20 * 1024 * 1024,
  },
  fileWatch: {
    debounceMs: 1000,
    maxAttachmentBytes: 8 * 1024 * 1024,
    ignore: [".git", "node_modules", "dist", ".next", "coverage"],
  },
});

const DEFAULT_CLI_SETTINGS = Object.freeze({
  commands: {
    claude: "claude",
    gemini: "gemini",
    copilot: "copilot",
    codex: "codex",
  },
  codex: {
    workdir: projectRoot,
    enableSearch: true,
    approvalPolicy: null,
    sandboxMode: null,
    bypassApprovalsAndSandbox: true,
    defaults: {
      model: "",
      reasoningEffort: "",
      serviceTier: "flex",
      profile: "default",
    },
  },
});

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

function parseOptionalNumber(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeServiceTier(value) {
  return String(value || "").trim().toLowerCase() === "fast" ? "fast" : "flex";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeConfig(base, overrides) {
  if (Array.isArray(base)) {
    return Array.isArray(overrides) ? [...overrides] : [...base];
  }
  if (!isPlainObject(base)) {
    return overrides === undefined ? base : overrides;
  }

  const result = { ...base };
  if (!isPlainObject(overrides)) {
    return result;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      result[key] = [...value];
      continue;
    }
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = mergeConfig(base[key], value);
      continue;
    }
    result[key] = value;
  }
  return result;
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

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvePathFromProject(value, fallback) {
  const normalized = parseOptionalString(value);
  if (!normalized) {
    return fallback;
  }
  return path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.resolve(projectRoot, normalized);
}

function normalizeAgentSettings(settings = {}) {
  if (!isPlainObject(settings)) {
    return {};
  }

  const next = {};
  if ("workdir" in settings) next.workdir = String(settings.workdir || "").trim();
  if ("instructions" in settings) next.instructions = String(settings.instructions || "").trim();
  if ("reasoningEffort" in settings) next.reasoningEffort = String(settings.reasoningEffort || "").trim();
  if ("planMode" in settings) next.planMode = String(settings.planMode || "").trim();
  if ("fastMode" in settings) {
    next.fastMode =
      settings.fastMode === true || settings.fastMode === false
        ? settings.fastMode
        : String(settings.fastMode || "").trim();
  }
  return next;
}

function normalizeAgentDefinitions(rawValue) {
  const sourceList = Array.isArray(rawValue)
    ? rawValue
    : Array.isArray(rawValue?.agents)
      ? rawValue.agents
      : [];
  const seen = new Set();
  const definitions = [];

  for (const entry of sourceList) {
    const name = String(entry?.name || "").trim().toLowerCase();
    const type = String(entry?.type || "").trim().toLowerCase();
    if (!name || !type || seen.has(name)) {
      continue;
    }
    seen.add(name);
    definitions.push({
      name,
      type,
      model: String(entry?.model || "").trim(),
      settings: normalizeAgentSettings(entry?.settings),
    });
  }

  return definitions;
}

function readLegacyCliSettingsFromEnv() {
  return {
    commands: {
      claude: parseOptionalString(process.env.CLAUDE_COMMAND),
      gemini: parseOptionalString(process.env.GEMINI_COMMAND),
      copilot: parseOptionalString(process.env.COPILOT_COMMAND),
      codex: parseOptionalString(process.env.CODEX_COMMAND),
    },
    codex: {
      workdir: parseOptionalString(process.env.CODEX_WORKDIR),
      enableSearch:
        process.env.CODEX_ENABLE_SEARCH == null ? undefined : parseBoolean(process.env.CODEX_ENABLE_SEARCH, true),
      approvalPolicy: parseOptionalString(process.env.CODEX_APPROVAL_POLICY),
      sandboxMode: parseOptionalString(process.env.CODEX_SANDBOX_MODE),
      bypassApprovalsAndSandbox:
        process.env.CODEX_BYPASS_APPROVALS_AND_SANDBOX == null
          ? undefined
          : parseBoolean(process.env.CODEX_BYPASS_APPROVALS_AND_SANDBOX, true),
      defaults: {
        model: parseOptionalString(process.env.CODEX_MODEL),
        reasoningEffort: parseOptionalString(process.env.CODEX_REASONING_EFFORT),
        serviceTier: parseOptionalString(process.env.CODEX_SERVICE_TIER),
        profile: parseOptionalString(process.env.CODEX_PROFILE),
      },
    },
  };
}

function readLegacyAppSettingsFromEnv() {
  return {
    discord: {
      statusUpdates:
        process.env.DISCORD_STATUS_UPDATES == null
          ? undefined
          : parseBoolean(process.env.DISCORD_STATUS_UPDATES, true),
      maxAttachmentsPerMessage: parseOptionalNumber(process.env.MAX_ATTACHMENTS_PER_MESSAGE, undefined),
      maxAttachmentBytes: parseOptionalNumber(process.env.MAX_ATTACHMENT_BYTES, undefined),
    },
    fileWatch: {
      debounceMs: parseOptionalNumber(process.env.FILE_WATCH_DEBOUNCE_MS, undefined),
      maxAttachmentBytes: parseOptionalNumber(process.env.FILE_WATCH_MAX_ATTACHMENT_BYTES, undefined),
      ignore:
        process.env.FILE_WATCH_IGNORE == null
          ? undefined
          : parseStringList(process.env.FILE_WATCH_IGNORE),
    },
  };
}

function readLegacyAgentsFromEnv() {
  const prefix = "AGENT_";
  const names = new Set();

  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const underIdx = rest.lastIndexOf("_");
    if (underIdx < 1) continue;
    names.add(rest.slice(0, underIdx).toLowerCase());
  }

  return [...names]
    .map((name) => {
      const envPrefix = `AGENT_${name.toUpperCase()}_`;
      return {
        name,
        type: String(process.env[`${envPrefix}TYPE`] || "").trim().toLowerCase(),
        model: String(process.env[`${envPrefix}MODEL`] || "").trim(),
        settings: {},
      };
    })
    .filter((entry) => entry.name && entry.type);
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

function resolveCodexVersionCommand(command) {
  if (process.platform !== "win32") {
    return {
      command,
      args: ["--version"],
    };
  }

  const baseName = path.basename(command).toLowerCase();
  const resolved = baseName === "codex" || baseName === "codex.ps1" ? "codex.cmd" : command;
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", resolved, "--version"],
  };
}

function parseCodexVersion(output) {
  const match = String(output || "").match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function loadCodexVersion(codexCommand) {
  try {
    const invocation = resolveCodexVersionCommand(codexCommand || "codex");
    const output = execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const parsed = parseCodexVersion(output);
    if (parsed) {
      return parsed;
    }
  } catch {
    // Fall back to the cached version file when invoking Codex directly fails.
  }

  const versionPath = path.join(codexHome, "version.json");
  const versionInfo = readJsonFile(versionPath, {});
  return versionInfo.latest_version || "unknown";
}

function loadAppVersion() {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = readJsonFile(packageJsonPath, {});
  return packageJson.version || "unknown";
}

function loadAppSettingsConfig(appSettingsPath) {
  const fromFile = readJsonFile(appSettingsPath, {});
  const merged = mergeConfig(
    cloneJson(DEFAULT_APP_SETTINGS),
    mergeConfig(readLegacyAppSettingsFromEnv(), fromFile),
  );
  return {
    discord: {
      statusUpdates: Boolean(merged.discord?.statusUpdates ?? true),
      maxAttachmentsPerMessage: parseOptionalNumber(merged.discord?.maxAttachmentsPerMessage, 5),
      maxAttachmentBytes: parseOptionalNumber(merged.discord?.maxAttachmentBytes, 20 * 1024 * 1024),
    },
    fileWatch: {
      debounceMs: parseOptionalNumber(merged.fileWatch?.debounceMs, 1000),
      maxAttachmentBytes: parseOptionalNumber(merged.fileWatch?.maxAttachmentBytes, 8 * 1024 * 1024),
      ignore: Array.isArray(merged.fileWatch?.ignore)
        ? merged.fileWatch.ignore.map((item) => String(item).trim()).filter(Boolean)
        : [...DEFAULT_APP_SETTINGS.fileWatch.ignore],
    },
  };
}

function loadCliSettingsConfig(cliSettingsPath, availableModels) {
  const fromFile = readJsonFile(cliSettingsPath, {});
  const merged = mergeConfig(
    cloneJson(DEFAULT_CLI_SETTINGS),
    mergeConfig(readLegacyCliSettingsFromEnv(), fromFile),
  );
  const commands = {
    claude: parseOptionalString(merged.commands?.claude) || "claude",
    gemini: parseOptionalString(merged.commands?.gemini) || "gemini",
    copilot: parseOptionalString(merged.commands?.copilot) || "copilot",
    codex: parseOptionalString(merged.commands?.codex) || "codex",
  };
  const codexWorkdir = resolvePathFromProject(
    merged.codex?.workdir,
    projectRoot,
  );

  if (!fs.existsSync(codexWorkdir)) {
    throw new Error(`Configured Codex workdir was not found: ${codexWorkdir}`);
  }

  if (!fs.statSync(codexWorkdir).isDirectory()) {
    throw new Error(`Configured Codex workdir is not a directory: ${codexWorkdir}`);
  }

  const defaultModel =
    parseOptionalString(merged.codex?.defaults?.model) ||
    readCodexConfigValue("model") ||
    availableModels[0]?.slug ||
    "gpt-5.4";
  const defaultReasoningEffort =
    parseOptionalString(merged.codex?.defaults?.reasoningEffort) ||
    readCodexConfigValue("model_reasoning_effort") ||
    "medium";
  const defaultServiceTier = normalizeServiceTier(
    merged.codex?.defaults?.serviceTier || readCodexConfigValue("service_tier") || "flex",
  );
  const defaultProfile = parseOptionalString(merged.codex?.defaults?.profile) || "default";

  return {
    commands,
    codex: {
      workdir: codexWorkdir,
      enableSearch: merged.codex?.enableSearch !== false,
      approvalPolicy: parseOptionalString(merged.codex?.approvalPolicy),
      sandboxMode: parseOptionalString(merged.codex?.sandboxMode),
      bypassApprovalsAndSandbox: merged.codex?.bypassApprovalsAndSandbox !== false,
      defaults: {
        model: defaultModel,
        reasoningEffort: defaultReasoningEffort,
        serviceTier: defaultServiceTier,
        profile: defaultProfile,
      },
    },
  };
}

export function loadConfig() {
  const appSettingsPath = path.join(configDir, "app-settings.json");
  const cliSettingsPath = path.join(configDir, "cli-settings.json");
  const agentsConfigPath = path.join(configDir, "agents.json");
  const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || "data");
  const uiDir = path.resolve(projectRoot, "ui");
  const uploadsDir = path.join(dataDir, "uploads");
  const logsDir = path.join(dataDir, "logs");
  const schedulesDir = path.join(dataDir, "schedules");
  const scheduleDefaultsPath = path.join(dataDir, "schedule-defaults.json");
  const availableModels = loadAvailableModels();
  const cliSettings = loadCliSettingsConfig(cliSettingsPath, availableModels);
  const appSettings = loadAppSettingsConfig(appSettingsPath);
  const configuredAgents = normalizeAgentDefinitions(
    fs.existsSync(agentsConfigPath)
      ? readJsonFile(agentsConfigPath, {})
      : readLegacyAgentsFromEnv(),
  );
  const discordBotToken = String(process.env.DISCORD_BOT_TOKEN || "").trim();
  const discordAllowedGuildIds = parseIdList(process.env.DISCORD_ALLOWED_GUILD_IDS);
  const fileWatchEnabled = parseBoolean(process.env.FILE_WATCH_ENABLED, false);
  const fileWatchRoot = parseOptionalString(process.env.FILE_WATCH_ROOT);
  const fileLogChannelId = parseOptionalString(process.env.FILE_LOG_CHANNEL_ID);
  if (discordBotToken && discordAllowedGuildIds.size !== 1) {
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

    if (!discordBotToken) {
      throw new Error("DISCORD_BOT_TOKEN is required when FILE_WATCH_ENABLED is true.");
    }
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(schedulesDir, { recursive: true });

  return {
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 3087),
    dataDir,
    uploadsDir,
    schedulesDir,
    scheduleDefaultsPath,
    databasePath: path.join(dataDir, "bridge.sqlite"),
    uiDir,
    configDir,
    configFiles: {
      appSettingsPath,
      cliSettingsPath,
      agentsConfigPath,
    },
    claudeCommand: cliSettings.commands.claude,
    geminiCommand: cliSettings.commands.gemini,
    copilotCommand: cliSettings.commands.copilot,
    codexCommand: cliSettings.commands.codex,
    codexHome,
    codexWorkdir: cliSettings.codex.workdir,
    codexSearchEnabled: cliSettings.codex.enableSearch,
    codexApprovalPolicy: cliSettings.codex.approvalPolicy,
    codexSandboxMode: cliSettings.codex.sandboxMode,
    codexBypassApprovalsAndSandbox: cliSettings.codex.bypassApprovalsAndSandbox,
    codexDeveloperLogPath: path.join(logsDir, "codex-live.log"),
    scheduleLogPath: path.join(logsDir, "schedule-runs.log"),
    appVersion: loadAppVersion(),
    codexVersion: loadCodexVersion(cliSettings.commands.codex),
    codexDefaults: {
      model: cliSettings.codex.defaults.model,
      reasoningEffort: cliSettings.codex.defaults.reasoningEffort,
      serviceTier: cliSettings.codex.defaults.serviceTier,
      profile: cliSettings.codex.defaults.profile,
      workdir: cliSettings.codex.workdir,
    },
    availableModels,
    configuredAgents,
    saveAgentDefinitions(definitions) {
      const normalized = normalizeAgentDefinitions(definitions);
      writeJsonFile(agentsConfigPath, { agents: normalized });
      return normalized;
    },
    discordBotToken,
    discordAllowedGuildIds,
    discordAllowedChannelIds: parseIdList(process.env.DISCORD_ALLOWED_CHANNEL_IDS),
    discordStatusUpdates: appSettings.discord.statusUpdates,
    maxAttachmentsPerMessage: appSettings.discord.maxAttachmentsPerMessage,
    maxAttachmentBytes: appSettings.discord.maxAttachmentBytes,
    fileWatchEnabled,
    fileWatchRoot: fileWatchRoot ? path.resolve(fileWatchRoot) : null,
    fileLogChannelId,
    fileWatchDebounceMs: appSettings.fileWatch.debounceMs,
    fileWatchMaxAttachmentBytes: appSettings.fileWatch.maxAttachmentBytes,
    fileWatchIgnore: appSettings.fileWatch.ignore,
  };
}
