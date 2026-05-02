import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function runGit(workdir, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (error) {
    if (allowFailure) {
      const stderr = normalizeText(error?.stderr);
      const stdout = normalizeText(error?.stdout);
      return {
        ok: false,
        stdout,
        stderr,
        message: stderr || stdout || normalizeText(error?.message),
      };
    }
    throw error;
  }
}

function parseStatusOutput(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const indexStatus = line.slice(0, 1);
    const worktreeStatus = line.slice(1, 2);
    const rawPath = line.slice(3).trim();
    const filePath = rawPath.includes(" -> ")
      ? rawPath.split(" -> ").at(-1)
      : rawPath;
    entries.push({
      indexStatus,
      worktreeStatus,
      path: filePath,
      raw: line,
      kind:
        line.startsWith("??") ? "untracked" :
        line.startsWith("!!") ? "ignored" :
        "tracked",
    });
  }
  return {
    entries,
    dirtyCount: entries.filter((entry) => entry.kind !== "ignored").length,
    trackedCount: entries.filter((entry) => entry.kind === "tracked").length,
    untrackedCount: entries.filter((entry) => entry.kind === "untracked").length,
  };
}

function buildRollbackBlockedReasons(runtimeStates = []) {
  const reasons = [];
  for (const state of runtimeStates) {
    const agentName = normalizeText(state?.agentName) || "unknown";
    if (state?.manualInputDirty) {
      reasons.push(`${agentName} に未送信の Terminal 入力があります。`);
    }
    if (state?.approvalRequest?.status === "pending") {
      reasons.push(`${agentName} が承認待ちです。`);
    }
    if (state?.status === "running" || state?.status === "manual_running") {
      reasons.push(`${agentName} が実行中です。`);
    }
    if (state?.status === "waiting_input") {
      reasons.push(`${agentName} が入力待ちです。`);
    }
    if (state?.status === "quota_wait") {
      reasons.push(`${agentName} が利用制限待ちです。`);
    }
  }
  return [...new Set(reasons)];
}

