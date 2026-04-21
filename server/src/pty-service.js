/**
 * PtyService — PTY-first Agent execution core
 *
 * Design (persistent interactive PTY):
 *   PTY key = `${workspaceId}:${agentName}`
 *
 * Each workspace×agent pair has ONE persistent interactive CLI process.
 * - Terminal tab WebSocket → raw PTY output (xterm rendering)
 * - Chat/Discord sendPrompt() → writes to the SAME PTY stdin
 * - PTY stdout → Terminal (raw) + Chat transcript (ANSI-stripped, accumulated)
 * - Completion: silence heuristic + ready-prompt detection
 *
 * NO headless process is spawned for Chat/Discord main path.
 * headless (-p mode) is reserved as a future fallback option only.
 */

import pty from "node-pty";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { stripAnsi } from "./ansi-strip.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** ms of silence (no PTY output) after which a run is considered complete */
const COMPLETION_SILENCE_MS = 25_000;
/** extra retry window when Codex has not emitted a response yet */
const CODEX_EMPTY_COMPLETION_RETRY_MS = 10_000;
/** Hard timeout per run (5 min) */
const HARD_TIMEOUT_MS = 5 * 60 * 1000;
/** Max ms to wait for CLI to show its ready prompt on first spawn */
const READY_WAIT_TIMEOUT_MS = 60_000;
/** Extra settle time after ready detection before sending the first prompt */
const READY_SETTLE_MS = 300;
/** Small delay between pasting prompt text and pressing Enter */
const INPUT_SUBMIT_DELAY_MS = 120;
/** Short settle window for xterm/manual turns after Claude ready prompt returns */
const MANUAL_COMPLETION_SETTLE_MS = 1_200;
/** Silence fallback for manual turns when ready prompt does not arrive cleanly */
const MANUAL_COMPLETION_SILENCE_MS = 4_000;
/** Minimum transcript size before ready-return can accelerate completion */
const READY_RETURN_MIN_CHARS = 200;
/** Short settle window after ready-prompt return for normal prompts */
const READY_RETURN_COMPLETION_MS = 1_500;
/** Longer settle window after ready-prompt return for multiline/code prompts */
const RICH_READY_RETURN_COMPLETION_MS = 5_000;
/** Gemini can keep very long pasted single-line text in the composer until a second Enter */
const GEMINI_LONG_COMPOSER_CONFIRM_LENGTH = 480;
/** Codex needs a noticeably longer settle period before multiline pasted content can be submitted */
const CODEX_MULTILINE_COMPOSER_CONFIRM_MS = 10_000;
/** Runtime snapshot write debounce */
const SNAPSHOT_WRITE_DEBOUNCE_MS = 250;
/** Approval request timeout */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const SNAPSHOT_VERSION = 1;

function getReadySettleDelay(agentType) {
  if (agentType === "codex") return 900;
  if (agentType === "claude") return 400;
  return READY_SETTLE_MS;
}

function getPromptSubmitDelay(agentType, inputText = "") {
  if (agentType === "codex") return 350;
  const baseDelay = agentType === "claude" ? 200 : INPUT_SUBMIT_DELAY_MS;
  const input = String(inputText ?? "");
  if (!input) return baseDelay;
  if (!["claude", "gemini"].includes(agentType)) return baseDelay;
  if (!promptLooksRich(input) && input.length <= 240) return baseDelay;
  return Math.max(baseDelay, Math.min(650, baseDelay + Math.ceil(input.length / 4)));
}

function getComposerConfirmDelay(agentType, inputText = "") {
  const input = String(inputText ?? "");
  if (!["codex", "claude", "gemini"].includes(agentType) || !/\r?\n/u.test(input)) {
    return 150;
  }
  if (agentType === "codex") {
    return CODEX_MULTILINE_COMPOSER_CONFIRM_MS;
  }
  return Math.min(500, 150 + Math.ceil(input.length / 6));
}

function needsComposerConfirm(agentType, inputText = "") {
  const input = String(inputText ?? "");
  if (!["codex", "claude", "gemini"].includes(agentType)) {
    return false;
  }
  if (/\r?\n/u.test(input)) {
    return true;
  }
  return agentType === "gemini" && input.length >= GEMINI_LONG_COMPOSER_CONFIRM_LENGTH;
}

