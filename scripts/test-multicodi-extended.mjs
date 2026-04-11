/**
 * multicodi 拡張テストスクリプト
 *
 * test-multicodi.mjs でカバーしていない領域をテスト:
 *   6. コマンドパーサー エッジケース
 *   7. Pricing エッジケース (prefix matching / cache tokens)
 *   8. Canonical Event Normalizer エッジケース
 *   9. Store エッジケース (period filter / multi-agent / null handling)
 *  10. AgentBridge 単体テスト (モックストア使用)
 *  11. API エラーケース (不正入力・存在しないリソース)
 *  12. HTTP ヘッダー / SSE / xterm 静的ファイル
 *
 * 使い方: node --env-file=.env scripts/test-multicodi-extended.mjs
 */

import { createDatabase } from "../server/src/db.js";
import { Store } from "../server/src/store.js";
import { AgentBridge } from "../server/src/agent-bridge.js";
import { AgentRegistry } from "../server/src/agent-registry.js";
import { calcCost, formatUsage } from "../server/src/pricing.js";
import {
  normalizeClaudeEvent,
  normalizeGeminiEvent,
  normalizeCodexEvent,
} from "../server/src/adapters/canonical-events.js";
import http from "node:http";
import { spawn } from "node:child_process";

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

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

function section(name) {
  console.log(`\n── ${name} ─────────────────────────────────`);
}

// ── 6. コマンドパーサー エッジケース ──────────────────────────────────────

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

section("6. コマンドパーサー エッジケース");

const agents = ["hanako", "taro", "jiro"];

// Case insensitivity
{
  const r = parseAgentCommand("STOP?", agents);
  ok("STOP? (uppercase) → verb=stop", r?.verb === "stop");
}
{
  const r = parseAgentCommand("AGENTS?", agents);
  ok("AGENTS? → verb=agents", r?.verb === "agents");
}
{
  const r = parseAgentCommand("WORKSPACE? foo", agents);
  ok("WORKSPACE? foo → prompt=foo", r?.verb === "workspace" && r?.prompt === "foo");
}
{
  const r = parseAgentCommand("COST? TODAY", agents);
  ok("COST? TODAY → prompt=today (lowercase)", r?.verb === "cost" && r?.prompt === "today");
}

// Leading/trailing whitespace
{
  const r = parseAgentCommand("  hanako? バグ修正  ", agents);
  ok("leading/trailing spaces → trimmed prompt", r?.agent === "hanako" && r?.prompt === "バグ修正");
}

// Multi-line prompt
{
  const r = parseAgentCommand("hanako? 1行目\n2行目\n3行目", agents);
  ok("multi-line prompt → preserved newlines", r?.agent === "hanako" && r?.prompt.includes("\n"));
}

// workspace? with spaces in name
{
  const r = parseAgentCommand("workspace? my cool project", agents);
  ok("workspace? with spaces → full prompt", r?.prompt === "my cool project");
}

// cost? with invalid period → treated as all (no match, returns null)
{
  const r = parseAgentCommand("cost? yesterday", agents);
  ok("cost? invalid period → null (not a cost command)", r === null);
}

// Agent name that starts with a verb keyword
{
  const r = parseAgentCommand("stop?", agents);
  ok("stop? global (not an agent named stop)", r?.verb === "stop" && !r?.agent);
}

// Empty string
{
  const r = parseAgentCommand("", agents);
  ok("empty string → null", r === null);
}

// Just whitespace
{
  const r = parseAgentCommand("   ", agents);
  ok("whitespace only → null", r === null);
}

// Prompt with question mark
{
  const r = parseAgentCommand("hanako? これは何ですか？", agents);
  ok("prompt with ? char → preserved", r?.prompt === "これは何ですか？");
}

// ── 7. Pricing エッジケース ────────────────────────────────────────────────

section("7. Pricing エッジケース");

// Prefix matching
{
  // "claude-opus-4-6-20251101" should match "claude-opus-4-6"
  const cost = calcCost("claude-opus-4-6-20251101", { inputTokens: 1_000_000, outputTokens: 0 });
  ok("prefix match: claude-opus-4-6-20251101 → $15.00", cost && approx(cost.usd, 15.0, 0.001));
}
{
  const cost = calcCost("gemini-2.5-pro-preview", { inputTokens: 1_000_000, outputTokens: 0 });
  ok("prefix match: gemini-2.5-pro-preview → $1.25", cost && approx(cost.usd, 1.25, 0.001));
}

