import fs from "node:fs";
import path from "node:path";

function normalizeMarkdownContent(content = "") {
  return String(content ?? "").replace(/\r/g, "");
}

function sanitizeName(value, fallback = "unknown") {
  const normalized = String(value ?? "").trim();
  if (!normalized) return fallback;
  return normalized.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-");
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readTextFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export class MemoryService {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  getGlobalPath() {
    return path.join(this.rootDir, "global.md");
  }

  getWorkspacePath(workspaceId) {
    return path.join(this.rootDir, "workspaces", `${sanitizeName(workspaceId)}.md`);
  }

  getAgentPath(agentName) {
    return path.join(this.rootDir, "agents", `${sanitizeName(agentName)}.md`);
  }

  getGlobalMemory() {
    const filePath = this.getGlobalPath();
    return {
      scope: "global",
      path: filePath,
      content: readTextFileSafe(filePath),
    };
  }

  setGlobalMemory(content = "") {
    const filePath = this.getGlobalPath();
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, normalizeMarkdownContent(content), "utf8");
    return this.getGlobalMemory();
  }

  getWorkspaceMemory(workspaceId) {
    const filePath = this.getWorkspacePath(workspaceId);
    return {
      scope: "workspace",
      workspaceId,
      path: filePath,
      content: readTextFileSafe(filePath),
    };
  }

  setWorkspaceMemory(workspaceId, content = "") {
    const filePath = this.getWorkspacePath(workspaceId);
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, normalizeMarkdownContent(content), "utf8");
    return this.getWorkspaceMemory(workspaceId);
  }

  getAgentMemory(agentName) {
    const filePath = this.getAgentPath(agentName);
    return {
      scope: "agent",
      agentName,
      path: filePath,
      content: readTextFileSafe(filePath),
    };
  }

  setAgentMemory(agentName, content = "") {
    const filePath = this.getAgentPath(agentName);
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, normalizeMarkdownContent(content), "utf8");
    return this.getAgentMemory(agentName);
  }
}