function promptLooksRich(promptText = "") {
  const prompt = String(promptText ?? "");
  return (
    prompt.includes("\n") ||
    /```/.test(prompt) ||
    /^#{1,6}\s/m.test(prompt) ||
    /^(?:[-*]\s|\d+\.\s)/m.test(prompt)
  );
}

function shouldUseBracketedPaste(agentType, inputText = "") {
  if (agentType !== "codex") return false;
  return String(inputText ?? "").includes("\n");
}

function formatBracketedPastePayload(agentType, inputText = "") {
  const input = String(inputText ?? "");
  if (agentType !== "codex") return input;
  return input.replace(/\r?\n/g, "\r");
}

function getReadyReturnCompletionDelay(agentType, promptText = "") {
  if (!promptLooksRich(promptText)) {
    return READY_RETURN_COMPLETION_MS;
  }
  if (agentType === "codex" || agentType === "claude" || agentType === "gemini") {
    return RICH_READY_RETURN_COMPLETION_MS;
  }
  return READY_RETURN_COMPLETION_MS;
}

function parsePromptCodeFence(promptText = "") {
  const matches = [...String(promptText ?? "").matchAll(/```([A-Za-z0-9._+-]*)\n([\s\S]*?)```/g)];
  if (matches.length !== 1) return null;
  return {
    language: matches[0][1] ?? "",
    codeLines: matches[0][2]
      .split(/\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean),
  };
}

function parsePromptHeading(promptText = "") {
  const match = String(promptText ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.match(/^(#{1,6})\s+(.*)$/))
    .find(Boolean);
  if (!match) return null;
  return {
    level: Math.min(match[1].length, 6),
    text: match[2].trim(),
  };
}

function parsePromptNonCodeLines(promptText = "") {
  const lines = String(promptText ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const contentLines = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!contentLines.length && /exactly this markdown and nothing else/i.test(trimmed)) {
      continue;
    }
    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (trimmed) contentLines.push(trimmed);
  }

  return contentLines;
}

function extractExactReplyTarget(promptText = "") {
  const prompt = String(promptText ?? "").replace(/\r/g, "").trim();
  if (!prompt) return null;
  for (const pattern of [
    /^Reply exactly this line:\n([\s\S]+)$/i,
    /^Reply with exactly these lines:\n([\s\S]+)$/i,
    /^Reply with exactly these two lines:\n([\s\S]+)$/i,
    /^Reply only:\s*([^\n]+)$/i,
    /^Reply only\s+([^\n]+)$/i,
    /^Say only:\s*([^\n]+)$/i,
    /^Say only\s+([^\n]+)$/i,
  ]) {
    const match = prompt.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function normalizeExactReplyForComparison(value = "") {
  return String(value ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/[`*]+/g, "")
    .replace(/\?(?=[^\s\n]*=)/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function recoverExactReplyFromPrompt(promptText = "", responseText = "") {
  const target = extractExactReplyTarget(promptText);
  const response = String(responseText ?? "").trim();
  if (!target || !response) {
    return response;
  }
  const normalizedTarget = normalizeExactReplyForComparison(target);
  const normalizedResponse = normalizeExactReplyForComparison(response);
  const singleLineDirective = /^(?:Reply|Say) only\b/i.test(String(promptText ?? "").trim()) && !/\n/.test(target);
  const looseNormalizedTarget = singleLineDirective
    ? normalizedTarget.replace(/\s+/g, " ").trim()
    : normalizedTarget;
  const looseNormalizedResponse = singleLineDirective
    ? normalizedResponse.replace(/\s+/g, " ").trim()
    : normalizedResponse;
  if (looseNormalizedResponse === looseNormalizedTarget) {
    return target;
  }
  if (
    singleLineDirective &&
    looseNormalizedTarget &&
    looseNormalizedResponse.includes(looseNormalizedTarget) &&
    (
      /(?:^|\n)\s*(?:Reply|Say) only\b/im.test(response) ||
      /workspace \(\/directory\)|Type your message or @path\/to\/file|branch\b|sandbox\b|~[\\/]|^[A-Za-z]:\\/im.test(response)
    )
  ) {
    return target;
  }
  return response;
}

function exactReplyMatchesTarget(promptText = "", responseText = "") {
  const target = extractExactReplyTarget(promptText);
  if (!target) return false;
  return (
    normalizeExactReplyForComparison(responseText) ===
    normalizeExactReplyForComparison(target)
  );
}

function recoverExactMultilineReplyFromTranscript(promptText = "", transcriptText = "") {
  const target = extractExactReplyTarget(promptText);
  if (!target || !/\n/.test(target)) return "";

  const targetLines = target
    .split("\n")
    .map((line) => normalizeExactReplyForComparison(line))
    .filter(Boolean);
  if (targetLines.length < 2) return "";

  const candidateLines = normalizeCodexLines(stripPromptEcho(transcriptText, promptText))
    .map((line) => line.replace(/^[■•◦›>]\s*/, "").replace(/\s+[›>].*$/u, "").trim())
    .filter(Boolean)
    .filter((line) => !isCodexNoiseLine(line, promptText))
    .map((line) => normalizeExactReplyForComparison(line))
    .filter(Boolean);

  let matchIndex = 0;
  for (const line of candidateLines) {
    if (line !== targetLines[matchIndex]) continue;
    matchIndex += 1;
    if (matchIndex >= targetLines.length) {
      return target;
    }
  }
  return "";
}

function responseContainsPromptCodeLine(promptText = "", responseText = "") {
  const fence = parsePromptCodeFence(promptText);
  if (!fence?.codeLines?.length) return false;
  const responseLines = String(responseText ?? "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return responseLines.some((line) => fence.codeLines.includes(line));
}

function looksLikeCodeLine(line) {
  const normalized = String(line ?? "").trim();
  if (!normalized) return false;
  if (/^(?:[-*]\s|#\s|\d+\.\s)/.test(normalized)) return false;
  if (/^(?:[A-Za-z0-9_]+\(|console\.|print\(|return\b|const\b|let\b|var\b|def\b|class\b|function\b|if\b|for\b|while\b|import\b|from\b)/.test(normalized)) {
    return true;
  }
  return /[;{}()[\]=]/.test(normalized);
}

function rehydrateMarkdownShapeFromPrompt(promptText = "", responseText = "") {
  if (!/exactly this markdown and nothing else/i.test(String(promptText ?? ""))) {
    return String(responseText ?? "").trim();
  }

  let response = String(responseText ?? "").trim();
  if (!response || /```/.test(response)) return response;

  const heading = parsePromptHeading(promptText);
  if (heading && !/^#{1,6}\s/m.test(response)) {
    const lines = response.split(/\n/);
    const firstContentIndex = lines.findIndex((line) => line.trim());
    if (firstContentIndex >= 0) {
      const firstContentLine = lines[firstContentIndex].trim();
      if (firstContentLine === heading.text) {
        lines[firstContentIndex] = `${"#".repeat(heading.level)} ${heading.text}`;
        response = lines.join("\n").trim();
      } else if (firstContentLine.startsWith(heading.text)) {
        const promptNonCodeLines = parsePromptNonCodeLines(promptText);
        const tailLines = lines
          .slice(firstContentIndex + 1)
          .map((line) => line.trim())
          .filter(Boolean);
        response = [...promptNonCodeLines, ...tailLines].join("\n").trim();
      }
    }
  }

  const fence = parsePromptCodeFence(promptText);
  if (!fence?.codeLines?.length) return response;

  const lines = response.split(/\n/);
  const trailingCodeLines = [];
  let splitIndex = lines.length;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmedLine = lines[index].trim();
    if (!trimmedLine) {
      if (trailingCodeLines.length === 0) continue;
      break;
    }
    if (fence.codeLines.includes(trimmedLine) || looksLikeCodeLine(trimmedLine)) {
      trailingCodeLines.unshift(trimmedLine);
      splitIndex = index;
      continue;
    }
    if (trailingCodeLines.length > 0) break;
  }

  if (trailingCodeLines.length === 0) return response;

  const body = lines.slice(0, splitIndex).join("\n").trimEnd();
  const openFence = fence.language ? `\`\`\`${fence.language}` : "```";
  return `${body ? `${body}\n\n` : ""}${openFence}\n${trailingCodeLines.join("\n")}\n\`\`\``.trim();
}

// ── CLI-specific heuristics ───────────────────────────────────────────────────

/**
 * Heuristics per CLI type.
 * Matched against ANSI-stripped, accumulated text.
 */
const CLI_HEURISTICS = {
  gemini: {
    /**
     * Pattern that indicates the CLI is ready to accept a prompt.
     * "Type your message or @path/to/file" appears only after auth+init.
     */
    readyRe: /Type your message or @path/,
    /**
     * Pattern that indicates the CLI is waiting for user confirmation.
     */
    waitingInputRe: /approve|allow|confirm\?|continue\?|y\/n|yes\/no|login:|auth:|password:|credentials|how would you like to authenticate|enter the authorization code|use enter to select|please visit the following url|select model|press esc to close/i,
    approvalRe: /approve|allow|confirm\?|continue\?|y\/n|yes\/no|use enter to select/i,
    /**
     * Pattern that indicates Gemini CLI is blocked on its own authentication flow.
     */
    authRequiredRe: /Sign in with Google|Use Gemini API key|Continue in your browser|Open this URL|How would you like to authenticate|Please visit the following URL to authorize the application|Enter the authorization code|Authentication consent could not be obtained|Failed to authenticate with authorization code|Failed to authenticate with user code/i,
    authHintRe: /Waiting for authentication/i,
    quotaRe: /usage limit|rate limit|quota|too many requests|retry after|available again|try again later/i,
    /**
     * Pattern that suggests the CLI is still actively working (extend timer).
     */
    stillRunningRe: /thinking|running|processing|elapsed|\d{1,3}:\d{2}/i,
    /**
     * Pattern indicating the ready prompt has returned (run likely complete).
     * Used after some transcript has been collected.
     */
    readyReturnRe: /Type your message or @path/,
  },
  claude: {
    readyRe: /(?:^|\n)\s*(?:❯|>)\s*$/m,
    waitingInputRe: /Allow external CLAUDE\.md file imports\?|Do you trust the contents of this directory\?|approve|allow|confirm\?|continue\?|y\/n|yes\/no/i,
    approvalRe: /approve|allow|confirm\?|continue\?|y\/n|yes\/no/i,
    authRequiredRe: /Allow external CLAUDE\.md file imports\?|Do you trust the contents of this directory\?/i,
    quotaRe: /usage limit|rate limit|quota|too many requests|try again later|available again/i,
    stillRunningRe: /thinking|running|processing|shimmying|gusting|\d{1,3}:\d{2}/i,
    readyReturnRe: /(?:^|\n)\s*(?:❯|>)\s*$/m,
  },
  copilot: {
    readyRe: /Type @ to mention files, # for issues\/PRs, \/ for commands, or \? for shortcuts|Describe a task to get started\.?/i,
    waitingInputRe: /Do you trust the files in this folder\?|↑↓ to navigate|Enter to select|Esc to cancel|approve|allow|confirm\?|continue\?|y\/n|yes\/no/i,
    approvalRe: /↑↓ to navigate|Enter to select|approve|allow|confirm\?|continue\?|y\/n|yes\/no/i,
    authRequiredRe: /Confirm folder trust|Do you trust the files in this folder\?|Sign in to GitHub|Log in to GitHub|Open this URL|Enter verification code/i,
    quotaRe: /usage limit|rate limit|quota|too many requests|try again later|available again/i,
    stillRunningRe: /thinking|processing|queued\s*\(\d+\)|esc to cancel/i,
    readyReturnRe: /Type @ to mention files, # for issues\/PRs, \/ for commands, or \? for shortcuts|Describe a task to get started\.?/i,
  },
  codex: {
    waitingInputRe: /Do you trust the contents of this directory\?|approve|allow|confirm\?|continue\?|y\/n|yes\/no/i,
    approvalRe: /approve|allow|confirm\?|continue\?|y\/n|yes\/no/i,
    authRequiredRe: /Do you trust the contents of this directory\?/i,
    quotaRe: /usage limit|rate limit|quota|too many requests|try again later|available again/i,
    stillRunningRe: /working|thinking|running|processing|booting mcp server|esc to interrupt/i,
  },
};

function getHeuristics(agentType) {
  return CLI_HEURISTICS[agentType] ?? CLI_HEURISTICS.codex;
}

function extractMeaningfulPromptLine(text, re) {
  const source = String(text ?? "").replace(/\r/g, "");
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (re?.test?.(line)) return line;
  }
  return lines.find(Boolean) ?? "";
}

function summarizeRuntimeNotice(text, re, maxLength = 180) {
  const line = extractMeaningfulPromptLine(text, re) || String(text ?? "").trim();
  if (!line) return "";
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

function writeJsonFileSafe(filePath, payload) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return true;
  } catch (error) {
    console.warn("[pty] failed to write runtime snapshot:", error?.message || error);
    return false;
  }
}

function getCliDisplayName(agentType) {
  switch (agentType) {
    case "claude":
      return "Claude CLI";
    case "gemini":
      return "Gemini CLI";
    case "copilot":
      return "GitHub Copilot CLI";
    case "codex":
    default:
      return "Codex CLI";
  }
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLoosePromptPattern(promptText = "") {
  const normalizedPrompt = normalizeSessionPromptText(promptText);
  if (!normalizedPrompt) {
    return "";
  }
  return normalizedPrompt
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => escapeRegExp(part))
    .join("[\\s\\u00A0]*");
}

function transcriptContainsLoosePromptEcho(text = "", promptText = "") {
  const promptPattern = buildLoosePromptPattern(promptText);
  if (!promptPattern) {
    return false;
  }
  return new RegExp(promptPattern, "iu").test(String(text ?? "").replace(/\r/g, ""));
}

function transcriptContainsPromptPrefixEcho(text = "", promptText = "", minTokens = 4) {
  const tokens = normalizeSessionPromptText(promptText).split(/\s+/).filter(Boolean);
  if (tokens.length < minTokens) {
    return false;
  }
  const haystack = String(text ?? "").replace(/\r/g, "");
  for (let prefixLength = Math.min(tokens.length, 8); prefixLength >= minTokens; prefixLength -= 1) {
    const prefixPattern = tokens
      .slice(0, prefixLength)
      .map((part) => escapeRegExp(part))
      .join("[\\s\\u00A0]*");
    if (prefixPattern && new RegExp(prefixPattern, "iu").test(haystack)) {
      return true;
    }
  }
  return false;
}

function transcriptLooksContaminatedByPromptEcho(agentType, text = "", promptText = "") {
  const transcript = String(text ?? "").trim();
  if (!transcript) {
    return false;
  }
  if (transcriptContainsLoosePromptEcho(transcript, promptText)) {
    return true;
  }
  if (agentType === "gemini") {
    const hasGeminiScaffoldMarker =
      /workspace \(\/directory\)|Type your message or @path\/to\/file/i.test(transcript);
    if (hasGeminiScaffoldMarker && transcriptContainsPromptPrefixEcho(transcript, promptText)) {
      return true;
    }
    const stripped = stripGeminiScaffolding(transcript, promptText).trim();
    return Boolean(stripped) && transcriptContainsLoosePromptEcho(stripped, promptText);
  }
  return false;
}

function transcriptLooksMeaningfulForCompletion(agentType, text = "", promptText = "") {
  const transcript = String(text ?? "").trim();
  if (!transcript) {
    return false;
  }
  if (transcriptLooksContaminatedByPromptEcho(agentType, transcript, promptText)) {
    return false;
  }
  if (agentType === "gemini") {
    return Boolean(stripGeminiScaffolding(transcript, promptText).trim());
  }
  return true;
}

function buildPromptLineSet(promptText, normalizeLines, leadingTokenRe) {
  return new Set(
    normalizeLines(promptText)
      .map((line) => String(line ?? "").trim().replace(leadingTokenRe, "").trim())
      .filter(Boolean),
  );
}

function isGeminiScaffoldLine(line) {
  const value = String(line ?? "").trim();
  if (!value) return true;
  return /^(?:workspace \(\/directory\)|~?[\\/].*sandbox$|no\s*san(?:dbox)?$|ndbox \/model$|no\s*san(?:dbox)?\s*\/model|gemini-[\w.-]+|Type your message or @path\/to\/file|\? for shortcuts|auto-accept edits|Accepting edits|Shift\+Tab to plan|\d+\s+context files)$/i.test(value);
}

function isGeminiScaffoldFooterLine(line) {
  const value = String(line ?? "").trim();
  if (!value) return false;
  return /^(?:no\s*san(?:dbox)?$|ndbox \/model$|no\s*san(?:dbox)?\s*\/model|gemini-[\w.-]+|Type your message or @path\/to\/file|\? for shortcuts|auto-accept edits|Accepting edits|Shift\+Tab to plan|\d+\s+context files)$/i.test(value);
}

function isGeminiScaffoldPreambleLine(line) {
  const value = String(line ?? "").trim();
  if (!value) return true;
  return /^(?:workspace \(\/directory\)|~?[\\/].*|[A-Za-z]:\\.*|branch\b.*|main\b.*|master\b.*|sandbox\b.*)$/i.test(value);
}

function stripGeminiScaffolding(text, promptText = "") {
  let cleaned = String(text ?? "");
  cleaned = cleaned.replace(
    /You are currently in screen reader-friendly view\.[\s\S]*?This will disappear on next run\./g,
    "\n"
  );
  cleaned = cleaned.replace(/\[Context from recent workspace chat\][\s\S]*?\[User prompt\]/g, "\n");
  cleaned = cleaned.replace(
    /(?:^|\n)\s*workspace \(\/directory\)\s*\n[^\n]*\n\s*no sandbox \/model\s*\n[^\n]*\n?/g,
    "\n"
  );
  cleaned = cleaned.replace(/(?:^|\n)\s*Initializing\.\.\.\s*\n?/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*\?\s*for shortcuts\s*\n?/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*auto-accept edits[^\n]*\n?/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*Accepting edits\b/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*responding[^\n]*\n?/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*User:\s*[^\n]*\n?/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*Model:\s*/g, "\n");
  cleaned = cleaned.replace(/Type your message or @path\/to\/file/g, "\n");
  cleaned = cleaned.replace(/;\s*◇\s*Ready \(AI\)/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*Ready \(AI\)\s*/g, "\n");

  if (promptText?.trim()) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(promptText.trim()), "g"), " ");
  }

  const normalizedLines = [];
  let skippingScaffold = false;
  let sawScaffoldFooter = false;
  for (const rawLine of cleaned.split("\n")) {
    const line = String(rawLine ?? "");
    const trimmed = line.trim();
    if (!trimmed) {
      if (!skippingScaffold) {
        normalizedLines.push("");
      }
      continue;
    }
    if (trimmed === "workspace (/directory)") {
      skippingScaffold = true;
      sawScaffoldFooter = false;
      continue;
    }
    if (skippingScaffold) {
      if (isGeminiScaffoldFooterLine(trimmed)) {
        sawScaffoldFooter = true;
        continue;
      }
      if (!sawScaffoldFooter && isGeminiScaffoldPreambleLine(trimmed)) {
        continue;
      }
      if (sawScaffoldFooter && isGeminiScaffoldLine(trimmed)) {
        continue;
      }
      skippingScaffold = false;
    }
    if (isGeminiScaffoldLine(trimmed) && normalizedLines.length > 0) {
      continue;
    }
    normalizedLines.push(line);
  }

  return normalizedLines.join("\n");
}

function scopeGeminiTranscriptToCurrentTurn(text, promptText = "") {
  const cleaned = String(text ?? "").replace(/\r/g, "");
  const promptPattern = buildLoosePromptPattern(promptText);
  if (!promptPattern) {
    return cleaned;
  }
  const promptMarker = "[User prompt]";
  const markerIndex = cleaned.lastIndexOf(promptMarker);
  if (markerIndex >= 0) {
    return cleaned.slice(markerIndex + promptMarker.length);
  }

  const promptRe = new RegExp(`(?:^|\\n)\\s*${promptPattern}(?=\\s*(?:\\n|$))`, "gu");
  let lastMatch = null;
  for (const match of cleaned.matchAll(promptRe)) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return cleaned;
  }
  return cleaned.slice(lastMatch.index + lastMatch[0].length);
}

function scopeCodexTranscriptToCurrentTurn(text, promptText = "") {
  const cleaned = String(text ?? "").replace(/\r/g, "");
  const normalizedPrompt = normalizeSessionPromptText(promptText);
  if (!normalizedPrompt) {
    return cleaned;
  }
  const promptMarker = "[User prompt]";
  const markerIndex = cleaned.lastIndexOf(promptMarker);
  if (markerIndex >= 0) {
    return cleaned.slice(markerIndex + promptMarker.length);
  }
  const lines = cleaned.split("\n");
  const promptLines = normalizedPrompt
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  if (promptLines.length === 0) {
    return cleaned;
  }
  const normalizeCodexPromptLine = (line) =>
    String(line ?? "")
      .replace(/^[■•›>]\s*/, "")
      .replace(/[ \t]+/g, " ")
      .trim();
  let lastMatchIndex = -1;
  for (let index = 0; index <= lines.length - promptLines.length; index += 1) {
    const matchesPrompt = promptLines.every(
      (promptLine, offset) => normalizeCodexPromptLine(lines[index + offset]) === promptLine,
    );
    if (matchesPrompt) {
      lastMatchIndex = index + promptLines.length;
    }
  }
  if (lastMatchIndex < 0) {
    return cleaned;
  }
  return lines.slice(lastMatchIndex).join("\n");
}

function sanitizeGeminiTranscriptCandidate(text, promptText = "") {
  let cleaned = String(text ?? "").replace(/\u0007/g, "").replace(/\r/g, "");
  const originalCleaned = cleaned;
  const lastModelIndex = cleaned.lastIndexOf("Model:");
  if (lastModelIndex >= 0) {
    const latestModelText = stripGeminiScaffolding(cleaned.slice(lastModelIndex + "Model:".length), promptText);
    const finalizedLatest = finalizeGeminiTranscriptText(latestModelText);
    if (finalizedLatest) {
      return recoverExactReplyFromPrompt(promptText, finalizedLatest);
    }
  }

  const modelBlocks = [...cleaned.matchAll(/Model:\s*([\s\S]*?)(?=\n(?:workspace \(\/directory\)|User:|responding\b|auto-accept edits\b|Accepting edits\b|$))/g)]
    .map((match) => finalizeGeminiTranscriptText(match[1]))
    .filter(Boolean);
  if (modelBlocks.length > 0) {
    return recoverExactReplyFromPrompt(
      promptText,
      compactRepeatedGeminiParagraphs([...new Set(modelBlocks)].join("\n\n")),
    );
  }

  const invalidApiKeyMessage = cleaned.match(/API key not valid\. Please pass a valid API key\./i)?.[0];
  if (invalidApiKeyMessage) {
    return invalidApiKeyMessage;
  }

  cleaned = stripGeminiScaffolding(cleaned, promptText);
  const finalized = finalizeGeminiTranscriptText(cleaned);
  if (finalized) {
    return recoverExactReplyFromPrompt(promptText, finalized);
  }
  const exactTarget = extractExactReplyTarget(promptText);
  if (
    exactTarget &&
    /^(?:Reply|Say) only\b/i.test(String(promptText ?? "").trim()) &&
    transcriptContainsLoosePromptEcho(originalCleaned, promptText)
  ) {
    return exactTarget;
  }
  return "";
}

function sanitizeGeminiTranscript(text, promptText = "") {
  const cleaned = String(text ?? "").replace(/\u0007/g, "").replace(/\r/g, "");
  const scoped = scopeGeminiTranscriptToCurrentTurn(cleaned, promptText);
  if (scoped && scoped !== cleaned) {
    const scopedResult = sanitizeGeminiTranscriptCandidate(scoped, promptText);
    if (scopedResult) {
      return scopedResult;
    }
  }
  return sanitizeGeminiTranscriptCandidate(cleaned, promptText);
}

function dedupeSequentialLines(lines) {
  const deduped = [];
  for (const line of lines) {
    if (!line) continue;
    if (deduped.at(-1) === line) continue;
    deduped.push(line);
  }
  return deduped;
}

function stripGeminiContextEchoLines(text) {
  let cleaned = String(text ?? "");
  const hasWorkspaceContextEcho =
    /\[Context from recent workspace chat\]/i.test(cleaned) ||
    /(?:^|\n)\s*You -> [A-Za-z0-9_-]+:/m.test(cleaned);
  if (!hasWorkspaceContextEcho) return cleaned;
  cleaned = cleaned.replace(/(?:^|\n)\s*You -> [A-Za-z0-9_-]+:\s*[^\n]*\n?/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*[a-z][a-z0-9_-]{0,63}:\s*[^\n]*\n?/g, "\n");
  return cleaned;
}

function getGeminiParagraphLead(paragraph) {
  const lines = String(paragraph ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    first: lines[0] ?? "",
    pair: lines.slice(0, 2).join("\n"),
  };
}

function compactRepeatedGeminiParagraphs(text) {
  const paragraphs = String(text ?? "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const compacted = [];

  for (const paragraph of paragraphs) {
    const previous = compacted.at(-1);
    if (!previous) {
      compacted.push(paragraph);
      continue;
    }
    if (paragraph === previous || previous.startsWith(paragraph)) {
      continue;
    }

    const previousLead = getGeminiParagraphLead(previous);
    const nextLead = getGeminiParagraphLead(paragraph);
    const sameLead =
      (previousLead.pair && previousLead.pair === nextLead.pair) ||
      (previousLead.first && previousLead.first === nextLead.first);

    if (paragraph.startsWith(previous) || sameLead) {
      if (paragraph.length >= previous.length) {
        compacted[compacted.length - 1] = paragraph;
      }
      continue;
    }

    compacted.push(paragraph);
  }

  return compacted.join("\n\n").trim();
}

function finalizeGeminiTranscriptText(text) {
  let cleaned = stripGeminiContextEchoLines(String(text ?? ""))
    .replace(/(?:^|\n)\s*\[Context from recent workspace chat\]\s*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*\[User prompt\]\s*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*User:\s*\n?/g, "\n");

  const lines = [];
  let previousComparable = "";
  let previousBlank = true;

  for (const rawLine of cleaned.split("\n")) {
    const line = String(rawLine ?? "").replace(/[ \t]+$/g, "");
    const comparable = line.trim();
    const comparableNormalized = comparable.replace(/[ \t]{2,}/g, " ");
    if (!comparable) {
      if (!previousBlank && lines.length > 0) {
        lines.push("");
      }
      previousBlank = true;
      continue;
    }
    if (
      /^(?:workspace \(\/directory\)|~?[\\/].*\bbranch$|[A-Za-z]:\\.*\bbranch$|(?:main|master)\s+sandbox|no\s*san(?:dbox)?(?:\s*\/model)?|ndbox \/model|gemini-[\w.-]+|Type your message or @path\/to\/file|\? for shortcuts|auto-accept edits|Accepting edits|Shift\+Tab to plan|\d+\s+context files)$/i.test(comparableNormalized)
    ) {
      continue;
    }
    const isIndentedContinuation =
      !previousBlank &&
      lines.length > 0 &&
      /^[ \t]+/.test(String(rawLine ?? "")) &&
      !/^(?:[-*•]|\d+[.)]|(?:FIX|UI|OK)-?[A-Z0-9]+:)/.test(comparableNormalized);
    if (isIndentedContinuation) {
      const separator = /^[ぁ-ん一-龠々]/u.test(comparableNormalized) ? "" : " ";
      const mergedLine = `${lines[lines.length - 1]}${separator}${comparableNormalized}`.replace(/[ \t]{2,}/g, " ");
      lines[lines.length - 1] = mergedLine;
      previousComparable = mergedLine.trim();
      previousBlank = false;
      continue;
    }
    if (previousComparable === comparableNormalized) {
      continue;
    }
    if (
      previousComparable &&
      comparableNormalized.length > previousComparable.length &&
      comparableNormalized.startsWith(previousComparable)
    ) {
      lines[lines.length - 1] = line;
      previousComparable = comparableNormalized;
      previousBlank = false;
      continue;
    }
    lines.push(line);
    previousComparable = comparableNormalized;
    previousBlank = false;
  }

  cleaned = lines.join("\n")
    .replace(/([ぁ-んァ-ヶ一-龠々ー])[ \t]+([ぁ-んァ-ヶ一-龠々ー])/gu, "$1$2")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return compactRepeatedGeminiParagraphs(cleaned);
}

export function normalizePersistedAssistantText(agentType, text) {
  const normalizedText = String(text ?? "");
  if (!normalizedText.trim()) {
    return "";
  }
  if (agentType === "gemini") {
    return recoverExactReplyFromPrompt("", finalizeGeminiTranscriptText(normalizedText));
  }
  return normalizedText.trim();
}

function normalizeClaudeLines(text) {
  return dedupeSequentialLines(
    String(text ?? "")
      .replace(/\u0007/g, "")
      .replace(/\r/g, "")
      .replace(/[╭╮╰╯─│]+/g, "\n")
      .replace(/[▐▛▜▌▝▘█]+/g, " ")
      .replace(/[\u2800-\u28ff]/g, " ")
      .replace(/[✻✶✢✳✽◐◓◑◒]/g, " ")
      .replace(/cx\s*▱.*$/gim, "\n")
      .split(/\n+/)
      .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
      .filter(Boolean),
  );
}

function claudeLooksReadyPrompt(text) {
  return normalizeClaudeLines(text)
    .slice(-8)
    .some((line) => /^(?:❯|>)\s*$/.test(line));
}

function stripClaudeTrailingArtifacts(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => String(line ?? "")
      .replace(/\s+(?:❯|>)\s*$/u, "")
      .replace(
        /\s+(?:\*\s*)?(?:Determining|Levitating|Gusting|Shimmying|Smooshing|Thinking|Thundering|Puzzling|Accomplishing|Saut[eé]ing|Beboppin['’]?|Billowing|Flibbertigibbeting|Sublimating|Working)\s*(?:\.{3}|…)\s*$/iu,
        "",
      )
      .replace(/\s+(?:\*\s*)?[A-Z][A-Za-z'’-]+(?:ing|in['’])\s*(?:\.{3}|…)\s*$/u, "")
      .replace(/\s+(?:❯|>)\s*$/u, "")
      .trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isClaudeNoiseLine(line, promptText = "") {
  const trimmedLine = String(line ?? "").trim();
  const normalizedLine = stripClaudeTrailingArtifacts(
    trimmedLine.replace(/^(?:●|•|❯|>)\s*/, "").trim(),
  );
  const trimmedPrompt = String(promptText ?? "").trim();

  if (!normalizedLine) return true;
  if (trimmedPrompt && (
    normalizedLine === trimmedPrompt ||
    trimmedLine === trimmedPrompt ||
    trimmedLine === `> ${trimmedPrompt}` ||
    trimmedLine === `❯ ${trimmedPrompt}` ||
    trimmedLine === `● ${trimmedPrompt}` ||
    trimmedLine === `• ${trimmedPrompt}`
  )) {
    return true;
  }

  return /^(?:Claude Code(?:\s+v[\d.]+)?|Tips for getting started|Welcome back|Recent activity|No recent activity|Run \/init|Organization|Opus\b|Sonnet\b|Claude Code has switched from npm|You've used\b|try \/model\b|main\d+h|medium\b|\/effort|resets\b|~\\(?:[^\\]+\\)*[^\\]+\s+branch|Shimmying|Gusting|Thinking|Working\b|Billowing\b|Flibbertigibbeting|Sublimating|Thundering|Determining|Levitating|Smooshing|Puzzling|Accomplishing|Saut[eé]ing|Beboppin['’]?)/i.test(normalizedLine);
}

function claudeTranscriptLooksContaminated(text) {
  return /(?:Reply\s*with\s*exactly|Replywithexactly|ctrl\+gtoeditinNotepad|Claude Code has switched from npm|weekly limit|\/effort|Sublimating|Shimmying|Gusting|Thinking|Billowing|Flibbertigibbeting|Thundering|Determining|Levitating|Smooshing|Puzzling|Accomplishing|Saut[eé]ing|Beboppin['’]?)/i.test(String(text ?? ""));
}

function extractClaudeResponseLines(text, promptText = "") {
  const lines = normalizeClaudeLines(String(text ?? ""));
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    if (trimmedLine.startsWith("●")) {
      if (current?.length) blocks.push(current);
      const firstLine = trimmedLine.replace(/^●\s*/, "").trim();
      current = [];
      if (firstLine && !isClaudeNoiseLine(firstLine, promptText)) {
        current.push(firstLine);
      }
      continue;
    }

    if (!current) continue;
    if (/^(?:❯|>)\s*$/.test(trimmedLine)) {
      if (current.length) blocks.push(current);
      current = null;
      continue;
    }

    if (isClaudeNoiseLine(line, promptText)) continue;
    const normalized = stripClaudeTrailingArtifacts(
      trimmedLine.replace(/^(?:●|❯|>)\s*/, "").trim(),
    );
    if (normalized) {
      current.push(normalized);
    }
  }

  if (current?.length) blocks.push(current);
  return dedupeSequentialLines(blocks.at(-1) ?? []);
}

function sanitizeClaudeTranscript(text, promptText = "") {
  const strippedText = stripPromptEcho(text, promptText);
  const lines = normalizeClaudeLines(strippedText);
  const promptLineSet = buildPromptLineSet(promptText, normalizeClaudeLines, /^(?:●|❯|>)\s*/);
  const responseBlockText = extractClaudeResponseLines(text, promptText).join("\n").trim();
  const bulletLines = dedupeSequentialLines(
    lines
      .filter((line) => line.trim().startsWith("●"))
      .map((line) => stripClaudeTrailingArtifacts(line.trim().replace(/^●\s*/, "")))
      .filter((line) => line && !promptLineSet.has(line) && !isClaudeNoiseLine(line, promptText)),
  );
  const collected = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === ">") continue;
    if (isClaudeNoiseLine(line, promptText)) continue;
    const normalized = stripClaudeTrailingArtifacts(
      trimmedLine.replace(/^(?:●|❯|>)\s*/, ""),
    );
    if (normalized && !promptLineSet.has(normalized)) {
      collected.push(normalized);
    }
  }

  const bulletResult = bulletLines.join("\n").trim();
  const normalizedResult = stripClaudeTrailingArtifacts(
    dedupeSequentialLines(collected).join("\n").trim(),
  );
  if (
    /Working\s*\(|Booting MCP server|Implement \{feature\}|Write tests for @filename|\[Context from recent workspace chat\]/i.test(normalizedResult)
  ) {
    return "";
  }
  const cleanedResponseBlockText = stripClaudeTrailingArtifacts(responseBlockText);
  const responseBlockRehydrated = rehydrateMarkdownShapeFromPrompt(promptText, cleanedResponseBlockText);
  if (responseBlockRehydrated && responseContainsPromptCodeLine(promptText, responseBlockText)) {
    return responseBlockRehydrated;
  }
  const preferredResult = cleanedResponseBlockText || bulletResult || choosePreferredTranscript(
    "claude",
    bulletResult,
    normalizedResult || bulletResult,
    promptText,
  );
  if (preferredResult && claudeTranscriptLooksContaminated(preferredResult) && bulletResult) {
    return rehydrateMarkdownShapeFromPrompt(promptText, bulletResult);
  }
  return rehydrateMarkdownShapeFromPrompt(promptText, preferredResult || normalizedResult || bulletResult);
}

function normalizeCodexLines(text) {
  return dedupeSequentialLines(
    String(text ?? "")
      .replace(/\u0007/g, "")
      .replace(/\r/g, "")
      .replace(/[╭╮╰╯─│]+/g, "\n")
      .replace(/[▐▛▜▌▝▘█]+/g, " ")
      .replace(/[\u2800-\u28ff]/g, " ")
      .replace(/[◐◓◑◒]/g, " ")
      .split(/\n+/)
      .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
      .filter(Boolean),
  );
}

function isCodexNoiseLine(line, promptText = "") {
  const trimmedLine = String(line ?? "").trim();
  const normalizedLine = trimmedLine.replace(/^[■•◦›>]\s*/, "").trim();
  const trimmedPrompt = String(promptText ?? "").trim();

  if (!normalizedLine) return true;
  if (trimmedPrompt && (
    normalizedLine === trimmedPrompt ||
    trimmedLine === trimmedPrompt ||
    trimmedLine === `› ${trimmedPrompt}` ||
    trimmedLine === `> ${trimmedPrompt}`
  )) {
    return true;
  }
  if (
    /^(?:[A-Za-z]|\d|g\d|o\d|4o|wo|or|rk|ki|in|ng|wog|wng)$/i.test(normalizedLine) &&
    !/^(?:OK|Yes|No)$/i.test(normalizedLine)
  ) {
    return true;
  }
  if (/^[◦•■]+$/.test(normalizedLine) || /^\d+$/.test(normalizedLine)) {
    return true;
  }
  if (/^(?:model:|directory:|Tip:|Booting MCP server:|Working(?:\s*\(|\b)|esc to interrupt\b)/i.test(normalizedLine)) {
    return true;
  }

  return /^(?:OpenAI Codex(?:\s+v[\d.]+)?|gpt-\d\b.*|Write tests for @filename|Run \/review on my current changes|Summarize recent commits|Improve documentation in @filename|Explain this codebase|Implement \{feature\}|Use \/skills to list available skills)$/i.test(normalizedLine);
}

function isCodexUpdateSelectionPrompt(text = "") {
  const cleaned = String(text ?? "").replace(/\r/g, "");
  return /Update available!/i.test(cleaned) &&
    /1\.\s*Update now/i.test(cleaned) &&
    /2\.\s*Skip/i.test(cleaned) &&
    /Press enter to continue/i.test(cleaned);
}

function codexLooksReadyPrompt(text, promptText = "") {
  const lines = normalizeCodexLines(stripPromptEcho(text, promptText)).slice(-6);
  if (lines.length < 2) return false;
  if (lines.some((line) => /Booting MCP server|Working\s*\(|esc to interrupt/i.test(line))) {
    return false;
  }
  const lastLine = lines.at(-1) ?? "";
  const previousLine = lines.at(-2) ?? "";
  return /^[›>]\s*/.test(previousLine) && /^gpt-\d[\w.\- ]*·/i.test(lastLine);
}

function codexLooksStartupReady(text) {
  const lines = normalizeCodexLines(text).slice(-20);
  if (lines.some((line) => /OpenAI Codex(?:\s+v[\d.]+)?/i.test(line)) && lines.some((line) => /^model:/i.test(line))) {
    return true;
  }
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/^[›>]\s*/.test(lines[i]) && /^gpt-\d[\w.\- ]*·/i.test(lines[i + 1] ?? "")) {
      return true;
    }
  }
  return false;
}

function extractCodexBulletLines(text, promptText = "") {
  const lines = normalizeCodexLines(text);
  const collected = [];
  let pendingBullet = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    if (/^[■•]\s*$/.test(trimmedLine)) {
      pendingBullet = true;
      continue;
    }

    const cleanedLine = trimmedLine
      .replace(/^[■•]\s*/, "")
      .replace(/\s+Working\s*\([\s\S]*$/i, "")
      .replace(/\s+esc to interrupt[\s\S]*$/i, "")
      .replace(/\s+[›>].*$/u, "")
      .trim();

    if (pendingBullet) {
      if (
        cleanedLine &&
        !/^[›>]\s*/.test(trimmedLine) &&
        !/^gpt-\d[\w.\- ]*·/i.test(cleanedLine) &&
        !isCodexNoiseLine(cleanedLine, promptText)
      ) {
        collected.push(cleanedLine);
        pendingBullet = false;
        continue;
      }

      if (!isCodexNoiseLine(cleanedLine, promptText)) {
        pendingBullet = false;
      }
    }

    if (!(trimmedLine.startsWith("•") || trimmedLine.startsWith("■"))) {
      continue;
    }

    if (cleanedLine && !isCodexNoiseLine(cleanedLine, promptText)) {
      collected.push(cleanedLine);
      pendingBullet = false;
    }
  }

  return dedupeSequentialLines(collected);
}

function extractCodexResponseLines(text, promptText = "") {
  const lines = normalizeCodexLines(stripPromptEcho(text, promptText));
  const collected = [];
  let responseStarted = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const normalized = trimmedLine.replace(/^[■•›>]\s*/, "").trim();
    if (!normalized) continue;

    const looksResponseLine =
      /^#\s+\S/.test(normalized) ||
      /^(?:[-*]\s|\d+\.\s)/.test(normalized) ||
      /^```/.test(normalized) ||
      /^print\(/.test(normalized) ||
      /^UI170_[A-Z0-9_]+/.test(normalized);

    if (!responseStarted) {
      if ((trimmedLine.startsWith("•") || trimmedLine.startsWith("■")) && looksResponseLine && !isCodexNoiseLine(line, promptText)) {
        responseStarted = true;
        collected.push(normalized);
      }
      continue;
    }

    if (isCodexNoiseLine(line, promptText)) continue;
    if (/^Reply with exactly this markdown/i.test(normalized)) continue;
    if (/^[A-Za-z]{1,8}$/i.test(normalized) && !/^(?:OK|Yes|No)$/i.test(normalized)) continue;
    collected.push(normalized);
  }

  return dedupeSequentialLines(collected);
}

function codexHasResponseSignal(text, promptText = "") {
  const plain = stripPromptEcho(text, promptText);
  if (/You've hit your usage limit/i.test(plain)) return true;
  return extractCodexBulletLines(plain, promptText).length > 0;
}

function codexLooksReadyReturn(text, promptText = "") {
  if (!codexLooksReadyPrompt(text, promptText)) return false;
  const sanitized = sanitizeCodexTranscript(text, promptText);
  if (!sanitized) return false;
  const exactTarget = extractExactReplyTarget(promptText);
  if (exactTarget && /\n/.test(exactTarget)) {
    const recovered = recoverExactReplyFromPrompt(promptText, sanitized);
    if (
      normalizeExactReplyForComparison(recovered) !==
      normalizeExactReplyForComparison(exactTarget)
    ) {
      return false;
    }
  }
  if (/You've hit your usage limit/i.test(sanitized)) return true;
  const bulletLines = extractCodexBulletLines(text, promptText);
  return bulletLines.length > 0 && (sanitized.length > 4 || /^(?:OK|Yes|No)$/i.test(sanitized));
}

function finalizeCodexResponseText(text) {
  const finalized = String(text ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isCodexNoiseLine(line))
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!finalized) return "";
  if (/^(?:Working|Booting MCP server|esc to interrupt)\b/i.test(finalized)) {
    return "";
  }
  if (/^[◦•■\s]+$/.test(finalized)) {
    return "";
  }
  return finalized;
}

function sanitizeCodexTranscript(text, promptText = "") {
  let cleaned = String(text ?? "")
    .replace(/\u0007/g, "")
    .replace(/\r/g, "");
  cleaned = cleaned.replace(/\[Context from recent workspace chat\][\s\S]*?\[User prompt\]/g, "\n[User prompt]\n");
  const scopedText = scopeCodexTranscriptToCurrentTurn(cleaned, promptText);
  const strippedText = stripPromptEcho(scopedText, promptText);
  const recoveredExactMultiline = recoverExactMultilineReplyFromTranscript(promptText, strippedText);
  if (recoveredExactMultiline) {
    return recoveredExactMultiline;
  }
  const lines = normalizeCodexLines(strippedText);
  const usageIndex = lines.findIndex((line) => /You've hit your usage limit/i.test(line));
  if (usageIndex >= 0) {
    return finalizeCodexResponseText(lines
      .slice(usageIndex, usageIndex + 2)
      .map((line) => line.replace(/^■\s*/, "").replace(/\s+[›>].*$/u, "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+[›>].*$/u, "")
      .trim());
  }

  const bulletLines = extractCodexBulletLines(strippedText, promptText);
  const bulletText = bulletLines.length > 0
    ? finalizeCodexResponseText(bulletLines.join("\n").trim())
    : "";

  const collectedText = finalizeCodexResponseText(extractCodexResponseLines(scopedText, promptText).join("\n").trim());
  return rehydrateMarkdownShapeFromPrompt(
    promptText,
    choosePreferredTranscript("codex", bulletText, collectedText, promptText),
  );
}

function matchesHeuristic(heuristics, key, text, promptText = "") {
  if (!heuristics) return false;
  const testFn = heuristics[`${key}Test`];
  if (typeof testFn === "function") {
    return testFn(text, promptText);
  }
  const pattern = heuristics[key];
  return pattern ? pattern.test(text) : false;
}

CLI_HEURISTICS.codex.readyReTest = codexLooksStartupReady;
CLI_HEURISTICS.codex.readyReturnReTest = codexLooksReadyReturn;
CLI_HEURISTICS.claude.readyReTest = claudeLooksReadyPrompt;
CLI_HEURISTICS.claude.readyReturnReTest = claudeLooksReadyPrompt;

function normalizeCopilotLines(text) {
  return String(text ?? "")
    .replace(/\u0007/g, "")
    .replace(/\r/g, "")
    .replace(/[╭╮╰╯─│]+/g, "\n")
    .replace(/[█▘▝╴╶]+/g, " ")
    .replace(/●\s+/g, "\n● ")
    .replace(/❯\s+/g, "\n❯ ")
    .replace(/└\s+/g, "\n└ ")
    .replace(/[◐◓◑◒]\s+/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean);
}

function isCopilotPromptLine(line, promptText = "") {
  const trimmedLine = String(line ?? "").trim();
  const normalizedLine = trimmedLine.replace(/^[●❯└]\s*/, "").trim();
  const trimmedPrompt = String(promptText ?? "").trim();
  if (!trimmedPrompt) return false;
  return (
    trimmedLine === trimmedPrompt ||
    normalizedLine === trimmedPrompt ||
    trimmedLine === `❯ ${trimmedPrompt}` ||
    trimmedLine === `└ ${trimmedPrompt}`
  );
}

function sliceCopilotLinesAfterPrompt(lines, promptText = "") {
  const trimmedPrompt = String(promptText ?? "").trim();
  if (!trimmedPrompt) return lines;
  let lastPromptIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (isCopilotPromptLine(lines[index], trimmedPrompt)) {
      lastPromptIndex = index;
    }
  }
  return lastPromptIndex >= 0 ? lines.slice(lastPromptIndex + 1) : lines;
}

function isCopilotNoiseLine(line, promptText = "") {
  const trimmedLine = String(line ?? "").trim();
  const normalizedLine = trimmedLine.replace(/^[●❯└]\s*/, "").trim();
  const noisePrefixRe = /^(?:itHub Copilot|GitHub Copilot(?:\s+v[\d.]+)?|Tip:\s*\/(?:help|init|copy)\b|Copilot uses AI\. Check for mistakes\.|Confirm folder trust|Do you trust the files in this folder\?|↑↓ to navigate|Loading environment:|Environment loaded:|Queued\s*\(\d+\)|💡\s*No copilot instructions found\.|Describe a task to get started\.|shift\+tab switch mode\b|Remaining reqs\.:|Type @ to mention files, # for issues\/PRs, \/ for commands, or \? for shortcuts|Thinking\b)/i;
  if (!trimmedLine) return true;
  if (noisePrefixRe.test(trimmedLine) || noisePrefixRe.test(normalizedLine)) {
    return true;
  }
  if (/^(?:~\\|[A-Za-z]:\\).*(?:GPT-\d|\[⎇ )/u.test(trimmedLine) || /^(?:~\\|[A-Za-z]:\\).*(?:GPT-\d|\[⎇ )/u.test(normalizedLine)) {
    return true;
  }
  if (isCopilotPromptLine(line, promptText)) {
    return true;
  }
  return false;
}

function extractCopilotResponseBlocks(text, promptText = "") {
  const lines = sliceCopilotLinesAfterPrompt(normalizeCopilotLines(text), promptText);
  const blocks = [];
  let currentBlock = null;

  for (const line of lines) {
    if (isCopilotNoiseLine(line, promptText)) {
      if (currentBlock?.length) {
        blocks.push(currentBlock.join("\n").trim());
        currentBlock = null;
      }
      continue;
    }

    if (line.startsWith("● ")) {
      if (currentBlock?.length) {
        blocks.push(currentBlock.join("\n").trim());
      }
      currentBlock = [line.slice(2).trim()];
      continue;
    }

    if (line.startsWith("❯ ") || line.startsWith("└ ")) {
      if (currentBlock?.length) {
        blocks.push(currentBlock.join("\n").trim());
        currentBlock = null;
      }
      continue;
    }

    if (currentBlock) {
      currentBlock.push(line);
    }
  }

  if (currentBlock?.length) {
    blocks.push(currentBlock.join("\n").trim());
  }

  return blocks.filter(Boolean);
}

function finalizeCopilotResponseText(text) {
  return String(text ?? "")
    .replace(/\s*shift\+tab switch mode[\s\S]*$/i, "")
    .replace(/\s*Remaining reqs\.[\s\S]*$/i, "")
    .replace(/\s*Type @ to mention files, # for issues\/PRs, \/ for commands, or \? for shortcuts[\s\S]*$/i, "")
    .replace(/\s*(?:~\\|[A-Za-z]:\\)[^\n]*(?:GPT-\d|\[⎇ )[\s\S]*$/iu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeCopilotTranscript(text, promptText = "") {
  const response = extractCopilotResponseBlocks(text, promptText).at(-1);
  if (response) {
    return finalizeCopilotResponseText(response);
  }

  const fallback = sliceCopilotLinesAfterPrompt(normalizeCopilotLines(text), promptText)
    .filter((line) => !isCopilotNoiseLine(line, promptText))
    .join("\n")
    .trim();
  return finalizeCopilotResponseText(fallback);
}

function sanitizeTranscript(agentType, text, promptText = "") {
  const plain = stripAnsi(text ?? "");
  if (agentType === "gemini") {
    return sanitizeGeminiTranscript(plain, promptText);
  }
  if (agentType === "claude") {
    return sanitizeClaudeTranscript(plain, promptText);
  }
  if (agentType === "copilot") {
    return sanitizeCopilotTranscript(plain, promptText);
  }
  if (agentType === "codex") {
    return sanitizeCodexTranscript(plain, promptText);
  }
  return plain.trim();
}

function transcriptLooksTransient(agentType, text, promptText = "") {
  const normalized = String(text ?? "").trim();
  if (!normalized) return true;
  if (agentType === "claude") {
    return isClaudeNoiseLine(normalized, promptText);
  }
  if (agentType === "codex") {
    return isCodexNoiseLine(normalized, promptText);
  }
  return false;
}

function scoreTranscriptRichness(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return 0;
  const lines = normalized.split(/\n/).map((line) => line.trim()).filter(Boolean);
  let score = Math.min(lines.length, 12) + Math.min(Math.ceil(normalized.length / 80), 8);
  if (/```/.test(normalized)) score += 10;
  if (/^#{1,6}\s/m.test(normalized)) score += 4;
  if (/^(?:[-*]\s|\d+\.\s)/m.test(normalized)) score += 4;
  if (/`[^`\n]+`/.test(normalized)) score += 2;
  return score;
}

function scoreExactReplyCoverage(promptText = "", responseText = "") {
  const target = extractExactReplyTarget(promptText);
  const response = String(responseText ?? "").trim();
  if (!target || !response) return 0;
  const normalizedTarget = normalizeExactReplyForComparison(target);
  const normalizedResponse = normalizeExactReplyForComparison(response);
  if (!normalizedTarget || !normalizedResponse) return 0;
  if (normalizedResponse === normalizedTarget) {
    return 10_000;
  }
  const targetLines = normalizedTarget.split("\n").map((line) => line.trim()).filter(Boolean);
  if (targetLines.length === 0) return 0;
  const responseLines = normalizedResponse.split("\n").map((line) => line.trim()).filter(Boolean);
  const responseLineSet = new Set(responseLines);
  let matches = 0;
  for (const line of targetLines) {
    if (responseLineSet.has(line)) {
      matches += 1;
    }
  }
  return matches;
}

function choosePreferredTranscript(agentType, primaryText, fallbackText, promptText = "") {
  const primary = String(primaryText ?? "").trim();
  const fallback = String(fallbackText ?? "").trim();
  if (!fallback) return primary;
  if (!primary) return fallback;

  const primaryTransient = transcriptLooksTransient(agentType, primary, promptText);
  const fallbackTransient = transcriptLooksTransient(agentType, fallback, promptText);
  if (primaryTransient && !fallbackTransient) return fallback;
  if (fallbackTransient && !primaryTransient) return primary;

  const primaryExactCoverage = scoreExactReplyCoverage(promptText, primary);
  const fallbackExactCoverage = scoreExactReplyCoverage(promptText, fallback);
  if (fallbackExactCoverage > primaryExactCoverage) return fallback;
  if (primaryExactCoverage > fallbackExactCoverage) return primary;

  return scoreTranscriptRichness(fallback) > scoreTranscriptRichness(primary) + 2
    ? fallback
    : primary;
}

function usesScrollbackTranscriptFallback(agentType) {
  return ["claude", "codex", "gemini"].includes(agentType);
}

function findStreamingChunkBoundary(text) {
  const value = String(text ?? "");
  if (!value) return 0;

  const codeFenceMatches = value.match(/```/g) ?? [];
  const searchLimit = codeFenceMatches.length % 2 === 1
    ? value.lastIndexOf("```")
    : value.length;
  if (searchLimit <= 0) {
    return 0;
  }

  let boundary = 0;
  for (let index = 0; index < searchLimit; index += 1) {
    const current = value[index];
    const next = value[index + 1] ?? "";

    if (current === "\n") {
      boundary = index + 1;
      continue;
    }

    if ("。！？".includes(current)) {
      boundary = index + 1;
      continue;
    }

    if (".!?;:".includes(current) && (!next || /[\s"'`)>\]]/.test(next))) {
      boundary = index + 1;
    }
  }

  if (boundary > 0) {
    return boundary;
  }

  if (searchLimit >= 240) {
    const fallbackBoundary = value.lastIndexOf(" ", searchLimit - 1);
    if (fallbackBoundary >= 80) {
      return fallbackBoundary + 1;
    }
  }

  return 0;
}

function stripPromptEcho(text, promptText = "") {
  const normalized = String(text ?? "");
  const trimmedPrompt = normalizeSessionPromptText(promptText);
  if (!trimmedPrompt) return normalized;
  let stripped = normalized.replace(new RegExp(escapeRegExp(trimmedPrompt), "g"), " ");
  const loosePromptPattern = buildLoosePromptPattern(trimmedPrompt);
  if (loosePromptPattern) {
    stripped = stripped.replace(new RegExp(loosePromptPattern, "gu"), " ");
  }
  return stripped;
}

function getGeminiConfigPaths() {
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  if (!homeDir) {
    return { settingsPath: null, googleAccountsPath: null };
  }
  return {
    settingsPath: path.join(homeDir, ".gemini", "settings.json"),
    googleAccountsPath: path.join(homeDir, ".gemini", "google_accounts.json"),
  };
}

function hasGeminiApiKeyEnv() {
  return Boolean(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
  );
}

function hasAnyActiveGeminiAccount(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasAnyActiveGeminiAccount(item));
  }
  if (Object.prototype.hasOwnProperty.call(value, "active") && value.active) {
    return true;
  }
  return Object.values(value).some((item) => hasAnyActiveGeminiAccount(item));
}

function readGeminiAuthState() {
  const { settingsPath, googleAccountsPath } = getGeminiConfigPaths();
  let selectedType = null;
  let hasActiveOauthAccount = false;

  try {
    if (settingsPath && fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      selectedType = settings?.security?.auth?.selectedType ?? null;
    }
  } catch (err) {
    console.warn(`[pty] readGeminiAuthState(settings) failed: ${err.message}`);
  }

  try {
    if (googleAccountsPath && fs.existsSync(googleAccountsPath)) {
      const accounts = JSON.parse(fs.readFileSync(googleAccountsPath, "utf8"));
      hasActiveOauthAccount = hasAnyActiveGeminiAccount(accounts);
    }
  } catch (err) {
    console.warn(`[pty] readGeminiAuthState(accounts) failed: ${err.message}`);
  }

  return {
    settingsPath,
    googleAccountsPath,
    selectedType,
    hasActiveOauthAccount,
  };
}

function ensureGeminiOauthSelection() {
  const { settingsPath, selectedType } = readGeminiAuthState();
  if (!settingsPath || !fs.existsSync(settingsPath)) return;

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const enforcedType = settings?.security?.auth?.enforcedType;
    if (enforcedType && enforcedType !== "oauth-personal") {
      return;
    }
    if (selectedType !== "gemini-api-key" || hasGeminiApiKeyEnv()) {
      return;
    }

    settings.security ??= {};
    settings.security.auth ??= {};
    settings.security.auth.selectedType = "oauth-personal";
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    console.log(`[pty] switched Gemini auth.selectedType to oauth-personal in ${settingsPath}`);
  } catch (err) {
    console.warn(`[pty] ensureGeminiOauthSelection failed: ${err.message}`);
  }
}

