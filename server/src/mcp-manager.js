import fs from "node:fs";
import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function ensureJsonRegistry(filePath) {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const defaultRegistry = {
    version: 1,
    targetFiles: {
      claude: [".claude\\mcp.json"],
      gemini: [".gemini\\mcp.json"],
      copilot: [".github\\copilot\\mcp.json"],
      codex: [".codex\\mcp.json"],
    },
    servers: [
      {
        id: "workspace-files",
        title: "Workspace files",
        targets: ["claude", "gemini", "copilot", "codex"],
        source: "workspace-files.json",
      },
      {
        id: "git-tools",
        title: "Git tools",
        targets: ["claude", "gemini", "copilot", "codex"],
        source: "git-tools.json",
      },
    ],
  };
  fs.writeFileSync(filePath, `${JSON.stringify(defaultRegistry, null, 2)}\n`, "utf8");
}

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mergeServerConfigs(snippets = []) {
  const merged = { mcpServers: {} };
  for (const snippet of snippets) {
    const servers = snippet?.mcpServers && typeof snippet.mcpServers === "object"
      ? snippet.mcpServers
      : {};
    for (const [serverId, config] of Object.entries(servers)) {
      merged.mcpServers[serverId] = config;
    }
  }
  return merged;
}

export class McpManager {
  constructor({ config, store, agentRegistry }) {
    this.config = config;
    this.store = store;
    this.agentRegistry = agentRegistry;
    ensureJsonRegistry(this.config.mcpRegistryPath);
  }

  loadRegistry() {
    const raw = safeReadJson(this.config.mcpRegistryPath, {});
    return {
      version: Number(raw?.version || 1),
      targetFiles: raw?.targetFiles && typeof raw.targetFiles === "object"
        ? raw.targetFiles
        : {},
      servers: Array.isArray(raw?.servers) ? raw.servers : [],
    };
  }

  getRegistrySummary() {
    const registry = this.loadRegistry();
    return {
      path: this.config.mcpRegistryPath,
      version: registry.version,
      serverCount: registry.servers.length,
      targetTypes: Object.keys(registry.targetFiles),
      servers: registry.servers.map((server) => ({
        id: normalizeText(server.id),
        title: normalizeText(server.title) || normalizeText(server.id),
        targets: Array.isArray(server.targets) ? server.targets.map((entry) => normalizeText(entry).toLowerCase()).filter(Boolean) : [],
      })),
    };
  }

  _resolveWorkspaceWorkdir(workspaceId) {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    const workdir = normalizeText(workspace.workdir || this.config.codexWorkdir);
    if (!workdir) {
      throw new Error("workspace workdir が未設定です。");
    }
    return {
      workspace,
      workdir: path.resolve(workdir),
    };
  }

  planWorkspaceSync(workspaceId, { agentName = "" } = {}) {
    const { workspace, workdir } = this._resolveWorkspaceWorkdir(workspaceId);
    const registry = this.loadRegistry();
    const members = this.store.listWorkspaceAgents(workspaceId)
      .filter((entry) => !agentName || entry.agentName === agentName);
    const plans = [];
    for (const member of members) {
      const agent = this.agentRegistry.get(member.agentName);
      const agentType = normalizeText(agent?.type).toLowerCase();
      if (!agentType) continue;
      const targetFiles = Array.isArray(registry.targetFiles?.[agentType]) ? registry.targetFiles[agentType] : [];
      const applicableServers = registry.servers.filter((server) => {
        const targets = Array.isArray(server.targets) ? server.targets.map((entry) => normalizeText(entry).toLowerCase()) : [];
        return targets.includes(agentType);
      });
      const snippets = applicableServers.map((server) => safeReadJson(path.resolve(this.config.mcpSourceDir, normalizeText(server.source)), {}));
      const desiredConfig = mergeServerConfigs(snippets);
      const desiredText = stableJson(desiredConfig);
      const targets = targetFiles.map((relativePath) => {
        const destinationPath = path.resolve(workdir, relativePath);
        if (!destinationPath.startsWith(workdir)) {
          throw new Error(`MCP target path escaped workspace root: ${relativePath}`);
        }
        const currentText = readText(destinationPath);
        const exists = fs.existsSync(destinationPath);
        const action =
          !exists ? "copy" :
          currentText === desiredText ? "noop" :
          "conflict";
        return {
          relativePath,
          destinationPath,
          action,
          serverIds: applicableServers.map((server) => normalizeText(server.id)).filter(Boolean),
          desiredText,
        };
      });
      plans.push({
        agentName: member.agentName,
        agentType,
        targets,
      });
    }
    return {
      workspaceId,
      workspaceName: workspace.name,
      workdir,
      registryPath: this.config.mcpRegistryPath,
      plans,
    };
  }

  applyWorkspaceSync(workspaceId, options = {}) {
    const plan = this.planWorkspaceSync(workspaceId, options);
    const applied = [];
    for (const agentPlan of plan.plans) {
      for (const target of agentPlan.targets) {
        if (target.action !== "copy") {
          continue;
        }
        fs.mkdirSync(path.dirname(target.destinationPath), { recursive: true });
        fs.writeFileSync(target.destinationPath, target.desiredText, "utf8");
        applied.push({
          agentName: agentPlan.agentName,
          destinationPath: target.destinationPath,
          serverIds: target.serverIds,
        });
      }
    }
    return {
      ...plan,
      applied,
    };
  }
}
