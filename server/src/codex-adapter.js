import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { normalizeCodexEvent } from "./adapters/canonical-events.js";

function buildArgs(config, threadId, sessionConfig, imagePaths = []) {
  const globalOptions = [];
  const execOptions = [];

  if (config.codexSearchEnabled) {
    globalOptions.push("--search");
  }

  if (
    config.codexBypassApprovalsAndSandbox &&
    !config.codexSandboxMode &&
    !config.codexApprovalPolicy
  ) {
    execOptions.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    if (config.codexApprovalPolicy) {
      globalOptions.push("-a", config.codexApprovalPolicy);
    }

    if (config.codexSandboxMode) {
      execOptions.push("-s", config.codexSandboxMode);
    }
  }

  if (sessionConfig.profile && sessionConfig.profile !== "default") {
    execOptions.push("-p", sessionConfig.profile);
  }

  if (sessionConfig.model) {
    execOptions.push("-m", sessionConfig.model);
  }

  if (sessionConfig.reasoningEffort) {
    execOptions.push("-c", `model_reasoning_effort="${sessionConfig.reasoningEffort}"`);
  }

  if (sessionConfig.serviceTier === "fast") {
    execOptions.push("-c", `service_tier="${sessionConfig.serviceTier}"`);
  }

  for (const imagePath of imagePaths) {
    if (imagePath) {
      execOptions.push("--image", imagePath);
    }
  }

  if (threadId) {
    return [...globalOptions, "exec", "resume", ...execOptions, "--json", threadId, "-"];
  }

  return [...globalOptions, "exec", ...execOptions, "--json", "-"];
}

function createCancelledError() {
  const error = new Error("Codex run cancelled by user.");
  error.name = "CodexRunCancelledError";
  error.cancelled = true;
  return error;
}

function ensureFile(logPath) {
  if (!logPath) {
    return;
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "", "utf8");
  }
}

function appendLines(logPath, lines = [], { timestamped = false } = {}) {
  if (!logPath || lines.length === 0) {
    return;
  }

  ensureFile(logPath);
  const normalizedLines = lines.map((line) => String(line ?? ""));
  const chunk = timestamped
    ? normalizedLines.map((line) => `[${new Date().toISOString()}] ${line}`).join("\n")
    : normalizedLines.join("\n");
  fs.appendFileSync(logPath, `${chunk}\n`, "utf8");
}

function appendTimestampedLines(logPath, lines = []) {
  appendLines(logPath, lines, { timestamped: true });
}