// Cache read tokens
{
  const cost = calcCost("claude-sonnet-4-6", {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
  });
  ok("claude-sonnet-4-6 cacheRead 1M → $0.30", cost && approx(cost.usd, 0.30, 0.001));
}

// Zero tokens
{
  const cost = calcCost("claude-sonnet-4-6", { inputTokens: 0, outputTokens: 0 });
  ok("zero tokens → $0.00", cost && approx(cost.usd, 0, 1e-10));
}

// JPY conversion
{
  const cost = calcCost("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 0 });
  ok("JPY = USD * 150 (rounded)", cost && approx(cost.jpy, Math.round(cost.usd * 150 * 10) / 10, 0.01));
}

// formatUsage with cache tokens
{
  const str = formatUsage("claude-sonnet-4-6", { inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 1000 });
  ok("formatUsage with cache tokens → has cost", str.includes("¥") || str.includes("$"));
}

// formatUsage with null usage
{
  const str = formatUsage("claude-sonnet-4-6", null);
  ok("formatUsage with null → ''", str === "");
}

// ── 8. Canonical Event Normalizer エッジケース ────────────────────────────

section("8. Canonical Event Normalizer エッジケース");

// Claude: error result
{
  const events = normalizeClaudeEvent({ type: "result", is_error: true, result: "timeout" }, "hanako");
  ok("Claude error result → run.error", events[0]?.type === "run.error");
  ok("Claude run.error message", events[0]?.message === "timeout");
}

// Claude: tool_result (tool.done)
{
  const events = normalizeClaudeEvent({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "t-1",
        content: [{ type: "text", text: "file contents" }],
        is_error: false,
      }],
    },
  }, "hanako");
  ok("Claude tool_result → tool.done", events[0]?.type === "tool.done");
  ok("Claude tool.done output", events[0]?.output === "file contents");
  ok("Claude tool.done toolId", events[0]?.toolId === "t-1");
}

// Claude: tool_result error
{
  const events = normalizeClaudeEvent({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "t-2",
        content: [{ type: "text", text: "file not found" }],
        is_error: true,
      }],
    },
  }, "hanako");
  ok("Claude tool_result error → isError=true", events[0]?.isError === true);
}

// Claude: unknown type → empty
{
  const events = normalizeClaudeEvent({ type: "unknown_event_xyz" }, "hanako");
  ok("Claude unknown event → empty array", events.length === 0);
}

// Codex: item.completed agent_message
{
  const events = normalizeCodexEvent({
    type: "item.completed",
    item: { type: "agent_message", text: "完了しました" },
  }, "jiro");
  ok("Codex item.completed → message.done", events[0]?.type === "message.done");
  ok("Codex message.done content", events[0]?.content === "完了しました");
}

// Codex: turn.completed with usage
{
  const events = normalizeCodexEvent({
    type: "turn.completed",
    usage: { input_tokens: 500, output_tokens: 300, cached_input_tokens: 100 },
  }, "jiro");
  ok("Codex turn.completed → run.done", events[0]?.type === "run.done");
  ok("Codex cachedInputTokens=100", events[0]?.usage?.cachedInputTokens === 100);
}

// Codex: turn.failed → run.error
{
  const events = normalizeCodexEvent({
    type: "turn.failed",
    error: { message: "context limit exceeded" },
  }, "jiro");
  ok("Codex turn.failed → run.error", events[0]?.type === "run.error");
  ok("Codex run.error message", events[0]?.message === "context limit exceeded");
}

// Gemini: tool_use
{
  const events = normalizeGeminiEvent({
    type: "tool_use",
    name: "search",
    id: "g-1",
    input: { query: "node-pty" },
  }, "taro");
  ok("Gemini tool_use → tool.start", events[0]?.type === "tool.start");
  ok("Gemini tool.start toolName=search", events[0]?.toolName === "search");
}

// Gemini: result with models breakdown
{
  const events = normalizeGeminiEvent({
    type: "result",
    status: "success",
    stats: {
      models: {
        "gemini-2.5-pro": { input_tokens: 1000, output_tokens: 500, cached: 200 },
      },
      duration_ms: 3500,
    },
  }, "taro");
  ok("Gemini result with models → inputTokens=1000", events[0]?.usage?.inputTokens === 1000);
  ok("Gemini result cachedInputTokens=200", events[0]?.usage?.cachedInputTokens === 200);
  ok("Gemini result durationMs=3500", events[0]?.usage?.durationMs === 3500);
}

