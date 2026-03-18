import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
]);

const MIME_BY_EXTENSION = {
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

const EXTENSION_BY_MIME = Object.fromEntries(
  Object.entries(MIME_BY_EXTENSION).map(([extension, mimeType]) => [mimeType, extension]),
);

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitizeFileName(name) {
  const cleaned = String(name || "attachment")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "attachment";
}

function detectMimeType(name, mimeType) {
  if (mimeType) {
    return mimeType;
  }

  const extension = path.extname(name || "").toLowerCase();
  return MIME_BY_EXTENSION[extension] || "application/octet-stream";
}

function getAttachmentKind(name, mimeType) {
  const normalizedMimeType = String(mimeType || "").toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    return "image";
  }

  const extension = path.extname(name || "").toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) ? "image" : "file";
}

function toPublicPath(relativePath) {
  return `/uploads/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export class AttachmentService {
  constructor(config) {
    this.uploadsDir = config.uploadsDir;
    this.maxAttachmentsPerMessage = config.maxAttachmentsPerMessage;
    this.maxAttachmentBytes = config.maxAttachmentBytes;
  }

  validateAttachmentCount(attachments) {
    if (attachments.length > this.maxAttachmentsPerMessage) {
      throw createHttpError(
        400,
        `You can attach up to ${this.maxAttachmentsPerMessage} files per message.`,
      );
    }
  }

  async saveUiAttachments(sessionId, attachments) {
    const normalized = Array.isArray(attachments) ? attachments : [];
    this.validateAttachmentCount(normalized);
    const saved = [];

    for (const attachment of normalized) {
      const name = sanitizeFileName(attachment.name);
      const base64 = String(attachment.base64 || "");
      if (!base64) {
        throw createHttpError(400, `Attachment is missing file data: ${name}`);
      }

      let buffer;
      try {
        buffer = Buffer.from(base64, "base64");
      } catch {
        throw createHttpError(400, `Attachment data is invalid: ${name}`);
      }

      saved.push(
        await this.saveBufferAttachment(sessionId, {
          name,
          mimeType: attachment.type,
          buffer,
          source: "ui",
        }),
      );
    }

    return saved;
  }

  async saveDiscordAttachments(sessionId, attachments) {
    const normalized = Array.isArray(attachments) ? attachments : [];
    this.validateAttachmentCount(normalized);
    const saved = [];

    for (const attachment of normalized) {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw createHttpError(
          400,
          `Failed to download Discord attachment: ${attachment.name || attachment.url}`,
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      saved.push(
        await this.saveBufferAttachment(sessionId, {
          name: sanitizeFileName(attachment.name),
          mimeType: attachment.contentType,
          buffer,
          source: "discord",
        }),
      );
    }

    return saved;
  }

  async saveBufferAttachment(sessionId, { name, mimeType, buffer, source }) {
    if (!buffer?.length) {
      throw createHttpError(400, `Attachment is empty: ${name}`);
    }

    if (buffer.length > this.maxAttachmentBytes) {
      throw createHttpError(
        400,
        `${name} is too large. Limit is ${Math.floor(this.maxAttachmentBytes / (1024 * 1024))} MB.`,
      );
    }

    const safeName = sanitizeFileName(name);
    const normalizedMimeType = detectMimeType(safeName, mimeType);
    const extension =
      path.extname(safeName) || EXTENSION_BY_MIME[normalizedMimeType] || "";
    const savedName = `${Date.now()}-${randomUUID()}${extension}`;
    const relativePath = path.join(sessionId, savedName);
    const absolutePath = path.join(this.uploadsDir, relativePath);
    const kind = getAttachmentKind(safeName, normalizedMimeType);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);

    return {
      id: randomUUID(),
      name: safeName,
      mimeType: normalizedMimeType,
      size: buffer.length,
      kind,
      source,
      savedPath: absolutePath,
      relativePath: relativePath.replaceAll("\\", "/"),
      publicUrl: toPublicPath(relativePath),
    };
  }

  async deleteSessionAttachments(sessionId) {
    const sessionDir = path.join(this.uploadsDir, sessionId);
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
}