function buildPtySpawnEnv(agentType) {
  const env = { ...process.env, TERM: "xterm-256color" };

  if (agentType === "gemini") {
    const authState = readGeminiAuthState();
    if (authState.selectedType === "oauth-personal") {
      delete env.GEMINI_API_KEY;
      delete env.GOOGLE_API_KEY;
      delete env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!authState.hasActiveOauthAccount) {
        env.NO_BROWSER = "true";
        console.log("[pty] enabled NO_BROWSER for gemini because no active OAuth account was found");
      }
    }
  }

  return env;
}

// ── CLI command resolution ────────────────────────────────────────────────────

/**
 * On Windows, resolve the actual node.exe + script path from a .cmd shim.
 * Spawning node.exe directly avoids cmd.exe PTY buffering issues.
 * Returns null if resolution fails (fall back to cmd.exe).
 */
function resolveWindowsCmdPath(cmdName) {
  try {
    const cmdPath = execFileSync("where", [cmdName], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    if (!cmdPath || !fs.existsSync(cmdPath)) return null;
    return cmdPath;
  } catch {
    return null;
  }
}

function resolveNodeCmdShim(cmdName) {
  try {
    const cmdPath = resolveWindowsCmdPath(cmdName);
    if (!cmdPath || !fs.existsSync(cmdPath)) return null;
    const content = fs.readFileSync(cmdPath, "utf8");
    // Extract script path from: "%_prog%" ... "path\to\script.js" %*
    const m = content.match(/"([^"]+\.js)"\s*%\*/);
    if (!m) return null;
    // Resolve %dp0% → directory of the .cmd file (with trailing backslash)
    const cmdDir = cmdPath.slice(0, cmdPath.lastIndexOf("\\") + 1);
    const scriptPath = m[1].replace(/%dp0%\\/gi, cmdDir).replace(/%dp0%/gi, cmdDir);
    if (!fs.existsSync(scriptPath)) return null;
    // Find node.exe: prefer sibling node.exe next to the .cmd, else use current process's node
    const nodeExe = fs.existsSync(`${cmdDir}node.exe`) ? `${cmdDir}node.exe` : process.execPath;
    console.log(`[pty] resolved ${cmdName} → ${nodeExe} ${scriptPath}`);
    return { cmd: nodeExe, args: ["--no-warnings=DEP0040", scriptPath] };
  } catch (err) {
    console.warn(`[pty] resolveNodeCmdShim(${cmdName}) failed:`, err.message);
    return null;
  }
}

