/**
 * multicodi 自動テストスクリプト
 *
 * AIエージェントなしでテストできる範囲:
 *   1. Discord コマンドパーサー
 *   2. Store (DB) 操作
 *   3. REST API エンドポイント
 *   4. コスト集計
 *
 * 使い方: node --env-file=.env scripts/test-multicodi.mjs
 */

import { createDatabase } from "../server/src/db.js";
import { Store } from "../server/src/store.js";
import { calcCost, formatUsage } from "../server/src/pricing.js";
import { normalizeClaudeEvent, normalizeCodexEvent, normalizeGeminiEvent } from "../server/src/adapters/canonical-events.js";
import http from "node:http";
import path from "node:path";

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
function parseAgentCommand(content, agentNames) {
  const trimmed = content.trim();
  if (/^stop\?$/i.test(trimmed)) return { agent: null, verb: "stop", prompt: null };
  if (/^agents?\?$/i.test(trimmed)) return { agent: null, verb: "agents", prompt: null };
  const wsMatch = trimmed.match(/^workspace\?\s*([\s\S]*)$/i);
  if (wsMatch) return { agent: null, verb: "workspace", prompt: wsMatch[1].trim() };
  const costMatch = trimmed.match(/^cost\?\s*(today|week|month|all)?$/i);
  if (costMatch) return { agent: null, verb: "cost", prompt: (costMatch[1] || "all").toLowerCase() };

  const verbMatch = trimmed.match(/^(\S+)\s+(new|stop|reset)\?$/i);
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
  const r = parseAgentCommand("stop?", agents);
  ok("stop? → verb=stop", r?.verb === "stop" && !r?.agent);
}
{
  const r = parseAgentCommand("agents?", agents);
  ok("agents? → verb=agents", r?.verb === "agents");
}
{
  const r = parseAgentCommand("agent?", agents);
  ok("agent? → verb=agents", r?.verb === "agents");
}
{
  const r = parseAgentCommand("workspace?", agents);
  ok("workspace? → verb=workspace, prompt=''", r?.verb === "workspace" && r?.prompt === "");
}
{
  const r = parseAgentCommand("workspace? my-project", agents);
  ok("workspace? my-project → prompt=my-project", r?.verb === "workspace" && r?.prompt === "my-project");
}
{
  const r = parseAgentCommand("cost?", agents);
  ok("cost? → verb=cost, prompt=all", r?.verb === "cost" && r?.prompt === "all");
}
{
  const r = parseAgentCommand("cost? week", agents);
  ok("cost? week → prompt=week", r?.verb === "cost" && r?.prompt === "week");
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
  const r = parseAgentCommand("hanako stop?", agents);
  ok("hanako stop? → verb=stop", r?.agent === "hanako" && r?.verb === "stop");
}
{
  const r = parseAgentCommand("hanako new?", agents);
  ok("hanako new? → verb=new", r?.agent === "hanako" && r?.verb === "new");
}
{
  const r = parseAgentCommand("unknown? hello", agents);
  ok("unknown agent → null", r === null);
}
{
  const r = parseAgentCommand("just a normal message", agents);
  ok("normal message → null", r === null);
}

// ── 2. Pricing / calcCost ──────────────────────────────────────────────────

section("2. Pricing / コスト計算");

