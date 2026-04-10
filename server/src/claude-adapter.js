import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { normalizeClaudeEvent } from "./adapters/canonical-events.js";

function resolveCommand(command) {
  if (process.platform !== "win32") return command;
  const base = path.basename(command).toLowerCase();
  if (base === "claude" || base === "claude.ps1") return "claude.cmd";
  return command;
}

function spawnClaude(execPath, args, workdir) {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", execPath, ...args], {
      cwd: workdir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn(execPath, args, {
    cwd: workdir,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function killProcess(child) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    killer.unref();
  } else {
    child.kill("SIGTERM");
  }
}

/**
 * ClaudeAdapter wraps the Claude Code CLI (claude --output-format stream-json).
 *
 * runTurn() emits:
 *   onEvent(rawEvent)          — raw CLI JSON event
 *   onCanonicalEvent(event)    — normalized CanonicalEvent
 */
export class ClaudeAdapter {
  constructor(config) {
    this.command = resolveCommand(config.claudeCommand || "claude");
    this.defaultModel = config.claudeModel || "";
    this.baseWorkdir = config.codexWorkdir;
    this.runSequence = 0;
  }

  /**
   * @param {object} opts
   * @param {string|null} opts.threadId         Claude session_id (for --resume)
   * @param {string} opts.prompt
   * @param {string} opts.agentName             Used in CanonicalEvents
   * @param {Function} [opts.onEvent]           raw JSON event callback
   * @param {Function} [opts.onCanonicalEvent]  CanonicalEvent callback
   * @param {{ model?: string }} [opts.sessionConfig]
   * @param {string} [opts.workdir]
   * @returns {Promise<{ threadId: string, text: string, usage: object }>}
   *   promise.cancel() cancels the run
   */
  runTurn({ threadId, prompt, agentName = "claude", onEvent, onCanonicalEvent, sessionConfig = {}, workdir }) {
    const runId = ++this.runSequence;
    const resolvedWorkdir = workdir || this.baseWorkdir;
    const model = sessionConfig.model || this.defaultModel;

    const args = [
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
    ];
    if (model) args.push("--model", model);
    if (threadId) args.push("--resume", threadId);
    args.push("-p", prompt);

    console.log(`[claude-adapter:${agentName}] run #${runId} cwd=${resolvedWorkdir} model=${model || "(default)"} resume=${threadId || "none"}`);

    const child = spawnClaude(this.command, args, resolvedWorkdir);

    let activeThreadId = threadId || null;
    let cancelRequested = false;
    let settled = false;
    const textParts = [];
    const stderrLines = [];
    const usage = {};

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    const emitCanonical = (raw) => {
      if (!onCanonicalEvent) return;
      for (const ce of normalizeClaudeEvent(raw, agentName)) {
        onCanonicalEvent(ce);
      }
    };

    const promise = new Promise((resolve, reject) => {
      function finalize(cb) {
        if (settled) return;
        settled = true;
        stdoutReader.close();
        stderrReader.close();
        cb();
      }

      stdoutReader.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return;
        }

        onEvent?.(event);
        emitCanonical(event);

        if (event.type === "system" && event.session_id) {
          activeThreadId = event.session_id;
        }
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === "text") textParts.push(block.text);
          }
        }
        if (event.type === "result") {
          if (event.usage) {
            usage.inputTokens = (usage.inputTokens || 0) + (event.usage.input_tokens || 0);
            usage.outputTokens = (usage.outputTokens || 0) + (event.usage.output_tokens || 0);
            usage.cacheReadTokens = (usage.cacheReadTokens || 0) + (event.usage.cache_read_input_tokens || 0);
          }
          usage.costUsd = event.total_cost_usd;
        }
      });

      stderrReader.on("line", (line) => {
        if (line.trim()) stderrLines.push(line.trim());
      });

      child.on("error", (err) => {
        console.error(`[claude-adapter:${agentName}] run #${runId} process error:`, err);
        finalize(() => reject(err));
      });

      child.on("close", (code) => {
        if (cancelRequested) {
          const err = new Error("Claude run cancelled.");
          err.cancelled = true;
          finalize(() => reject(err));
          return;
        }
        if (code !== 0) {
          const detail = stderrLines.join(" | ") || `exit code ${code}`;
          finalize(() => reject(new Error(`Claude exited with code ${code}: ${detail}`)));
          return;
        }
        finalize(() =>
          resolve({ threadId: activeThreadId, text: textParts.join("").trim(), usage }),
        );
      });
    });

    promise.cancel = () => {
      if (settled || cancelRequested) return false;
      cancelRequested = true;
      killProcess(child);
      return true;
    };

    return promise;
  }
}
