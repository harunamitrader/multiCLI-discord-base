/**
 * multiCLI-discord-base 自動テストスクリプト
 *
 * AIエージェントなしでテストできる範囲:
 *   1. Discord コマンドパーサー
 *   2. Store (DB) 操作
 *   3. REST API エンドポイント
 *   4. Canonical Event 正規化
 *
 * 使い方: node --env-file=.env scripts/test-multiCLI-discord-base.mjs
 */

import { createDatabase } from "../server/src/db.js";
import { Store } from "../server/src/store.js";
import { normalizeClaudeEvent, normalizeCodexEvent, normalizeGeminiEvent } from "../server/src/adapters/canonical-events.js";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// ── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, value) {
  if (value) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
    failures.push(label);
  }
}

function section(name) {
  console.log(`\n── ${name} ─────────────────────────────────`);
}

// ── 1. Discord コマンドパーサー ────────────────────────────────────────────

// Inline the parser (copied from discord-adapter.js logic) for testing
function parseLeadingBangCommand(content) {
  const trimmed = String(content ?? "").trim();
  const bangIndex = trimmed.indexOf("!");
  if (bangIndex <= 0) return null;
  return {
    raw: trimmed.slice(0, bangIndex + 1),
    command: trimmed.slice(0, bangIndex + 1).toLowerCase(),
    args: trimmed.slice(bangIndex + 1).trim(),
    trimmed,
  };
}

function parseAgentCommand(content, agentNames) {
  const trimmed = content.trim();
  const bang = parseLeadingBangCommand(trimmed);
  if (bang?.command === "stop!") return { agent: null, verb: "stop", prompt: null };
  if (bang?.command === "agents!") return { agent: null, verb: "agents", prompt: null };
  if (bang?.command === "workspace!") return { agent: null, verb: "workspace", prompt: bang.args };

  const verbMatch = bang?.raw.match(/^(\S+)\s+(new|stop|reset)!$/i);
  if (verbMatch) {
    const name = verbMatch[1].toLowerCase();
    if (agentNames.includes(name)) return { agent: name, verb: verbMatch[2].toLowerCase(), prompt: null };
  }
  const promptMatch = trimmed.match(/^(\S+)\?\s*([\s\S]*)$/);
  if (promptMatch) {
    const name = promptMatch[1].toLowerCase();
    if (agentNames.includes(name)) return { agent: name, verb: null, prompt: promptMatch[2].trim() };
  }
  return null;
}

section("1. Discord コマンドパーサー");

const agents = ["hanako", "taro", "jiro"];

{
  const r = parseAgentCommand("stop!", agents);
  ok("stop! → verb=stop", r?.verb === "stop" && !r?.agent);
}
{
  const r = parseAgentCommand("agents!", agents);
  ok("agents! → verb=agents", r?.verb === "agents");
}
{
  const r = parseAgentCommand("agent!", agents);
  ok("agent! → null", r === null);
}
{
  const r = parseAgentCommand("workspace!", agents);
  ok("workspace! → verb=workspace, prompt=''", r?.verb === "workspace" && r?.prompt === "");
}
{
  const r = parseAgentCommand("workspace! my-project", agents);
  ok("workspace! my-project → prompt=my-project", r?.verb === "workspace" && r?.prompt === "my-project");
}
{
  const r = parseLeadingBangCommand("status! extra text");
  ok("status! extra text → command prefix recognized", r?.command === "status!" && r?.args === "extra text");
}
{
  const r = parseLeadingBangCommand("new! please");
  ok("new! please → command prefix recognized", r?.command === "new!" && r?.args === "please");
}
{
  const r = parseLeadingBangCommand("output! gemini");
  ok("output! gemini → command prefix recognized", r?.command === "output!" && r?.args === "gemini");
}
{
  const r = parseLeadingBangCommand("enter! gemini");
  ok("enter! gemini → command prefix recognized", r?.command === "enter!" && r?.args === "gemini");
}
{
  const r = parseLeadingBangCommand("approve! gemini");
  ok("approve! gemini → command prefix recognized", r?.command === "approve!" && r?.args === "gemini");
}
{
  const r = parseLeadingBangCommand("deny! gemini");
  ok("deny! gemini → command prefix recognized", r?.command === "deny!" && r?.args === "gemini");
}
{
  const r = parseAgentCommand("hanako? バグを直して", agents);
  ok("hanako? <prompt> → agent=hanako", r?.agent === "hanako" && r?.prompt === "バグを直して");
}
{
  const r = parseAgentCommand("hanako?", agents);
  ok("hanako? (no prompt) → agent=hanako, prompt=''", r?.agent === "hanako" && r?.prompt === "");
}
{
  const r = parseAgentCommand("hanako stop!", agents);
  ok("hanako stop! → verb=stop", r?.agent === "hanako" && r?.verb === "stop");
}
{
  const r = parseAgentCommand("hanako new!", agents);
  ok("hanako new! → verb=new", r?.agent === "hanako" && r?.verb === "new");
}
{
  const r = parseAgentCommand("unknown? hello", agents);
  ok("unknown agent → null", r === null);
}
{
  const r = parseAgentCommand("just a normal message", agents);
  ok("normal message → null", r === null);
}