// Gemini: error result
{
  const events = normalizeGeminiEvent({
    type: "result",
    status: "error",
    error: "API quota exceeded",
  }, "taro");
  ok("Gemini error result → run.error", events[0]?.type === "run.error");
}

// ── 9. Store エッジケース ────────────────────────────────────────────────

section("9. Store エッジケース");

const db = createDatabase(":memory:", {});
const store = new Store(db);

// getCostSummary: period filter (all runs should be returned since since=very old date)
{
  store.upsertAgent({ name: "alpha", type: "claude", model: "claude-sonnet-4-6" });
  store.upsertAgent({ name: "beta", type: "gemini", model: "gemini-2.5-flash" });

  // Add completed runs for alpha
  const r1 = store.startRun({ agentName: "alpha", workspaceId: "default", prompt: "p1", source: "test" });
  store.completeRun(r1.id, { status: "completed", inputTokens: 100, outputTokens: 50, costUsd: 0.005 });

  const r2 = store.startRun({ agentName: "alpha", workspaceId: "default", prompt: "p2", source: "test" });
  store.completeRun(r2.id, { status: "completed", inputTokens: 200, outputTokens: 100, costUsd: 0.010 });

  // Add completed run for beta
  const r3 = store.startRun({ agentName: "beta", workspaceId: "default", prompt: "p3", source: "test" });
  store.completeRun(r3.id, { status: "completed", inputTokens: 500, outputTokens: 200, costUsd: 0.020 });

  // Add failed run (should NOT appear in cost)
  const r4 = store.startRun({ agentName: "alpha", workspaceId: "default", prompt: "p4", source: "test" });
  store.completeRun(r4.id, { status: "error" });

  const all = store.getCostSummary({});
  ok("getCostSummary all: 2 agents", all.length === 2);

  const alphaRow = all.find((r) => r.agentName === "alpha");
  ok("getCostSummary alpha: runCount=2 (errors excluded)", alphaRow?.runCount === 2);
  ok("getCostSummary alpha: totalInputTokens=300", alphaRow?.totalInputTokens === 300);
  ok("getCostSummary alpha: totalCostUsd≈0.015", approx(alphaRow?.totalCostUsd, 0.015, 1e-6));
}

// getCostSummary: filter by agent
{
  const betaOnly = store.getCostSummary({ agentName: "beta" });
  ok("getCostSummary by agentName: 1 row", betaOnly.length === 1);
  ok("getCostSummary beta: totalCostUsd≈0.020", approx(betaOnly[0]?.totalCostUsd, 0.020, 1e-6));
}

// getCostSummary: no results for non-existent agent
{
  const none = store.getCostSummary({ agentName: "nonexistent" });
  ok("getCostSummary nonexistent agent → []", none.length === 0);
}

// getCostSummary: future 'since' → no results
{
  const future = store.getCostSummary({ since: "2099-01-01 00:00:00" });
  ok("getCostSummary with future since → []", future.length === 0);
}

// deleteWorkspace
{
  const ws = store.createWorkspace({ name: "to-delete" });
  const deleted = store.deleteWorkspace(ws.id);
  ok("deleteWorkspace → returns deleted workspace", deleted?.name === "to-delete");
  const gone = store.getWorkspace(ws.id);
  ok("deleteWorkspace → workspace no longer exists", gone === null);
}

// deleteWorkspace non-existent → null
{
  const r = store.deleteWorkspace("does-not-exist");
  ok("deleteWorkspace non-existent → null", r === null);
}

// updateWorkspace: null workdir (unset)
{
  const ws = store.createWorkspace({ name: "updatable", workdir: "/old" });
  const updated = store.updateWorkspace(ws.id, { workdir: null });
  // null means keep existing (not unset) per implementation
  ok("updateWorkspace null workdir keeps old", updated?.workdir === "/old");
}

// listRuns
{
  const runs = store.listRuns("alpha", "default", 5);
  ok("listRuns → returns runs array", Array.isArray(runs));
  ok("listRuns → most recent first", runs.length > 0 && runs[0].startedAt >= (runs[1]?.startedAt ?? ""));
}

