import fs from "node:fs";
import path from "node:path";
import http from "node:http";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function serveFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".bmp": "image/bmp",
    ".html": "text/html; charset=utf-8",
    ".gif": "image/gif",
    ".css": "text/css; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".webp": "image/webp",
  };

  if (!fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const headers = {
    "Content-Type": contentTypes[extension] || "application/octet-stream",
  };
  if (extension === ".html" || extension === ".js" || extension === ".css") {
    headers["Cache-Control"] = "no-store";
  }

  response.writeHead(200, headers);

  fs.createReadStream(filePath).pipe(response);
}

function logRequest(request, pathname) {
  const timestamp = new Date().toISOString();
  console.log(`[http] ${timestamp} ${request.method || "GET"} ${pathname}`);
}

function serveUploadsFile(response, uploadsDir, pathname) {
  const relativePath = decodeURIComponent(pathname.replace(/^\/uploads\//, ""));
  const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const rootDir = path.resolve(uploadsDir);
  const filePath = path.resolve(rootDir, safePath);

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  serveFile(response, filePath);
}

function buildRequestUrl(request) {
  return new URL(request.url || "/", "http://localhost");
}

function getPromptErrorStatus(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    message.includes("実行中") ||
    message.includes("入力待ち") ||
    message.includes("利用制限待ち") ||
    message.includes("未送信の入力があります")
  ) {
    return 409;
  }
  return 400;
}

function isLoopbackRequest(request) {
  const remote = String(request.socket?.remoteAddress || "").trim();
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
}

function hasSensitiveApiAccess(request, config) {
  const headerValue =
    request.headers.authorization ||
    request.headers["x-api-key"] ||
    "";
  const normalizedHeader = String(headerValue).trim();
  const token = String(config?.apiAuth?.token || "").trim();
  if (token) {
    return normalizedHeader === `Bearer ${token}` || normalizedHeader === token;
  }
  return Boolean(config?.apiAuth?.allowLoopback) && isLoopbackRequest(request);
}

function ensureSensitiveApiAccess(request, response, config) {
  if (hasSensitiveApiAccess(request, config)) {
    return true;
  }
  sendJson(response, 403, { error: "Sensitive API access is not authorized." });
  return false;
}

function isPathWithinRoot(filePath, rootDir) {
  const normalizedPath = path.resolve(filePath);
  const normalizedRoot = path.resolve(rootDir);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${path.sep}`);
}

function canViewFilePath(filePath, agentBridge, config) {
  const workspaces = agentBridge?.listWorkspaces?.() ?? [];
  const allowedRoots = [
    config.uploadsDir,
    config.codexWorkdir,
    ...workspaces.map((workspace) => workspace.workdir).filter(Boolean),
  ]
    .map((value) => path.resolve(String(value)))
    .filter(Boolean);
  return allowedRoots.some((rootDir) => isPathWithinRoot(filePath, rootDir));
}

function readTextFileExcerpt(filePath, { start = 1, end = 200 } = {}) {
  const content = fs.readFileSync(filePath, "utf8").replace(/\r/g, "");
  const lines = content.split("\n");
  const normalizedStart = Math.max(1, Number(start) || 1);
  const normalizedEnd = Math.max(normalizedStart, Number(end) || normalizedStart + 199);
  return {
    path: filePath,
    startLine: normalizedStart,
    endLine: Math.min(lines.length, normalizedEnd),
    totalLines: lines.length,
    lines: lines.slice(normalizedStart - 1, normalizedEnd).map((line, index) => ({
      number: normalizedStart + index,
      text: line,
    })),
  };
}

export function createHttpServer({
  config,
  bridge,
  agentBridge,
  bus,
  discord,
  attachments,
  scheduler,
  restartServer,
  ptyService,
}) {
  const httpServer = http.createServer(async (request, response) => {
    try {
      const url = buildRequestUrl(request);
      const pathname = url.pathname;
      logRequest(request, pathname);

      if (pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (pathname === "/api/runtime" && request.method === "GET") {
        const runtimeInfo = bridge.getRuntimeInfo();
        sendJson(response, 200, {
          ...runtimeInfo,
          transportMode: "pty-first",
          legacy: {
            sessionApiEnabled: true,
            sessionCount: bridge.listSessions().length,
            routes: [
              "/api/sessions",
              "/api/sessions/:id",
              "/api/sessions/:id/messages",
              "/api/sessions/:id/settings",
            ],
          },
        });
        return;
      }

      if (pathname === "/api/app-settings" && request.method === "GET") {
        sendJson(response, 200, agentBridge?.getAppSettings?.() ?? { defaultWorkdir: "" });
        return;
      }

      if (pathname === "/api/app-settings" && request.method === "PATCH") {
        const body = await readJsonBody(request);
        const settings = agentBridge?.updateAppSettings?.({
          defaultWorkdir: "defaultWorkdir" in body ? (body.defaultWorkdir?.trim() || "") : undefined,
        }) ?? { defaultWorkdir: "" };
        sendJson(response, 200, settings);
        return;
      }

      if (pathname === "/api/memory/global" && request.method === "GET") {
        sendJson(response, 200, agentBridge.getGlobalMemory());
        return;
      }

      if (pathname === "/api/memory/global" && request.method === "PATCH") {
        const body = await readJsonBody(request);
        sendJson(response, 200, agentBridge.updateGlobalMemory(body.content ?? ""));
        return;
      }

      if (pathname === "/api/workdirs" && request.method === "GET") {
        sendJson(response, 200, bridge.listSelectableWorkdirs());
        return;
      }

      if (pathname === "/api/workdirs/browse" && request.method === "POST") {
        const body = await readJsonBody(request);
        const sessionId = body.sessionId?.trim() || "";
        if (!sessionId) {
          sendJson(response, 400, { error: "sessionId is required" });
          return;
        }

        if (!bridge.getSession(sessionId)) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        const result = await bridge.browseForSessionWorkdir(sessionId);
        sendJson(response, 200, result);
        return;
      }

      if (pathname === "/api/developer/codex-console/open" && request.method === "POST") {
        const result = bridge.openDeveloperConsole();
        const statusCode = result.ok ? 200 : 400;
        sendJson(response, statusCode, result);
        return;
      }

      if (pathname === "/api/server/restart" && request.method === "POST") {
        if (typeof restartServer !== "function") {
          sendJson(response, 400, { error: "Server restart is not available." });
          return;
        }

        sendJson(response, 202, {
          accepted: true,
          message:
            "Restart requested. If the server was launched via start-multiCLI-discord-base.bat or scripts/start-server.cmd, it will come back automatically.",
        });

        queueMicrotask(() => {
          restartServer({ source: "ui", requestedBy: "Local UI" }).catch((error) => {
            console.error("UI restart request failed:", error);
          });
        });
        return;
      }

      if (pathname === "/api/discord/channels" && request.method === "GET") {
        const channels = await discord.getSelectableChannels();
        sendJson(response, 200, { channels });
        return;
      }

      if (pathname === "/api/stream" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const cleanup = bus.addSseClient(response);
        request.on("close", cleanup);
        return;
      }

      if (pathname.startsWith("/uploads/") && request.method === "GET") {
        serveUploadsFile(response, config.uploadsDir, pathname);
        return;
      }

      if (pathname === "/api/files/view" && request.method === "GET") {
        const requestedPath = url.searchParams.get("path") || "";
        if (!requestedPath.trim()) {
          sendJson(response, 400, { error: "path is required" });
          return;
        }
        const filePath = path.resolve(requestedPath);
        if (!canViewFilePath(filePath, agentBridge, config)) {
          sendJson(response, 403, { error: "File path is outside allowed roots." });
          return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          sendJson(response, 404, { error: "File not found" });
          return;
        }
        const extension = path.extname(filePath).toLowerCase();
        if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf"].includes(extension)) {
          sendJson(response, 200, {
            path: filePath,
            kind: "binary",
            downloadUrl: filePath.startsWith(path.resolve(config.uploadsDir))
              ? `/uploads/${encodeURIComponent(path.relative(path.resolve(config.uploadsDir), filePath)).replace(/%5C/g, "/")}`
              : null,
          });
          return;
        }
        sendJson(response, 200, {
          kind: "text",
          ...readTextFileExcerpt(filePath, {
            start: url.searchParams.get("start"),
            end: url.searchParams.get("end"),
          }),
        });
        return;
      }

      // Serve xterm.js library files from node_modules
      if (pathname.startsWith("/xterm/") && request.method === "GET") {
        const rel = pathname.slice("/xterm/".length);
        const allowedFiles = {
          "xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
          "xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
          "addon-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js",
          "addon-search.js": "node_modules/@xterm/addon-search/lib/addon-search.js",
          "addon-web-links.js": "node_modules/@xterm/addon-web-links/lib/addon-web-links.js",
        };
        const target = allowedFiles[rel];
        if (!target) { response.writeHead(404); response.end("Not found"); return; }
        serveFile(response, path.resolve(target));
        return;
      }

      if (pathname === "/api/sessions" && request.method === "GET") {
        sendJson(response, 200, bridge.listSessions());
        return;
      }

      if (pathname === "/api/schedules" && request.method === "GET") {
        sendJson(response, 200, {
          schedules: scheduler.listJobs(),
        });
        return;
      }

      if (pathname === "/api/cron/describe" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!body.cron?.trim()) {
          sendJson(response, 400, { error: "cron is required" });
          return;
        }

        sendJson(response, 200, scheduler.describeCron(body.cron));
        return;
      }

      if (pathname === "/api/schedule-defaults" && request.method === "GET") {
        sendJson(response, 200, bridge.getScheduleDefaults());
        return;
      }

      if (pathname === "/api/schedule-defaults" && request.method === "POST") {
        const body = await readJsonBody(request);
        const defaults = bridge.updateScheduleDefaults({
          model: body.model?.trim() || undefined,
          reasoningEffort: body.reasoningEffort?.trim() || undefined,
          profile: body.profile?.trim() || undefined,
          workdir: body.workdir?.trim() || undefined,
          fastMode: body.fastMode == null ? undefined : Boolean(body.fastMode),
        });
        sendJson(response, 200, defaults);
        return;
      }

      if (pathname === "/api/schedule-defaults/workdir/browse" && request.method === "POST") {
        const body = await readJsonBody(request);
        const result = await bridge.browseForScheduleDefaultsWorkdir(
          body.initialPath?.trim() || undefined,
        );
        sendJson(response, 200, result);
        return;
      }

      if (pathname === "/api/schedules" && request.method === "POST") {
        const body = await readJsonBody(request);
        const schedule = await scheduler.addJob({
          name: body.name,
          cron: body.cron,
          prompt: body.prompt,
          target: body.target,
          timezone: body.timezone,
          active: body.active,
        });
        sendJson(response, 201, schedule);
        return;
      }

      const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleMatch && request.method === "PATCH") {
        const body = await readJsonBody(request);
        const schedule = await scheduler.updateJob(decodeURIComponent(scheduleMatch[1]), {
          cron: body.cron,
          prompt: body.prompt,
          target: body.target,
          timezone: body.timezone,
          active: body.active,
        });
        if (!schedule) {
          sendJson(response, 404, { error: "Schedule not found" });
          return;
        }

        sendJson(response, 200, schedule);
        return;
      }

      if (scheduleMatch && request.method === "DELETE") {
        const deleted = await scheduler.removeJob(decodeURIComponent(scheduleMatch[1]));
        if (!deleted) {
          sendJson(response, 404, { error: "Schedule not found" });
          return;
        }

        sendJson(response, 200, { deleted: true });
        return;
      }

      if (pathname === "/api/sessions" && request.method === "POST") {
        const body = await readJsonBody(request);
        const session = bridge.createSession({
          title: body.title?.trim() || undefined,
          discordChannelId: body.discordChannelId?.trim() || null,
          discordChannelName: body.discordChannelName?.trim() || null,
          model: body.model?.trim() || undefined,
          reasoningEffort: body.reasoningEffort?.trim() || undefined,
          profile: body.profile?.trim() || undefined,
          workdir: body.workdir?.trim() || undefined,
          fastMode: body.fastMode == null ? undefined : Boolean(body.fastMode),
        });
        sendJson(response, 201, session);
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && request.method === "GET") {
        const detail = bridge.getSessionDetail(sessionMatch[1]);
        if (!detail) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        sendJson(response, 200, detail);
        return;
      }

      if (sessionMatch && request.method === "DELETE") {
        const session = bridge.getSession(sessionMatch[1]);
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        const dependentSchedules = scheduler.listJobsReferencingSession(session.id, session.title);
        if (dependentSchedules.length > 0) {
          sendJson(response, 409, {
            error: `This session is used by schedules: ${dependentSchedules
              .map((schedule) => schedule.name)
              .join(", ")}`,
            schedules: dependentSchedules.map((schedule) => schedule.name),
          });
          return;
        }

        const deletedSession = bridge.deleteSession(sessionMatch[1]);

        sendJson(response, 200, { deleted: true, session: deletedSession });
        return;
      }

      const restoreMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/restore$/);
      if (restoreMatch && request.method === "POST") {
        const result = bridge.recoverSessionState(restoreMatch[1]);
        if (!result.session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        const detail = bridge.getSessionDetail(restoreMatch[1]);
        sendJson(response, 200, {
          recovered: result.recovered,
          reason: result.reason,
          session: detail?.session || result.session,
          events: detail?.events || [],
        });
        return;
      }

      const lastAssistantMessageMatch = pathname.match(
        /^\/api\/sessions\/([^/]+)\/last-assistant-message$/,
      );
      if (lastAssistantMessageMatch && request.method === "GET") {
        const result = bridge.getLastAssistantMessage(lastAssistantMessageMatch[1]);
        if (!result) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        if (!String(result.message?.text || "").trim()) {
          sendJson(response, 404, {
            error: "No assistant message was found for this session yet.",
          });
          return;
        }

        sendJson(response, 200, result);
        return;
      }

      const recoverAssistantMessageMatch = pathname.match(
        /^\/api\/sessions\/([^/]+)\/recover-last-assistant-message$/,
      );
      if (recoverAssistantMessageMatch && request.method === "POST") {
        const result = bridge.recoverMissingAssistantMessage(recoverAssistantMessageMatch[1]);
        if (!result) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        const detail = bridge.getSessionDetail(recoverAssistantMessageMatch[1]);
        sendJson(response, 200, {
          ...result,
          session: detail?.session || result.session,
          events: detail?.events || [],
        });
        return;
      }

      const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (messageMatch && request.method === "POST") {
        if (!bridge.getSession(messageMatch[1])) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        const body = await readJsonBody(request);
        const text = body.text?.trim() || "";
        const savedAttachments = await attachments.saveUiAttachments(
          messageMatch[1],
          body.attachments,
        );

        if (!text && savedAttachments.length === 0) {
          sendJson(response, 400, { error: "text or attachments are required" });
          return;
        }

        const result = await bridge.handleIncomingMessage({
          sessionId: messageMatch[1],
          text,
          source: "ui",
          attachments: savedAttachments,
        });

        sendJson(response, 202, { accepted: true, queue: result.queue });
        return;
      }

      const bindMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/discord-bind$/);
      if (bindMatch && request.method === "POST") {
        const body = await readJsonBody(request);
        const session = bridge.bindDiscordChannelWithName(
          bindMatch[1],
          body.channelId?.trim() || null,
          body.channelName?.trim() || null,
        );
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        sendJson(response, 200, session);
        return;
      }

      const settingsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/settings$/);
      if (settingsMatch && request.method === "POST") {
        const body = await readJsonBody(request);
        const session = bridge.updateSessionSettings(settingsMatch[1], {
          model: body.model?.trim() || undefined,
          reasoningEffort: body.reasoningEffort?.trim() || undefined,
          profile: body.profile?.trim() || undefined,
          workdir: body.workdir?.trim() || undefined,
          fastMode:
            body.fastMode == null ? undefined : Boolean(body.fastMode),
        });
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        sendJson(response, 200, session);
        return;
      }

      const renameMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/rename$/);
      if (renameMatch && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!body.title?.trim()) {
          sendJson(response, 400, { error: "title is required" });
          return;
        }

        const session = bridge.renameSession(renameMatch[1], body.title.trim());
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        sendJson(response, 200, session);
        return;
      }

      const stopMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (stopMatch && request.method === "POST") {
        const result = bridge.stopSession(stopMatch[1]);
        if (result.reason === "not_found") {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }

        sendJson(response, 200, result);
        return;
      }

      // ── multiCLI-discord-base: Agent API ──────────────────────────────────────────────
      if (agentBridge) {
        // GET /api/agents — list all agents
        if (pathname === "/api/agents" && request.method === "GET") {
          sendJson(response, 200, agentBridge.listAgents());
          return;
        }

        // POST /api/agents — create custom agent
        if (pathname === "/api/agents" && request.method === "POST") {
          const body = await readJsonBody(request);
          if (!body.name?.trim()) {
            sendJson(response, 400, { error: "name is required" });
            return;
          }
          if (!body.type?.trim()) {
            sendJson(response, 400, { error: "type is required" });
            return;
          }
          try {
            const settings = {
              workdir: body.workdir?.trim() || "",
              planMode: body.planMode?.trim() || "",
              instructions: body.instructions?.trim() || "",
            };
            const reasoningEffort = body.reasoningEffort?.trim() || body.reasoning?.trim() || "";
            if (reasoningEffort) {
              settings.reasoningEffort = reasoningEffort;
            }
            if ("fastMode" in body) {
              settings.fastMode =
                body.fastMode === true || body.fastMode === "fast"
                  ? true
                  : body.fastMode === false || body.fastMode === "flex"
                    ? false
                    : "";
            }
            const agent = agentBridge.createAgent({
              name: body.name.trim(),
              type: body.type.trim(),
              model: body.model?.trim() || "",
              settings,
            });
            sendJson(response, 201, agent);
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // GET /api/workspaces — list workspaces
        if (pathname === "/api/workspaces" && request.method === "GET") {
          sendJson(response, 200, agentBridge.listWorkspaces());
          return;
        }

        // POST /api/workspaces — create workspace
        if (pathname === "/api/workspaces" && request.method === "POST") {
          const body = await readJsonBody(request);
          if (!body.name?.trim()) {
            sendJson(response, 400, { error: "name is required" });
            return;
          }
          const requestedParentAgent = body.parentAgent?.trim();
          const availableAgents = agentBridge.listAgents();
          const parentAgent =
            requestedParentAgent ||
            (availableAgents.length === 1 ? availableAgents[0].name : "");

          if (!parentAgent) {
            sendJson(response, 400, { error: "parentAgent is required" });
            return;
          }
          if (!agentBridge.getAgent(parentAgent)) {
            sendJson(response, 400, { error: `Unknown parentAgent: ${parentAgent}` });
            return;
          }
          try {
            const ws = agentBridge.createWorkspace({
              name: body.name.trim(),
              workdir: body.workdir?.trim() || undefined,
              parentAgent,
              contextInjectionEnabled:
                body.contextInjectionMode === "on"
                  ? true
                  : body.contextInjectionMode === "off"
                    ? false
                    : null,
            });
            sendJson(response, 201, ws);
          } catch (err) {
            sendJson(response, 400, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        // PATCH /api/workspaces/layout — reorder active/inactive sidebar layout
        if (pathname === "/api/workspaces/layout" && request.method === "PATCH") {
          const body = await readJsonBody(request);
          try {
            const workspaces = agentBridge.updateWorkspaceLayout(body.items);
            sendJson(response, 200, workspaces);
          } catch (err) {
            sendJson(response, 400, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        // POST /api/workspaces/:id/activate — switch active workspace
        const wsActivateMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/activate$/);
        if (wsActivateMatch && request.method === "POST") {
          if (!agentBridge.getWorkspace(wsActivateMatch[1])) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          await agentBridge.switchWorkspace(wsActivateMatch[1]);
          sendJson(response, 200, { ok: true, workspaceId: wsActivateMatch[1] });
          return;
        }

        // PATCH /api/workspaces/:id — rename/update workspace
        const wsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
        if (wsMatch && request.method === "PATCH") {
          const body = await readJsonBody(request);
          const contextInjectionEnabled =
            body.contextInjectionMode === "on"
              ? true
              : body.contextInjectionMode === "off"
                ? false
                : body.contextInjectionMode === "default"
                  ? null
                  : undefined;
          const ws = agentBridge.updateWorkspace(wsMatch[1], {
            name: body.name?.trim() || undefined,
            workdir: body.workdir?.trim() || undefined,
            contextInjectionEnabled,
          });
          if (!ws) { sendJson(response, 404, { error: "Workspace not found" }); return; }
          sendJson(response, 200, ws);
          return;
        }

        // DELETE /api/workspaces/:id — delete workspace
        if (wsMatch && request.method === "DELETE") {
          try {
            const ws = await agentBridge.deleteWorkspace(wsMatch[1]);
            if (!ws) { sendJson(response, 404, { error: "Workspace not found" }); return; }
            sendJson(response, 200, { deleted: true, workspace: ws });
          } catch (err) {
            sendJson(response, 400, { error: err.message });
          }
          return;
        }

        const wsCheckpointMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/checkpoints$/);
        if (wsCheckpointMatch && request.method === "GET") {
          const workspaceId = decodeURIComponent(wsCheckpointMatch[1]);
          if (!agentBridge.getWorkspace(workspaceId)) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          sendJson(response, 200, agentBridge.listWorkspaceCheckpoints(workspaceId, Number(url.searchParams.get("limit")) || 20));
          return;
        }

        const wsTerminalStatesMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/terminal-states$/);
        if (wsTerminalStatesMatch && request.method === "GET") {
          const workspaceId = decodeURIComponent(wsTerminalStatesMatch[1]);
          if (!agentBridge.getWorkspace(workspaceId)) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          sendJson(response, 200, agentBridge.listWorkspaceTerminalStates(workspaceId));
          return;
        }

        if (wsCheckpointMatch && request.method === "POST") {
          if (!ensureSensitiveApiAccess(request, response, config)) return;
          const workspaceId = decodeURIComponent(wsCheckpointMatch[1]);
          const body = await readJsonBody(request);
          try {
            const checkpoint = agentBridge.createWorkspaceCheckpoint(workspaceId, {
              agentName: body.agentName?.trim() || null,
              runId: body.runId?.trim() || null,
              kind: body.kind?.trim() || "manual",
              label: body.label?.trim() || "",
              requestedBy: body.requestedBy?.trim() || "HTTP API",
              source: "http",
            });
            sendJson(response, 201, checkpoint);
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        const wsRollbackPreviewMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/rollback\/preview$/);
        if (wsRollbackPreviewMatch && request.method === "POST") {
          const workspaceId = decodeURIComponent(wsRollbackPreviewMatch[1]);
          const body = await readJsonBody(request);
          try {
            sendJson(response, 200, agentBridge.previewWorkspaceRollback(workspaceId, body.checkpointId?.trim() || "", { source: "http" }));
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        const wsRollbackApplyMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/rollback\/apply$/);
        if (wsRollbackApplyMatch && request.method === "POST") {
          if (!ensureSensitiveApiAccess(request, response, config)) return;
          const workspaceId = decodeURIComponent(wsRollbackApplyMatch[1]);
          const body = await readJsonBody(request);
          try {
            sendJson(response, 200, agentBridge.applyWorkspaceRollback(workspaceId, body.checkpointId?.trim() || "", {
              approved: Boolean(body.approved),
              dryRun: Boolean(body.dryRun),
              requestedBy: body.requestedBy?.trim() || "HTTP API",
              source: "http",
            }));
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // GET /api/workspaces/:id/messages — cross-agent workspace timeline
        const wsMsgMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/messages$/);
        if (wsMsgMatch && request.method === "GET") {
          const workspaceId = decodeURIComponent(wsMsgMatch[1]);
          if (!agentBridge.getWorkspace(workspaceId)) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          const limit = parseInt(url.searchParams.get("limit") || "100", 10);
          sendJson(response, 200, agentBridge.listWorkspaceMessages(workspaceId, limit));
          return;
        }

        const wsResumeBindingsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/bindings$/);
        if (wsResumeBindingsMatch && request.method === "GET") {
          const workspaceId = decodeURIComponent(wsResumeBindingsMatch[1]);
          if (!agentBridge.getWorkspace(workspaceId)) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          sendJson(response, 200, agentBridge.listResumeBindings(workspaceId));
          return;
        }

        const wsAuditsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/audits$/);
        if (wsAuditsMatch && request.method === "GET") {
          const workspaceId = decodeURIComponent(wsAuditsMatch[1]);
          if (!agentBridge.getWorkspace(workspaceId)) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          sendJson(response, 200, agentBridge.listOperationAudits(workspaceId, Number(url.searchParams.get("limit")) || 50));
          return;
        }

        const wsMemoryMatch = pathname.match(/^\/api\/memory\/workspaces\/([^/]+)$/);
        if (wsMemoryMatch && request.method === "GET") {
          try {
            sendJson(response, 200, agentBridge.getWorkspaceMemory(decodeURIComponent(wsMemoryMatch[1])));
          } catch (err) {
            sendJson(response, 404, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        const wsConsolidationPreviewMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/memory\/consolidation\/preview$/);
        if (wsConsolidationPreviewMatch && request.method === "GET") {
          try {
            sendJson(response, 200, agentBridge.previewWorkspaceConsolidation(decodeURIComponent(wsConsolidationPreviewMatch[1])));
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        const wsConsolidationApplyMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/memory\/consolidation\/apply$/);
        if (wsConsolidationApplyMatch && request.method === "POST") {
          if (!ensureSensitiveApiAccess(request, response, config)) return;
          const body = await readJsonBody(request);
          try {
            sendJson(response, 200, agentBridge.applyWorkspaceConsolidation(decodeURIComponent(wsConsolidationApplyMatch[1]), {
              approved: Boolean(body.approved),
              requestedBy: body.requestedBy?.trim() || "HTTP API",
              source: "http",
            }));
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        const wsDiaryPreviewMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/memory\/diary\/preview$/);
        if (wsDiaryPreviewMatch && request.method === "GET") {
          try {
            sendJson(response, 200, agentBridge.previewWorkspaceDiary(decodeURIComponent(wsDiaryPreviewMatch[1])));
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        const wsDiaryApplyMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/memory\/diary\/apply$/);
        if (wsDiaryApplyMatch && request.method === "POST") {
          if (!ensureSensitiveApiAccess(request, response, config)) return;
          const body = await readJsonBody(request);
          try {
            sendJson(response, 200, agentBridge.applyWorkspaceDiary(decodeURIComponent(wsDiaryApplyMatch[1]), {
              approved: Boolean(body.approved),
              requestedBy: body.requestedBy?.trim() || "HTTP API",
              source: "http",
            }));
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (pathname === "/api/skills/registry" && request.method === "GET") {
          sendJson(response, 200, agentBridge.getSkillRegistry());
          return;
        }

        const wsSkillSyncMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/skills\/sync$/);
        if (wsSkillSyncMatch && request.method === "POST") {
          const workspaceId = decodeURIComponent(wsSkillSyncMatch[1]);
          const body = await readJsonBody(request);
          try {
            const result =
              body.apply
                ? (() => {
                    if (!ensureSensitiveApiAccess(request, response, config)) return null;
                    return agentBridge.applyWorkspaceSkillSync(workspaceId, {
                      agentName: body.agentName?.trim() || "",
                      requestedBy: body.requestedBy?.trim() || "HTTP API",
                      source: "http",
                    });
                  })()
                : agentBridge.planWorkspaceSkillSync(workspaceId, {
                    agentName: body.agentName?.trim() || "",
                  });
            if (result) {
              sendJson(response, 200, result);
            }
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (wsMemoryMatch && request.method === "PATCH") {
          const body = await readJsonBody(request);
          try {
            sendJson(
              response,
              200,
              agentBridge.updateWorkspaceMemory(decodeURIComponent(wsMemoryMatch[1]), body.content ?? ""),
            );
          } catch (err) {
            sendJson(response, 404, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // GET /api/workspaces/:id/agents — list membership
        const wsAgentsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/agents$/);
        if (wsAgentsMatch && request.method === "GET") {
          const workspaceId = decodeURIComponent(wsAgentsMatch[1]);
          if (!agentBridge.getWorkspace(workspaceId)) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          sendJson(response, 200, agentBridge.listWorkspaceAgents(workspaceId));
          return;
        }

        const wsBindingMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/discord-binding$/);
        if (wsBindingMatch && request.method === "GET") {
          try {
            sendJson(response, 200, agentBridge.listWorkspaceDiscordBindings(wsBindingMatch[1]));
          } catch (err) {
            sendJson(response, 404, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (wsBindingMatch && request.method === "PUT") {
          const body = await readJsonBody(request);
          try {
            const binding = agentBridge.setWorkspaceDiscordBinding(wsBindingMatch[1], {
              channelId: body.channelId?.trim() || "",
              defaultAgent: body.defaultAgent?.trim() || "",
            });
            sendJson(response, 200, binding);
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // POST /api/workspaces/:id/agents — add agent to workspace
        if (wsAgentsMatch && request.method === "POST") {
          const workspaceId = decodeURIComponent(wsAgentsMatch[1]);
          if (!agentBridge.getWorkspace(workspaceId)) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          const body = await readJsonBody(request);
          if (!body.agentName?.trim()) {
            sendJson(response, 400, { error: "agentName is required" });
            return;
          }
          try {
            const result = agentBridge.addWorkspaceAgent({
              workspaceId,
              agentName: body.agentName.trim(),
            });
            sendJson(response, 201, result);
          } catch (err) {
            sendJson(response, 400, { error: err.message });
          }
          return;
        }

        // DELETE /api/workspaces/:id/agents/:agentName — remove agent from workspace
        const wsAgentItemMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)$/);
        if (wsAgentItemMatch && request.method === "DELETE") {
          const workspaceId = decodeURIComponent(wsAgentItemMatch[1]);
          if (!agentBridge.getWorkspace(workspaceId)) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          const removed = agentBridge.removeWorkspaceAgent({
            workspaceId,
            agentName: decodeURIComponent(wsAgentItemMatch[2]),
          });
          sendJson(response, 200, { removed });
          return;
        }

        // POST /api/agents/:name/run — run prompt
        const agentItemMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
        if (agentItemMatch && request.method === "GET") {
          const agent = agentBridge.getAgent(decodeURIComponent(agentItemMatch[1]));
          if (!agent) {
            sendJson(response, 404, { error: "Agent not found" });
            return;
          }
          sendJson(response, 200, agent);
          return;
        }

        if (agentItemMatch && request.method === "PATCH") {
          const agentName = decodeURIComponent(agentItemMatch[1]);
          const body = await readJsonBody(request);
          try {
            const settingsPatch = {};
            if ("workdir" in body) settingsPatch.workdir = body.workdir?.trim() || "";
            if ("reasoning" in body) settingsPatch.reasoning = body.reasoning?.trim() || "";
            if ("reasoningEffort" in body) settingsPatch.reasoningEffort = body.reasoningEffort?.trim() || "";
            if ("planMode" in body) settingsPatch.planMode = body.planMode?.trim() || "";
            if ("instructions" in body) settingsPatch.instructions = body.instructions?.trim() || "";
            if ("fastMode" in body) {
              settingsPatch.fastMode =
                body.fastMode === true || body.fastMode === "fast"
                  ? true
                  : body.fastMode === false || body.fastMode === "flex"
                    ? false
                    : "";
            }
            const agent = await agentBridge.updateAgent(agentName, {
              name: body.name?.trim() || undefined,
              type: body.type?.trim() || undefined,
              model: "model" in body ? body.model?.trim() || "" : undefined,
              settings: settingsPatch,
            });
            sendJson(response, 200, agent);
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (agentItemMatch && request.method === "DELETE") {
          const agentName = decodeURIComponent(agentItemMatch[1]);
          try {
            const agent = await agentBridge.deleteAgent(agentName);
            if (!agent) {
              sendJson(response, 404, { error: "Agent not found" });
              return;
            }
            sendJson(response, 200, { deleted: true, agent });
          } catch (err) {
            sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        const agentRunMatch = pathname.match(/^\/api\/agents\/([^/]+)\/run$/);
        if (agentRunMatch && request.method === "POST") {
          const agentName = decodeURIComponent(agentRunMatch[1]);
          const body = await readJsonBody(request);
          const requestedWorkspaceId = body.workspaceId?.trim();
          const source = typeof body.source === "string" && body.source.trim()
            ? body.source.trim()
            : "ui";
          const includeContext = body.includeContext !== false;
          const inputMode =
            body.inputMode === "slash_command"
              ? "slash_command"
              : "prompt";
          const ws = requestedWorkspaceId
            ? agentBridge.store.getWorkspace(requestedWorkspaceId)
            : agentBridge.getActiveWorkspace();
          if (requestedWorkspaceId && !ws) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          const workspaceId = ws?.id ?? null;
          if (!workspaceId) {
            sendJson(response, 400, { error: "workspaceId is required when no workspace is active" });
            return;
          }
          try {
            const prepared = await agentBridge.preparePrompt({
              agentName,
              workspaceId,
              workdir: body.workdir,
            });
            if (inputMode === "slash_command") {
              await agentBridge.runPrompt({
                agentName,
                prompt: body.prompt,
                workspaceId,
                workdir: body.workdir,
                source,
                includeContext,
                inputMode,
                prepared,
              });
            } else {
              // Fire and forget — result comes via SSE
              agentBridge.runPrompt({
                agentName,
                prompt: body.prompt,
                workspaceId,
                workdir: body.workdir,
                source,
                includeContext,
                inputMode,
                prepared,
              }).catch(() => {});
            }
            sendJson(response, 202, { ok: true, agentName });
          } catch (err) {
            sendJson(response, getPromptErrorStatus(err), {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        const agentPrewarmMatch = pathname.match(/^\/api\/agents\/([^/]+)\/prewarm$/);
        if (agentPrewarmMatch && request.method === "POST") {
          const agentName = decodeURIComponent(agentPrewarmMatch[1]);
          const body = await readJsonBody(request);
          const requestedWorkspaceId = body.workspaceId?.trim();
          if (!requestedWorkspaceId) {
            sendJson(response, 400, { error: "workspaceId is required" });
            return;
          }
          try {
            const terminalState = await agentBridge.prewarmWorkspaceAgent(agentName, requestedWorkspaceId, {
              workdir: body.workdir?.trim() || undefined,
              waitForReadyMs: Number(body.waitForReadyMs) || 4000,
            });
            sendJson(response, 200, {
              ok: true,
              agentName,
              workspaceId: requestedWorkspaceId,
              terminalKey: `${requestedWorkspaceId}:${agentName}`,
              ...terminalState,
            });
          } catch (err) {
            sendJson(response, getPromptErrorStatus(err), {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        const agentResumeMatch = pathname.match(/^\/api\/agents\/([^/]+)\/resume$/);
        if (agentResumeMatch && request.method === "POST") {
          const agentName = decodeURIComponent(agentResumeMatch[1]);
          const body = await readJsonBody(request);
          if (!body.workspaceId?.trim()) {
            sendJson(response, 400, { error: "workspaceId is required" });
            return;
          }
          try {
            sendJson(response, 200, await agentBridge.resumeAgentSession(agentName, body.workspaceId.trim(), {
              workdir: body.workdir?.trim() || undefined,
              waitForReadyMs: Number(body.waitForReadyMs) || 4000,
            }));
          } catch (err) {
            sendJson(response, getPromptErrorStatus(err), { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        const agentRestartMatch = pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
        if (agentRestartMatch && request.method === "POST") {
          if (!ensureSensitiveApiAccess(request, response, config)) return;
          const agentName = decodeURIComponent(agentRestartMatch[1]);
          const body = await readJsonBody(request);
          const workspaceId = body.workspaceId?.trim() || url.searchParams.get("workspace") || "";
          if (!workspaceId) {
            sendJson(response, 400, { error: "workspaceId is required" });
            return;
          }
          try {
            sendJson(response, 200, await agentBridge.restartAgent(agentName, workspaceId, {
              workdir: body.workdir?.trim() || undefined,
              waitForReadyMs: Number(body.waitForReadyMs) || 4000,
              force: Boolean(body.force),
              requestedBy: body.requestedBy?.trim() || "HTTP API",
              source: "http",
            }));
          } catch (err) {
            sendJson(response, getPromptErrorStatus(err), { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // POST /api/agents/:name/cancel — cancel running agent
        const agentCancelMatch = pathname.match(/^\/api\/agents\/([^/]+)\/cancel$/);
        if (agentCancelMatch && request.method === "POST") {
          const agentName = decodeURIComponent(agentCancelMatch[1]);
          const body = await readJsonBody(request);
          const requestedWorkspaceId =
            body.workspaceId?.trim() || url.searchParams.get("workspace") || undefined;
          const ws = requestedWorkspaceId
            ? agentBridge.store.getWorkspace(requestedWorkspaceId)
            : agentBridge.getActiveWorkspace();
          if (requestedWorkspaceId && !ws) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          const workspaceId = ws?.id ?? null;
          if (!workspaceId) {
            sendJson(response, 400, { error: "workspaceId is required when no workspace is active" });
            return;
          }
          agentBridge.cancelAgent(agentName, workspaceId);
          sendJson(response, 200, { ok: true, workspaceId });
          return;
        }

        // POST /api/agents/:name/reset — reset session
        const agentResetMatch = pathname.match(/^\/api\/agents\/([^/]+)\/reset$/);
        if (agentResetMatch && request.method === "POST") {
          const agentName = decodeURIComponent(agentResetMatch[1]);
          const body = await readJsonBody(request);
          const requestedWorkspaceId =
            body.workspaceId?.trim() || url.searchParams.get("workspace") || undefined;
          const ws = requestedWorkspaceId
            ? agentBridge.store.getWorkspace(requestedWorkspaceId)
            : agentBridge.getActiveWorkspace();
          if (requestedWorkspaceId && !ws) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          const workspaceId = ws?.id ?? null;
          if (!workspaceId) {
            sendJson(response, 400, { error: "workspaceId is required when no workspace is active" });
            return;
          }
          agentBridge.resetAgentSession(agentName, workspaceId);
          sendJson(response, 200, { ok: true, workspaceId });
          return;
        }

        // GET /api/agents/:name/terminal-state — PTY status for one workspace-aware terminal
        const agentTerminalStateMatch = pathname.match(/^\/api\/agents\/([^/]+)\/terminal-state$/);
        if (agentTerminalStateMatch && request.method === "GET") {
          const agentName = decodeURIComponent(agentTerminalStateMatch[1]);
          const requestedWorkspaceId = url.searchParams.get("workspace") || undefined;
          const ws = requestedWorkspaceId
            ? agentBridge.store.getWorkspace(requestedWorkspaceId)
            : agentBridge.getActiveWorkspace();
          if (requestedWorkspaceId && !ws) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          const workspaceId = ws?.id ?? null;
          const terminalState = ptyService?.getAgentTerminalState(agentName, workspaceId) ?? {
            status: "idle",
            hasProcess: false,
            readyForPrompt: false,
            lastOutputAt: null,
            runId: null,
            configStale: false,
            configWarning: "",
          };
          sendJson(response, 200, {
            agentName,
            workspaceId,
            terminalKey: workspaceId ? `${workspaceId}:${agentName}` : null,
            ...terminalState,
          });
          return;
        }

        const agentApprovalMatch = pathname.match(/^\/api\/agents\/([^/]+)\/approval$/);
        if (agentApprovalMatch && request.method === "GET") {
          const agentName = decodeURIComponent(agentApprovalMatch[1]);
          const requestedWorkspaceId = url.searchParams.get("workspace") || undefined;
          const ws = requestedWorkspaceId
            ? agentBridge.store.getWorkspace(requestedWorkspaceId)
            : agentBridge.getActiveWorkspace();
          if (requestedWorkspaceId && !ws) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          sendJson(response, 200, {
            agentName,
            workspaceId: ws?.id ?? null,
            approval: ws?.id ? agentBridge.getAgentApprovalState(agentName, ws.id) : null,
          });
          return;
        }

        if (agentApprovalMatch && request.method === "POST") {
          const agentName = decodeURIComponent(agentApprovalMatch[1]);
          const body = await readJsonBody(request);
          const requestedWorkspaceId = body.workspaceId?.trim() || url.searchParams.get("workspace") || undefined;
          const ws = requestedWorkspaceId
            ? agentBridge.store.getWorkspace(requestedWorkspaceId)
            : agentBridge.getActiveWorkspace();
          if (requestedWorkspaceId && !ws) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          const workspaceId = ws?.id ?? null;
          if (!workspaceId) {
            sendJson(response, 400, { error: "workspaceId is required when no workspace is active" });
            return;
          }
          const result = agentBridge.respondToApproval(
            agentName,
            workspaceId,
            body.decision,
            { workdir: body.workdir },
          );
          sendJson(response, result.ok ? 200 : 400, result);
          return;
        }

        const agentMemoryMatch = pathname.match(/^\/api\/memory\/agents\/([^/]+)$/);
        if (agentMemoryMatch && request.method === "GET") {
          try {
            sendJson(response, 200, agentBridge.getAgentMemory(decodeURIComponent(agentMemoryMatch[1])));
          } catch (err) {
            sendJson(response, 404, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (agentMemoryMatch && request.method === "PATCH") {
          const body = await readJsonBody(request);
          try {
            sendJson(
              response,
              200,
              agentBridge.updateAgentMemory(decodeURIComponent(agentMemoryMatch[1]), body.content ?? ""),
            );
          } catch (err) {
            sendJson(response, 404, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // GET /api/agents/:name/messages — chat history
        const agentMsgMatch = pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
        if (agentMsgMatch && request.method === "GET") {
          const agentName = decodeURIComponent(agentMsgMatch[1]);
          const requestedWorkspaceId = url.searchParams.get("workspace") || undefined;
          const ws = requestedWorkspaceId
            ? agentBridge.store.getWorkspace(requestedWorkspaceId)
            : agentBridge.getActiveWorkspace();
          const limit = parseInt(url.searchParams.get("limit") || "100", 10);
          if (requestedWorkspaceId && !ws) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          sendJson(
            response,
            200,
            ws?.id ? agentBridge.listMessages(agentName, ws.id, limit) : []
          );
          return;
        }

        // GET /api/agents/:name/runs — run history
        const agentRunsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/runs$/);
        if (agentRunsMatch && request.method === "GET") {
          const agentName = decodeURIComponent(agentRunsMatch[1]);
          const requestedWorkspaceId = url.searchParams.get("workspace") || undefined;
          const ws = requestedWorkspaceId
            ? agentBridge.store.getWorkspace(requestedWorkspaceId)
            : agentBridge.getActiveWorkspace();
          if (requestedWorkspaceId && !ws) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
          }
          sendJson(response, 200, ws?.id ? agentBridge.listRuns(agentName, ws.id) : []);
          return;
        }

      }
      // ─────────────────────────────────────────────────────────────────────

      const relativePath = pathname === "/" ? "multiCLI-discord-base.html" : pathname.slice(1);
      const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(config.uiDir, safePath);
      serveFile(response, filePath);
    } catch (error) {
      sendJson(response, error?.statusCode || 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Attach PTY WebSocket server after httpServer is created
  if (ptyService) {
    // We defer attach until the server is actually listening
    httpServer._ptyServicePending = ptyService;
  }

  const _origListen = httpServer.listen.bind(httpServer);
  httpServer.listen = function (...args) {
    const result = _origListen(...args);
    if (httpServer._ptyServicePending) {
      httpServer._ptyServicePending.attach(httpServer);
      httpServer._ptyServicePending = null;
    }
    return result;
  };

  return httpServer;
}