// ── 2. Canonical Event Normalizer ──────────────────────────────────────────

section("2. Canonical Event Normalizer");

{
  const events = normalizeClaudeEvent(
    { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    "hanako"
  );
  ok("Claude text → message.delta", events[0]?.type === "message.delta" && events[0]?.content === "hello");
}
{
  const events = normalizeClaudeEvent(
    { type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 50 } },
    "hanako"
  );
  ok("Claude result → run.done", events[0]?.type === "run.done");
  ok("Claude result → usage.inputTokens=100", events[0]?.usage?.inputTokens === 100);
}
{
  // session.init comes from system event, not result
  const events = normalizeClaudeEvent(
    { type: "system", subtype: "init", session_id: "sid-1", model: "claude-sonnet-4-6" },
    "hanako"
  );
  ok("Claude system.init → session.init", events[0]?.type === "session.init");
  ok("Claude system.init → sessionRef=sid-1", events[0]?.sessionRef === "sid-1");
}
{
  const events = normalizeCodexEvent(
    { type: "thread.started", thread_id: "thread-abc" },
    "jiro"
  );
  ok("Codex thread.started → session.init", events[0]?.type === "session.init");
  ok("Codex thread.started → sessionRef=thread-abc", events[0]?.sessionRef === "thread-abc");
}
{
  // Gemini result uses stats, not usage
  const events = normalizeGeminiEvent(
    { type: "result", status: "success", stats: { input_tokens: 200, output_tokens: 80 } },
    "taro"
  );
  ok("Gemini result → run.done", events[0]?.type === "run.done");
  ok("Gemini result → usage.inputTokens=200", events[0]?.usage?.inputTokens === 200);
}
{
  const events = normalizeClaudeEvent(
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", id: "t-1", input: { path: "/foo" } }] } },
    "hanako"
  );
  ok("Claude tool_use → tool.start", events[0]?.type === "tool.start");
  ok("Claude tool.start → toolName=Read", events[0]?.toolName === "Read");
}

// ── 4. Store (DB) 操作 ────────────────────────────────────────────────────

section("4. Store / DB 操作");

// Use in-memory DB for testing
const db = createDatabase(":memory:", {});
const store = new Store(db);

{
  // Workspace
  const ws = store.createWorkspace({
    name: "test-ws",
    workdir: "/tmp/test",
    contextInjectionEnabled: false,
  });
  ok("createWorkspace → id exists", !!ws?.id);
  ok("createWorkspace → name=test-ws", ws?.name === "test-ws");
  ok("createWorkspace → contextInjectionEnabled=false", ws?.contextInjectionEnabled === false);
  ok("createWorkspace → first workspace is sidebar-active", ws?.isSidebarActive === true);
  ok("createWorkspace → first workspace sortOrder=0", ws?.sortOrder === 0);

  const got = store.getWorkspaceByName("test-ws");
  ok("getWorkspaceByName", got?.name === "test-ws");
  ok("getWorkspaceByName → contextInjectionEnabled=false", got?.contextInjectionEnabled === false);

  const updated = store.updateWorkspace(ws.id, {
    workdir: "/tmp/updated",
    contextInjectionEnabled: true,
  });
  ok("updateWorkspace workdir", updated?.workdir === "/tmp/updated");
  ok("updateWorkspace contextInjectionEnabled", updated?.contextInjectionEnabled === true);

  const list = store.listWorkspaces();
  ok("listWorkspaces ≥ 1", list.length >= 1);
}