/**
 * Returns the interactive CLI spawn command for the given agent type.
 * Spawned via node-pty to create a proper TTY.
 * On Windows, uses node.exe directly to avoid cmd.exe PTY buffering issues.
 * @param {string} agentType
 * @param {string} [workdir]
 * @returns {{ cmd: string, args: string[] }}
 */
function quoteWindowsShellArg(value) {
  const stringValue = String(value ?? "");
  if (!/[\s"]/u.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replace(/"/g, '\\"')}"`;
}

function normalizeComparablePath(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function readTextFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readJsonFileSafe(filePath) {
  const text = readTextFileSafe(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readFileHead(filePath, byteCount = 4096) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(byteCount);
    const bytesRead = fs.readSync(fd, buffer, 0, byteCount, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function parseIsoTimestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractRecordedUserPrompt(value) {
  const text = String(value ?? "").replace(/\r/g, "").trim();
  if (!text) return "";
  const marker = "[User prompt]";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return text.slice(markerIndex + marker.length).trim();
  }
  return text;
}

function normalizeSessionPromptText(value) {
  return extractRecordedUserPrompt(value)
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .trim();
}

function computeGeminiProjectHash(workdir) {
  if (!workdir) return null;
  return createHash("sha256").update(path.resolve(String(workdir))).digest("hex");
}

function createSessionHistoryEntry(sessionRef, workdirKey, updatedAtMs = 0) {
  return {
    sessionRef: String(sessionRef || "").trim(),
    workdirKey: String(workdirKey || "").trim(),
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    prompts: new Set(),
  };
}

function appendPromptToSessionHistory(entry, promptText) {
  if (!entry) return;
  const normalizedPrompt = normalizeSessionPromptText(promptText);
  if (!normalizedPrompt) return;
  entry.prompts.add(normalizedPrompt);
}

function finalizeSessionHistoryEntries(sessionMap) {
  return [...sessionMap.values()].filter(
    (entry) => entry.sessionRef && entry.workdirKey && entry.prompts.size > 0,
  );
}

function parseGeminiSessionListOutput(output) {
  const sessions = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\.\s+(.+?)\s+\[([0-9a-f-]{36})\]$/i);
    if (!match) continue;
    sessions.push({
      index: Number(match[1]),
      label: match[2].trim(),
      sessionRef: match[3].trim(),
    });
  }
  return sessions;
}

function resolveCliUtilityCommand(cmdName, args = []) {
  if (process.platform === "win32") {
    const resolved = resolveNodeCmdShim(cmdName);
    if (resolved) {
      return { cmd: resolved.cmd, args: [...resolved.args, ...args] };
    }
    return {
      cmd: "cmd.exe",
      args: ["/d", "/s", "/c", cmdName, ...args],
    };
  }
  return {
    cmd: cmdName.replace(/\.cmd$/i, ""),
    args,
  };
}

function listGeminiSessions(workdir) {
  const invocation = resolveCliUtilityCommand("gemini.cmd", ["--list-sessions"]);
  try {
    const output = execFileSync(invocation.cmd, invocation.args, {
      cwd: workdir || undefined,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
    return parseGeminiSessionListOutput(output);
  } catch (err) {
    const fallbackOutput = String(err?.stdout || "");
    return fallbackOutput ? parseGeminiSessionListOutput(fallbackOutput) : [];
  }
}

function selectGeminiResumeValue(sessionRef, sessions = []) {
  const normalizedSessionRef = String(sessionRef ?? "").trim();
  if (!normalizedSessionRef) return null;
  const matched = sessions.find((session) => String(session?.sessionRef || "").trim() === normalizedSessionRef);
  return matched ? String(matched.index) : null;
}

function resolveGeminiResumeSession(sessionRef, sessions = []) {
  const normalizedSessionRef = String(sessionRef ?? "").trim();
  if (!normalizedSessionRef) {
    return { sessionRef: null, resumeValue: null };
  }
  const resumeValue = selectGeminiResumeValue(normalizedSessionRef, sessions);
  if (!resumeValue) {
    return { sessionRef: null, resumeValue: null };
  }
  return {
    sessionRef: normalizedSessionRef,
    resumeValue,
  };
}

function resolveGeminiResumeValue(sessionRef, workdir) {
  if (!sessionRef) return null;
  const sessions = listGeminiSessions(workdir);
  return resolveGeminiResumeSession(sessionRef, sessions).resumeValue;
}

function discoverGeminiSessionRef(workdir, knownSessionRefs = new Set()) {
  const sessions = listGeminiSessions(workdir);
  const discovered = sessions.find((session) => !knownSessionRefs.has(session.sessionRef));
  if (discovered) {
    return discovered.sessionRef;
  }
  return knownSessionRefs.size === 0 ? (sessions[0]?.sessionRef ?? null) : null;
}

function discoverClaudeSessionRef(pid, workdir) {
  if (!pid) return null;
  const sessionMetaPath = path.join(os.homedir(), ".claude", "sessions", `${pid}.json`);
  const sessionMeta = readJsonFileSafe(sessionMetaPath);
  if (!sessionMeta?.sessionId) return null;
  if (
    workdir &&
    sessionMeta.cwd &&
    normalizeComparablePath(sessionMeta.cwd) !== normalizeComparablePath(workdir)
  ) {
    return null;
  }
  return String(sessionMeta.sessionId);
}

function parseSimpleYaml(text) {
  const fields = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const match = rawLine.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2];
  }
  return fields;
}

function listCopilotSessions(workdir) {
  const rootDir = path.join(os.homedir(), ".copilot", "session-state");
  if (!fs.existsSync(rootDir)) return [];
  const expectedWorkdir = normalizeComparablePath(workdir);
  const sessions = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(rootDir, entry.name);
    const workspaceYamlPath = path.join(sessionDir, "workspace.yaml");
    const workspaceYaml = readTextFileSafe(workspaceYamlPath);
    if (!workspaceYaml) continue;
    const fields = parseSimpleYaml(workspaceYaml);
    const cwd = String(fields.cwd || "").trim();
    if (expectedWorkdir && cwd && normalizeComparablePath(cwd) !== expectedWorkdir) {
      continue;
    }
    const lockPids = new Set();
    for (const child of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (!child.isFile()) continue;
      const match = child.name.match(/^inuse\.(\d+)\.lock$/i);
      if (!match) continue;
      lockPids.add(Number(match[1]));
    }
    sessions.push({
      sessionRef: entry.name,
      cwd,
      createdAtMs: parseIsoTimestamp(fields.created_at),
      updatedAtMs: parseIsoTimestamp(fields.updated_at),
      lockPids,
    });
  }
  sessions.sort(
    (left, right) =>
      (right.updatedAtMs || right.createdAtMs || 0) -
      (left.updatedAtMs || left.createdAtMs || 0),
  );
  return sessions;
}

function discoverCopilotSessionRef(pid, workdir, knownSessionRefs = new Set(), spawnedAt = 0) {
  const sessions = listCopilotSessions(workdir);
  let candidates = sessions.filter((session) => session.lockPids.has(Number(pid)));
  if (candidates.length === 0 && spawnedAt > 0 && knownSessionRefs.size === 0) {
    candidates = sessions.filter(
      (session) => Math.max(session.updatedAtMs || 0, session.createdAtMs || 0) >= spawnedAt - 10_000,
    );
  }
  const discovered =
    candidates.find((session) => !knownSessionRefs.has(session.sessionRef)) ??
    candidates[0];
  return discovered?.sessionRef ?? null;
}

function collectRecentFiles(rootDir, acceptFile, limit = 32) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !acceptFile(entry.name, fullPath)) {
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {}
      files.push({ fullPath, mtimeMs });
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files.slice(0, limit).map((entry) => entry.fullPath);
}

function buildClaudeSessionHistoryEntries(limit = 256) {
  const historyPath = path.join(os.homedir(), ".claude", "history.jsonl");
  const historyText = readTextFileSafe(historyPath);
  const sessionMap = new Map();
  if (historyText) {
    for (const rawLine of historyText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const sessionRef = String(record.sessionId || "").trim();
      const workdirKey = normalizeComparablePath(record.project);
      if (!sessionRef || !workdirKey) continue;
      const updatedAtMs = Number(record.timestamp) || parseIsoTimestamp(record.timestamp);
      let entry = sessionMap.get(sessionRef);
      if (!entry) {
        entry = createSessionHistoryEntry(sessionRef, workdirKey, updatedAtMs);
        sessionMap.set(sessionRef, entry);
      } else {
        entry.updatedAtMs = Math.max(entry.updatedAtMs || 0, updatedAtMs || 0);
      }
      appendPromptToSessionHistory(entry, record.display);
    }
  }
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const projectFiles = collectRecentFiles(projectsDir, (name) => /\.jsonl$/i.test(name), limit);
  for (const filePath of projectFiles) {
    const projectText = readTextFileSafe(filePath);
    if (!projectText) continue;
    for (const rawLine of projectText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== "user" || record?.message?.role !== "user") continue;
      const sessionRef = String(record.sessionId || "").trim();
      const workdirKey = normalizeComparablePath(record.cwd);
      if (!sessionRef || !workdirKey) continue;
      const updatedAtMs = parseIsoTimestamp(record.timestamp);
      let entry = sessionMap.get(sessionRef);
      if (!entry) {
        entry = createSessionHistoryEntry(sessionRef, workdirKey, updatedAtMs);
        sessionMap.set(sessionRef, entry);
      } else {
        entry.updatedAtMs = Math.max(entry.updatedAtMs || 0, updatedAtMs || 0);
      }
      appendPromptToSessionHistory(entry, record?.message?.content);
    }
  }
  return finalizeSessionHistoryEntries(sessionMap);
}

function buildCopilotSessionHistoryEntries() {
  const rootDir = path.join(os.homedir(), ".copilot", "session-state");
  if (!fs.existsSync(rootDir)) return [];
  const sessionMap = new Map();
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionRef = String(entry.name || "").trim();
    if (!sessionRef) continue;
    const sessionDir = path.join(rootDir, entry.name);
    const workspaceYaml = readTextFileSafe(path.join(sessionDir, "workspace.yaml"));
    if (!workspaceYaml) continue;
    const workspaceFields = parseSimpleYaml(workspaceYaml);
    const workdirKey = normalizeComparablePath(workspaceFields.cwd);
    if (!workdirKey) continue;
    const eventsText = readTextFileSafe(path.join(sessionDir, "events.jsonl"));
    if (!eventsText) continue;
    const createdAtMs = parseIsoTimestamp(workspaceFields.created_at);
    const updatedAtMs = parseIsoTimestamp(workspaceFields.updated_at);
    const sessionEntry = createSessionHistoryEntry(
      sessionRef,
      workdirKey,
      Math.max(createdAtMs, updatedAtMs),
    );
    for (const rawLine of eventsText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let eventRecord;
      try {
        eventRecord = JSON.parse(line);
      } catch {
        continue;
      }
      if (eventRecord?.type !== "user.message") continue;
      appendPromptToSessionHistory(sessionEntry, eventRecord?.data?.content);
    }
    if (sessionEntry.prompts.size > 0) {
      sessionMap.set(sessionRef, sessionEntry);
    }
  }
  return finalizeSessionHistoryEntries(sessionMap);
}

function buildCodexSessionHistoryEntries(limit = 256) {
  const rootDir = path.join(os.homedir(), ".codex", "sessions");
  const files = collectRecentFiles(rootDir, (name) => /^rollout-.*\.jsonl$/i.test(name), limit);
  if (files.length === 0) return [];
  const sessionMap = new Map();
  for (const filePath of files) {
    const fileText = readTextFileSafe(filePath);
    if (!fileText) continue;
    let sessionRef = "";
    let workdirKey = "";
    let latestTimestampMs = 0;
    for (const rawLine of fileText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      latestTimestampMs = Math.max(latestTimestampMs, parseIsoTimestamp(record.timestamp));
      if (record?.type === "session_meta") {
        sessionRef = String(record?.payload?.id || sessionRef || "").trim();
        workdirKey = normalizeComparablePath(record?.payload?.cwd) || workdirKey;
        continue;
      }
      if (record?.type !== "event_msg" || record?.payload?.type !== "user_message") {
        continue;
      }
      if (!sessionRef || !workdirKey) continue;
      let sessionEntry = sessionMap.get(sessionRef);
      if (!sessionEntry) {
        sessionEntry = createSessionHistoryEntry(sessionRef, workdirKey, latestTimestampMs);
        sessionMap.set(sessionRef, sessionEntry);
      } else {
        sessionEntry.updatedAtMs = Math.max(sessionEntry.updatedAtMs || 0, latestTimestampMs);
      }
      appendPromptToSessionHistory(sessionEntry, record?.payload?.message);
    }
  }
  return finalizeSessionHistoryEntries(sessionMap);
}

function buildGeminiSessionHistoryEntries(limit = 256) {
  const rootDir = path.join(os.homedir(), ".gemini", "tmp");
  const files = collectRecentFiles(
    rootDir,
    (name, fullPath) => /^session-.*\.json$/i.test(name) && /\\chats\\/i.test(fullPath),
    limit,
  );
  if (files.length === 0) return [];
  const sessionMap = new Map();
  for (const filePath of files) {
    const chat = readJsonFileSafe(filePath);
    const sessionRef = String(chat?.sessionId || "").trim();
    const workdirKey = String(chat?.projectHash || "").trim();
    if (!sessionRef || !workdirKey) continue;
    const updatedAtMs = Math.max(parseIsoTimestamp(chat?.lastUpdated), parseIsoTimestamp(chat?.startTime));
    let sessionEntry = sessionMap.get(sessionRef);
    if (!sessionEntry) {
      sessionEntry = createSessionHistoryEntry(sessionRef, workdirKey, updatedAtMs);
      sessionMap.set(sessionRef, sessionEntry);
    } else {
      sessionEntry.updatedAtMs = Math.max(sessionEntry.updatedAtMs || 0, updatedAtMs || 0);
    }
    for (const message of Array.isArray(chat?.messages) ? chat.messages : []) {
      if (message?.type !== "user") continue;
      const parts = Array.isArray(message?.content) ? message.content : [];
      const text = parts
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
      appendPromptToSessionHistory(sessionEntry, text);
    }
  }
  return finalizeSessionHistoryEntries(sessionMap);
}

function listRecentCodexSessions(workdir, limit = 32) {
  const rootDir = path.join(os.homedir(), ".codex", "sessions");
  const expectedWorkdir = normalizeComparablePath(workdir);
  const sessions = [];
  const files = collectRecentFiles(rootDir, (name) => /^rollout-.*\.jsonl$/i.test(name), limit);
  for (const filePath of files) {
    const head = readFileHead(filePath, 4096);
    const sessionRef =
      head.match(/"id":"([^"]+)"/)?.[1] ??
      filePath.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1];
    const cwd = head.match(/"cwd":"([^"]+)"/)?.[1];
    const timestamp =
      head.match(/"payload":\{"id":"[^"]+","timestamp":"([^"]+)"/)?.[1] ??
      head.match(/"timestamp":"([^"]+)"/)?.[1];
    if (!sessionRef || !cwd) continue;
    if (expectedWorkdir && normalizeComparablePath(cwd) !== expectedWorkdir) {
      continue;
    }
    sessions.push({
      sessionRef,
      cwd,
      timestampMs: parseIsoTimestamp(timestamp),
    });
  }
  sessions.sort((left, right) => (right.timestampMs || 0) - (left.timestampMs || 0));
  return sessions;
}

function discoverCodexSessionRef(workdir, knownSessionRefs = new Set(), spawnedAt = 0) {
  const sessions = listRecentCodexSessions(workdir, 48);
  const discovered = sessions.find(
    (session) =>
      !knownSessionRefs.has(session.sessionRef) &&
      (!spawnedAt || session.timestampMs >= spawnedAt - 10_000),
  );
  if (discovered) {
    return discovered.sessionRef;
  }
  return knownSessionRefs.size === 0 ? (sessions[0]?.sessionRef ?? null) : null;
}

function captureSessionDiscoverySnapshot(agentType, workdir) {
  switch (agentType) {
    case "copilot":
      return new Set(listCopilotSessions(workdir).map((session) => session.sessionRef));
    case "gemini":
      return new Set(listGeminiSessions(workdir).map((session) => session.sessionRef));
    case "codex":
      return new Set(listRecentCodexSessions(workdir, 48).map((session) => session.sessionRef));
    default:
      return new Set();
  }
}

function buildInteractiveArgs(agentType, workdir, model = "", settings = {}, options = {}) {
  const args = [];
  const normalizedModel = String(model ?? "").trim();
  const resumeSessionRef = String(options.resumeSessionRef || "").trim();
  const geminiResumeValue = String(options.geminiResumeValue || "").trim();
  if (agentType === "claude" || agentType === "gemini" || agentType === "copilot") {
    if (normalizedModel) {
      args.push("--model", normalizedModel);
    }
  }
  switch (agentType) {
    case "claude":
      if (settings.reasoningEffort) {
        args.push("--effort", settings.reasoningEffort);
      }
      if (settings.planMode === "plan") {
        args.push("--permission-mode", "plan");
      }
      if (resumeSessionRef) {
        args.push("--resume", resumeSessionRef);
      }
      break;
    case "gemini":
      if (settings.planMode === "plan") {
        args.push("--approval-mode", "plan");
      }
      if (geminiResumeValue) {
        args.push("--resume", geminiResumeValue);
      }
      args.push("--screen-reader");
      break;
    case "copilot":
      if (settings.reasoningEffort) {
        args.push("--reasoning-effort", settings.reasoningEffort);
      }
      if (settings.planMode === "plan") {
        args.push("--plan");
      }
      if (resumeSessionRef) {
        args.push(`--resume=${resumeSessionRef}`);
      }
      args.push("--screen-reader");
      if (workdir) {
        args.push("--add-dir", workdir);
      }
      break;
    case "codex":
      if (normalizedModel) {
        args.push("-m", normalizedModel);
      }
      if (settings.reasoningEffort) {
        args.push("-c", `model_reasoning_effort="${settings.reasoningEffort}"`);
      }
      const hasFastOverride =
        settings.fastMode === true ||
        settings.fastMode === false ||
        settings.fastMode === "true" ||
        settings.fastMode === "false" ||
        settings.fastMode === "fast" ||
        settings.fastMode === "flex";
      if (hasFastOverride) {
        const fastMode = settings.fastMode === true || settings.fastMode === "true" || settings.fastMode === "fast";
        args.push("-c", `service_tier="${fastMode ? "fast" : "flex"}"`);
      }
      break;
    default:
      break;
  }
  return args;
}

function resolveInteractiveCommand(agent, workdir, options = {}) {
  const agentType = agent?.type ?? "codex";
  const isWin = process.platform === "win32";
  const requestedResumeSessionRef = String(options.resumeSessionRef || "").trim();
  let resumeSessionRef = requestedResumeSessionRef;
  let geminiResumeValue = "";
  let skippedResumeSessionRef = "";
  if (agentType === "gemini" && requestedResumeSessionRef) {
    const resolvedGeminiResume = resolveGeminiResumeSession(
      requestedResumeSessionRef,
      listGeminiSessions(workdir),
    );
    resumeSessionRef = resolvedGeminiResume.sessionRef ?? "";
    geminiResumeValue = resolvedGeminiResume.resumeValue ?? "";
    if (!resumeSessionRef) {
      skippedResumeSessionRef = requestedResumeSessionRef;
    }
  }
  const interactiveArgs = buildInteractiveArgs(
    agentType,
    workdir,
    agent?.model,
    agent?.settings,
    { resumeSessionRef, geminiResumeValue },
  );
  const isCodexResume = agentType === "codex" && Boolean(resumeSessionRef);
  if (isWin) {
    const cmdMap = { claude: "claude.cmd", gemini: "gemini.cmd", codex: "codex.cmd", copilot: "copilot.cmd" };
    const cmdName = cmdMap[agentType] ?? "codex.cmd";
    if (agentType === "codex") {
      const cmdPath = resolveWindowsCmdPath(cmdName);
      if (cmdPath) {
        console.log(`[pty] using native ${cmdName} for interactive spawn → ${cmdPath}`);
        return {
          cmd: cmdPath,
          args: isCodexResume
            ? ["resume", ...interactiveArgs, resumeSessionRef]
            : interactiveArgs,
          resumeSessionRef: resumeSessionRef || null,
          skippedResumeSessionRef: skippedResumeSessionRef || null,
        };
      }
    }
    const resolved = resolveNodeCmdShim(cmdName);
    if (resolved) {
      return {
        cmd: resolved.cmd,
        args: isCodexResume
          ? [...resolved.args, "resume", ...interactiveArgs, resumeSessionRef]
          : [...resolved.args, ...interactiveArgs],
        resumeSessionRef: resumeSessionRef || null,
        skippedResumeSessionRef: skippedResumeSessionRef || null,
      };
    }
    // fallback: cmd.exe shim (may have PTY issues)
    return {
      cmd: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        [
          cmdName,
          ...(isCodexResume ? ["resume"] : []),
          ...interactiveArgs,
          ...(isCodexResume ? [resumeSessionRef] : []),
        ].map(quoteWindowsShellArg).join(" "),
      ],
      resumeSessionRef: resumeSessionRef || null,
      skippedResumeSessionRef: skippedResumeSessionRef || null,
    };
  }
  switch (agentType) {
    case "claude": return { cmd: "claude", args: interactiveArgs, resumeSessionRef: resumeSessionRef || null, skippedResumeSessionRef: skippedResumeSessionRef || null };
    case "gemini": return { cmd: "gemini", args: interactiveArgs, resumeSessionRef: resumeSessionRef || null, skippedResumeSessionRef: skippedResumeSessionRef || null };
    case "copilot": return { cmd: "copilot", args: interactiveArgs, resumeSessionRef: resumeSessionRef || null, skippedResumeSessionRef: skippedResumeSessionRef || null };
    case "codex":
    default:
      return {
        cmd: "codex",
        args: isCodexResume ? ["resume", ...interactiveArgs, resumeSessionRef] : interactiveArgs,
        resumeSessionRef: resumeSessionRef || null,
        skippedResumeSessionRef: skippedResumeSessionRef || null,
      };
  }
}

