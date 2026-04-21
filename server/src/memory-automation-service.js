import fs from "node:fs";
import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").replace(/\r/g, "");
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function buildLineDiff(beforeText, afterText) {
  const beforeLines = normalizeText(beforeText).split("\n");
  const afterLines = normalizeText(afterText).split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines = ["--- before", "+++ after"];
  for (let index = 0; index < max; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) {
      if (beforeLine !== undefined) {
        lines.push(` ${beforeLine}`);
      }
      continue;
    }
    if (beforeLine !== undefined) {
      lines.push(`-${beforeLine}`);
    }
    if (afterLine !== undefined) {
      lines.push(`+${afterLine}`);
    }
  }
  return lines.join("\n");
}

function summarizeMessages(messages = [], limit = 8) {
  return messages
    .slice(-Math.max(1, limit))
    .map((message) => {
      const author =
        message.role === "user" ? "User" :
        message.agentName || "Assistant";
      const text = normalizeText(message.content).split("\n").map((line) => line.trim()).filter(Boolean)[0] || "(empty)";
      return `- ${author}: ${text.slice(0, 160)}`;
    })
    .join("\n");
}

export class MemoryAutomationService {
  constructor({ config, store, memoryService }) {
    this.config = config;
    this.store = store;
    this.memoryService = memoryService;
  }

  _getWorkspace(workspaceId) {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    return workspace;
  }

  _timestampLabel() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  listSuggestedJobs(workspaceId) {
    const workspace = this._getWorkspace(workspaceId);
    return [
      {
        name: `memory-consolidation-${workspace.name}`,
        active: false,
        description: "workspace memory を定期的に要約・統合する提案ジョブ",
      },
      {
        name: `ai-diary-${workspace.name}`,
        active: false,
        description: "recent runs から AI diary を生成する提案ジョブ",
      },
    ];
  }

  previewWorkspaceConsolidation(workspaceId) {
    const workspace = this._getWorkspace(workspaceId);
    const memory = this.memoryService.getWorkspaceMemory(workspaceId);
    const recentMessages = this.store.listWorkspaceMessages(workspaceId, 24);
    const summary = summarizeMessages(recentMessages, 10);
    const proposedContent = [
      normalizeText(memory.content).trim(),
      "## Consolidated notes",
      `- Generated for workspace: ${workspace.name}`,
      summary || "- (recent activity not found)",
    ].filter(Boolean).join("\n\n").trim();
    const backupPath = path.join(
      this.config.memoryAutomationDir,
      "backups",
      `${workspaceId}-workspace-memory-${this._timestampLabel()}.md`,
    );
    return {
      scope: "workspace",
      workspaceId,
      workspaceName: workspace.name,
      path: memory.path,
      backupPath,
      currentContent: memory.content,
      proposedContent,
      diff: buildLineDiff(memory.content, proposedContent),
      tokenEstimate: Math.ceil(proposedContent.length / 4),
      suggestedJobs: this.listSuggestedJobs(workspaceId),
    };
  }

  applyWorkspaceConsolidation(workspaceId, { approved = false } = {}) {
    if (!approved) {
      throw new Error("memory consolidation 実行には explicit approval が必要です。");
    }
    const preview = this.previewWorkspaceConsolidation(workspaceId);
    ensureDir(preview.backupPath);
    fs.writeFileSync(preview.backupPath, normalizeText(preview.currentContent), "utf8");
    const saved = this.memoryService.setWorkspaceMemory(workspaceId, preview.proposedContent);
    return {
      ...preview,
      saved,
      applied: true,
    };
  }

  previewWorkspaceDiary(workspaceId) {
    const workspace = this._getWorkspace(workspaceId);
    const messages = this.store.listWorkspaceMessages(workspaceId, 30);
    const diaryPath = path.join(
      this.config.memoryAutomationDir,
      "diary",
      `${workspaceId}.md`,
    );
    const currentContent = fs.existsSync(diaryPath) ? fs.readFileSync(diaryPath, "utf8") : "";
    const proposedContent = [
      `# AI diary · ${workspace.name}`,
      "",
      `- Workspace ID: ${workspace.id}`,
      `- Generated at: ${new Date().toISOString()}`,
      "",
      "## Recent highlights",
      summarizeMessages(messages, 12) || "- (recent activity not found)",
    ].join("\n");
    const backupPath = path.join(
      this.config.memoryAutomationDir,
      "backups",
      `${workspaceId}-ai-diary-${this._timestampLabel()}.md`,
    );
    return {
      scope: "diary",
      workspaceId,
      workspaceName: workspace.name,
      diaryPath,
      backupPath,
      currentContent,
      proposedContent,
      diff: buildLineDiff(currentContent, proposedContent),
      tokenEstimate: Math.ceil(proposedContent.length / 4),
      suggestedJobs: this.listSuggestedJobs(workspaceId),
    };
  }

  applyWorkspaceDiary(workspaceId, { approved = false } = {}) {
    if (!approved) {
      throw new Error("AI diary 実行には explicit approval が必要です。");
    }
    const preview = this.previewWorkspaceDiary(workspaceId);
    ensureDir(preview.backupPath);
    fs.writeFileSync(preview.backupPath, normalizeText(preview.currentContent), "utf8");
    ensureDir(preview.diaryPath);
    fs.writeFileSync(preview.diaryPath, normalizeText(preview.proposedContent), "utf8");
    return {
      ...preview,
      applied: true,
    };
  }
}
