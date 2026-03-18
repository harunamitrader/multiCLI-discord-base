import fs from "node:fs/promises";
import path from "node:path";

function normalizeRelativePath(rootDir, filePath) {
  const relativePath = path.relative(rootDir, filePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return null;
  }

  return relativePath.replaceAll("\\", "/");
}

function isTemporaryPath(relativePath) {
  const fileName = path.basename(relativePath).toLowerCase();
  return (
    fileName.endsWith(".tmp") ||
    fileName.endsWith(".swp") ||
    fileName.endsWith(".swo") ||
    fileName.endsWith(".crdownload") ||
    fileName.endsWith(".part") ||
    fileName.startsWith("~$") ||
    fileName.startsWith(".#")
  );
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${bytes} B`;
}

export class FileWatcherService {
  constructor({ config, discord }) {
    this.config = config;
    this.discord = discord;
    this.intervalId = null;
    this.previousSnapshot = new Map();
    this.polling = false;
  }

  shouldIgnore(filePath) {
    const relativePath = normalizeRelativePath(this.config.fileWatchRoot, filePath);
    if (!relativePath) {
      return false;
    }

    if (isTemporaryPath(relativePath)) {
      return true;
    }

    const parts = relativePath.split("/");
    return this.config.fileWatchIgnore.some((ignoredName) => parts.includes(ignoredName));
  }

  async buildSnapshot(directoryPath = this.config.fileWatchRoot, snapshot = new Map()) {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      if (this.shouldIgnore(absolutePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.buildSnapshot(absolutePath, snapshot);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = normalizeRelativePath(this.config.fileWatchRoot, absolutePath);
      if (!relativePath) {
        continue;
      }

      const stat = await fs.stat(absolutePath);
      snapshot.set(relativePath, {
        absolutePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }

    return snapshot;
  }

  async notify(action, relativePath, entry) {
    if (action === "deleted") {
      await this.discord.sendFileLogNotification({
        action,
        relativePath,
        absolutePath: entry.absolutePath,
        attached: false,
        reason: null,
      });
      return;
    }

    const attached = entry.size <= this.config.fileWatchMaxAttachmentBytes;
    const reason = attached
      ? null
      : `Attachment skipped (${formatBytes(entry.size)} exceeds limit).`;

    await this.discord.sendFileLogNotification({
      action,
      relativePath,
      absolutePath: entry.absolutePath,
      attached,
      reason,
    });
  }

  async poll() {
    if (this.polling) {
      return;
    }

    this.polling = true;
    try {
      const nextSnapshot = await this.buildSnapshot();

      for (const [relativePath, nextEntry] of nextSnapshot.entries()) {
        const previousEntry = this.previousSnapshot.get(relativePath);
        if (!previousEntry) {
          await this.notify("created", relativePath, nextEntry);
          continue;
        }

        if (
          previousEntry.mtimeMs !== nextEntry.mtimeMs ||
          previousEntry.size !== nextEntry.size
        ) {
          await this.notify("modified", relativePath, nextEntry);
        }
      }

      for (const [relativePath, previousEntry] of this.previousSnapshot.entries()) {
        if (!nextSnapshot.has(relativePath)) {
          await this.notify("deleted", relativePath, previousEntry);
        }
      }

      this.previousSnapshot = nextSnapshot;
    } catch (error) {
      console.error("File watcher error:", error);
    } finally {
      this.polling = false;
    }
  }

  async start() {
    if (!this.config.fileWatchEnabled) {
      return;
    }

    this.previousSnapshot = await this.buildSnapshot();
    this.intervalId = setInterval(() => {
      this.poll().catch((error) => {
        console.error("File watcher poll failed:", error);
      });
    }, this.config.fileWatchDebounceMs);

    console.log(`File watcher enabled for ${this.config.fileWatchRoot}`);
    await this.discord.sendFileLogSystemMessage(
      [
        "[File Watch] Started",
        `Root: \`${this.config.fileWatchRoot.replaceAll("\\", "/")}\``,
        `Interval: ${this.config.fileWatchDebounceMs}ms`,
      ].join("\n"),
    );
  }

  async stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.previousSnapshot.clear();
  }
}