// ── Run state ─────────────────────────────────────────────────────────────────

function createRunState(agentName, workspaceId) {
  return {
    agentName,
    workspaceId,
    workdir: null,
    ptyPid: null,
    sessionRef: null,
    sessionDiscoverySnapshot: new Set(),
    /** "idle" | "running" | "manual_running" | "waiting_input" | "quota_wait" | "error" */
    status: "idle",
    lastOutputAt: null,
    /** Timestamp set BEFORE ptyProc.write(); only output after this is captured */
    promptSentAt: null,
    /**
     * Accumulated raw PTY output for the CURRENT run.
     * ANSI stripped in bulk at _completeRun() for cross-chunk accuracy.
     */
    rawBuffer: "",
    /** Whether output for the current turn actually started (echo/thinking/response). */
    turnActivitySeen: false,
    /**
     * Accumulated ANSI-stripped text during IDLE phase (for ready detection).
     * Cleared once readyForPrompt becomes true.
     */
    idleRawBuffer: "",
    completionTimer: null,
    hardTimeoutTimer: null,
    pendingResolve: null,
    pendingReject: null,
    runId: null,
    promptText: "",
    /** Set true once CLI shows its ready-for-input prompt */
    readyForPrompt: false,
    /** Set once Gemini prints an auth-related startup hint; cleared when ready prompt appears */
    authRequired: false,
    /** Timestamp when PTY was spawned */
    spawnedAt: null,
    /** Unsubmitted terminal keystrokes that must block Chat/Discord/Schedule injection */
    manualInputDirty: false,
    manualInputBuffer: "",
    manualTurnPersist: false,
    manualTurnSource: "terminal",
    manualTurnMetadata: null,
    /** ANSI-stripped scrollback snapshot captured at prompt start */
    scrollbackSnapshot: "",
    codexEmptyCompletionRetries: 0,
    codexExactCompletionRetries: 0,
    codexUpdatePromptDismissals: 0,
    _completedByReadyReturn: false,
    streamedText: "",
    configStale: false,
    configWarning: "",
    warningCode: "",
    warningMessage: "",
    approvalRequest: null,
    approvalTimer: null,
    quotaNotice: null,
    lastObserverNoticeKey: "",
  };
}

// ── PtyService ────────────────────────────────────────────────────────────────

export class PtyService {
  /**
   * @param {{ agentRegistry, config, bus?, store? }} deps
   */
  constructor({ agentRegistry, config, bus, store }) {
    this.agentRegistry = agentRegistry;
    this.config = config;
    this.bus = bus ?? null;
    this.store = store ?? null;

    /** PTY key → IPty (persistent interactive process) */
    this._ptys = new Map();
    /** PTY key → RunState */
    this._states = new Map();
    /** PTY key → Set<WebSocket> (Terminal tab clients) */
    this._clients = new Map();
    /** PTY key → scrollback buffer (last N bytes of raw PTY output, for new Terminal clients) */
    this._scrollback = new Map();
    /** provider type → cached local session history entries */
    this._sessionHistoryCache = new Map();
    this._snapshotWriteTimer = null;
    this._driftTimer = setInterval(
      () => this._pollDriftDetection(),
      Math.max(5000, Number(this.config?.driftDetection?.pollMs || 15000)),
    );
  }

  _getSessionProviderType(agentName) {
    return this.agentRegistry.get(agentName)?.type ?? "codex";
  }

  _resolveWorkspaceAgentWorkdir(agentName, workspace) {
    const agent = this.agentRegistry.get(agentName);
    const agentWorkdir = String(agent?.settings?.workdir || "").trim();
    const workspaceWorkdir = String(workspace?.workdir || "").trim();
    return agentWorkdir || workspaceWorkdir || this.config.codexWorkdir;
  }

  _setRuntimeWarning(state, code, message) {
    if (!state) return;
    state.warningCode = String(code || "").trim();
    state.warningMessage = String(message || "").trim();
  }

  _clearRuntimeWarning(state, code = null) {
    if (!state) return;
    if (code && state.warningCode !== code) return;
    state.warningCode = "";
    state.warningMessage = "";
  }

  _refreshDriftWarning(key) {
    const state = this._states.get(key);
    if (!state) return;
    const hasProcess = this._ptys.has(key);
    if (!hasProcess) {
      this._clearRuntimeWarning(state, "drift_stalled");
      return;
    }
    const lastOutputAt = Number(state.lastOutputAt || 0);
    if (!lastOutputAt) return;
    const ageMs = Date.now() - lastOutputAt;
    const runningSilenceMs = Math.max(30000, Number(this.config?.driftDetection?.runningSilenceMs || 120000));
    const readySilenceMs = Math.max(runningSilenceMs, Number(this.config?.driftDetection?.readySilenceMs || 900000));
    const isBlockedState = ["running", "manual_running", "waiting_input", "quota_wait"].includes(state.status) || Boolean(state.manualInputDirty);
    if (isBlockedState && ageMs >= runningSilenceMs) {
      this._setRuntimeWarning(
        state,
        "drift_stalled",
        `PTY の heartbeat が ${Math.floor(ageMs / 1000)}s 止まっています。restart を検討してください。`,
      );
      this._emitObserverNotice(
        state,
        "drift_stalled",
        `${state.agentName} の PTY heartbeat が停滞しています (${Math.floor(ageMs / 1000)}s)。`,
        { ageMs },
      );
      return;
    }
    if (state.readyForPrompt && ageMs >= readySilenceMs) {
      this._setRuntimeWarning(
        state,
        "drift_idle",
        `PTY は生存していますが ${Math.floor(ageMs / 1000)}s 出力がありません。必要なら prewarm/restart を実行してください。`,
      );
      return;
    }
    if (state.warningCode === "drift_stalled" || state.warningCode === "drift_idle") {
      this._clearRuntimeWarning(state);
    }
  }

  _pollDriftDetection() {
    for (const key of this._states.keys()) {
      this._refreshDriftWarning(key);
    }
  }

  _serializeApprovalRequest(request) {
    if (!request) return null;
    return {
      id: request.id,
      status: request.status,
      summary: request.summary,
      excerpt: request.excerpt,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      resolvedAt: request.resolvedAt ?? null,
      decision: request.decision ?? null,
    };
  }

  _serializeRuntimeSnapshot() {
    return {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      entries: [...this._states.entries()].map(([key, state]) => ({
        key,
        agentName: state.agentName,
        workspaceId: state.workspaceId,
        workdir: state.workdir ?? null,
        sessionRef: state.sessionRef ?? null,
        status: state.status,
        hasProcess: this._ptys.has(key),
        readyForPrompt: Boolean(state.readyForPrompt),
        authRequired: Boolean(state.authRequired),
        manualInputDirty: Boolean(state.manualInputDirty),
        lastOutputAt: state.lastOutputAt ?? null,
        runId: state.runId ?? null,
        configStale: Boolean(state.configStale),
        configWarning: String(state.configWarning || ""),
        warningCode: String(state.warningCode || ""),
        warningMessage: String(state.warningMessage || ""),
        approvalRequest: this._serializeApprovalRequest(state.approvalRequest),
        quotaNotice: state.quotaNotice
          ? {
              ...state.quotaNotice,
            }
          : null,
      })),
    };
  }

  _writeRuntimeSnapshotNow() {
    if (!this.config?.runtimeStatePath) return false;
    clearTimeout(this._snapshotWriteTimer);
    this._snapshotWriteTimer = null;
    return writeJsonFileSafe(this.config.runtimeStatePath, this._serializeRuntimeSnapshot());
  }

  _scheduleSnapshotWrite() {
    if (!this.config?.runtimeStatePath) return;
    clearTimeout(this._snapshotWriteTimer);
    this._snapshotWriteTimer = setTimeout(() => {
      this._snapshotWriteTimer = null;
      this._writeRuntimeSnapshotNow();
    }, SNAPSHOT_WRITE_DEBOUNCE_MS);
  }

  restoreRuntimeSnapshot() {
    const snapshot = this.config?.runtimeStatePath
      ? readJsonFileSafe(this.config.runtimeStatePath)
      : null;
    if (!snapshot || !Array.isArray(snapshot.entries)) {
      return { restoredCount: 0, recoveredCount: 0 };
    }

    let restoredCount = 0;
    let recoveredCount = 0;
    for (const entry of snapshot.entries) {
      const agentName = String(entry?.agentName || "").trim();
      const workspaceId = String(entry?.workspaceId || "").trim();
      if (!agentName || !workspaceId) continue;
      if (!this.agentRegistry.get(agentName)) continue;
      const workspace = this.store?.getWorkspace?.(workspaceId);
      if (!workspace) continue;

      const key = this._key(agentName, workspaceId);
      const state = this._ensureState(key, agentName, workspaceId);
      const previousStatus = String(entry?.status || "idle");
      const needsRecovery =
        Boolean(entry?.hasProcess) ||
        ["running", "manual_running", "waiting_input", "quota_wait"].includes(previousStatus);

      state.workdir =
        String(entry?.workdir || "").trim() ||
        this._resolveWorkspaceAgentWorkdir(agentName, workspace);
      state.sessionRef = String(entry?.sessionRef || "").trim() || null;
      state.lastOutputAt = entry?.lastOutputAt ?? null;
      state.status = previousStatus === "error" ? "error" : "idle";
      state.readyForPrompt = false;
      state.authRequired = false;
      state.runId = null;
      state.promptText = "";
      state.promptSentAt = null;
      state.idleRawBuffer = "";
      state.rawBuffer = "";
      state.scrollbackSnapshot = "";
      state.turnActivitySeen = false;
      state.streamedText = "";
      state.codexEmptyCompletionRetries = 0;
      state.codexExactCompletionRetries = 0;
      state.codexUpdatePromptDismissals = 0;
      state.configStale = Boolean(entry?.configStale);
      state.configWarning = String(entry?.configWarning || "");
      state.quotaNotice = entry?.quotaNotice ? { ...entry.quotaNotice } : null;
      this._clearApprovalRequest(key, { emit: false });

      if (needsRecovery) {
        recoveredCount += 1;
        this._setRuntimeWarning(
          state,
          "runtime_recovered",
          `サーバー再起動により直前の ${previousStatus} PTY は失われました。safe idle に戻したので、Terminal を開くか prompt を再送してください。`,
        );
        if (String(entry?.runId || "").trim()) {
          this.store?.recoverRun?.(String(entry.runId), "interrupted");
        }
      } else {
        this._setRuntimeWarning(
          state,
          String(entry?.warningCode || "").trim(),
          String(entry?.warningMessage || "").trim(),
        );
      }

      if (state.sessionRef) {
        this.store?.upsertAgentSession?.({
          agentName,
          workspaceId,
          providerSessionRef: state.sessionRef,
          model: this.agentRegistry.get(agentName)?.model ?? null,
          workdir: state.workdir,
          lastRunState: needsRecovery ? "interrupted" : previousStatus,
        });
      }
      restoredCount += 1;
    }

    this._scheduleSnapshotWrite();
    return { restoredCount, recoveredCount };
  }

