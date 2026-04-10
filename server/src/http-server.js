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

  response.writeHead(200, {
    "Content-Type": contentTypes[extension] || "application/octet-stream",
  });

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

export function createHttpServer({
  config,
  bridge,
  agentBridge,
  bus,
  discord,
  attachments,
  scheduler,
  restartServer,
}) {
  return http.createServer(async (request, response) => {
    try {
      const url = buildRequestUrl(request);
      const pathname = url.pathname;
      logRequest(request, pathname);

      if (pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (pathname === "/api/runtime" && request.method === "GET") {
        sendJson(response, 200, bridge.getRuntimeInfo());
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
            "Restart requested. If the server was launched via codicodi-server.cmd or scripts/start-server.cmd, it will come back automatically.",
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

      // ── multicodi: Agent API ──────────────────────────────────────────────
      if (agentBridge) {
        // GET /api/agents — list all agents
        if (pathname === "/api/agents" && request.method === "GET") {
          sendJson(response, 200, agentBridge.listAgents());
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
          const ws = agentBridge.createWorkspace({ name: body.name, workdir: body.workdir });
          sendJson(response, 201, ws);
          return;
        }

        // POST /api/workspaces/:id/activate — switch active workspace
        const wsActivateMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/activate$/);
        if (wsActivateMatch && request.method === "POST") {
          await agentBridge.switchWorkspace(wsActivateMatch[1]);
          sendJson(response, 200, { ok: true, workspaceId: wsActivateMatch[1] });
          return;
        }

        // PATCH /api/workspaces/:id — rename workspace
        const wsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
        if (wsMatch && request.method === "PATCH") {
          const body = await readJsonBody(request);
          const ws = agentBridge.renameWorkspace(wsMatch[1], body.name?.trim());
          if (!ws) { sendJson(response, 404, { error: "Workspace not found" }); return; }
          sendJson(response, 200, ws);
          return;
        }

        // DELETE /api/workspaces/:id — delete workspace
        if (wsMatch && request.method === "DELETE") {
          try {
            const ws = agentBridge.deleteWorkspace(wsMatch[1]);
            if (!ws) { sendJson(response, 404, { error: "Workspace not found" }); return; }
            sendJson(response, 200, { deleted: true, workspace: ws });
          } catch (err) {
            sendJson(response, 400, { error: err.message });
          }
          return;
        }

        // POST /api/agents/:name/run — run prompt
        const agentRunMatch = pathname.match(/^\/api\/agents\/([^/]+)\/run$/);
        if (agentRunMatch && request.method === "POST") {
          const agentName = agentRunMatch[1];
          const body = await readJsonBody(request);
          const ws = agentBridge.getActiveWorkspace();
          // Fire and forget — result comes via SSE
          agentBridge.runPrompt({
            agentName,
            prompt: body.prompt,
            workspaceId: ws?.id ?? "default",
            workdir: body.workdir,
            source: "ui",
          }).catch(() => {});
          sendJson(response, 202, { ok: true, agentName });
          return;
        }

        // POST /api/agents/:name/cancel — cancel running agent
        const agentCancelMatch = pathname.match(/^\/api\/agents\/([^/]+)\/cancel$/);
        if (agentCancelMatch && request.method === "POST") {
          agentBridge.cancelAgent(agentCancelMatch[1]);
          sendJson(response, 200, { ok: true });
          return;
        }

        // POST /api/agents/:name/reset — reset session
        const agentResetMatch = pathname.match(/^\/api\/agents\/([^/]+)\/reset$/);
        if (agentResetMatch && request.method === "POST") {
          const ws = agentBridge.getActiveWorkspace();
          agentBridge.resetAgentSession(agentResetMatch[1], ws?.id ?? "default");
          sendJson(response, 200, { ok: true });
          return;
        }

        // GET /api/agents/:name/messages — chat history
        const agentMsgMatch = pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
        if (agentMsgMatch && request.method === "GET") {
          const agentName = agentMsgMatch[1];
          const ws = agentBridge.getActiveWorkspace();
          const limit = parseInt(url.searchParams.get("limit") || "100", 10);
          sendJson(response, 200, agentBridge.listMessages(agentName, ws?.id ?? "default", limit));
          return;
        }

        // GET /api/agents/:name/runs — run history
        const agentRunsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/runs$/);
        if (agentRunsMatch && request.method === "GET") {
          const agentName = agentRunsMatch[1];
          const ws = agentBridge.getActiveWorkspace();
          sendJson(response, 200, agentBridge.listRuns(agentName, ws?.id ?? "default"));
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
      const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(config.uiDir, safePath);
      serveFile(response, filePath);
    } catch (error) {
      sendJson(response, error?.statusCode || 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