const storeWorkspaceId = store.getWorkspaceByName("test-ws")?.id;

{
  // Agent
  store.upsertAgent({ name: "hanako", type: "claude", model: "claude-sonnet-4-6" });
  const agents2 = db.prepare("SELECT * FROM agents WHERE name='hanako'").all();
  ok("upsertAgent", agents2.length === 1);
}

{
  // Run completion
  const run = store.startRun({ agentName: "hanako", workspaceId: storeWorkspaceId, prompt: "hello", source: "test" });
  ok("startRun → id exists", !!run?.id);
  ok("startRun → status=running", run?.status === "running");

  const completed = store.completeRun(run.id, {
    status: "completed",
  });
  ok("completeRun → status=completed", completed?.status === "completed");
}

{
  const run = store.startRun({ agentName: "hanako", workspaceId: storeWorkspaceId, prompt: "recover", source: "test" });
  const recovered = store.recoverRun(run.id, "interrupted");
  ok("recoverRun → status=interrupted", recovered?.status === "interrupted");
}

{
  // Message
  store.addMessage({ agentName: "hanako", workspaceId: storeWorkspaceId, runId: null, role: "user", content: "テスト", source: "test" });
  store.addMessage({ agentName: "hanako", workspaceId: storeWorkspaceId, runId: null, role: "assistant", content: "了解です", source: "agent" });
  const msgs = store.listMessages("hanako", storeWorkspaceId, 10);
  ok("addMessage + listMessages → 2 messages", msgs.length === 2);
  ok("listMessages → user first", msgs[0]?.role === "user");
}

{
  // Discord binding
  const ws = store.createWorkspace({ name: "discord-ws" });
  store.upsertDiscordBinding({ discordChannelId: "ch-001", workspaceId: ws.id, defaultAgent: "hanako" });
  const binding = store.getDiscordBinding("ch-001");
  ok("upsertDiscordBinding + getDiscordBinding", binding?.workspaceId === ws.id);
  ok("getDiscordBinding → defaultAgent=hanako", binding?.defaultAgent === "hanako");
  ok("getDiscordBinding non-existent → null", store.getDiscordBinding("no-such-ch") == null);
}

// ── 5. REST API (live server) ──────────────────────────────────────────────

section("5. REST API (ライブサーバー)");

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body, json: () => JSON.parse(body) }));
    }).on("error", reject);
  });
}

function post(url, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname, port: opts.port, path: opts.pathname + opts.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body, json: () => JSON.parse(body) }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function patch(url, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname, port: opts.port, path: opts.pathname + opts.search,
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body, json: () => JSON.parse(body) }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const PORT = 3300 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiCLI-discord-base-test-basic-"));

// Start server in background, run API tests, then shut down
const { spawn } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const serverScript = path.resolve("server/src/index.js");
const serverProc = spawn(process.execPath, ["--env-file=.env", serverScript], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: tempDataDir,
    DISCORD_BOT_TOKEN: "",
    DISCORD_ALLOWED_GUILD_IDS: "",
    DISCORD_ALLOWED_CHANNEL_IDS: "",
    FILE_WATCH_ENABLED: "false",
    FILE_WATCH_ROOT: "",
    FILE_LOG_CHANNEL_ID: "",
  },
  stdio: "ignore",
  detached: false,
});