{
  const cost = calcCost("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 0 });
  ok("claude-sonnet-4-6 input 1M → $3.00", Math.abs(cost.usd - 3.00) < 0.001);
}
{
  const cost = calcCost("claude-sonnet-4-6", { inputTokens: 0, outputTokens: 1_000_000 });
  ok("claude-sonnet-4-6 output 1M → $15.00", Math.abs(cost.usd - 15.00) < 0.001);
}
{
  const cost = calcCost("gemini-2.5-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  ok("gemini-2.5-flash 1M+1M = $2.80", Math.abs(cost.usd - 2.80) < 0.001);
}
{
  const cost = calcCost("unknown-model-xyz", { inputTokens: 100, outputTokens: 100 });
  ok("unknown model → null", cost === null);
}
{
  const str = formatUsage("claude-sonnet-4-6", { inputTokens: 10000, outputTokens: 5000 });
  ok("formatUsage includes token counts", str.includes("10,000") && str.includes("5,000"));
}
{
  const str = formatUsage("claude-sonnet-4-6", {});
  ok("formatUsage with empty usage → ''", str === "");
}

// ── 3. Canonical Event Normalizer ──────────────────────────────────────────

section("3. Canonical Event Normalizer");

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
  const ws = store.createWorkspace({ name: "test-ws", workdir: "/tmp/test" });
  ok("createWorkspace → id exists", !!ws?.id);
  ok("createWorkspace → name=test-ws", ws?.name === "test-ws");

  const got = store.getWorkspaceByName("test-ws");
  ok("getWorkspaceByName", got?.name === "test-ws");

  const updated = store.updateWorkspace(ws.id, { workdir: "/tmp/updated" });
  ok("updateWorkspace workdir", updated?.workdir === "/tmp/updated");

  const list = store.listWorkspaces();
  ok("listWorkspaces ≥ 1", list.length >= 1);
}

{
  // Agent
  store.upsertAgent({ name: "hanako", type: "claude", model: "claude-sonnet-4-6" });
  const agents2 = db.prepare("SELECT * FROM agents WHERE name='hanako'").all();
  ok("upsertAgent", agents2.length === 1);
}

{
  // Run + cost
  const run = store.startRun({ agentName: "hanako", workspaceId: "default", prompt: "hello", source: "test" });
  ok("startRun → id exists", !!run?.id);
  ok("startRun → status=running", run?.status === "running");

  const completed = store.completeRun(run.id, {
    status: "completed",
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.0105,
  });
  ok("completeRun → status=completed", completed?.status === "completed");
  ok("completeRun → inputTokens=1000", completed?.inputTokens === 1000);
  ok("completeRun → costUsd≈0.0105", Math.abs(completed?.costUsd - 0.0105) < 0.0001);
}

{
  // Message
  store.addMessage({ agentName: "hanako", workspaceId: "default", runId: null, role: "user", content: "テスト", source: "test" });
  store.addMessage({ agentName: "hanako", workspaceId: "default", runId: null, role: "assistant", content: "了解です", source: "agent" });
  const msgs = store.listMessages("hanako", "default", 10);
  ok("addMessage + listMessages → 2 messages", msgs.length === 2);
  ok("listMessages → user first", msgs[0]?.role === "user");
}

{
  // Cost summary
  const summary = store.getCostSummary({ agentName: "hanako", workspaceId: "default" });
  ok("getCostSummary → 1 row", summary.length === 1);
  ok("getCostSummary → totalInputTokens=1000", summary[0]?.totalInputTokens === 1000);
  ok("getCostSummary → totalCostUsd≈0.0105", Math.abs(summary[0]?.totalCostUsd - 0.0105) < 0.0001);
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

const BASE = "http://127.0.0.1:3187";

// Start server in background, run API tests, then shut down
const { spawn } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const serverScript = path.resolve("server/src/index.js");
const serverProc = spawn(process.execPath, ["--env-file=.env", serverScript], {
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
    ok("GET /api/agents → array", Array.isArray(r.json()));
  }

  // Workspaces
  {
    const r = await get(`${BASE}/api/workspaces`);
    ok("GET /api/workspaces → 200", r.status === 200);
    const ws = r.json();
    ok("GET /api/workspaces → array with default", Array.isArray(ws) && ws.some((w) => w.name === "default"));
  }

  // Create workspace
  let newWsId;
  {
    const r = await post(`${BASE}/api/workspaces`, { name: "test-api-ws" });
    ok("POST /api/workspaces → 201", r.status === 201);
    newWsId = r.json()?.id;
    ok("POST /api/workspaces → id exists", !!newWsId);
  }

  // Activate workspace
  {
    const r = await post(`${BASE}/api/workspaces/${newWsId}/activate`, {});
    ok("POST /api/workspaces/:id/activate → 200", r.status === 200);
  }

  // Cost summary
  {
    const r = await get(`${BASE}/api/cost?period=all`);
    ok("GET /api/cost → 200", r.status === 200);
    ok("GET /api/cost → array", Array.isArray(r.json()));
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
    const r = await get(`${BASE}/multicodi.html`);
    ok("GET /multicodi.html → 200", r.status === 200);
  }
  {
    const r = await get(`${BASE}/multicodi.css`);
    ok("GET /multicodi.css → 200", r.status === 200);
  }
  {
    const r = await get(`${BASE}/multicodi.js`);
    ok("GET /multicodi.js → 200", r.status === 200);
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

  // Default workspace delete should fail
  {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(`${BASE}/api/workspaces/default`, { method: "DELETE" }, (res) => {
        let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject); req.end();
    });
    ok("DELETE /api/workspaces/default → 400", r.status === 400);
  }
}

serverProc.kill();

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`テスト結果: ${passed} 通過 / ${failed} 失敗 / 計 ${passed + failed}`);
if (failures.length > 0) {
  console.log(`\n失敗したテスト:`);
  for (const f of failures) console.log(`  ❌ ${f}`);
}
console.log(`${"═".repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
