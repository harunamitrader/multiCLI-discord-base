import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

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

  if (sessionConfig.serviceTier) {
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

export class CodexAdapter {
  constructor(config) {
    this.config = config;
    this.command = this.resolveCommand(config.codexCommand);
    this.workdir = config.codexWorkdir;
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

  runTurn({ threadId, prompt, onEvent, sessionConfig, imagePaths = [] }) {
    const invocation = this.resolveInvocation(threadId, sessionConfig, imagePaths);
    const child = spawn(invocation.command, invocation.args, {
      cwd: this.workdir,
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
        } catch {
          stderrLines.push(`Unparsed stdout: ${trimmed}`);
        }
      });

      stderrReader.on("line", (line) => {
        if (line.trim()) {
          stderrLines.push(line.trim());
        }
      });

      child.on("error", (error) => {
        finalize(() => reject(error));
      });

      child.on("close", (code) => {
        if (cancelRequested) {
          finalize(() => reject(createCancelledError()));
          return;
        }

        if (code !== 0) {
          finalize(() =>
            reject(
              new Error(
                `Codex exited with code ${code}. ${stderrLines.join(" | ")}`.trim(),
              ),
            ),
          );
          return;
        }

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
