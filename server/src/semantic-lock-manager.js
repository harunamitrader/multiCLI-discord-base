import path from "node:path";
import { randomUUID } from "node:crypto";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function settingKey(workspaceId) {
  return `workspace_semantic_locks:${workspaceId}`;
}

function normalizeWorkspaceFilePath(filePath, workspaceWorkdir = "") {
  const raw = normalizeText(filePath);
  if (!raw) return "";
  const candidate = raw.replace(/\//g, "\\");
  const normalizedWorkdir = normalizeText(workspaceWorkdir);
  if (!normalizedWorkdir) {
    return path.normalize(candidate);
  }
  const rootDir = path.resolve(normalizedWorkdir);
  const absolutePath = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(rootDir, candidate);
  if (absolutePath === rootDir || absolutePath.startsWith(`${rootDir}${path.sep}`)) {
    return path.relative(rootDir, absolutePath) || ".";
  }
  return path.normalize(candidate);
}

function normalizeSymbol(value) {
  return normalizeText(value);
}

function normalizeLockEntry(entry = {}) {
  const filePath = normalizeText(entry.filePath);
  const symbol = normalizeSymbol(entry.symbol);
  return {
    id: normalizeText(entry.id) || randomUUID(),
    workspaceId: normalizeText(entry.workspaceId),
    agentName: normalizeText(entry.agentName),
    filePath,
    symbol,
    note: normalizeText(entry.note),
    createdAt: normalizeText(entry.createdAt) || new Date().toISOString(),
    updatedAt: normalizeText(entry.updatedAt) || new Date().toISOString(),
  };
}

function buildLockKey(filePath, symbol) {
  return `${normalizeText(filePath).toLowerCase()}::${normalizeSymbol(symbol).toLowerCase()}`;
}

function formatConflictSummary(conflicts = []) {
  return conflicts
    .map((entry) => `${entry.agentName} @ ${entry.filePath} :: ${entry.symbol}`)
    .join(" / ");
}

export class SemanticLockManager {
  constructor({ store, bus }) {
    this.store = store;
    this.bus = bus ?? null;
  }

  _getWorkspace(workspaceId) {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`workspace "${workspaceId}" が見つかりません。`);
    }
    return workspace;
  }

  _loadLocks(workspaceId) {
    const snapshot = this.store.getJsonAppSetting(settingKey(workspaceId), []);
    if (!Array.isArray(snapshot)) {
      return [];
    }
    return snapshot
      .map((entry) => normalizeLockEntry({ ...entry, workspaceId }))
      .filter((entry) => entry.agentName && entry.filePath && entry.symbol)
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  }

  _saveLocks(workspaceId, locks = []) {
    const normalized = (Array.isArray(locks) ? locks : [])
      .map((entry) => normalizeLockEntry({ ...entry, workspaceId }))
      .filter((entry) => entry.agentName && entry.filePath && entry.symbol)
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    this.store.setJsonAppSetting(settingKey(workspaceId), normalized);
    return normalized;
  }

  _emitUpdate(workspaceId, locks = [], details = {}) {
    this.bus?.publish?.("semantic-lock.updated", {
      type: "semantic-lock.updated",
      workspaceId,
      locks,
      details,
      createdAt: new Date().toISOString(),
    });
  }

  _emitNotice(workspaceId, message, details = {}) {
    this.bus?.publish?.("semantic-lock.notice", {
      type: "semantic-lock.notice",
      workspaceId,
      message,
      ...details,
      createdAt: new Date().toISOString(),
    });
  }

  listWorkspaceLocks(workspaceId) {
    this._getWorkspace(workspaceId);
    return this._loadLocks(workspaceId);
  }

  claimWorkspaceLock(workspaceId, options = {}) {
    const workspace = this._getWorkspace(workspaceId);
    const agentName = normalizeText(options.agentName);
    const filePath = normalizeWorkspaceFilePath(options.filePath, workspace.workdir || "");
    const symbol = normalizeSymbol(options.symbol);
    if (!agentName || !filePath || !symbol) {
      throw new Error("agentName / filePath / symbol は必須です。");
    }
    const timestamp = new Date().toISOString();
    const locks = this._loadLocks(workspaceId);
    const key = buildLockKey(filePath, symbol);
    const conflicts = locks.filter((entry) => buildLockKey(entry.filePath, entry.symbol) === key && entry.agentName !== agentName);
    if (conflicts.length > 0) {
      this.store.addOperationAudit({
        workspaceId,
        agentName,
        operationType: "semantic_lock.conflict",
        targetRef: `${filePath}::${symbol}`,
        status: "blocked",
        requestedBy: options.requestedBy ?? "system",
        source: options.source ?? "ui",
        details: {
          filePath,
          symbol,
          conflicts,
        },
      });
      this._emitNotice(
        workspaceId,
        `⚠️ semantic lock conflict: ${agentName} / ${filePath} :: ${symbol} (${formatConflictSummary(conflicts)})`,
        {
          agentName,
          filePath,
          symbol,
          conflicts,
          kind: "semantic_lock_conflict",
          source: options.source ?? "ui",
        },
      );
      const error = new Error("同じ symbol を別 agent が lock 中です。");
      error.code = "semantic_lock_conflict";
      error.conflicts = conflicts;
      throw error;
    }
    const existingIndex = locks.findIndex((entry) => buildLockKey(entry.filePath, entry.symbol) === key && entry.agentName === agentName);
    const nextEntry = normalizeLockEntry({
      ...locks[existingIndex],
      workspaceId,
      agentName,
      filePath,
      symbol,
      note: options.note ?? locks[existingIndex]?.note ?? "",
      createdAt: locks[existingIndex]?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    const nextLocks = [...locks];
    if (existingIndex >= 0) {
      nextLocks.splice(existingIndex, 1, nextEntry);
    } else {
      nextLocks.unshift(nextEntry);
    }
    const savedLocks = this._saveLocks(workspaceId, nextLocks);
    this.store.addOperationAudit({
      workspaceId,
      agentName,
      operationType: "semantic_lock.claim",
      targetRef: nextEntry.id,
      status: "completed",
      requestedBy: options.requestedBy ?? "system",
      source: options.source ?? "ui",
      details: {
        filePath,
        symbol,
        note: nextEntry.note,
      },
    });
    this._emitUpdate(workspaceId, savedLocks, {
      action: "claim",
      agentName,
      filePath,
      symbol,
    });
    this._emitNotice(
      workspaceId,
      `🔒 ${agentName} locked ${filePath} :: ${symbol}`,
      {
        agentName,
        filePath,
        symbol,
        kind: "semantic_lock_claim",
        source: options.source ?? "ui",
      },
    );
    return {
      workspaceId,
      lock: nextEntry,
      locks: savedLocks,
      conflicts: [],
    };
  }

  releaseWorkspaceLock(workspaceId, options = {}) {
    this._getWorkspace(workspaceId);
    const locks = this._loadLocks(workspaceId);
    const lockId = normalizeText(options.lockId);
    const agentName = normalizeText(options.agentName);
    const filePath = normalizeText(options.filePath);
    const symbol = normalizeSymbol(options.symbol);
    const nextLocks = locks.filter((entry) => {
      if (lockId) {
        return entry.id !== lockId;
      }
      if (agentName && filePath && symbol) {
        return !(entry.agentName === agentName && entry.filePath === filePath && entry.symbol === symbol);
      }
      if (agentName && !filePath && !symbol) {
        return entry.agentName !== agentName;
      }
      return true;
    });
    if (nextLocks.length === locks.length) {
      return {
        workspaceId,
        removedCount: 0,
        locks,
      };
    }
    const removedCount = locks.length - nextLocks.length;
    const savedLocks = this._saveLocks(workspaceId, nextLocks);
    this.store.addOperationAudit({
      workspaceId,
      agentName: agentName || null,
      operationType: "semantic_lock.release",
      targetRef: lockId || `${filePath || "*"}::${symbol || "*"}`,
      status: "completed",
      requestedBy: options.requestedBy ?? "system",
      source: options.source ?? "ui",
      details: {
        agentName,
        filePath,
        symbol,
        removedCount,
        reason: options.reason ?? "manual",
      },
    });
    this._emitUpdate(workspaceId, savedLocks, {
      action: "release",
      agentName,
      removedCount,
      reason: options.reason ?? "manual",
    });
    if (!options.silent) {
      this._emitNotice(
        workspaceId,
        `🔓 semantic lock released${agentName ? `: ${agentName}` : ""}`,
        {
          agentName,
          removedCount,
          kind: "semantic_lock_release",
          source: options.source ?? "ui",
        },
      );
    }
    return {
      workspaceId,
      removedCount,
      locks: savedLocks,
    };
  }

  clearAgentLocks(workspaceId, agentName, options = {}) {
    return this.releaseWorkspaceLock(workspaceId, {
      agentName,
      requestedBy: options.requestedBy ?? "system",
      source: options.source ?? "system",
      reason: options.reason ?? "cleanup",
      silent: options.silent ?? true,
    });
  }

  clearWorkspaceLocks(workspaceId, options = {}) {
    const locks = this._loadLocks(workspaceId);
    if (locks.length === 0) {
      return {
        workspaceId,
        removedCount: 0,
        locks: [],
      };
    }
    this.store.deleteAppSetting(settingKey(workspaceId));
    this.store.addOperationAudit({
      workspaceId,
      agentName: null,
      operationType: "semantic_lock.clear",
      targetRef: workspaceId,
      status: "completed",
      requestedBy: options.requestedBy ?? "system",
      source: options.source ?? "system",
      details: {
        removedCount: locks.length,
        reason: options.reason ?? "workspace_cleanup",
      },
    });
    this._emitUpdate(workspaceId, [], {
      action: "clear",
      removedCount: locks.length,
      reason: options.reason ?? "workspace_cleanup",
    });
    if (!options.silent) {
      this._emitNotice(
        workspaceId,
        "🧹 semantic locks cleared",
        {
          removedCount: locks.length,
          kind: "semantic_lock_clear",
          source: options.source ?? "system",
        },
      );
    }
    return {
      workspaceId,
      removedCount: locks.length,
      locks: [],
    };
  }
}
