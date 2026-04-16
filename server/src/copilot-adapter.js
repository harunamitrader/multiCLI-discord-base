import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { normalizeCopilotEvent } from "./adapters/canonical-events.js";

function resolveCommand(command) {
  if (process.platform !== "win32") return command;
  const base = path.basename(command).toLowerCase();
  if (base === "copilot" || base === "copilot.ps1") return "copilot.cmd";
  return command;
}

function spawnCopilot(execPath, args, workdir) {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", execPath, ...args], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn(execPath, args, {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
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

export class CopilotAdapter {
  constructor(config) {
    this.command = resolveCommand(config.copilotCommand || "copilot");
    this.defaultModel = config.copilotModel || "gpt-5.4";
    this.baseWorkdir = config.codexWorkdir;
    this.runSequence = 0;
  }

  runTurn({
    threadId,
    prompt,
    agentName = "copilot",
    onEvent,
    onCanonicalEvent,
    sessionConfig = {},
    workdir,
  }) {
    const runId = ++this.runSequence;
    const resolvedWorkdir = workdir || this.baseWorkdir;
    const model = sessionConfig.model || this.defaultModel;

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--allow-all-tools",
      "--add-dir",
      resolvedWorkdir,
    ];
    if (model) args.push("--model", model);
    if (threadId) args.push(`--resume=${threadId}`);

    console.log(
      `[copilot-adapter:${agentName}] run #${runId} cwd=${resolvedWorkdir} model=${model || "(default)"} resume=${threadId || "none"}`,
    );

    const child = spawnCopilot(this.command, args, resolvedWorkdir);

    let activeThreadId = threadId || null;
    let cancelRequested = false;
    let settled = false;
    const textParts = [];
    const stderrLines = [];
    const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let finalText = "";
    let finalDurationMs = null;

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    const emitCanonical = (raw) => {
      if (!onCanonicalEvent) return;
      for (const ce of normalizeCopilotEvent(raw, agentName)) {
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
        if (!trimmed || trimmed[0] !== "{") return;

        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return;
        }

        onEvent?.(event);
        emitCanonical(event);

        if (event.type === "assistant.message_delta" && event.data?.deltaContent) {
          textParts.push(String(event.data.deltaContent));
        }
        if (event.type === "assistant.message" && event.data?.content != null) {
          finalText = String(event.data.content);
        }
        if (event.type === "result") {
          if (event.sessionId) {
            activeThreadId = event.sessionId;
          }
          finalDurationMs = Number(event.usage?.totalApiDurationMs || 0) || null;
        }
        if (event.type === "error") {
          stderrLines.push(String(event.message || event.data?.message || "GitHub Copilot CLI error"));
        }
      });

      stderrReader.on("line", (line) => {
        if (line.trim()) stderrLines.push(line.trim());
      });

      child.on("error", (err) => {
        console.error(`[copilot-adapter:${agentName}] run #${runId} process error:`, err);
        finalize(() => reject(err));
      });

      child.on("close", (code) => {
        if (cancelRequested) {
          const err = new Error("GitHub Copilot run cancelled.");
          err.cancelled = true;
          finalize(() => reject(err));
          return;
        }
        if (code !== 0) {
          const detail = stderrLines.join(" | ") || `exit code ${code}`;
          finalize(() => reject(new Error(`GitHub Copilot CLI exited with code ${code}: ${detail}`)));
          return;
        }
        finalize(() =>
          resolve({
            threadId: activeThreadId,
            text: (finalText || textParts.join("")).trim(),
            usage: {
              ...usage,
              durationMs: finalDurationMs ?? undefined,
            },
          }),
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