// Wait for server to be ready
async function waitForServer(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await get(`${BASE}/api/health`);
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const serverReady = await waitForServer();
ok("サーバー起動", serverReady);

if (serverReady) {
  let liveAgentList = [];

  // Health
  {
    const r = await get(`${BASE}/api/health`);
    ok("GET /api/health → 200", r.status === 200);
    ok("GET /api/health → ok:true", r.json()?.ok === true);
  }

  // Agents (empty — no AGENT_* env vars in test)
  {
    const r = await get(`${BASE}/api/agents`);
    ok("GET /api/agents → 200", r.status === 200);
    liveAgentList = Array.isArray(r.json()) ? r.json() : [];
    ok("GET /api/agents → array", Array.isArray(liveAgentList));
  }

  // Workspaces
  {
    const r = await get(`${BASE}/api/workspaces`);
    ok("GET /api/workspaces → 200", r.status === 200);
    const ws = r.json();
    ok("GET /api/workspaces → array", Array.isArray(ws));
    ok("GET /api/workspaces → initial empty array", Array.isArray(ws) && ws.length === 0);
  }

  {
    const r = await get(`${BASE}/api/app-settings`);
    ok("GET /api/app-settings → 200", r.status === 200);
    ok("GET /api/app-settings → defaultWorkdir exists", typeof r.json()?.defaultWorkdir === "string");
  }

  // Create workspace
  let newWsId;
  {
    const parentAgent = liveAgentList[0]?.name;
    const r = await post(
      `${BASE}/api/workspaces`,
      parentAgent
        ? { name: "test-api-ws", parentAgent, contextInjectionMode: "off" }
        : { name: "test-api-ws", contextInjectionMode: "off" }
    );
    ok("POST /api/workspaces → 201", r.status === 201);
    newWsId = r.json()?.id;
    ok("POST /api/workspaces → id exists", !!newWsId);
    ok("POST /api/workspaces → contextInjectionEnabled=false", r.json()?.contextInjectionEnabled === false);
  }

  {
    const r = await patch(`${BASE}/api/workspaces/${newWsId}`, {
      contextInjectionMode: "default",
    });
    ok("PATCH /api/workspaces/:id → 200", r.status === 200);
    ok("PATCH /api/workspaces/:id → contextInjectionEnabled=null", r.json()?.contextInjectionEnabled === null);
  }

  // Activate workspace
  {
    const r = await post(`${BASE}/api/workspaces/${newWsId}/activate`, {});
    ok("POST /api/workspaces/:id/activate → 200", r.status === 200);
  }

  {
    const payload = JSON.stringify({ defaultWorkdir: process.cwd() });
    const r = await new Promise((resolve, reject) => {
      const req = http.request(`${BASE}/api/app-settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body, json: () => JSON.parse(body) }));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    ok("PATCH /api/app-settings → 200", r.status === 200);
    ok("PATCH /api/app-settings → defaultWorkdir saved", r.json()?.defaultWorkdir === process.cwd());
  }

  // xterm static files
  {
    const r = await get(`${BASE}/xterm/xterm.js`);
    ok("GET /xterm/xterm.js → 200", r.status === 200);
  }
  {
    const r = await get(`${BASE}/xterm/xterm.css`);
    ok("GET /xterm/xterm.css → 200", r.status === 200);
  }
  {
    const r = await get(`${BASE}/xterm/addon-fit.js`);
    ok("GET /xterm/addon-fit.js → 200", r.status === 200);
  }

  // UI files
  {
    const r = await get(`${BASE}/multiCLI-discord-base.html`);
    ok("GET /multiCLI-discord-base.html → 200", r.status === 200);
  }
  {
    const r = await get(`${BASE}/multiCLI-discord-base.css`);
    ok("GET /multiCLI-discord-base.css → 200", r.status === 200);
  }
  {
    const r = await get(`${BASE}/multiCLI-discord-base.js`);
    ok("GET /multiCLI-discord-base.js → 200", r.status === 200);
  }

  // Delete workspace
  {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(`${BASE}/api/workspaces/${newWsId}`, { method: "DELETE" }, (res) => {
        let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode }));
      });
      req.on("error", reject); req.end();
    });
    ok("DELETE /api/workspaces/:id → 200", r.status === 200);
  }

}

serverProc.kill();
await new Promise((resolve) => {
  if (serverProc.exitCode !== null) {
    resolve();
    return;
  }
  serverProc.once("exit", () => resolve());
});
fs.rmSync(tempDataDir, { recursive: true, force: true });

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`テスト結果: ${passed} 通過 / ${failed} 失敗 / 計 ${passed + failed}`);
if (failures.length > 0) {
  console.log(`\n失敗したテスト:`);
  for (const f of failures) console.log(`  ❌ ${f}`);
}
console.log(`${"═".repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