// ── 10. AgentBridge 単体テスト ─────────────────────────────────────────────

section("10. AgentBridge 単体テスト");

{
  // Create an AgentBridge with a real in-memory store and mocked EventBus
  const db2 = createDatabase(":memory:", {});
  const store2 = new Store(db2);

  // Minimal config — no real CLI needed for these tests
  const config = { codexWorkdir: process.cwd() };

  // Mock EventBus
  const publishedEvents = [];
  const mockBus = { publish: (type, payload) => publishedEvents.push({ type, payload }) };

  // AgentRegistry with no agents (env not set)
  const registry = new AgentRegistry(config);

  const ab = new AgentBridge({ agentRegistry: registry, store: store2, bus: mockBus, config });

  // listAgents
  const agents2 = ab.listAgents();
  ok("AgentBridge.listAgents() → array", Array.isArray(agents2));

  // listWorkspaces
  const workspaces = ab.listWorkspaces();
  ok("AgentBridge.listWorkspaces() → has default", workspaces.some((w) => w.name === "default"));

  // createWorkspace
  const ws = ab.createWorkspace({ name: "ab-test-ws" });
  ok("AgentBridge.createWorkspace() → id exists", !!ws?.id);

  // getWorkspaceByName
  const found = ab.getWorkspaceByName("ab-test-ws");
  ok("AgentBridge.getWorkspaceByName() → found", found?.name === "ab-test-ws");

  // bindDiscordChannel
  ab.bindDiscordChannel({ discordChannelId: "ch-ab-1", workspaceId: ws.id, defaultAgent: null });
  const binding = ab.getDiscordBinding("ch-ab-1");
  ok("AgentBridge.bindDiscordChannel + getDiscordBinding", binding?.workspaceId === ws.id);

  // deleteWorkspace
  const del = ab.deleteWorkspace(ws.id);
  ok("AgentBridge.deleteWorkspace() → returns workspace", del?.name === "ab-test-ws");

  // deleteWorkspace("default") throws
  let threw = false;
  try { ab.deleteWorkspace("default"); } catch { threw = true; }
  ok("AgentBridge.deleteWorkspace('default') → throws", threw);

  // getCostSummary (no runs yet)
  const cost = ab.getCostSummary({ period: "all" });
  ok("AgentBridge.getCostSummary() → array", Array.isArray(cost));

  // runPrompt with non-existent agent → throws
  let threw2 = false;
  try { await ab.runPrompt({ agentName: "does-not-exist", prompt: "hi" }); } catch { threw2 = true; }
  ok("AgentBridge.runPrompt unknown agent → throws", threw2);
}

// ── 11. API エラーケース ───────────────────────────────────────────────────

section("11. REST API エラーケース");

// HTTP helpers
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.pathname + opts.search,
      method,
      headers: {
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b, json: () => { try { return JSON.parse(b); } catch { return null; } } }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const BASE = "http://127.0.0.1:3187";

// Start server
const serverProc = spawn(process.execPath, ["--env-file=.env", "server/src/index.js"], {
  stdio: "ignore",
  detached: false,
});