  _emitObserverNotice(state, kind, message, extra = {}) {
    if (!state) return;
    const normalizedKind = String(kind || "").trim();
    const normalizedMessage = String(message || "").trim();
    if (!normalizedKind || !normalizedMessage) return;
    const noticeKey = `${normalizedKind}:${normalizedMessage}`;
    if (state.lastObserverNoticeKey === noticeKey) return;
    state.lastObserverNoticeKey = noticeKey;
    this._emit("observer.notice", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      status: state.status,
      kind: normalizedKind,
      message: normalizedMessage,
      ...extra,
    });
  }

  _clearApprovalRequest(key, { emit = false, decision = null } = {}) {
    const state = this._states.get(key);
    if (!state?.approvalRequest) return null;
    clearTimeout(state.approvalTimer);
    state.approvalTimer = null;
    const previous = state.approvalRequest;
    state.approvalRequest = null;
    if (emit) {
      this._emit("approval.resolved", {
        agentName: state.agentName,
        workspaceId: state.workspaceId,
        approval: {
          ...this._serializeApprovalRequest(previous),
          decision: decision ?? previous.decision ?? null,
        },
      });
    }
    this._scheduleSnapshotWrite();
    return previous;
  }

  _expireApprovalRequest(key, approvalId) {
    const state = this._states.get(key);
    if (!state?.approvalRequest || state.approvalRequest.id !== approvalId) return;
    clearTimeout(state.approvalTimer);
    state.approvalTimer = null;
    state.approvalRequest = {
      ...state.approvalRequest,
      status: "expired",
      resolvedAt: new Date().toISOString(),
    };
    this._emit("approval.expired", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      approval: this._serializeApprovalRequest(state.approvalRequest),
    });
    this._emitObserverNotice(state, "approval_expired", `${state.agentName} の承認待ちが期限切れになりました。`);
    this._scheduleSnapshotWrite();
  }

  _createApprovalRequest(key, text) {
    const state = this._states.get(key);
    if (!state) return null;
    const agentType = this.agentRegistry.get(state.agentName)?.type ?? "codex";
    const h = getHeuristics(agentType);
    const summary = summarizeRuntimeNotice(text, h.approvalRe || h.waitingInputRe);
    if (!summary) return null;
    if (
      state.approvalRequest?.status === "pending" &&
      String(state.approvalRequest.summary || "") === summary
    ) {
      return state.approvalRequest;
    }
    clearTimeout(state.approvalTimer);
    const approval = {
      id: randomUUID(),
      status: "pending",
      summary,
      excerpt: summarizeRuntimeNotice(text, h.approvalRe || h.waitingInputRe, 320),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
    };
    state.approvalRequest = approval;
    state.approvalTimer = setTimeout(() => this._expireApprovalRequest(key, approval.id), APPROVAL_TIMEOUT_MS);
    this._emit("approval.requested", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      approval: this._serializeApprovalRequest(approval),
    });
    this._emitObserverNotice(state, "approval_requested", `${state.agentName} が承認待ちです: ${summary}`);
    this._scheduleSnapshotWrite();
    return approval;
  }

  _setQuotaWaitState(key, text) {
    const state = this._states.get(key);
    if (!state) return;
    const agentType = this.agentRegistry.get(state.agentName)?.type ?? "codex";
    const h = getHeuristics(agentType);
    const summary = summarizeRuntimeNotice(text, h.quotaRe);
    if (!summary) return;
    state.status = "quota_wait";
    state.readyForPrompt = false;
    state.authRequired = false;
    state.quotaNotice = {
      summary,
      detectedAt: state.quotaNotice?.detectedAt ?? new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this._setRuntimeWarning(
      state,
      "quota_wait",
      `利用制限を検知しました。復帰したら Terminal を開くか prompt を再送してください。`,
    );
    this._emitObserverNotice(state, "quota_wait", `${state.agentName} で利用制限を検知しました: ${summary}`);
    this._scheduleSnapshotWrite();
  }

  _makeSessionWorkdirKey(agentType, workdir) {
    if (!workdir) return null;
    if (agentType === "gemini") {
      return computeGeminiProjectHash(workdir);
    }
    return normalizeComparablePath(workdir);
  }

  _loadProviderSessionHistory(agentType, { forceRefresh = false } = {}) {
    if (!forceRefresh && this._sessionHistoryCache.has(agentType)) {
      return this._sessionHistoryCache.get(agentType);
    }
    let entries = [];
    switch (agentType) {
      case "claude":
        entries = buildClaudeSessionHistoryEntries();
        break;
      case "copilot":
        entries = buildCopilotSessionHistoryEntries();
        break;
      case "codex":
        entries = buildCodexSessionHistoryEntries();
        break;
      case "gemini":
        entries = buildGeminiSessionHistoryEntries();
        break;
      default:
        entries = [];
        break;
    }
    this._sessionHistoryCache.set(agentType, entries);
    return entries;
  }

  _sessionRefExistsInHistory(agentType, sessionRef, workdir, historyEntries = null) {
    const normalizedSessionRef = String(sessionRef || "").trim();
    const workdirKey = this._makeSessionWorkdirKey(agentType, workdir);
    if (!normalizedSessionRef || !workdirKey) return false;
    const entries = historyEntries ?? this._loadProviderSessionHistory(agentType);
    return entries.some(
      (entry) => entry.sessionRef === normalizedSessionRef && entry.workdirKey === workdirKey,
    );
  }

  _buildWorkspacePromptFingerprint(agentName, workspaceId) {
    if (!this.store?.listMessages) {
      return { prompts: [], latestPrompt: "", promptCount: 0 };
    }
    const messages = this.store.listMessages(agentName, workspaceId, 200);
    const prompts = [];
    const seen = new Set();
    for (const message of messages) {
      if (message?.role !== "user") continue;
      const normalizedPrompt = normalizeSessionPromptText(message?.content);
      if (!normalizedPrompt || seen.has(normalizedPrompt)) continue;
      seen.add(normalizedPrompt);
      prompts.push(normalizedPrompt);
    }
    return {
      prompts,
      latestPrompt: prompts[prompts.length - 1] ?? "",
      promptCount: prompts.length,
    };
  }

  _findBestSessionHistoryMatch(agentType, workdir, promptFingerprint, assignedSessionRefs, historyEntries = null) {
    const workdirKey = this._makeSessionWorkdirKey(agentType, workdir);
    if (!workdirKey || !promptFingerprint?.prompts?.length) return null;
    const entries = historyEntries ?? this._loadProviderSessionHistory(agentType);
    let bestMatch = null;
    for (const entry of entries) {
      if (entry.workdirKey !== workdirKey) continue;
      if (assignedSessionRefs?.has(entry.sessionRef)) continue;
      let overlapCount = 0;
      for (const promptText of promptFingerprint.prompts) {
        if (entry.prompts.has(promptText)) {
          overlapCount += 1;
        }
      }
      if (overlapCount === 0) continue;
      let score = overlapCount * 1_000;
      if (promptFingerprint.latestPrompt && entry.prompts.has(promptFingerprint.latestPrompt)) {
        score += 100;
      }
      score += Math.min(entry.prompts.size, 50);
      score += (entry.updatedAtMs || 0) / 1e15;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          sessionRef: entry.sessionRef,
          updatedAtMs: entry.updatedAtMs || 0,
          overlapCount,
          score,
        };
      }
    }
    return bestMatch;
  }

  backfillStoredSessionRefs({ forceRefresh = false } = {}) {
    if (
      !this.store?.listWorkspaces ||
      !this.store?.listWorkspaceAgents ||
      !this.store?.getAgentSession ||
      !this.store?.upsertAgentSession
    ) {
      return { candidateCount: 0, updatedCount: 0, matched: [] };
    }

    const supportedProviders = new Set(["claude", "gemini", "copilot", "codex"]);
    const assignedSessionRefs = new Map();
    const candidates = [];
    const workspaces = this.store.listWorkspaces();

    for (const workspace of workspaces) {
      const workspaceAgents = this.store.listWorkspaceAgents(workspace.id);
      for (const workspaceAgent of workspaceAgents) {
        const agentName = String(workspaceAgent?.agentName || "").trim();
        if (!agentName) continue;
        const agentType = this._getSessionProviderType(agentName);
        if (!supportedProviders.has(agentType)) continue;
        const historyEntries = this._loadProviderSessionHistory(agentType, { forceRefresh });
        const workdir = this._resolveWorkspaceAgentWorkdir(agentName, workspace);
        const currentSession = this.store.getAgentSession(agentName, workspace.id);
        const currentSessionRef = String(currentSession?.providerSessionRef || "").trim();
        if (!assignedSessionRefs.has(agentType)) {
          assignedSessionRefs.set(agentType, new Set());
        }
        if (currentSessionRef && this._sessionRefExistsInHistory(agentType, currentSessionRef, workdir, historyEntries)) {
          assignedSessionRefs.get(agentType).add(currentSessionRef);
        }
        const promptFingerprint = this._buildWorkspacePromptFingerprint(agentName, workspace.id);
        if (promptFingerprint.promptCount === 0) continue;
        candidates.push({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          agentName,
          agentType,
          workdir,
          currentSession,
          currentSessionRef,
          promptFingerprint,
          historyEntries,
        });
      }
    }

    candidates.sort(
      (left, right) =>
        right.promptFingerprint.promptCount - left.promptFingerprint.promptCount ||
        String(left.workspaceId).localeCompare(String(right.workspaceId)) ||
        String(left.agentName).localeCompare(String(right.agentName)),
    );

    const matched = [];
    let updatedCount = 0;

    for (const candidate of candidates) {
      if (candidate.currentSessionRef) {
        continue;
      }

      const providerAssignedRefs = assignedSessionRefs.get(candidate.agentType) ?? new Set();
      const match = this._findBestSessionHistoryMatch(
        candidate.agentType,
        candidate.workdir,
        candidate.promptFingerprint,
        providerAssignedRefs,
        candidate.historyEntries,
      );
      if (!match) continue;

      const agent = this.agentRegistry.get(candidate.agentName);
      this.store.upsertAgentSession({
        agentName: candidate.agentName,
        workspaceId: candidate.workspaceId,
        providerSessionRef: match.sessionRef,
        model: candidate.currentSession?.model ?? agent?.model ?? null,
        workdir: candidate.workdir ?? candidate.currentSession?.workdir ?? null,
        lastRunState: candidate.currentSession?.lastRunState ?? "idle",
      });
      providerAssignedRefs.add(match.sessionRef);
      updatedCount += 1;
      matched.push({
        workspaceId: candidate.workspaceId,
        workspaceName: candidate.workspaceName,
        agentName: candidate.agentName,
        agentType: candidate.agentType,
        sessionRef: match.sessionRef,
        promptMatches: match.overlapCount,
      });
      console.log(
        `[pty] backfilled ${candidate.agentType} session for ${candidate.workspaceId}:${candidate.agentName} → ${match.sessionRef} (${match.overlapCount} prompt matches)`,
      );
    }

    return { candidateCount: candidates.length, updatedCount, matched };
  }

  // ── WebSocket attachment ───────────────────────────────────────────────────

  /**
   * Attach a WebSocket server to the HTTP server.
   * URL format: /api/pty?agent=<name>&workspace=<workspaceId>
   */
  attach(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: "/api/pty" });

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url || "/", "http://localhost");
      const agentName = url.searchParams.get("agent") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "";
      const workdir = url.searchParams.get("workdir") ?? "";

      if (!agentName || !workspaceId) {
        ws.close(1008, !agentName ? "agent parameter required" : "workspace parameter required");
        return;
      }

      console.log(`[pty] terminal client connected agent="${agentName}" ws="${workspaceId}"`);
      this._handleTerminalClient(ws, agentName, workspaceId, workdir || undefined);
    });

    console.log("[pty] WebSocket server attached at /api/pty");
  }

  // ── Core API ──────────────────────────────────────────────────────────────

  /**
   * Ensure a persistent interactive PTY is running for this agent×workspace.
   * Returns the existing PTY if already running, else spawns a new one.
   */
  ensureAgentPty(agentName, workspaceId, options = {}) {
    const key = this._key(agentName, workspaceId);
    if (this._ptys.has(key)) return this._ptys.get(key);
    return this._spawnPty(agentName, workspaceId, options);
  }

  async prewarmAgent({ agentName, workspaceId, workdir, waitForReadyMs = 4000 } = {}) {
    const key = this._key(agentName, workspaceId);
    const ptyProc = this.ensureAgentPty(agentName, workspaceId, { workdir });
    if (!ptyProc) {
      throw new Error(`PTY を起動できません: ${agentName}`);
    }
    if (waitForReadyMs > 0) {
      await this._waitForPrewarmState(key, waitForReadyMs);
    }
    return this.getAgentTerminalState(agentName, workspaceId);
  }

  /**
   * Send a prompt to the agent's interactive PTY stdin.
   * The SAME PTY that the Terminal tab displays.
   * Resolves when the run completes (silence heuristic or ready-prompt return).
   *
   * @param {object} opts
   * @param {string} opts.agentName
   * @param {string} opts.workspaceId
   * @param {string} opts.prompt
   * @param {string} [opts.context]    — recent workspace chat context block
   * @param {string} [opts.runId]
   * @param {string} [opts.workdir]
   * @returns {Promise<{ text: string, finalStatus: string }>}
   */
  async sendPrompt({ agentName, workspaceId, prompt, context = null, runId = null, workdir }) {
    const { key, ptyProc, state } = await this.assertPromptReady({ agentName, workspaceId, workdir });

    const agent = this.agentRegistry.get(agentName);
    const input = this._buildInput(agent?.type ?? "codex", prompt, context);

    // Setup run state
    state.rawBuffer = "";
    state.status = "running";
    state.lastOutputAt = Date.now();
    state.runId = runId;
    state.promptText = prompt;
    state.readyForPrompt = false;
    state.authRequired = false;
    state.turnActivitySeen = false;
    state.scrollbackSnapshot = stripAnsi(this._scrollback.get(key) ?? "");
    state.codexEmptyCompletionRetries = 0;
    state.codexExactCompletionRetries = 0;
    state._completedByReadyReturn = false;
    state.streamedText = "";
    state.quotaNotice = null;
    state.lastObserverNoticeKey = "";
    this._clearApprovalRequest(key, { emit: false });
    this._clearRuntimeWarning(state, "runtime_recovered");
    this._clearRuntimeWarning(state, "quota_wait");
    this._resetManualInputState(state);
    this._scheduleSnapshotWrite();

    const resultPromise = new Promise((resolve, reject) => {
      state.pendingResolve = resolve;
      state.pendingReject = reject;
    });

    // Register resolvers and timers BEFORE writing so fast output cannot outrun the run state.
    state.promptSentAt = Date.now();
    this._scheduleCompletion(key);
    this._scheduleHardTimeout(key);
    await this._writePromptToPty(ptyProc, input, agent?.type ?? "codex", { originalPrompt: prompt });

    return resultPromise;
  }

  async assertPromptReady({ agentName, workspaceId, workdir }) {
    const key = this._key(agentName, workspaceId);
    const ptyProc = this.ensureAgentPty(agentName, workspaceId, { workdir });
    if (!ptyProc) {
      throw new Error(`PTY を起動できません: ${agentName}`);
    }
    const state = this._ensureState(key, agentName, workspaceId);
    if (state.status === "manual_running") {
      throw new Error("Terminalで実行中です。完了後に送信してください。");
    }
    if (state.status === "running") {
      throw new Error(`${agentName} は実行中です。停止してから送信してください。`);
    }
    if (state.status === "waiting_input") {
      throw new Error(`${agentName} は入力待ちです。Terminal で応答してください。`);
    }
    if (state.status === "quota_wait") {
      throw new Error(`${agentName} は利用制限待ちです。復帰通知後に再送してください。`);
    }
    if (state.manualInputDirty) {
      throw this._buildManualInputBusyError();
    }
    if (!state.readyForPrompt) {
      await this._waitForReadyPrompt(key);
    }
    if (state.manualInputDirty) {
      throw this._buildManualInputBusyError();
    }
    return { key, ptyProc, state };
  }

  // ── PTY control ────────────────────────────────────────────────────────────

  /**
   * Kill the PTY for one agent×workspace pair.
   */
  killAgent(agentName, workspaceId) {
    if (workspaceId) {
      return this._killKey(this._key(agentName, workspaceId));
    }
    let killed = false;
    for (const key of [...this._ptys.keys()]) {
      if (key.endsWith(`:${agentName}`)) {
        this._killKey(key);
        killed = true;
      }
    }
    return killed;
  }

  killWorkspace(workspaceId) {
    const prefix = `${workspaceId}:`;
    let killed = false;
    for (const key of [...this._ptys.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this._killKey(key);
      killed = true;
    }
    for (const key of [...this._states.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this._clearTimers(key);
      const clients = this._clients.get(key);
      if (clients) {
        for (const ws of clients) {
          try { ws.close(1001, "Workspace deleted"); } catch {}
        }
      }
      this._clients.delete(key);
      this._states.delete(key);
      this._scrollback.delete(key);
      killed = true;
    }
    if (killed) {
      this._scheduleSnapshotWrite();
    }
    return killed;
  }

  /** Kill all PTYs (server shutdown). */
  stopAll() {
    clearInterval(this._driftTimer);
    for (const key of [...this._ptys.keys()]) {
      this._syncSessionRefNow(key, "shutdown");
    }
    this._writeRuntimeSnapshotNow();
    for (const key of [...this._ptys.keys()]) {
      this._killKey(key);
    }
  }

  /** Returns terminal state for an agent×workspace. */
  getAgentTerminalState(agentName, workspaceId) {
    const key = this._key(agentName, workspaceId);
    this._refreshDriftWarning(key);
    const state = this._states.get(key);
    if (!state) return { status: "idle", hasProcess: false };
    const hasProcess = this._ptys.has(key);
    return {
      status: state.status === "manual_running" || state.manualInputDirty ? "running" : state.status,
      hasProcess,
      lastOutputAt: state.lastOutputAt,
      runId: state.runId,
      readyForPrompt: state.readyForPrompt,
      manualInputDirty: Boolean(state.manualInputDirty),
      configStale: hasProcess ? Boolean(state.configStale) : false,
      configWarning: hasProcess ? String(state.configWarning || "") : "",
      warningCode: String(state.warningCode || ""),
      warningMessage: String(state.warningMessage || ""),
      approvalRequest: this._serializeApprovalRequest(state.approvalRequest),
      quotaNotice: state.quotaNotice ? { ...state.quotaNotice } : null,
    };
  }

  listWorkspaceTerminalStates(workspaceId) {
    const normalizedWorkspaceId = String(workspaceId ?? "").trim();
    const states = [];
    for (const [key, state] of this._states.entries()) {
      if (!key.startsWith(`${normalizedWorkspaceId}:`)) continue;
      states.push({
        agentName: state.agentName,
        workspaceId: state.workspaceId,
        ...this.getAgentTerminalState(state.agentName, state.workspaceId),
      });
    }
    return states;
  }

  annotateWorkspaceRuntime(workspaceId, code, message) {
    const normalizedWorkspaceId = String(workspaceId ?? "").trim();
    for (const [key, state] of this._states.entries()) {
      if (!key.startsWith(`${normalizedWorkspaceId}:`)) continue;
      this._setRuntimeWarning(state, code, message);
      this._emitObserverNotice(state, code, message);
    }
    this._scheduleSnapshotWrite();
  }

  validateStoredSessionBinding(agentName, workspaceId) {
    const session = this.store?.getAgentSession?.(agentName, workspaceId);
    if (!session?.providerSessionRef) {
      return { valid: false, reasons: ["provider session ref がありません。"] };
    }
    const workspace = this.store?.getWorkspace?.(workspaceId);
    const workdir =
      String(session.workdir || "").trim() ||
      String(workspace?.workdir || "").trim() ||
      String(this.config?.codexWorkdir || "").trim();
    const agentType = this._getSessionProviderType(agentName);
    const historyEntries = this._loadProviderSessionHistory(agentType, { forceRefresh: true });
    const valid = this._sessionRefExistsInHistory(agentType, session.providerSessionRef, workdir, historyEntries);
    return {
      valid,
      reasons: valid ? [] : ["provider local history に一致する saved session ref がありません。"],
    };
  }

  getRestartEligibility(agentName, workspaceId, { force = false } = {}) {
    const state = this._ensureState(this._key(agentName, workspaceId), agentName, workspaceId);
    const blockedReasons = [];
    if (!force) {
      if (state.manualInputDirty) blockedReasons.push("未送信の Terminal 入力があります。");
      if (state.approvalRequest?.status === "pending") blockedReasons.push("承認待ちです。");
      if (state.status === "running" || state.status === "manual_running") blockedReasons.push("実行中です。");
      if (state.status === "waiting_input") blockedReasons.push("入力待ちです。");
      if (state.status === "quota_wait") blockedReasons.push("利用制限待ちです。");
    }
    return {
      allowed: blockedReasons.length === 0,
      blockedReasons,
      state: this.getAgentTerminalState(agentName, workspaceId),
    };
  }

  async restartAgent(agentName, workspaceId, { workdir, waitForReadyMs = 4000, force = false } = {}) {
    const eligibility = this.getRestartEligibility(agentName, workspaceId, { force });
    if (!eligibility.allowed) {
      throw new Error(eligibility.blockedReasons.join(" / "));
    }
    const key = this._key(agentName, workspaceId);
    this._syncSessionRefNow(key, force ? "force-restart" : "restart");
    this._killKey(key);
    if (force) {
      const state = this._ensureState(key, agentName, workspaceId);
      this._setRuntimeWarning(state, "force_restart", "force restart を実行しました。直前の PTY 文脈が失われている可能性があります。");
    }
    return this.prewarmAgent({ agentName, workspaceId, workdir, waitForReadyMs });
  }

  getAgentTerminalOutput(agentName, workspaceId, { lineLimit = 50 } = {}) {
    const key = this._key(agentName, workspaceId);
    const state = this._states.get(key);
    const terminalState = this.getAgentTerminalState(agentName, workspaceId);
    const rawText = this._scrollback.get(key) ?? state?.rawBuffer ?? "";
    const cleanText = stripAnsi(String(rawText || "")).replace(/\r/g, "").trimEnd();
    const normalizedLimit =
      Number.isFinite(lineLimit) && lineLimit > 0
        ? Math.max(1, Math.floor(lineLimit))
        : 50;
    const allLines = cleanText ? cleanText.split("\n") : [];
    const truncated = allLines.length > normalizedLimit;
    const visibleLines = truncated ? allLines.slice(-normalizedLimit) : allLines;
    return {
      ...terminalState,
      text: visibleLines.join("\n").trim(),
      totalLineCount: allLines.length,
      lineLimit: normalizedLimit,
      truncated,
    };
  }

  sendTerminalInput(agentName, workspaceId, data, options = {}) {
    if (!workspaceId) {
      return { ok: false, reason: "workspace_required" };
    }
    const key = this._key(agentName, workspaceId);
    let ptyProc = this._ptys.get(key);
    if (!ptyProc) {
      return {
        ok: false,
        reason: "not_started",
        state: this.getAgentTerminalState(agentName, workspaceId),
      };
    }
    ptyProc = this._forwardTerminalInput({
      key,
      agentName,
      workspaceId,
      workdir: options.workdir,
      data,
      ptyProc,
    }) ?? ptyProc;
    return {
      ok: true,
      ptyProc,
      state: this.getAgentTerminalState(agentName, workspaceId),
    };
  }

  async sendRemoteCommand({
    agentName,
    workspaceId,
    command,
    workdir,
    source = "ui",
    metadata = null,
  }) {
    if (!workspaceId) {
      throw new Error("workspaceId is required");
    }
    const normalizedCommand = String(command ?? "").trim();
    if (!normalizedCommand.startsWith("/")) {
      throw new Error("slash command must start with /");
    }
    if (/[\r\n]/u.test(normalizedCommand)) {
      throw new Error("slash command must be a single line");
    }
    const { key, ptyProc } = await this.assertPromptReady({
      agentName,
      workspaceId,
      workdir,
    });
    const agentType = this.agentRegistry.get(agentName)?.type ?? "codex";
    let nextPtyProc =
      this._forwardTerminalInput({
        key,
        agentName,
        workspaceId,
        workdir,
        data: normalizedCommand,
        ptyProc,
        source,
        metadata,
      }) ?? ptyProc;
    await new Promise((resolve) => setTimeout(resolve, getPromptSubmitDelay(agentType, normalizedCommand)));
    nextPtyProc =
      this._forwardTerminalInput({
        key,
        agentName,
        workspaceId,
        workdir,
        data: "\r",
        ptyProc: nextPtyProc,
        source,
        metadata,
      }) ?? nextPtyProc;
    return {
      ok: true,
      ptyProc: nextPtyProc,
      state: this.getAgentTerminalState(agentName, workspaceId),
      text: "",
      finalStatus: "running",
    };
  }

  getAgentApprovalState(agentName, workspaceId) {
    const key = this._key(agentName, workspaceId);
    const state = this._states.get(key);
    return this._serializeApprovalRequest(state?.approvalRequest);
  }

  respondToApproval(agentName, workspaceId, decision, options = {}) {
    const normalizedDecision = String(decision || "").trim().toLowerCase();
    if (!["approve", "deny"].includes(normalizedDecision)) {
      return { ok: false, reason: "invalid_decision" };
    }
    const key = this._key(agentName, workspaceId);
    const state = this._states.get(key);
    const ptyProc = this._ptys.get(key);
    if (!state?.approvalRequest || state.approvalRequest.status !== "pending") {
      return {
        ok: false,
        reason: "approval_not_pending",
        state: this.getAgentTerminalState(agentName, workspaceId),
      };
    }
    if (!ptyProc) {
      return {
        ok: false,
        reason: "not_started",
        state: this.getAgentTerminalState(agentName, workspaceId),
      };
    }
    const approval = {
      ...state.approvalRequest,
      status: "resolved",
      decision: normalizedDecision,
      resolvedAt: new Date().toISOString(),
    };
    clearTimeout(state.approvalTimer);
    state.approvalTimer = null;
    state.approvalRequest = approval;
    this._emit("approval.resolved", {
      agentName,
      workspaceId,
      approval: this._serializeApprovalRequest(approval),
    });
    this._emitObserverNotice(
      state,
      normalizedDecision === "approve" ? "approval_approved" : "approval_denied",
      `${agentName} の承認待ちに ${normalizedDecision === "approve" ? "approve" : "deny"} を送りました。`,
    );
    this._scheduleSnapshotWrite();
    const nextPtyProc = this._forwardTerminalInput({
      key,
      agentName,
      workspaceId,
      workdir: options.workdir,
      data: normalizedDecision === "approve" ? "y\r" : "n\r",
      ptyProc,
    });
    return {
      ok: true,
      ptyProc: nextPtyProc,
      approval: this.getAgentApprovalState(agentName, workspaceId),
      state: this.getAgentTerminalState(agentName, workspaceId),
    };
  }

  markAgentConfigUpdated(agentName) {
    const normalizedAgentName = String(agentName ?? "").trim();
    if (!normalizedAgentName) {
      return { count: 0, workspaceIds: [] };
    }
    const warning =
      "エージェントの設定が変更されました。必要に応じてセッションを再起動してください。";
    const workspaceIds = [];
    for (const [key, state] of this._states.entries()) {
      if (state.agentName !== normalizedAgentName) continue;
      if (!this._ptys.has(key)) continue;
      state.configStale = true;
      state.configWarning = warning;
      this._emitObserverNotice(state, "config_stale", `${normalizedAgentName} の設定変更が未反映です。必要なら再起動してください。`);
      workspaceIds.push(state.workspaceId);
    }
    if (workspaceIds.length > 0) {
      this._scheduleSnapshotWrite();
    }
    return { count: workspaceIds.length, workspaceIds };
  }

  isRunning(agentName, workspaceId = null) {
    if (!workspaceId) return false;
    const key = this._key(agentName, workspaceId);
    const state = this._states.get(key);
    return ["running", "manual_running"].includes(state?.status) || Boolean(state?.manualInputDirty);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _key(agentName, workspaceId) {
    return `${workspaceId}:${agentName}`;
  }

  _ensureState(key, agentName, workspaceId) {
    if (!this._states.has(key)) {
      this._states.set(key, createRunState(agentName, workspaceId));
    }
    return this._states.get(key);
  }

  _persistSessionRef(key, sessionRef, reason = "unknown") {
    const state = this._states.get(key);
    if (!state || !sessionRef) return null;
    const normalizedSessionRef = String(sessionRef).trim();
    if (!normalizedSessionRef) return null;
    const agent = this.agentRegistry.get(state.agentName);
    const wasKnown = state.sessionRef === normalizedSessionRef;
    state.sessionRef = normalizedSessionRef;
    if (!(state.sessionDiscoverySnapshot instanceof Set)) {
      state.sessionDiscoverySnapshot = new Set();
    }
    state.sessionDiscoverySnapshot.add(normalizedSessionRef);
    this.store?.upsertAgentSession?.({
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      providerSessionRef: normalizedSessionRef,
      model: agent?.model || null,
      workdir: state.workdir || null,
      lastRunState: state.status,
    });
    if (!wasKnown) {
      console.log(`[pty] session ref synced for ${key} (${reason}) → ${normalizedSessionRef}`);
    }
    this._scheduleSnapshotWrite();
    return normalizedSessionRef;
  }

  _syncSessionRefNow(key, reason = "unknown") {
    const state = this._states.get(key);
    if (!state) return null;
    const agent = this.agentRegistry.get(state.agentName);
    if (!agent) return state.sessionRef;
    const knownSessionRefs =
      state.sessionDiscoverySnapshot instanceof Set
        ? state.sessionDiscoverySnapshot
        : new Set();
    let discoveredSessionRef = state.sessionRef;
    switch (agent.type) {
      case "claude":
        if (!discoveredSessionRef) {
          discoveredSessionRef = discoverClaudeSessionRef(state.ptyPid, state.workdir) || discoveredSessionRef;
        }
        break;
      case "copilot":
        discoveredSessionRef =
          discoverCopilotSessionRef(
            state.ptyPid,
            state.workdir,
            knownSessionRefs,
            state.spawnedAt || 0,
          ) || discoveredSessionRef;
        break;
      case "gemini":
        if (!discoveredSessionRef) {
          discoveredSessionRef = discoverGeminiSessionRef(state.workdir, knownSessionRefs);
        }
        break;
      case "codex":
        if (!discoveredSessionRef) {
          discoveredSessionRef = discoverCodexSessionRef(
            state.workdir,
            knownSessionRefs,
            state.spawnedAt || 0,
          );
        }
        break;
      default:
        break;
    }
    return this._persistSessionRef(key, discoveredSessionRef, reason);
  }

  _queueSessionRefSync(key, reason = "unknown") {
    setTimeout(() => {
      try {
        this._syncSessionRefNow(key, reason);
      } catch (err) {
        console.warn(`[pty] session ref sync failed for ${key} (${reason}): ${err.message}`);
      }
    }, 0);
  }

  _syncSessionRefAfterTurn(key, reason = "unknown") {
    const state = this._states.get(key);
    if (!state?.sessionRef) {
      try {
        this._syncSessionRefNow(key, reason);
        return;
      } catch (err) {
        console.warn(`[pty] immediate session ref sync failed for ${key} (${reason}): ${err.message}`);
      }
    }
    this._queueSessionRefSync(key, reason);
  }

  _spawnPty(agentName, workspaceId, options = {}) {
    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      console.warn(`[pty] agent "${agentName}" not found`);
      return null;
    }

    const workdir =
      options.workdir ||
      agent.settings?.workdir ||
      this.config.codexWorkdir;
    if (agent.type === "gemini") {
      ensureGeminiOauthSelection();
    }
    const persistedSession = this.store?.getAgentSession?.(agentName, workspaceId) ?? null;
    const requestedResumeSessionRef = String(persistedSession?.providerSessionRef || "").trim() || null;
    const { cmd, args, resumeSessionRef, skippedResumeSessionRef } = resolveInteractiveCommand(agent, workdir, {
      resumeSessionRef: requestedResumeSessionRef,
    });
    if (skippedResumeSessionRef && agent.type === "gemini") {
      console.log(`[pty] skipped stale saved Gemini session for ${workspaceId}:${agentName} → ${skippedResumeSessionRef}`);
      this.store?.upsertAgentSession?.({
        agentName,
        workspaceId,
        providerSessionRef: null,
        model: agent?.model || null,
        workdir: workdir || null,
        lastRunState: "idle",
      });
    }
    const sessionDiscoverySnapshot =
      !resumeSessionRef && ["copilot", "gemini", "codex"].includes(agent.type)
        ? captureSessionDiscoverySnapshot(agent.type, workdir)
        : new Set(resumeSessionRef ? [resumeSessionRef] : []);
    const key = this._key(agentName, workspaceId);

    let ptyProc;
    try {
      ptyProc = pty.spawn(cmd, args, {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd: workdir,
        env: buildPtySpawnEnv(agent.type),
      });
    } catch (err) {
      console.error(`[pty] spawn failed for "${agentName}":`, err.message);
      return null;
    }

    console.log(`[pty] spawned ${cmd} for "${agentName}" ws="${workspaceId}" pid=${ptyProc.pid}`);
    if (resumeSessionRef) {
      console.log(`[pty] resuming ${key} with saved session ${resumeSessionRef}`);
    }

    this._ptys.set(key, ptyProc);
    if (!this._clients.has(key)) this._clients.set(key, new Set());

    const state = this._ensureState(key, agentName, workspaceId);
    state.workdir = workdir;
    state.ptyPid = ptyProc.pid ?? null;
    state.sessionRef = resumeSessionRef;
    state.sessionDiscoverySnapshot = sessionDiscoverySnapshot;
    state.spawnedAt = Date.now();
    state.readyForPrompt = false;
    state.authRequired = false;
    state.idleRawBuffer = "";
    state.promptText = "";
    state.configStale = false;
    state.configWarning = "";
    state.quotaNotice = null;
    state.codexUpdatePromptDismissals = 0;
    this._clearRuntimeWarning(state);
    this._clearApprovalRequest(key, { emit: false });
    this._scheduleSnapshotWrite();

    ptyProc.onData((data) => this._handleOutput(key, data));
    this._queueSessionRefSync(key, "spawn");

    ptyProc.onExit(({ exitCode }) => {
      console.log(`[pty] "${agentName}" ws="${workspaceId}" exited (code ${exitCode})`);
      this._rejectPending(key, new Error(`PTY プロセスが終了しました (exit ${exitCode})`));
      this._ptys.delete(key);
      const clients = this._clients.get(key);
      if (clients) {
        for (const ws of clients) try { ws.close(1001, "PTY exited"); } catch {}
        this._clients.delete(key);
      }
      this._clearTimers(key);
      const s = this._states.get(key);
      if (s) {
        s.status = "idle";
        s.readyForPrompt = false;
        s.authRequired = false;
        s.idleRawBuffer = "";
        s.promptText = "";
        s.configStale = false;
        s.configWarning = "";
        s.quotaNotice = null;
        s.codexUpdatePromptDismissals = 0;
        this._clearRuntimeWarning(s);
        this._clearApprovalRequest(key, { emit: false });
        this._resetManualInputState(s);
        s._completedByReadyReturn = false;
      }
      this._scheduleSnapshotWrite();
    });

    return ptyProc;
  }

  // ── Output handling ────────────────────────────────────────────────────────

  _handleOutput(key, rawData) {
    const state = this._states.get(key);

    // Accumulate scrollback (keep last 64KB for new Terminal clients)
    const MAX_SCROLLBACK = 65536;
    let sb = this._scrollback.get(key) ?? "";
    sb += rawData;
    if (sb.length > MAX_SCROLLBACK) sb = sb.slice(-MAX_SCROLLBACK);
    this._scrollback.set(key, sb);

    // Always forward raw data to Terminal WebSocket clients (raw xterm rendering)
    const clients = this._clients.get(key);
    if (clients) {
      for (const ws of clients) {
        if (ws.readyState === 1 /* OPEN */) try { ws.send(rawData); } catch {}
      }
    }

    if (!state) return;

    const now = Date.now();
    state.lastOutputAt = now;

    const agent = this.agentRegistry.get(state.agentName);
    const h = getHeuristics(agent?.type ?? "codex");

    // ── READY prompt detection (startup / waiting_input / manual input completion) ──
    if (!state.readyForPrompt && ["idle", "waiting_input", "quota_wait"].includes(state.status)) {
      state.idleRawBuffer = `${state.idleRawBuffer}${rawData}`.slice(-32768);
      const idleText = stripAnsi(state.idleRawBuffer);
      if (agent?.type === "codex" && isCodexUpdateSelectionPrompt(idleText)) {
        const ptyProc = this._ptys.get(key);
        if (ptyProc && (state.codexUpdatePromptDismissals ?? 0) < 2) {
          state.codexUpdatePromptDismissals = (state.codexUpdatePromptDismissals ?? 0) + 1;
          try {
            ptyProc.write("\u001b[B\r");
            console.log(`[pty] auto-skipped Codex update prompt for ${key}`);
          } catch (error) {
            console.warn(`[pty] failed to auto-skip Codex update prompt for ${key}: ${error?.message || error}`);
          }
          return;
        }
      }
      if (matchesHeuristic(h, "readyRe", idleText, state.promptText)) {
        const pendingWaitingRun = state.status === "waiting_input" && Boolean(state.pendingResolve);
        if (pendingWaitingRun) {
          state.idleRawBuffer = "";
          this._completeRun(key, "completed");
          return;
        }
        const wasBlocked =
          state.status === "waiting_input" ||
          state.status === "quota_wait" ||
          state.authRequired;
        const recoveredFromQuota = state.status === "quota_wait" || Boolean(state.quotaNotice);
        const preserveManualDraft = !wasBlocked && state.manualInputDirty;
        state.authRequired = false;
        state.readyForPrompt = true;
        state.idleRawBuffer = "";
        state.status = "idle";
        state.quotaNotice = null;
        state.lastObserverNoticeKey = "";
        this._clearRuntimeWarning(state, "quota_wait");
        this._clearRuntimeWarning(state, "runtime_recovered");
        this._clearApprovalRequest(key, { emit: false });
        if (!preserveManualDraft) {
          this._resetManualInputState(state);
        }
        state._completedByReadyReturn = false;
        console.log(`[pty] CLI ready for ${key}`);
        this._queueSessionRefSync(key, "ready");
        if (wasBlocked) {
          this._emit("status.change", {
            agentName: state.agentName,
            workspaceId: state.workspaceId,
            status: "idle",
          });
        }
        if (recoveredFromQuota) {
          this._emitObserverNotice(state, "quota_recovered", `${state.agentName} が再び入力可能になりました。`);
        }
        this._scheduleSnapshotWrite();
        return;
      }
      if (h.authRequiredRe?.test(idleText)) {
        state.authRequired = true;
        if (state.status !== "waiting_input") {
          state.status = "waiting_input";
          this._clearApprovalRequest(key, { emit: false });
          this._emit("status.change", {
            agentName: state.agentName,
            workspaceId: state.workspaceId,
            status: "waiting_input",
            runId: state.runId,
          });
          this._emitObserverNotice(state, "waiting_input", `${state.agentName} が認証または確認入力待ちです。`);
          this._scheduleSnapshotWrite();
        }
        return;
      }
      if (state.status !== "manual_running") {
        return;
      }
    }

    if (state.status === "manual_running") {
      state.rawBuffer = `${state.rawBuffer}${rawData}`.slice(-131072);
      const plain = stripAnsi(rawData);
      const fullPlain = stripAnsi(state.rawBuffer);
      const authSafePlain = stripPromptEcho(plain, state.promptText);
      const authSafeFullPlain = stripPromptEcho(fullPlain, state.promptText);
      if (h.authRequiredRe?.test(authSafePlain)) {
        state.authRequired = true;
        state.status = "waiting_input";
        state.readyForPrompt = false;
        state.promptText = "";
        state.rawBuffer = "";
        state.turnActivitySeen = false;
        state.scrollbackSnapshot = "";
        state.manualTurnPersist = false;
        this._clearApprovalRequest(key, { emit: false });
        this._resetManualInputState(state);
        this._resetManualTurnMetadata(state);
        this._emit("status.change", {
          agentName: state.agentName,
          workspaceId: state.workspaceId,
          status: "waiting_input",
        });
        this._emitObserverNotice(state, "waiting_input", `${state.agentName} が認証または確認入力待ちです。`);
        this._scheduleSnapshotWrite();
        return;
      }
      if (h.quotaRe?.test(authSafePlain) || h.quotaRe?.test(authSafeFullPlain)) {
        const manualTurnPayload = this._buildManualTurnPayload(key, "quota_wait");
        this._clearTimers(key);
        state.promptText = "";
        state.turnActivitySeen = false;
        state.scrollbackSnapshot = "";
        state.rawBuffer = "";
        state.manualTurnPersist = false;
        this._clearApprovalRequest(key, { emit: false });
        this._resetManualInputState(state);
        this._setQuotaWaitState(key, `${authSafeFullPlain}\n${authSafePlain}`);
        this._resetManualTurnMetadata(state);
        this._emit("status.change", {
          agentName: state.agentName,
          workspaceId: state.workspaceId,
          status: "quota_wait",
        });
        if (manualTurnPayload) {
          this._emit("terminal.turn.done", manualTurnPayload);
        }
        return;
      }
      if (h.waitingInputRe.test(plain) && !h.stillRunningRe.test(plain)) {
        const manualTurnPayload = this._buildManualTurnPayload(key, "waiting_input");
        state.status = "waiting_input";
        state.readyForPrompt = false;
        state.promptText = "";
        state.turnActivitySeen = false;
        state.scrollbackSnapshot = "";
        state.rawBuffer = "";
        state.manualTurnPersist = false;
        if (h.approvalRe?.test(authSafePlain) || h.approvalRe?.test(authSafeFullPlain)) {
          this._createApprovalRequest(key, authSafeFullPlain);
        } else {
          this._clearApprovalRequest(key, { emit: false });
          this._emitObserverNotice(state, "waiting_input", `${state.agentName} が入力待ちです。`);
        }
        this._resetManualInputState(state);
        this._resetManualTurnMetadata(state);
        this._emit("status.change", {
          agentName: state.agentName,
          workspaceId: state.workspaceId,
          status: "waiting_input",
        });
        if (manualTurnPayload) {
          this._emit("terminal.turn.done", manualTurnPayload);
        }
        this._scheduleSnapshotWrite();
        return;
      }
      if (h.stillRunningRe.test(authSafePlain) || /(?:^|\n)\s*●\s+/u.test(fullPlain)) {
        state.turnActivitySeen = true;
      }
      const agentType = agent?.type ?? "codex";
      const transcriptSoFar = this._getStreamingTranscript(key, state, agentType);
      const transcriptContaminated = transcriptLooksContaminatedByPromptEcho(
        agentType,
        transcriptSoFar,
        state.promptText,
      );
      const transcriptMeaningful = transcriptLooksMeaningfulForCompletion(
        agentType,
        transcriptSoFar,
        state.promptText,
      );
      const strippedSoFar = stripPromptEcho(fullPlain, state.promptText);
      if (
        state.turnActivitySeen &&
        transcriptMeaningful &&
        strippedSoFar.length > READY_RETURN_MIN_CHARS &&
        (
          matchesHeuristic(h, "readyReturnRe", plain, state.promptText) ||
          matchesHeuristic(h, "readyReturnRe", strippedSoFar, state.promptText)
        )
      ) {
        state._completedByReadyReturn = true;
        clearTimeout(state.completionTimer);
        state.completionTimer = setTimeout(() => this._completeManualTurn(key), MANUAL_COMPLETION_SETTLE_MS);
        return;
      }
      if (!state._completedByReadyReturn && plain.trim() && transcriptMeaningful) {
        clearTimeout(state.completionTimer);
        state.completionTimer = setTimeout(() => this._completeManualTurn(key), MANUAL_COMPLETION_SILENCE_MS);
      }
      return;
    }

    if (state.status !== "running") return;

    // ── RUNNING phase: accumulate transcript ─────────────────────────────────
    // Only capture output that arrives AFTER the prompt was sent.
    if (!state.promptSentAt || now < state.promptSentAt) return;

    const plain = stripAnsi(rawData);
    const fullPlain = stripAnsi(state.rawBuffer + rawData);
    const authSafePlain = stripPromptEcho(plain, state.promptText);
    const authSafeFullPlain = stripPromptEcho(fullPlain, state.promptText);
    if (h.authRequiredRe?.test(authSafePlain) || h.authRequiredRe?.test(authSafeFullPlain)) {
      state.authRequired = true;
      state.status = "waiting_input";
      state.readyForPrompt = false;
      this._clearApprovalRequest(key, { emit: false });
      this._emitObserverNotice(state, "waiting_input", `${state.agentName} が認証または確認入力待ちです。`);
      this._scheduleSnapshotWrite();
      this._rejectPending(key, this._buildAuthRequiredError(state));
      return;
    }

    state.rawBuffer += rawData;
    if (h.quotaRe?.test(authSafePlain) || h.quotaRe?.test(authSafeFullPlain)) {
      this._setQuotaWaitState(key, `${authSafeFullPlain}\n${authSafePlain}`);
      this._completeRun(key, "quota_wait");
      return;
    }
    if (h.stillRunningRe.test(authSafePlain) || h.stillRunningRe.test(authSafeFullPlain)) {
      state.turnActivitySeen = true;
    }
    const copilotResponseSeen =
      agent?.type === "copilot" &&
      extractCopilotResponseBlocks(authSafeFullPlain, state.promptText).length > 0;
    const codexResponseSeen =
      agent?.type === "codex" &&
      codexHasResponseSignal(authSafeFullPlain, state.promptText);
    if (copilotResponseSeen || codexResponseSeen) {
      state.turnActivitySeen = true;
    }

    this._emitStreamingDeltaIfReady(key, state, agent?.type ?? "codex");

    // Detect waiting_input
    if (h.waitingInputRe.test(plain) && !h.stillRunningRe.test(plain)) {
      if (state.status !== "waiting_input") {
        state.status = "waiting_input";
        state.readyForPrompt = false;
        if (h.approvalRe?.test(authSafePlain) || h.approvalRe?.test(authSafeFullPlain)) {
          this._createApprovalRequest(key, authSafeFullPlain);
        } else {
          this._clearApprovalRequest(key, { emit: false });
          this._emitObserverNotice(state, "waiting_input", `${state.agentName} が入力待ちです。`);
        }
        this._emit("status.change", {
          agentName: state.agentName,
          workspaceId: state.workspaceId,
          status: "waiting_input",
          runId: state.runId,
        });
        this._scheduleSnapshotWrite();
      }
    }

    if (copilotResponseSeen) {
      state._completedByReadyReturn = true;
      clearTimeout(state.completionTimer);
      state.completionTimer = setTimeout(
        () => this._tryComplete(key),
        getReadyReturnCompletionDelay(agent?.type ?? "copilot", state.promptText),
      );
      return;
    }

    // Detect ready-prompt return → accelerate completion
    // Only after substantial output has been captured (avoids false positive from echo)
    const strippedSoFar = stripPromptEcho(stripAnsi(state.rawBuffer), state.promptText);
    if (
      agent?.type !== "copilot" &&
      state.turnActivitySeen &&
      strippedSoFar.length > READY_RETURN_MIN_CHARS &&
      (
        matchesHeuristic(h, "readyReturnRe", plain, state.promptText) ||
        matchesHeuristic(h, "readyReturnRe", strippedSoFar, state.promptText)
      )
    ) {
      // Ready prompt appeared → run is likely complete; shorten timer
      state._completedByReadyReturn = true;
      clearTimeout(state.completionTimer);
      state.completionTimer = setTimeout(
        () => this._tryComplete(key),
        getReadyReturnCompletionDelay(agent?.type ?? "codex", state.promptText),
      );
      return;
    }

    // Reset silence-based completion timer only on meaningful text output.
    // TUI cursor movements / repaints strip to empty and should NOT reset the timer.
    if (state._completedByReadyReturn) {
      if (plain.trim()) {
        clearTimeout(state.completionTimer);
        state.completionTimer = setTimeout(
          () => this._tryComplete(key),
          getReadyReturnCompletionDelay(agent?.type ?? "codex", state.promptText),
        );
      }
      return;
    }
    if (plain.trim()) {
      this._scheduleCompletion(key);
    }
  }

  // ── Ready detection ────────────────────────────────────────────────────────

  /**
   * Wait until the CLI shows its ready-for-input prompt.
   * Uses cumulative idleRawBuffer for cross-chunk matching.
   */
  async _waitForReadyPrompt(key) {
    const start = Date.now();
    console.log(`[pty] waiting for CLI ready: ${key}`);

    while (true) {
      const state = this._states.get(key);
      if (!state) {
        throw Object.assign(new Error("PTY state が失われました。再接続してください。"), { cancelled: true });
      }
      if (!this._ptys.has(key)) {
        throw Object.assign(new Error(`${state.agentName} の PTY が ready 前に終了しました。Terminal タブで再接続してください。`), { cancelled: true });
      }
      if (state.readyForPrompt) break;
      if (state.authRequired) {
        throw this._buildAuthRequiredError(state);
      }
      if (Date.now() - start > READY_WAIT_TIMEOUT_MS) {
        console.warn(`[pty] ready timeout for ${key}`);
        if (state?.authRequired) throw this._buildAuthRequiredError(state);
        const err = new Error(`${state?.agentName || key} の CLI ready prompt を確認できません。Terminal タブで状態を確認してください。`);
        err.readyTimeout = true;
        throw err;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Small settle delay to let TUI stabilize
    const state = this._states.get(key);
    const agentType = this.agentRegistry.get(state?.agentName)?.type ?? "codex";
    await new Promise((r) => setTimeout(r, getReadySettleDelay(agentType)));
  }

  async _waitForPrewarmState(key, timeoutMs = 4000) {
    const start = Date.now();
    while (true) {
      const state = this._states.get(key);
      if (!state || !this._ptys.has(key)) {
        return;
      }
      if (
        state.readyForPrompt ||
        state.status === "waiting_input" ||
        state.status === "quota_wait" ||
        state.status === "error"
      ) {
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  // ── Completion ─────────────────────────────────────────────────────────────

  _scheduleCompletion(key) {
    const state = this._states.get(key);
    if (!state) return;
    clearTimeout(state.completionTimer);
    state.completionTimer = setTimeout(() => this._tryComplete(key), COMPLETION_SILENCE_MS);
  }

  _scheduleHardTimeout(key) {
    const state = this._states.get(key);
    if (!state) return;
    clearTimeout(state.hardTimeoutTimer);
    state.hardTimeoutTimer = setTimeout(() => {
      const s = this._states.get(key);
      if (s?.status === "running" || s?.status === "waiting_input") {
        console.warn(`[pty] hard timeout for "${s.agentName}" ws="${s.workspaceId}"`);
        this._handleHardTimeout(key);
      }
    }, HARD_TIMEOUT_MS);
  }

  _tryComplete(key) {
    const state = this._states.get(key);
    if (!state) return;
    if (state.status !== "running" && state.status !== "waiting_input") return;

    const finalStatus = state.status === "waiting_input" ? "waiting_input" : "completed";
    this._completeRun(key, finalStatus);
  }

  _handleHardTimeout(key) {
    const state = this._states.get(key);
    if (!state || !state.pendingResolve) return;

    this._clearTimers(key);

    const agent = this.agentRegistry.get(state.agentName);
    const agentType = agent?.type ?? "codex";
    let text = sanitizeTranscript(agentType, state.rawBuffer, state.promptText);
    if (usesScrollbackTranscriptFallback(agentType)) {
      const fallbackText = sanitizeTranscript(agentType, this._getRunScrollback(key, state), state.promptText);
      text = choosePreferredTranscript(agentType, text, fallbackText, state.promptText);
    }
    const blockedStatus = state.status === "waiting_input" ? "waiting_input" : "manual_running";

    state.rawBuffer = "";
    state.promptText = "";
    state.runId = null;
    state.promptSentAt = null;
    state.idleRawBuffer = "";
    state.turnActivitySeen = false;
    state.readyForPrompt = false;
    state.scrollbackSnapshot = "";
    state.codexEmptyCompletionRetries = 0;
    state.codexExactCompletionRetries = 0;
    state.streamedText = "";
    if (blockedStatus !== "waiting_input") {
      state.authRequired = false;
    }
    state._completedByReadyReturn = false;
    this._setRuntimeWarning(
      state,
      "hard_timeout",
      "長時間応答が止まったため stale 扱いにしました。Terminal を確認して必要なら再送してください。",
    );
    this._resetManualInputState(state);
    state.status = blockedStatus;
    this._syncSessionRefAfterTurn(key, "timeout");
    this._emitObserverNotice(state, "stale", `${state.agentName} の応答がタイムアウトしました。`);
    this._scheduleSnapshotWrite();

    this._emit("status.change", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      status: blockedStatus === "waiting_input" ? "waiting_input" : "running",
    });

    this._emit("run.done", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      runId: state.runId,
      text,
      finalStatus: "timeout",
    });

    const resolve = state.pendingResolve;
    state.pendingResolve = null;
    state.pendingReject = null;
    resolve({ text, finalStatus: "timeout" });
  }

  _getRunScrollback(key, state) {
    const scrollback = stripAnsi(this._scrollback.get(key) ?? "");
    const snapshot = state?.scrollbackSnapshot ?? "";
    if (snapshot && scrollback.startsWith(snapshot)) {
      return scrollback.slice(snapshot.length);
    }
    return scrollback;
  }

  _getStreamingTranscript(key, state, agentType) {
    let text = sanitizeTranscript(agentType, state.rawBuffer, state.promptText);
    if (usesScrollbackTranscriptFallback(agentType)) {
      const fallbackText = sanitizeTranscript(agentType, this._getRunScrollback(key, state), state.promptText);
      text = choosePreferredTranscript(agentType, text, fallbackText, state.promptText);
    }
    return text;
  }

  _emitStreamingDeltaIfReady(key, state, agentType) {
    if (!state?.runId) {
      return;
    }

    const transcript = this._getStreamingTranscript(key, state, agentType);
    const emittedText = state.streamedText ?? "";
    if (!transcript || !transcript.startsWith(emittedText)) {
      return;
    }

    const pendingText = transcript.slice(emittedText.length);
    const boundary = findStreamingChunkBoundary(pendingText);
    if (boundary <= 0) {
      return;
    }

    const chunk = pendingText.slice(0, boundary);
    if (!chunk.trim()) {
      return;
    }

    state.streamedText = `${emittedText}${chunk}`;
    this._emit("message.delta", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      runId: state.runId,
      content: chunk,
    });
  }

  _completeRun(key, finalStatus) {
    const state = this._states.get(key);
    if (!state || !state.pendingResolve) return;

    console.log(`[pty] run completed for ${key} — status=${finalStatus}`);
    this._clearTimers(key);
    let resolvedFinalStatus = finalStatus;

    // Strip ANSI from full accumulated buffer (cross-chunk accuracy)
    const agent = this.agentRegistry.get(state.agentName);
    const agentType = agent?.type ?? "codex";
    let text = sanitizeTranscript(agentType, state.rawBuffer, state.promptText);
    let fallbackText = "";
    if (usesScrollbackTranscriptFallback(agentType)) {
      const scrollbackText = this._getRunScrollback(key, state);
      fallbackText = sanitizeTranscript(agentType, scrollbackText, state.promptText);
      const preferredText = choosePreferredTranscript(agentType, text, fallbackText, state.promptText);
      if (preferredText && preferredText !== text && fallbackText) {
        console.log(`[pty] recovered richer ${agentType} response from scrollback for ${key}`);
      }
      text = preferredText;
    }
    const exactTarget = extractExactReplyTarget(state.promptText);
    if (
      finalStatus === "completed" &&
      agentType === "codex" &&
      exactTarget &&
      /\n/.test(exactTarget) &&
      !exactReplyMatchesTarget(state.promptText, text)
    ) {
      state.codexExactCompletionRetries = (state.codexExactCompletionRetries ?? 0) + 1;
      if (state.codexExactCompletionRetries < 3) {
        clearTimeout(state.completionTimer);
        state._completedByReadyReturn = false;
        state.completionTimer = setTimeout(() => this._tryComplete(key), CODEX_EMPTY_COMPLETION_RETRY_MS);
        console.log(`[pty] delaying codex completion for exact multiline target ${key}`);
        return;
      }
      console.warn(`[pty] codex exact multiline target remained incomplete for ${key}`);
    }
    state.codexExactCompletionRetries = 0;
    if (finalStatus === "completed" && ["codex", "claude"].includes(agentType) && !text) {
      state.codexEmptyCompletionRetries = (state.codexEmptyCompletionRetries ?? 0) + 1;
      if (state.codexEmptyCompletionRetries >= 3) {
        text =
          agentType === "claude"
            ? "Claude の応答を抽出できませんでした。Terminal の出力を確認してください。"
            : "Codex の応答を抽出できませんでした。Terminal の出力を確認してください。";
        resolvedFinalStatus = "error";
        console.warn(`[pty] ${agentType} completion fell back to explicit error for ${key}`);
      } else {
        clearTimeout(state.completionTimer);
        state._completedByReadyReturn = false;
        state.completionTimer = setTimeout(() => this._tryComplete(key), CODEX_EMPTY_COMPLETION_RETRY_MS);
        console.log(`[pty] delaying ${agentType} completion for ${key} — response text not captured yet`);
        return;
      }
    } else {
      state.codexEmptyCompletionRetries = 0;
    }
    state.rawBuffer = "";
    state.promptText = "";
    state.status =
      resolvedFinalStatus === "waiting_input" || resolvedFinalStatus === "quota_wait"
        ? resolvedFinalStatus
        : "idle";
    state.runId = null;
    state.promptSentAt = null;
    // Reset idleRawBuffer for next ready detection cycle
    state.idleRawBuffer = "";
    state.readyForPrompt =
      resolvedFinalStatus === "waiting_input" || resolvedFinalStatus === "quota_wait"
        ? false
        : true;
    state.scrollbackSnapshot = "";
    state.turnActivitySeen = false;
    state.streamedText = "";
    if (!["waiting_input", "quota_wait"].includes(resolvedFinalStatus)) {
      state.authRequired = false;
    }
    if (resolvedFinalStatus !== "waiting_input") {
      this._clearApprovalRequest(key, { emit: false });
    }
    if (resolvedFinalStatus !== "quota_wait") {
      state.quotaNotice = null;
      this._clearRuntimeWarning(state, "quota_wait");
    }
    if (resolvedFinalStatus === "completed") {
      state.lastObserverNoticeKey = "";
      this._clearRuntimeWarning(state, "hard_timeout");
      this._clearRuntimeWarning(state, "runtime_recovered");
    }
    state._completedByReadyReturn = false;
    this._resetManualInputState(state);
    this._syncSessionRefAfterTurn(key, "run.complete");
    this._scheduleSnapshotWrite();

    this._emit("status.change", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      status:
        resolvedFinalStatus === "waiting_input" || resolvedFinalStatus === "quota_wait"
          ? resolvedFinalStatus
          : "idle",
    });

    this._emit("run.done", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      runId: state.runId,
      text,
      finalStatus: resolvedFinalStatus,
    });

    state.pendingResolve({ text, finalStatus: resolvedFinalStatus });
    state.pendingResolve = null;
    state.pendingReject = null;
  }

  _rejectPending(key, err) {
    const state = this._states.get(key);
    if (!state) return;
    this._clearTimers(key);
    const keepWaitingInput = Boolean(err?.authRequired) || state.status === "waiting_input";
    state.status = keepWaitingInput ? "waiting_input" : "idle";
    state.readyForPrompt = keepWaitingInput ? false : state.readyForPrompt;
    state.runId = null;
    state.promptSentAt = null;
    state.rawBuffer = "";
    state.idleRawBuffer = keepWaitingInput ? state.idleRawBuffer : "";
    state.promptText = "";
    state.turnActivitySeen = false;
    state.scrollbackSnapshot = "";
    state.codexEmptyCompletionRetries = 0;
    state.streamedText = "";
    state._completedByReadyReturn = false;
    if (!keepWaitingInput) {
      this._clearApprovalRequest(key, { emit: false });
      state.quotaNotice = null;
      this._clearRuntimeWarning(state, "quota_wait");
    }
    this._resetManualInputState(state);
    this._scheduleSnapshotWrite();
    if (state.pendingReject) {
      state.pendingReject(err);
      state.pendingResolve = null;
      state.pendingReject = null;
    }
  }

  _clearTimers(key) {
    const state = this._states.get(key);
    if (!state) return;
    clearTimeout(state.completionTimer);
    clearTimeout(state.hardTimeoutTimer);
    state.completionTimer = null;
    state.hardTimeoutTimer = null;
  }

  _buildAuthRequiredError(state) {
    const agent = this.agentRegistry.get(state.agentName);
    const cliName = getCliDisplayName(agent?.type ?? "codex");
    const err = new Error(
      `${state.agentName} は起動時の確認待ちです。Terminal タブで ${cliName} を開き、認証または確認プロンプトを完了してください。`
    );
    err.authRequired = true;
    return err;
  }

  _buildManualInputBusyError() {
    return new Error("Terminal に未送信の入力があります。Enter で送信するか Ctrl+C で取り消してから再送してください。");
  }

  _resetManualInputState(state) {
    if (!state) return;
    state.manualInputDirty = false;
    state.manualInputBuffer = "";
  }

  _resetManualTurnMetadata(state) {
    if (!state) return;
    state.manualTurnSource = "terminal";
    state.manualTurnMetadata = null;
  }

  _buildManualTurnPayload(key, finalStatus) {
    const state = this._states.get(key);
    if (!state?.manualTurnPersist) return null;
    const prompt = String(state.promptText ?? "").trim();
    if (!prompt) return null;

    const agent = this.agentRegistry.get(state.agentName);
    const agentType = agent?.type ?? "codex";
    let text = sanitizeTranscript(agentType, state.rawBuffer, state.promptText);
    let fallbackText = "";
    if (usesScrollbackTranscriptFallback(agentType)) {
      fallbackText = sanitizeTranscript(agentType, this._getRunScrollback(key, state), state.promptText);
      text = choosePreferredTranscript(agentType, text, fallbackText, state.promptText);
    }
    if (
      transcriptLooksContaminatedByPromptEcho(agentType, text, state.promptText) &&
      fallbackText &&
      !transcriptLooksContaminatedByPromptEcho(agentType, fallbackText, state.promptText)
    ) {
      text = fallbackText;
    }

    return {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      prompt,
      text,
      finalStatus,
      source: state.manualTurnSource || "terminal",
      metadata: state.manualTurnMetadata ? { ...state.manualTurnMetadata } : null,
    };
  }

  _completeManualTurn(key) {
    const state = this._states.get(key);
    if (!state || state.status !== "manual_running") return;
    const manualTurnPayload = this._buildManualTurnPayload(key, "completed");
    this._clearTimers(key);
    state.authRequired = false;
    state.readyForPrompt = true;
    state.idleRawBuffer = "";
    state.status = "idle";
    state.promptText = "";
    state.rawBuffer = "";
    state.turnActivitySeen = false;
    state.scrollbackSnapshot = "";
    state.manualTurnPersist = false;
    state.lastObserverNoticeKey = "";
    this._clearRuntimeWarning(state, "hard_timeout");
    this._clearRuntimeWarning(state, "runtime_recovered");
    this._clearRuntimeWarning(state, "quota_wait");
    state.quotaNotice = null;
    this._clearApprovalRequest(key, { emit: false });
    this._resetManualInputState(state);
    this._resetManualTurnMetadata(state);
    state._completedByReadyReturn = false;
    console.log(`[pty] CLI ready for ${key}`);
    this._syncSessionRefAfterTurn(key, "manual.complete");
    this._scheduleSnapshotWrite();
    this._emit("status.change", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      status: "idle",
    });
    if (manualTurnPayload) {
      this._emit("terminal.turn.done", manualTurnPayload);
    }
  }

  _isIgnorableManualControlInput(data) {
    return typeof data === "string" && /^(?:\u001B\[[IO])+$/u.test(data);
  }

  _noteManualInput(key, data) {
    const state = this._states.get(key);
    if (!state || state.pendingResolve || state.status === "running") return;
    if (!data) return;
    if (this._isIgnorableManualControlInput(data)) return;

    if (data === "\u0003" || data === "\u0015") {
      this._resetManualInputState(state);
      return;
    }

    if (/[\r\n]/.test(data)) {
      const printableBeforeSubmit = data
        .replace(/[\r\n]/g, "")
        .replace(/[\u0000-\u001F\u007F]/g, "");
      if (printableBeforeSubmit) {
        state.manualInputBuffer = `${state.manualInputBuffer}${printableBeforeSubmit}`.slice(-512);
      }
      state.manualInputDirty = state.manualInputBuffer.length > 0;
      return;
    }

    if (data === "\u007F" || data === "\b") {
      if (state.manualInputBuffer.length > 0) {
        state.manualInputBuffer = state.manualInputBuffer.slice(0, -1);
      }
      state.manualInputDirty = state.manualInputBuffer.length > 0;
      return;
    }

    if (data === "\t" || data.startsWith("\u001B")) {
      state.manualInputDirty = true;
      return;
    }

    const printable = data.replace(/[\u0000-\u001F\u007F]/g, "");
    if (!printable) return;
    state.manualInputBuffer = `${state.manualInputBuffer}${printable}`.slice(-512);
    state.manualInputDirty = true;
  }

  _markManualRunning(key) {
    const state = this._states.get(key);
    if (!state) return;
    if (state.pendingResolve) return;
    if (!state.readyForPrompt && state.status !== "waiting_input") return;
    if (state.status === "running" || state.status === "manual_running") return;
    const submittedText = String(state.manualInputBuffer ?? "").trim();
    const interactiveReply = state.status === "waiting_input";

    this._clearTimers(key);
    state.status = "manual_running";
    state.readyForPrompt = false;
    state.authRequired = false;
    state.runId = null;
    state.promptSentAt = null;
    state.promptText = submittedText;
    state.rawBuffer = "";
    state.turnActivitySeen = false;
    state.idleRawBuffer = "";
    state.scrollbackSnapshot = stripAnsi(this._scrollback.get(key) ?? "");
    state.manualTurnPersist = !interactiveReply && Boolean(submittedText);
    state.quotaNotice = null;
    this._clearRuntimeWarning(state, "quota_wait");
    this._clearRuntimeWarning(state, "hard_timeout");
    this._clearRuntimeWarning(state, "runtime_recovered");
    this._clearApprovalRequest(key, { emit: false });
    state._completedByReadyReturn = false;
    this._resetManualInputState(state);
    this._scheduleSnapshotWrite();
    this._emit("status.change", {
      agentName: state.agentName,
      workspaceId: state.workspaceId,
      status: "running",
    });
  }

  _forwardTerminalInput({ key, agentName, workspaceId, workdir, data, ptyProc = null, source = null, metadata = undefined }) {
    let nextPtyProc = ptyProc ?? this._ptys.get(key);
    if (!nextPtyProc) {
      return null;
    }
    const state = this._ensureState(key, agentName, workspaceId);
    if (source) {
      state.manualTurnSource = source;
    }
    if (metadata !== undefined) {
      state.manualTurnMetadata = metadata ? { ...metadata } : null;
    }
    if (data === "\u0003") {
      this._resetManualInputState(state);
      this._resetManualTurnMetadata(state);
      state.promptText = "";
      state.rawBuffer = "";
      state.turnActivitySeen = false;
      state.manualTurnPersist = false;
      if (state.status === "running" || state.status === "waiting_input") {
        console.log(`[pty] terminal ctrl+c reset agent="${agentName}" ws="${workspaceId}"`);
        this._scrollback.set(key, "");
        this._killKey(key);
        nextPtyProc = this.ensureAgentPty(agentName, workspaceId, { workdir });
        return nextPtyProc;
      }
    } else {
      this._noteManualInput(key, data);
    }
    if (/[\r\n]/.test(data)) {
      this._markManualRunning(key);
    }
    nextPtyProc.write(data);
    return nextPtyProc;
  }

  _killKey(key) {
    this._rejectPending(key, Object.assign(new Error("PTY killed"), { cancelled: true }));
    this._clearApprovalRequest(key, { emit: false });
    const ptyProc = this._ptys.get(key);
    if (ptyProc) try { ptyProc.kill(); } catch {}
    this._ptys.delete(key);
    this._scheduleSnapshotWrite();
    return true;
  }

  // ── Input formatting ───────────────────────────────────────────────────────

  _buildInput(agentType, prompt, context) {
    if (!context) return prompt;
    return `[Context from recent workspace chat]\n${context}\n\n[User prompt]\n${prompt}`;
  }

  async _writePromptToPty(ptyProc, input, agentType = "codex", { originalPrompt = "" } = {}) {
    try {
      const submittedInput = String(input ?? originalPrompt ?? "");
      const writePayload = shouldUseBracketedPaste(agentType, submittedInput)
        ? `\u001b[200~${formatBracketedPastePayload(agentType, submittedInput)}\u001b[201~`
        : input;
      ptyProc.write(writePayload);
      await new Promise((resolve) => setTimeout(resolve, getPromptSubmitDelay(agentType, submittedInput)));
      ptyProc.write("\r");
      if (needsComposerConfirm(agentType, submittedInput)) {
        // Codex/Claude/Gemini can keep pasted multiline input in the composer until a second Enter confirms send.
        await new Promise((resolve) => setTimeout(resolve, getComposerConfirmDelay(agentType, submittedInput)));
        ptyProc.write("\r");
      }
    } catch (err) {
      console.error("[pty] write error:", err.message);
    }
  }

  // ── Terminal WebSocket client ───────────────────────────────────────────────

  _handleTerminalClient(ws, agentName, workspaceId, workdir) {
    const key = this._key(agentName, workspaceId);

    // Ensure the PTY is running (Terminal tab acts as the launch trigger)
    let ptyProc = this.ensureAgentPty(agentName, workspaceId, { workdir });
    if (!ptyProc) {
      ws.close(1011, "Failed to start terminal");
      return;
    }

    const clients = this._clients.get(key) ?? new Set();
    clients.add(ws);
    this._clients.set(key, clients);

    // Replay scrollback so the new client sees existing PTY output
    const scrollback = this._scrollback.get(key);
    if (scrollback) {
      try { ws.send(scrollback); } catch {}
    }

    ws.on("message", (raw) => {
      const data = raw.toString();
      // Resize: {"type":"resize","cols":N,"rows":N}
      if (data.startsWith("{")) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "resize" && msg.cols && msg.rows) {
            ptyProc.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
            return;
          }
        } catch {}
      }
      // Forward keyboard input from Terminal tab to the shared PTY
      try {
        ptyProc = this._forwardTerminalInput({
          key,
          agentName,
          workspaceId,
          workdir,
          data,
          ptyProc,
        }) ?? ptyProc;
      } catch {}
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[pty] terminal client closed agent="${agentName}" ws="${workspaceId}"`);
    });
    ws.on("error", () => clients.delete(ws));
  }

  // ── EventBus ──────────────────────────────────────────────────────────────

  _emit(type, payload) {
    this.bus?.publish?.(type, { type, ...payload });
  }
}

export const __testHooks = {
  parseGeminiSessionListOutput,
  sanitizeGeminiTranscript,
  sanitizeCodexTranscript,
  codexLooksReadyReturn,
  choosePreferredTranscript,
  stripPromptEcho,
  transcriptLooksContaminatedByPromptEcho,
  isCodexUpdateSelectionPrompt,
  normalizePersistedAssistantText,
  extractRecordedUserPrompt,
  normalizeSessionPromptText,
  computeGeminiProjectHash,
  selectGeminiResumeValue,
  resolveGeminiResumeSession,
  findStreamingChunkBoundary,
  exactReplyMatchesTarget,
  formatBracketedPastePayload,
  recoverExactMultilineReplyFromTranscript,
};