function formatElapsedSeconds(startedAt) {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

export class CodexAdapter {
  constructor(config) {
    this.config = config;
    this.command = this.resolveCommand(config.codexCommand);
    this.baseWorkdir = config.codexWorkdir;
    this.developerLogPath = config.codexDeveloperLogPath;
    this.runSequence = 0;
  }

  resolveCommand(command) {
    if (process.platform !== "win32") {
      return command;
    }

    const lowerName = path.basename(command).toLowerCase();
    if (lowerName === "codex" || lowerName === "codex.ps1") {
      return "codex.cmd";
    }

    return command;
  }

  resolveInvocation(threadId, sessionConfig, imagePaths = []) {
    const args = buildArgs(this.config, threadId, sessionConfig, imagePaths);
    if (process.platform === "win32") {
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", this.command, ...args],
      };
    }

    return {
      command: this.command,
      args,
    };
  }

  getGitWorkspaceState(workdir = this.baseWorkdir) {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workdir,
      encoding: "utf8",
      windowsHide: true,
    });

    if (result.status === 0) {
      return {
        ok: true,
        root: String(result.stdout || "").trim() || workdir,
      };
    }

    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    const detail = stderr || stdout || "The configured workdir is not inside a Git repository.";
    return {
      ok: false,
      detail,
      workdir,
    };
  }

  killChild(child) {
    if (!child.pid) {
      return;
    }

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.unref();
      return;
    }

    child.kill("SIGTERM");
  }

  ensureDeveloperLogFile() {
    ensureFile(this.developerLogPath);
  }

  appendDeveloperLog(lines = []) {
    if (lines.length === 0) {
      return;
    }

    appendTimestampedLines(this.developerLogPath, lines);
  }

  openDeveloperConsole() {
    if (process.platform !== "win32") {
      return {
        ok: false,
        reason: "unsupported_platform",
        message: "Developer console is currently supported on Windows only.",
      };
    }

    this.ensureDeveloperLogFile();
    const escapedLogPath = this.developerLogPath.replace(/'/g, "''");
    this.appendDeveloperLog([
      "",
      "===== Developer console attached =====",
      `log: ${this.developerLogPath}`,
      "Waiting for the next Codex CLI run...",
    ]);

    const script = [
      "chcp 65001 > $null",
      "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
      "$OutputEncoding = $utf8NoBom",
      "[Console]::InputEncoding = $utf8NoBom",
      "[Console]::OutputEncoding = $utf8NoBom",
      "$Host.UI.RawUI.WindowTitle = 'CoDiCoDi Developer Console'",
      "Write-Host 'CoDiCoDi Developer Console' -ForegroundColor Cyan",
      `Write-Host 'Watching: ${escapedLogPath}' -ForegroundColor DarkGray`,
      "Write-Host ''",
      `Get-Content -Path '${escapedLogPath}' -Encoding UTF8 -Tail 120 -Wait`,
    ].join("; ");

    const child = spawn(
      "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        "start",
        "\"\"",
        "powershell.exe",
        "-NoLogo",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        cwd: this.baseWorkdir,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.unref();

    return {
      ok: true,
      reason: "opened",
      message: `Developer console opened. Log: ${this.developerLogPath}`,
    };
  }

  runTurn({ threadId, prompt, agentName = "codex", onEvent, onCanonicalEvent, sessionConfig, imagePaths = [], workdir }) {
    const invocation = this.resolveInvocation(threadId, sessionConfig, imagePaths);
    const runId = ++this.runSequence;
    const runStartedAt = Date.now();
    const displayCommand = [invocation.command, ...invocation.args].join(" ");
    const resolvedWorkdir = workdir || this.baseWorkdir;
    this.appendDeveloperLog([
      "",
      `===== Codex run #${runId} started =====`,
      `cwd: ${resolvedWorkdir}`,
      `command: ${displayCommand}`,
      `threadId: ${threadId || "(new thread)"}`,
      `model: ${sessionConfig.model || "(default)"}`,
      `reasoning: ${sessionConfig.reasoningEffort || "(default)"}`,
      `service_tier: ${sessionConfig.serviceTier || "(default)"}`,
      `profile: ${sessionConfig.profile || "default"}`,
      `images: ${imagePaths.length}`,
    ]);
    const child = spawn(invocation.command, invocation.args, {
      cwd: resolvedWorkdir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let activeThreadId = threadId || null;
    const agentMessages = [];
    const rawEvents = [];
    const stderrLines = [];
    let cancelRequested = false;
    let settled = false;

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    const promise = new Promise((resolve, reject) => {
      function finalize(callback) {
        if (settled) {
          return;
        }

        settled = true;
        stdoutReader.close();
        stderrReader.close();
        callback();
      }

      stdoutReader.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        this.appendDeveloperLog([`[stdout] ${trimmed}`]);

        try {
          const event = JSON.parse(trimmed);
          rawEvents.push(event);

          if (event.type === "thread.started" && event.thread_id) {
            activeThreadId = event.thread_id;
          }

          if (
            event.type === "item.completed" &&
            event.item?.type === "agent_message" &&
            event.item?.text
          ) {
            agentMessages.push(event.item.text);
          }

          onEvent?.(event);

          if (onCanonicalEvent) {
            for (const ce of normalizeCodexEvent(event, agentName)) {
              onCanonicalEvent(ce);
            }
          }
        } catch {
          stderrLines.push(`Unparsed stdout: ${trimmed}`);
        }
      });

      stderrReader.on("line", (line) => {
        if (line.trim()) {
          const trimmed = line.trim();
          stderrLines.push(trimmed);
          this.appendDeveloperLog([`[stderr] ${trimmed}`]);
        }
      });

      child.on("error", (error) => {
        this.appendDeveloperLog([
          `===== Codex run #${runId} process error =====`,
          error instanceof Error ? error.message : String(error),
        ]);
        finalize(() => reject(error));
      });

      child.on("close", (code) => {
        if (cancelRequested) {
          this.appendDeveloperLog([
            `===== Codex run #${runId} cancelled =====`,
            `Stopped after ${formatElapsedSeconds(runStartedAt)}s.`,
          ]);
          finalize(() => reject(createCancelledError()));
          return;
        }

        if (code !== 0) {
          this.appendDeveloperLog([
            `===== Codex run #${runId} exited with code ${code} =====`,
            stderrLines.length ? stderrLines.join(" | ") : "(no stderr output)",
            `Failed in ${formatElapsedSeconds(runStartedAt)}s.`,
          ]);
          finalize(() =>
            reject(
              new Error(
                `Codex exited with code ${code}. ${stderrLines.join(" | ")}`.trim(),
              ),
            ),
          );
          return;
        }

        this.appendDeveloperLog([
          `===== Codex run #${runId} completed successfully =====`,
          `Completed in ${formatElapsedSeconds(runStartedAt)}s.`,
        ]);
        finalize(() =>
          resolve({
            threadId: activeThreadId,
            text: agentMessages.join("\n\n").trim(),
            rawEvents,
            stderrLines,
          }),
        );
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    promise.cancel = () => {
      if (settled || cancelRequested) {
        return false;
      }

      cancelRequested = true;
      this.killChild(child);
      return true;
    };

    return promise;
  }

}
