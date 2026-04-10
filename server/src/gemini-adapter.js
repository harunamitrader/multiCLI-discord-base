import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { normalizeGeminiEvent } from "./adapters/canonical-events.js";

function resolveCommand(command) {
  if (process.platform !== "win32") return command;
  const base = path.basename(command).toLowerCase();
  if (base === "gemini" || base === "gemini.ps1") return "gemini.cmd";
  return command;
}

function spawnGemini(execPath, args, workdir) {
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

/**
 * Resolves a session UUID to its 1-based index by running `gemini --list-sessions`.
 * Falls back to "latest" if not found.
 * Note: Direct UUID resume also appears to work (Phase 0 verified), but index is the documented API.
 */
function resolveSessionIndex(execPath, sessionId, workdir) {
  try {
    const cmd = process.platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", execPath, "--list-sessions"] }
      : { command: execPath, args: ["--list-sessions"] };

    const result = spawnSync(cmd.command, cmd.args, {
      cwd: workdir || undefined,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });

    if (result.status !== 0) return null;

    const needle = `[${sessionId}]`;
    for (const line of String(result.stdout || "").split(/\r?\n/)) {
      if (!line.includes(needle)) continue;
      const trimmed = line.trim();
      const dotIdx = trimmed.indexOf(".");
      if (dotIdx <= 0) continue;
      const n = parseInt(trimmed.slice(0, dotIdx).trim(), 10);
      if (!isNaN(n)) return n;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * GeminiAdapter wraps the Gemini CLI (gemini --output-format stream-json --yolo).
 *
 * runTurn() emits:
 *   onEvent(rawEvent)          — raw CLI JSON event
 *   onCanonicalEvent(event)    — normalized CanonicalEvent
 */
export class GeminiAdapter {
  constructor(config) {
    this.command = resolveCommand(config.geminiCommand || "gemini");
    this.defaultModel = config.geminiModel || "gemini-2.5-flash";
    this.baseWorkdir = config.codexWorkdir;
    this.runSequence = 0;
  }

  /**
   * @param {object} opts
   * @param {string|null} opts.threadId         Gemini session UUID (for --resume)
   * @param {string} opts.prompt
   * @param {string} opts.agentName             Used in CanonicalEvents
   * @param {Function} [opts.onEvent]           raw JSON event callback
   * @param {Function} [opts.onCanonicalEvent]  CanonicalEvent callback
   * @param {{ model?: string }} [opts.sessionConfig]
   * @param {string} [opts.workdir]
   * @returns {Promise<{ threadId: string, text: string, usage: object }>}
   *   promise.cancel() cancels the run
   */
  runTurn({ threadId, prompt, agentName = "gemini", onEvent, onCanonicalEvent, sessionConfig = {}, workdir }) {
    const runId = ++this.runSequence;
    const resolvedWorkdir = workdir || this.baseWorkdir;
    const model = sessionConfig.model || this.defaultModel;

    const args = ["--output-format", "stream-json", "--yolo"];
    if (model) args.push("--model", model);

    if (threadId) {
      // Try index resolution first (documented API), fall back to direct UUID or "latest"
      const idx = resolveSessionIndex(this.command, threadId, resolvedWorkdir);
      if (idx !== null) {
        args.push("--resume", String(idx));
      } else {
        // Phase 0 verified: UUID works directly; use as fallback before "latest"
        args.push("--resume", threadId);
      }
    }

    args.push("-p", prompt);

    console.log(`[gemini-adapter:${agentName}] run #${runId} cwd=${resolvedWorkdir} model=${model} resume=${threadId || "none"}`);

    const child = spawnGemini(this.command, args, resolvedWorkdir);

    let activeThreadId = threadId || null;
    let cancelRequested = false;
    let settled = false;
    const textParts = [];
    const stderrLines = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    const emitCanonical = (raw) => {
      if (!onCanonicalEvent) return;
      for (const ce of normalizeGeminiEvent(raw, agentName)) {
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

        switch (event.type) {
          case "init":
            if (event.session_id) activeThreadId = event.session_id;
            break;
          case "message":
            if (event.role === "assistant" && event.delta && event.content) {
              textParts.push(event.content);
            }
            break;
          case "result":
            if (event.stats?.models) {
              for (const mu of Object.values(event.stats.models)) {
                usage.inputTokens += mu.input_tokens || 0;
                usage.outputTokens += mu.output_tokens || 0;
                usage.cacheReadTokens += mu.cached || 0;
              }
            }
            break;
        }
      });

      stderrReader.on("line", (line) => {
        if (line.trim()) stderrLines.push(line.trim());
      });

      child.on("error", (err) => {
        console.error(`[gemini-adapter:${agentName}] run #${runId} error:`, err);
        finalize(() => reject(err));
      });

      child.on("close", (code) => {
        if (cancelRequested) {
          const err = new Error("Gemini run cancelled.");
          err.cancelled = true;
          finalize(() => reject(err));
          return;
        }
        if (code !== 0) {
          const stderrText = stderrLines.join(" ").toLowerCase();
          let errMsg = `Gemini exited with code ${code}`;
          if (stderrText.includes("gemini_api_key") || stderrText.includes("unauthenticated") || stderrText.includes("credentials")) {
            errMsg = "Gemini認証エラー。`gemini` を一度対話実行して認証、またはGEMINI_API_KEYを設定してください。";
          }
          finalize(() => reject(new Error(errMsg)));
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
