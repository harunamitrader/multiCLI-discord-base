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
    targetDirs: {
      claude: [".claude\\skills"],
      gemini: [".gemini\\skills"],
      copilot: [".github\\copilot\\skills"],
      codex: [".codex\\skills"],
    },
    skills: [
      {
        id: "workspace-overview",
        title: "Workspace overview",
        targets: ["claude", "gemini", "copilot", "codex"],
        source: "workspace-overview.md",
      },
      {
        id: "shared-pty-routing",
        title: "Shared PTY routing",
        targets: ["claude", "gemini", "copilot", "codex"],
        source: "shared-pty-routing.md",
      },
    ],
  };
  fs.writeFileSync(filePath, `${JSON.stringify(defaultRegistry, null, 2)}\n`, "utf8");
}

function safeReadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export class SkillManager {
  constructor({ config, store, agentRegistry }) {
    this.config = config;
    this.store = store;
    this.agentRegistry = agentRegistry;
    ensureJsonRegistry(this.config.skillRegistryPath);
  }

  loadRegistry() {
    const raw = safeReadJson(this.config.skillRegistryPath);
    return {
      version: Number(raw?.version || 1),
      targetDirs: raw?.targetDirs && typeof raw.targetDirs === "object"
        ? raw.targetDirs
        : {},
      skills: Array.isArray(raw?.skills) ? raw.skills : [],
    };
  }

  getRegistrySummary() {
    const registry = this.loadRegistry();
    return {
      path: this.config.skillRegistryPath,
      version: registry.version,
      skillCount: registry.skills.length,
      targetTypes: Object.keys(registry.targetDirs),
      skills: registry.skills.map((skill) => ({
        id: normalizeText(skill.id),
        title: normalizeText(skill.title) || normalizeText(skill.id),
        targets: Array.isArray(skill.targets) ? skill.targets.map((entry) => normalizeText(entry).toLowerCase()).filter(Boolean) : [],
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
      const targetDirs = Array.isArray(registry.targetDirs?.[agentType]) ? registry.targetDirs[agentType] : [];
      const applicableSkills = registry.skills.filter((skill) => {
        const targets = Array.isArray(skill.targets) ? skill.targets.map((entry) => normalizeText(entry).toLowerCase()) : [];
        return targets.includes(agentType);
      });
      const targets = [];
      for (const relativeDir of targetDirs) {
        const destinationRoot = path.resolve(workdir, relativeDir);
        if (!destinationRoot.startsWith(workdir)) {
          throw new Error(`skill target path escaped workspace root: ${relativeDir}`);
        }
        const operations = applicableSkills.map((skill) => {
          const sourcePath = path.resolve(this.config.skillSourceDir, normalizeText(skill.source));
          const destinationPath = path.join(destinationRoot, `${normalizeText(skill.id)}.md`);
          const sourceContent = readFileSafe(sourcePath);
          const destinationContent = readFileSafe(destinationPath);
          const exists = fs.existsSync(destinationPath);
          const action =
            !exists ? "copy" :
            destinationContent === sourceContent ? "noop" :
            "conflict";
          return {
            skillId: normalizeText(skill.id),
            title: normalizeText(skill.title) || normalizeText(skill.id),
            sourcePath,
            destinationPath,
            action,
          };
        });
        targets.push({
          destinationRoot,
          relativeDir,
          operations,
        });
      }
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
      registryPath: this.config.skillRegistryPath,
      plans,
    };
  }

  applyWorkspaceSync(workspaceId, options = {}) {
    const plan = this.planWorkspaceSync(workspaceId, options);
    const applied = [];
    for (const agentPlan of plan.plans) {
      for (const target of agentPlan.targets) {
        fs.mkdirSync(target.destinationRoot, { recursive: true });
        for (const operation of target.operations) {
          if (operation.action !== "copy") {
            continue;
          }
          fs.writeFileSync(operation.destinationPath, readFileSafe(operation.sourcePath), "utf8");
          applied.push({
            agentName: agentPlan.agentName,
            destinationPath: operation.destinationPath,
            skillId: operation.skillId,
          });
        }
      }
    }
    return {
      ...plan,
      applied,
    };
  }
}