function worktreeSettingKey(workspaceId) {
  return `workspace_worktree:${workspaceId}`;
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

function truncateText(value, maxLength = 4000) {
  const text = String(value ?? "").trimEnd();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n…`;
}

function parseWorktreeListOutput(output) {
  const lines = String(output ?? "").replace(/\r/g, "").split("\n");
  const entries = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = null;
      continue;
    }
    const separatorIndex = line.indexOf(" ");
    const key = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trim() : "";
    if (key === "worktree") {
      if (current?.worktree) {
        entries.push(current);
      }
      current = {
        worktree: path.normalize(value),
        headSha: "",
        branch: "",
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.headSha = value;
    if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    if (key === "detached") current.detached = true;
    if (key === "locked") current.locked = true;
    if (key === "prunable") current.prunable = true;
  }
  if (current?.worktree) {
    entries.push(current);
  }
  return entries;
}

function readFilePreview(filePath, maxLines = 80) {
  const content = fs.readFileSync(filePath, "utf8").replace(/\r/g, "");
  return truncateText(content.split("\n").slice(0, maxLines).join("\n"), 4000);
}

export class GitService {
  constructor({ store, ptyService, bus }) {
    this.store = store;
    this.ptyService = ptyService ?? null;
    this.bus = bus ?? null;
    this._workspaceLocks = new Set();
  }

  _emit(type, payload) {
    this.bus?.publish?.(type, {
      type,
      ...payload,
    });
  }

  _withWorkspaceLock(workspaceId, fn) {
    const normalizedWorkspaceId = normalizeText(workspaceId);
    if (!normalizedWorkspaceId) {
      throw new Error("workspaceId is required");
    }
    if (this._workspaceLocks.has(normalizedWorkspaceId)) {
      throw new Error("この workspace では別の Git 操作が進行中です。");
    }
    this._workspaceLocks.add(normalizedWorkspaceId);
    try {
      return fn();
    } finally {
      this._workspaceLocks.delete(normalizedWorkspaceId);
    }
  }

  inspectRepository(workdir) {
    const normalizedWorkdir = normalizeText(workdir);
    if (!normalizedWorkdir) {
      return {
        isGitRepository: false,
        workdir: "",
        rootDir: "",
        headSha: "",
        status: parseStatusOutput(""),
      };
    }
    const rootResult = runGit(normalizedWorkdir, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    if (rootResult?.ok === false) {
      return {
        isGitRepository: false,
        workdir: normalizedWorkdir,
        rootDir: "",
        headSha: "",
        status: parseStatusOutput(""),
        error: rootResult.message,
      };
    }
    const rootDir = path.normalize(rootResult);
    const headResult = runGit(rootDir, ["rev-parse", "HEAD"], { allowFailure: true });
    const headSha = normalizeText(headResult?.ok === false ? "" : headResult);
    const branchResult = runGit(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
    const statusOutput = runGit(rootDir, ["status", "--porcelain=v1", "--untracked-files=all"], { allowFailure: true });
    return {
      isGitRepository: true,
      workdir: normalizedWorkdir,
      rootDir,
      headSha,
      branch: normalizeText(branchResult?.ok === false ? "" : branchResult),
      status: parseStatusOutput(statusOutput?.ok === false ? "" : statusOutput),
    };
  }

  listWorktrees(workdir) {
    const repo = this.inspectRepository(workdir);
    if (!repo.isGitRepository) {
      return [];
    }
    const output = runGit(repo.rootDir, ["worktree", "list", "--porcelain"], { allowFailure: true });
    return parseWorktreeListOutput(output?.ok === false ? "" : output);
  }

  _buildReviewChanges(rootDir, entries = []) {
    return entries
      .filter((entry) => entry.kind !== "ignored")
      .slice(0, 24)
      .map((entry) => {
        let diffPreview = "";
        if (entry.kind === "untracked") {
          const absolutePath = path.resolve(rootDir, entry.path);
          if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
            diffPreview = `+++ ${entry.path}\n${readFilePreview(absolutePath, 60)}`;
          }
        } else {
          const diffOutput = runGit(
            rootDir,
            ["diff", "--no-ext-diff", "--minimal", "--unified=3", "HEAD", "--", entry.path],
            { allowFailure: true },
          );
          diffPreview = truncateText(diffOutput?.ok === false ? diffOutput.message : diffOutput, 4000);
        }
        return {
          ...entry,
          diffPreview,
        };
      });
  }

  getWorkspaceReview({ workspaceId, workdir }) {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    const repo = this.inspectRepository(workdir);
    const worktrees = repo.isGitRepository ? this.listWorktrees(repo.rootDir) : [];
    const changes = repo.isGitRepository ? this._buildReviewChanges(repo.rootDir, repo.status.entries) : [];
    return {
      workspaceId,
      workspaceName: workspace.name,
      repository: repo,
      worktrees,
      changes,
      truncated: (repo.status?.entries?.length || 0) > changes.length,
    };
  }

  getWorkspaceWorktreeStatus({ workspaceId, workdir }) {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    const repo = this.inspectRepository(workdir);
    const metadata = this.store.getJsonAppSetting(worktreeSettingKey(workspaceId), null);
    const worktrees = repo.isGitRepository ? this.listWorktrees(repo.rootDir) : [];
    const currentWorkdir = path.resolve(workdir || repo.rootDir || "");
    const storedWorktreePath = normalizeText(metadata?.worktreePath);
    return {
      workspaceId,
      workspaceName: workspace.name,
      isGitRepository: repo.isGitRepository,
      currentWorkdir,
      worktreePath: storedWorktreePath,
      repoRoot: repo.rootDir || "",
      headSha: repo.headSha || "",
      branch: repo.branch || "",
      metadata,
      worktrees,
      isIsolated: Boolean(storedWorktreePath) && path.resolve(storedWorktreePath) === currentWorkdir,
      suggestedWorktreePath:
        repo.isGitRepository
          ? path.join(
              path.dirname(repo.rootDir),
              ".multicli-worktrees",
              path.basename(repo.rootDir),
              `${slugify(workspace.name)}-${workspaceId.slice(0, 8)}`,
            )
          : "",
    };
  }

  ensureWorkspaceWorktree({ workspaceId, workdir, requestedBy = "system", source = "ui" }) {
    return this._withWorkspaceLock(workspaceId, () => {
      const workspace = this.store.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`workspace "${workspaceId}" が見つかりません。`);
      }
      const status = this.getWorkspaceWorktreeStatus({ workspaceId, workdir });
      if (!status.isGitRepository) {
        throw new Error("Git repository が見つかりません。");
      }
      if (status.isIsolated) {
        return {
          workspace,
          status,
        };
      }
      let targetPath = normalizeText(status.metadata?.worktreePath);
      if (!targetPath) {
        targetPath = status.suggestedWorktreePath;
      }
      const normalizedTargetPath = path.resolve(targetPath);
      const listedEntry = status.worktrees.find((entry) => path.resolve(entry.worktree) === normalizedTargetPath);
      if (!listedEntry) {
        fs.mkdirSync(path.dirname(normalizedTargetPath), { recursive: true });
        runGit(status.repoRoot, ["worktree", "add", "--detach", normalizedTargetPath, "HEAD"]);
      }
      const metadata = {
        enabled: true,
        repoRoot: status.repoRoot,
        worktreePath: normalizedTargetPath,
        createdAt: status.metadata?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.store.setJsonAppSetting(worktreeSettingKey(workspaceId), metadata);
      const updatedWorkspace = this.store.updateWorkspace(workspaceId, { workdir: normalizedTargetPath });
      this.store.addOperationAudit({
        workspaceId,
        agentName: null,
        operationType: "git.worktree.ensure",
        targetRef: normalizedTargetPath,
        status: "completed",
        requestedBy,
        source,
        details: {
          repoRoot: status.repoRoot,
          worktreePath: normalizedTargetPath,
        },
      });
      this._emit("workspace.worktree.updated", {
        type: "workspace.worktree.updated",
        workspaceId,
        worktreePath: normalizedTargetPath,
        repoRoot: status.repoRoot,
        source,
        requestedBy,
      });
      return {
        workspace: updatedWorkspace,
        status: this.getWorkspaceWorktreeStatus({
          workspaceId,
          workdir: normalizedTargetPath,
        }),
      };
    });
  }

  createCheckpoint({
    workspaceId,
    workdir,
    agentName = null,
    runId = null,
    kind = "manual",
    label = "",
    requestedBy = "system",
    source = "system",
  }) {
    return this._withWorkspaceLock(workspaceId, () => {
      const repo = this.inspectRepository(workdir);
      if (!repo.isGitRepository) {
        throw new Error("Git repository が見つかりません。");
      }
      const id = randomUUID();
      const checkpointLabel = normalizeText(label) || `${kind} checkpoint`;
      let stashRef = null;
      if (repo.status.dirtyCount > 0) {
        const stashMessage = `multiCLI-checkpoint-${id}`;
        runGit(repo.rootDir, ["stash", "push", "--all", "--message", stashMessage]);
        const stashSha = normalizeText(runGit(repo.rootDir, ["rev-parse", "stash@{0}"]));
        if (!stashSha) {
          throw new Error("checkpoint 用 stash の作成に失敗しました。");
        }
        stashRef = `refs/multicli/checkpoints/${id}`;
        runGit(repo.rootDir, ["update-ref", stashRef, stashSha]);
        runGit(repo.rootDir, ["stash", "apply", "--index", stashSha]);
      }
      const checkpoint = this.store.createGitCheckpoint({
        id,
        workspaceId,
        agentName,
        runId,
        kind,
        label: checkpointLabel,
        workdir: repo.rootDir,
        gitHeadSha: repo.headSha,
        stashRef,
        status: repo.status,
      });
      this.store.addOperationAudit({
        workspaceId,
        agentName,
        operationType: "git.checkpoint",
        targetRef: checkpoint.id,
        status: "completed",
        requestedBy,
        source,
        details: {
          workdir: repo.rootDir,
          headSha: repo.headSha,
          dirtyCount: repo.status.dirtyCount,
          stashRef,
          checkpointKind: kind,
        },
      });
      return checkpoint;
    });
  }

  listCheckpoints(workspaceId, { limit = 20 } = {}) {
    return this.store.listGitCheckpointsByWorkspace(workspaceId, limit);
  }

  previewRollback({
    workspaceId,
    checkpointId,
    workdir,
    source = "system",
  }) {
    const checkpoint = this.store.getGitCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.workspaceId !== workspaceId) {
      throw new Error("checkpoint が見つかりません。");
    }
    const repo = this.inspectRepository(workdir || checkpoint.workdir);
    if (!repo.isGitRepository) {
      throw new Error("Git repository が見つかりません。");
    }
    const runtimeStates = this.ptyService?.listWorkspaceTerminalStates?.(workspaceId) ?? [];
    const blockedReasons = buildRollbackBlockedReasons(runtimeStates);
    const sameRepo = path.normalize(checkpoint.workdir || "") === path.normalize(repo.rootDir || "");
    if (!sameRepo) {
      blockedReasons.push("checkpoint 作成時と現在の workdir が一致しません。");
    }
    const preview = {
      workspaceId,
      checkpoint,
      current: repo,
      blockedReasons,
      requiresApproval: true,
      source,
    };
    this.store.addOperationAudit({
      workspaceId,
      agentName: checkpoint.agentName,
      operationType: "git.rollback.preview",
      targetRef: checkpoint.id,
      status: blockedReasons.length > 0 ? "blocked" : "preview",
      dryRun: true,
      requestedBy: "preview",
      source,
      details: {
        blockedReasons,
        currentHeadSha: repo.headSha,
        checkpointHeadSha: checkpoint.gitHeadSha,
        dirtyCount: repo.status.dirtyCount,
      },
    });
    return preview;
  }

  applyRollback({
    workspaceId,
    checkpointId,
    workdir,
    requestedBy = "system",
    source = "system",
    approved = false,
    dryRun = false,
  }) {
    return this._withWorkspaceLock(workspaceId, () => {
      const preview = this.previewRollback({
        workspaceId,
        checkpointId,
        workdir,
        source,
      });
      const checkpoint = preview.checkpoint;
      if (dryRun) {
        return {
          ...preview,
          applied: false,
          dryRun: true,
        };
      }
      if (preview.blockedReasons.length > 0) {
        throw new Error(preview.blockedReasons.join(" / "));
      }
      if (!approved) {
        throw new Error("rollback 実行には explicit approval が必要です。");
      }
      try {
        runGit(preview.current.rootDir, ["reset", "--hard", checkpoint.gitHeadSha]);
        runGit(preview.current.rootDir, ["clean", "-fd"]);
        if (checkpoint.stashRef) {
          runGit(preview.current.rootDir, ["stash", "apply", "--index", checkpoint.stashRef]);
        }
        const after = this.inspectRepository(preview.current.rootDir);
        this.store.addOperationAudit({
          workspaceId,
          agentName: checkpoint.agentName,
          operationType: "git.rollback.apply",
          targetRef: checkpoint.id,
          status: "completed",
          requestedBy,
          source,
          details: {
            checkpointId,
            workdir: preview.current.rootDir,
            checkpointHeadSha: checkpoint.gitHeadSha,
            currentHeadSha: after.headSha,
            dirtyCount: after.status.dirtyCount,
          },
        });
        this.ptyService?.annotateWorkspaceRuntime?.(
          workspaceId,
          "git_rollback",
          "Git rollback を適用しました。Terminal の表示や未保存の前提を再確認してください。",
        );
        this._emit("workspace.rollback", {
          workspaceId,
          checkpointId,
          requestedBy,
          source,
        });
        return {
          ...preview,
          current: after,
          applied: true,
          dryRun: false,
        };
      } catch (error) {
        this.store.addOperationAudit({
          workspaceId,
          agentName: checkpoint.agentName,
          operationType: "git.rollback.apply",
          targetRef: checkpoint.id,
          status: "error",
          requestedBy,
          source,
          details: {
            checkpointId,
            error: normalizeText(error?.message),
          },
        });
        throw error;
      }
    });
  }
}