async function waitForServer(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { await request("GET", `${BASE}/api/health`); return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const serverReady = await waitForServer();
ok("サーバー起動 (2回目)", serverReady);

if (serverReady) {
  // Unknown route → 404
  {
    const r = await request("GET", `${BASE}/api/does-not-exist`);
    ok("GET /api/does-not-exist → 404", r.status === 404);
  }

  // xterm unknown file → 404
  {
    const r = await request("GET", `${BASE}/xterm/unknown.js`);
    ok("GET /xterm/unknown.js → 404", r.status === 404);
  }

  // SSE Content-Type — 接続を即破棄してヘッダーだけ確認
  {
    const contentType = await new Promise((resolve) => {
      const req = http.request({ hostname: "127.0.0.1", port: 3187, path: "/api/stream", method: "GET" }, (res) => {
        resolve(res.headers["content-type"] ?? "");
        res.destroy(); // SSE は終わらないので即破棄
      });
      req.on("error", () => resolve(""));
      req.end();
    });
    ok("GET /api/stream → text/event-stream", contentType.includes("text/event-stream"));
  }

  // POST workspace with no name → still creates (name required by convention but no server-side check)
  // Actually let's test PATCH unknown workspace → 404
  {
    const r = await request("PATCH", `${BASE}/api/workspaces/does-not-exist`, { name: "x" });
    ok("PATCH /api/workspaces/non-existent → 404", r.status === 404);
  }

  // DELETE non-existent workspace → 404
  {
    const r = await request("DELETE", `${BASE}/api/workspaces/does-not-exist`);
    ok("DELETE /api/workspaces/non-existent → 404", r.status === 404);
  }

  // POST /api/agents/non-existent/run → 202 accepted (error comes via SSE)
  // We only check the HTTP response, not the SSE stream
  {
    const r = await request("POST", `${BASE}/api/agents/nobody/run`, { prompt: "test" });
    ok("POST /api/agents/nobody/run → 202 (async error via SSE)", r.status === 202);
  }

  // GET /api/agents/nobody/messages → 200 with empty array
  {
    const r = await request("GET", `${BASE}/api/agents/nobody/messages`);
    ok("GET /api/agents/nobody/messages → 200 []", r.status === 200 && Array.isArray(r.json()));
  }

  // GET /api/cost?period=today
  {
    const r = await request("GET", `${BASE}/api/cost?period=today`);
    ok("GET /api/cost?period=today → 200", r.status === 200);
  }

  // GET /api/cost?period=week
  {
    const r = await request("GET", `${BASE}/api/cost?period=week`);
    ok("GET /api/cost?period=week → 200", r.status === 200);
  }

  // Health response shape
  {
    const r = await request("GET", `${BASE}/api/health`);
    const j = r.json();
    ok("health response has ok field", "ok" in j);
  }

  // Create workspace then try to activate it
  {
    const create = await request("POST", `${BASE}/api/workspaces`, { name: "edge-case-ws" });
    ok("create edge-case-ws → 201", create.status === 201);
    const wsId = create.json()?.id;
    if (wsId) {
      const activate = await request("POST", `${BASE}/api/workspaces/${wsId}/activate`, {});
      ok("activate new workspace → 200", activate.status === 200);

      // Switch back to default
      await request("POST", `${BASE}/api/workspaces/default/activate`, {});

      // Delete edge-case-ws
      const del = await request("DELETE", `${BASE}/api/workspaces/${wsId}`);
      ok("delete edge-case-ws → 200", del.status === 200);
    }
  }
}

serverProc.kill();

// ── 12. periodToSince ─────────────────────────────────────────────────────

section("12. periodToSince (コスト期間フィルター)");

// We test via AgentBridge.getCostSummary which internally calls periodToSince
// Seed a store with old and new runs, verify period filters correctly
{
  const db3 = createDatabase(":memory:", {});
  const store3 = new Store(db3);
  const registry3 = new AgentRegistry({ codexWorkdir: process.cwd() });
  const ab3 = new AgentBridge({ agentRegistry: registry3, store: store3, bus: { publish: () => {} }, config: { codexWorkdir: process.cwd() } });

  store3.upsertAgent({ name: "gamma", type: "claude", model: "claude-sonnet-4-6" });

  // Insert a run that "happened" recently (real time)
  const run = store3.startRun({ agentName: "gamma", workspaceId: "default", prompt: "test", source: "test" });
  store3.completeRun(run.id, { status: "completed", inputTokens: 100, outputTokens: 50, costUsd: 0.001 });

  // "all" period should include it
  const all = ab3.getCostSummary({ period: "all" });
  ok("periodToSince all → includes recent run", all.length === 1);

  // "today" should also include it (run just happened)
  const today = ab3.getCostSummary({ period: "today" });
  ok("periodToSince today → includes recent run", today.length === 1);

  // "week" should include it
  const week = ab3.getCostSummary({ period: "week" });
  ok("periodToSince week → includes recent run", week.length === 1);

  // "month" should include it
  const month = ab3.getCostSummary({ period: "month" });
  ok("periodToSince month → includes recent run", month.length === 1);

  // Invalid period → treated as all
  const invalid = ab3.getCostSummary({ period: "decade" });
  ok("periodToSince invalid → all (includes run)", invalid.length === 1);
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`テスト結果: ${passed} 通過 / ${failed} 失敗 / 計 ${passed + failed}`);
if (failures.length > 0) {
  console.log(`\n失敗したテスト:`);
  for (const f of failures) console.log(`  ❌ ${f}`);
}
console.log(`${"═".repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
