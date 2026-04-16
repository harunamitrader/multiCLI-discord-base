/**
 * multiCLI-discord-base 拡張テストスクリプト
 *
 * test-multiCLI-discord-base.mjs でカバーしていない領域をテスト:
 *   6. コマンドパーサー エッジケース
 *   7. Pricing エッジケース (prefix matching / cache tokens)
 *   8. Canonical Event Normalizer エッジケース
 *   9. Store エッジケース (period filter / multi-agent / null handling)
 *  10. AgentBridge 単体テスト (モックストア使用)
 *  11. API エラーケース (不正入力・存在しないリソース)
 *  12. HTTP ヘッダー / SSE / xterm 静的ファイル
 *
 * 使い方: node --env-file=.env scripts/test-multiCLI-discord-base-extended.mjs
 */

import { createDatabase } from "../server/src/db.js";
import { Store } from "../server/src/store.js";
import { AgentBridge } from "../server/src/agent-bridge.js";
import { DiscordAdapter, __testHooks as discordTestHooks } from "../server/src/discord-adapter.js";
import { calcCost, formatUsage } from "../server/src/pricing.js";
import { PtyService, __testHooks as ptyTestHooks } from "../server/src/pty-service.js";
import {
  normalizeClaudeEvent,
  normalizeGeminiEvent,
  normalizeCodexEvent,
} from "../server/src/adapters/canonical-events.js";
import http from "node:http";
import { spawn } from "node:child_process";
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
const primaryWorkspace = store.createWorkspace({ name: "primary-workspace" });
const primaryWorkspaceId = primaryWorkspace.id;

// getCostSummary: period filter (all runs should be returned since since=very old date)
{
  store.upsertAgent({ name: "alpha", type: "claude", model: "claude-sonnet-4-6" });
  store.upsertAgent({ name: "beta", type: "gemini", model: "gemini-2.5-flash" });

  // Add completed runs for alpha
  const r1 = store.startRun({ agentName: "alpha", workspaceId: primaryWorkspaceId, prompt: "p1", source: "test" });
  store.completeRun(r1.id, { status: "completed", inputTokens: 100, outputTokens: 50, costUsd: 0.005 });

  const r2 = store.startRun({ agentName: "alpha", workspaceId: primaryWorkspaceId, prompt: "p2", source: "test" });
  store.completeRun(r2.id, { status: "completed", inputTokens: 200, outputTokens: 100, costUsd: 0.010 });

  // Add completed run for beta
  const r3 = store.startRun({ agentName: "beta", workspaceId: primaryWorkspaceId, prompt: "p3", source: "test" });
  store.completeRun(r3.id, { status: "completed", inputTokens: 500, outputTokens: 200, costUsd: 0.020 });

  // Add failed run (should NOT appear in cost)
  const r4 = store.startRun({ agentName: "alpha", workspaceId: primaryWorkspaceId, prompt: "p4", source: "test" });
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

// deleteWorkspace: deleting active workspace promotes another workspace
{
  const dbDelete = createDatabase(":memory:", {});
  const storeDelete = new Store(dbDelete);
  const defaultWs = storeDelete.createWorkspace({ name: "default-like" });
  const replacement = storeDelete.createWorkspace({ name: "replacement-workspace" });
  const deletedDefault = storeDelete.deleteWorkspace(defaultWs.id);
  ok("deleteWorkspace active workspace → returns deleted workspace", deletedDefault?.id === defaultWs.id);
  ok("deleteWorkspace active workspace → workspace no longer exists", storeDelete.getWorkspace(defaultWs.id) === null);
  ok("deleteWorkspace active workspace → another workspace becomes active", storeDelete.getActiveWorkspace()?.id === replacement.id);
}

// deleteWorkspace non-existent → null
{
  const r = store.deleteWorkspace("does-not-exist");
  ok("deleteWorkspace non-existent → null", r === null);
}

// deleteAgent cascades workspace/session/run/message/discord cleanup
{
  const dbDeleteAgent = createDatabase(":memory:", {});
  const storeDeleteAgent = new Store(dbDeleteAgent);
  storeDeleteAgent.upsertAgent({
    name: "deleteme",
    type: "gemini",
    model: "gemini-2.5-flash",
    status: "stopped",
    enabled: true,
    settings: {},
  });
  const wsDeleteAgent = storeDeleteAgent.createWorkspace({ name: "agent-delete-ws" });
  storeDeleteAgent.addWorkspaceAgent({ workspaceId: wsDeleteAgent.id, agentName: "deleteme", isParent: true });
  const runDeleteAgent = storeDeleteAgent.startRun({
    agentName: "deleteme",
    workspaceId: wsDeleteAgent.id,
    prompt: "hello",
    source: "ui",
  });
  storeDeleteAgent.addMessage({
    agentName: "deleteme",
    workspaceId: wsDeleteAgent.id,
    runId: runDeleteAgent.id,
    role: "user",
    content: "hello",
    source: "ui",
  });
  storeDeleteAgent.upsertAgentSession({
    agentName: "deleteme",
    workspaceId: wsDeleteAgent.id,
    providerSessionRef: "session-1",
    model: "gemini-2.5-flash",
    workdir: "/tmp",
    lastRunState: "idle",
  });
  storeDeleteAgent.upsertDiscordBinding({
    discordChannelId: "delete-agent-channel",
    workspaceId: wsDeleteAgent.id,
    defaultAgent: "deleteme",
  });
  const deletedAgent = storeDeleteAgent.deleteAgent("deleteme");
  ok("deleteAgent → returns deleted agent", deletedAgent?.name === "deleteme");
  ok("deleteAgent → agent removed", storeDeleteAgent.getAgent("deleteme") === null);
  ok("deleteAgent → workspace membership removed", storeDeleteAgent.listWorkspaceAgents(wsDeleteAgent.id).length === 0);
  ok("deleteAgent → agent session removed", storeDeleteAgent.getAgentSession("deleteme", wsDeleteAgent.id) === null);
  ok("deleteAgent → runs removed", storeDeleteAgent.listRuns("deleteme", wsDeleteAgent.id, 10).length === 0);
  ok("deleteAgent → messages removed", storeDeleteAgent.listMessages("deleteme", wsDeleteAgent.id, 10).length === 0);
  ok(
    "deleteAgent → discord default agent cleared",
    storeDeleteAgent.getDiscordBinding("delete-agent-channel")?.defaultAgent === null,
  );
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
  const runs = store.listRuns("alpha", primaryWorkspaceId, 5);
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

  // Minimal registry stub — this section only exercises AgentBridge/store behavior
  const registry = {
    setStore() {},
    switchWorkspace() {},
    list: () => [],
    get: () => null,
  };

  const ab = new AgentBridge({ agentRegistry: registry, store: store2, bus: mockBus, config });

  // listAgents
  const agents2 = ab.listAgents();
  ok("AgentBridge.listAgents() → array", Array.isArray(agents2));

  // listWorkspaces
  const workspaces = ab.listWorkspaces();
  ok("AgentBridge.listWorkspaces() → initial empty array", Array.isArray(workspaces) && workspaces.length === 0);

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
  ab.bindDiscordChannel({ discordChannelId: "ch-ab-2", workspaceId: ws.id, defaultAgent: null });
  ok("AgentBridge.bindDiscordChannel keeps one channel per workspace", ab.listWorkspaceDiscordBindings(ws.id).length === 1);
  ok("AgentBridge.bindDiscordChannel replaces previous channel binding", ab.getDiscordBinding("ch-ab-1") === null);
  ok("AgentBridge.bindDiscordChannel latest channel wins", ab.getDiscordBinding("ch-ab-2")?.workspaceId === ws.id);

  // deleteWorkspace leaves zero workspaces allowed
  const delWorkspace = await ab.deleteWorkspace(ws.id);
  ok("AgentBridge.deleteWorkspace(workspace) → returns workspace", delWorkspace?.id === ws.id);
  ok("AgentBridge.deleteWorkspace(last workspace) → zero workspaces allowed", ab.listWorkspaces().length === 0);

  // getCostSummary (no runs yet)
  const cost = ab.getCostSummary({ period: "all" });
  ok("AgentBridge.getCostSummary() → array", Array.isArray(cost));

  // runPrompt with non-existent agent → throws
  let threw2 = false;
  try { await ab.runPrompt({ agentName: "does-not-exist", prompt: "hi" }); } catch { threw2 = true; }
  ok("AgentBridge.runPrompt unknown agent → throws", threw2);
}

{
  const dbGeminiPersist = createDatabase(":memory:", {});
  const storeGeminiPersist = new Store(dbGeminiPersist);
  const workspaceGeminiPersist = storeGeminiPersist.createWorkspace({ name: "gemini-persist" });
  const registryGeminiPersist = {
    setStore() {},
    hydrateFromStore() {},
    switchWorkspace() {},
    list: () => [],
    get: (name) => (name === "gemini2" ? { name: "gemini2", type: "gemini", settings: {} } : null),
  };
  const abGeminiPersist = new AgentBridge({
    agentRegistry: registryGeminiPersist,
    store: storeGeminiPersist,
    bus: { publish() {}, on() {} },
    config: { codexWorkdir: process.cwd() },
    ptyService: {
      async assertPromptReady() {},
      async sendPrompt() {
        return { text: "FIX12-C インタラク ション", finalStatus: "completed" };
      },
      getAgentTerminalState() {
        return { status: "idle" };
      },
    },
  });
  const runResult = await abGeminiPersist.runPrompt({
    agentName: "gemini2",
    workspaceId: workspaceGeminiPersist.id,
    prompt: "Say only: FIX12-C",
  });
  const savedAssistant = storeGeminiPersist
    .listMessages("gemini2", workspaceGeminiPersist.id, 10)
    .find((message) => message.role === "assistant");
  ok(
    "AgentBridge.runPrompt persists normalized Gemini assistant text",
    runResult.text === "FIX12-C インタラクション" &&
      savedAssistant?.content === "FIX12-C インタラクション",
  );
}

{
  const dbDeleteBridge = createDatabase(":memory:", {});
  const storeDeleteBridge = new Store(dbDeleteBridge);
  const deletedAgents = [];
  const killedAgents = [];
  const scheduledAgents = [];
  const publishedEvents = [];
  const registryDelete = {
    setStore() {},
    hydrateFromStore() {},
    switchWorkspace() {},
    list: () => [],
    get: (name) => (name === "bridge-delete" ? { name: "bridge-delete", toJSON: () => ({ name: "bridge-delete" }) } : null),
    deleteAgent: (name) => {
      deletedAgents.push(name);
      return { name };
    },
  };
  const busDelete = {
    publish: (type, payload) => publishedEvents.push({ type, payload }),
    on() {},
  };
  const abDelete = new AgentBridge({
    agentRegistry: registryDelete,
    store: storeDeleteBridge,
    bus: busDelete,
    config: { codexWorkdir: process.cwd() },
    ptyService: { killAgent: (name) => killedAgents.push(name) },
    scheduler: { removeJobsReferencingAgent: async (name) => scheduledAgents.push(name) },
  });
  const deleted = await abDelete.deleteAgent("bridge-delete");
  ok("AgentBridge.deleteAgent() → returns deleted agent", deleted?.name === "bridge-delete");
  ok("AgentBridge.deleteAgent() → PTY cleanup called", killedAgents.includes("bridge-delete"));
  ok("AgentBridge.deleteAgent() → schedule cleanup called", scheduledAgents.includes("bridge-delete"));
  ok("AgentBridge.deleteAgent() → registry delete called", deletedAgents.includes("bridge-delete"));
  ok("AgentBridge.deleteAgent() → event emitted", publishedEvents.some((event) => event.type === "agent.deleted"));
}

{
  const createdSessions = [];
  const runPrompts = [];
  const replies = [];
  const sentMessages = [];
  const reacted = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: (payload) => {
        createdSessions.push(payload);
        return { id: "legacy-session" };
      },
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ workspaceId: "ws-discord", defaultAgent: null }),
      getWorkspace: (workspaceId) => (workspaceId === "ws-discord" ? { id: "ws-discord", name: "workspace001" } : null),
      getWorkspaceParentAgent: () => "gemini",
      runPrompt: async (payload) => {
        runPrompts.push(payload);
        return { text: "ok", usage: {} };
      },
    },
    bus: { on: () => () => {} },
    config: {
      codexWorkdir: process.cwd(),
      discordAllowedGuildIds: new Set(),
      discordAllowedChannelIds: new Set(),
    },
    attachments: {
      saveDiscordAttachments: async () => [],
    },
    agentRegistry: {
      hasAgents: () => true,
      names: () => ["gemini"],
      list: () => [{ name: "gemini", type: "gemini", model: "gemini-2.5-flash" }],
      get: (name) => (name === "gemini" ? { name: "gemini", model: "gemini-2.5-flash" } : null),
    },
  });
  const message = {
    content: "test from discord",
    channelId: "discord-channel-1",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-1",
    channel: {
      id: "discord-channel-1",
      name: "workspace001",
      send: async (content) => {
        sentMessages.push(content);
        return null;
      },
    },
    reply: async (content) => {
      replies.push(content);
      return {
        edit: async (next) => { replies.push(next); return null; },
        delete: async () => null,
      };
    },
    react: async (emoji) => {
      reacted.push(emoji);
      return null;
    },
  };
  await adapter.handleMessage(message);
  ok("Discord plain message on bound workspace → AgentBridge.runPrompt", runPrompts.length === 1);
  ok("Discord plain message on bound workspace → uses parent agent", runPrompts[0]?.agentName === "gemini");
  ok("Discord plain message on bound workspace → uses bound workspace", runPrompts[0]?.workspaceId === "ws-discord");
  ok("Discord plain message on bound workspace → does not create legacy session", createdSessions.length === 0);
  ok("Discord plain message on bound workspace → reacts success", reacted.includes("\u2611"));
}

{
  const runPrompts = [];
  const savedAttachmentPayloads = [];
  const reacted = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ workspaceId: "ws-discord-agent", defaultAgent: "gemini" }),
      getWorkspace: (workspaceId) => (workspaceId === "ws-discord-agent" ? { id: "ws-discord-agent", name: "workspace-agent" } : null),
      getWorkspaceParentAgent: () => "gemini",
      runPrompt: async (payload) => {
        runPrompts.push(payload);
        return { text: "ok", usage: {} };
      },
    },
    bus: { on: () => () => {} },
    config: {
      codexWorkdir: process.cwd(),
      discordAllowedGuildIds: new Set(),
      discordAllowedChannelIds: new Set(),
    },
    attachments: {
      saveDiscordAttachments: async (storageKey, items) => {
        savedAttachmentPayloads.push({ storageKey, items });
        return [
          { savedPath: "C:\\fake\\image.png", contentType: "image/png", kind: "image" },
          { savedPath: "C:\\fake\\note.txt", contentType: "text/plain", kind: "file" },
        ];
      },
    },
    agentRegistry: {
      hasAgents: () => true,
      names: () => ["gemini"],
      list: () => [{ name: "gemini", type: "gemini", model: "gemini-2.5-flash" }],
      get: (name) => (name === "gemini" ? { name: "gemini", model: "gemini-2.5-flash" } : null),
    },
  });
  const message = {
    content: "gemini? inspect attachment",
    channelId: "discord-channel-agent-attachment",
    guildId: "guild-1",
    attachments: new Map([
      ["a1", { url: "https://example.test/image.png", name: "image.png", contentType: "image/png" }],
      ["a2", { url: "https://example.test/note.txt", name: "note.txt", contentType: "text/plain" }],
    ]),
    id: "discord-message-agent-attachment",
    channel: {
      id: "discord-channel-agent-attachment",
      name: "workspace-agent",
      send: async () => null,
    },
    reply: async () => ({ edit: async () => null, delete: async () => null }),
    react: async (emoji) => {
      reacted.push(emoji);
      return null;
    },
  };
  await adapter.handleMessage(message);
  ok("Discord explicit agent command with attachments → saves attachments", savedAttachmentPayloads.length === 1);
  ok("Discord explicit agent command with attachments → routes to requested agent", runPrompts[0]?.agentName === "gemini");
  ok("Discord explicit agent command with attachments → appends image path", runPrompts[0]?.prompt.includes("Images:\n- C:\\fake\\image.png"));
  ok("Discord explicit agent command with attachments → appends file path", runPrompts[0]?.prompt.includes("Files:\n- C:\\fake\\note.txt"));
  ok("Discord explicit agent command with attachments → reacts success", reacted.includes("\u2611"));
}

{
  const runPrompts = [];
  const sentMessages = [];
  const reacted = [];
  let resolveFirstPrompt;
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ workspaceId: "ws-discord-queue", defaultAgent: null }),
      getWorkspace: (workspaceId) => (workspaceId === "ws-discord-queue" ? { id: "ws-discord-queue", name: "queue-workspace" } : null),
      getWorkspaceParentAgent: () => "gemini",
      runPrompt: async (payload) => {
        runPrompts.push(payload.prompt);
        if (payload.prompt.includes("ST011-DOUBLE-A")) {
          await new Promise((resolve) => {
            resolveFirstPrompt = resolve;
          });
          return { text: "ST011-DOUBLE-A.", usage: {} };
        }
        return { text: "ST011-DOUBLE-B.", usage: {} };
      },
    },
    bus: { on: () => () => {} },
    config: {
      codexWorkdir: process.cwd(),
      discordAllowedGuildIds: new Set(),
      discordAllowedChannelIds: new Set(),
    },
    attachments: {
      saveDiscordAttachments: async () => [],
    },
    agentRegistry: {
      hasAgents: () => true,
      names: () => ["gemini"],
      list: () => [{ name: "gemini", type: "gemini", model: "gemini-2.5-flash" }],
      get: (name) => (name === "gemini" ? { name: "gemini", model: "gemini-2.5-flash" } : null),
    },
  });
  const channel = {
    id: "discord-channel-queue",
    name: "queue-workspace",
    send: async (content) => {
      sentMessages.push(String(content));
      return { delete: async () => null };
    },
  };
  const makeMessage = (id, content, replies) => ({
    content,
    channelId: "discord-channel-queue",
    guildId: "guild-1",
    attachments: new Map(),
    id,
    channel,
    reply: async (replyContent) => {
      replies.push(String(replyContent));
      return { edit: async () => null, delete: async () => null };
    },
    react: async (emoji) => {
      reacted.push(emoji);
      return null;
    },
  });
  const repliesA = [];
  const repliesB = [];
  const first = adapter.handleMessage(makeMessage("discord-double-a", "Please reply with exactly ST011-DOUBLE-A.", repliesA));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = adapter.handleMessage(makeMessage("discord-double-b", "Please reply with exactly ST011-DOUBLE-B.", repliesB));
  await new Promise((resolve) => setTimeout(resolve, 0));
  ok("Discord rapid double → second prompt waits in queue", runPrompts.length === 1);
  ok("Discord rapid double → second prompt shows queued notice", repliesB.some((line) => line.includes("Queued as next turn.")));
  resolveFirstPrompt?.();
  await Promise.all([first, second]);
  ok("Discord rapid double → both prompts execute", runPrompts.length === 2);
  ok("Discord rapid double → preserves prompt order", runPrompts[0]?.includes("ST011-DOUBLE-A") && runPrompts[1]?.includes("ST011-DOUBLE-B"));
  ok("Discord rapid double → both prompts react success", reacted.filter((emoji) => emoji === "\u2611").length === 2);
}

{
  const createdSessions = [];
  const replies = [];
  const runPrompts = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: (payload) => {
        createdSessions.push(payload);
        return { id: "legacy-session" };
      },
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => null,
      getWorkspace: () => null,
      getWorkspaceParentAgent: () => null,
      listWorkspaces: () => [{ id: "ws-1", name: "existing-workspace", isActive: true }],
      runPrompt: async (payload) => {
        runPrompts.push(payload);
        return { text: "ok", usage: {} };
      },
    },
    bus: { on: () => () => {} },
    config: {
      codexWorkdir: process.cwd(),
      discordAllowedGuildIds: new Set(),
      discordAllowedChannelIds: new Set(),
    },
    attachments: {
      saveDiscordAttachments: async () => [],
    },
    agentRegistry: {
      hasAgents: () => true,
      names: () => ["gemini"],
      list: () => [{ name: "gemini", type: "gemini", model: "gemini-2.5-flash" }],
      get: (name) => (name === "gemini" ? { name: "gemini", model: "gemini-2.5-flash" } : null),
    },
  });
  const message = {
    content: "hello without binding",
    channelId: "discord-channel-2",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-2",
    channel: { id: "discord-channel-2", name: "orphan-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord plain message without binding → no AgentBridge.runPrompt", runPrompts.length === 0);
  ok("Discord plain message without binding → no legacy session auto-create", createdSessions.length === 0);
  ok("Discord plain message without binding → shows binding guidance", replies.some((line) => String(line).includes("workspace? <名前>")));
}

{
  const createdWorkspaces = [];
  const boundChannels = [];
  const replies = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => null,
      getWorkspace: () => null,
      getWorkspaceByName: () => null,
      getWorkspaceParentAgent: (workspaceId) => (workspaceId === "ws-active" ? "gemini2" : null),
      listWorkspaces: () => [{ id: "ws-active", name: "existing-workspace", isActive: true }],
      createWorkspace: ({ name, parentAgent }) => {
        createdWorkspaces.push({ name, parentAgent });
        return { id: "ws-new", name };
      },
      bindDiscordChannel: (payload) => {
        boundChannels.push(payload);
      },
    },
    bus: { on: () => () => {} },
    config: {
      codexWorkdir: process.cwd(),
      discordAllowedGuildIds: new Set(),
      discordAllowedChannelIds: new Set(),
    },
    attachments: {
      saveDiscordAttachments: async () => [],
    },
    agentRegistry: {
      hasAgents: () => true,
      names: () => ["claude", "gemini2"],
      list: () => [
        { name: "claude", type: "claude", model: "claude-sonnet-4.5" },
        { name: "gemini2", type: "gemini", model: "gemini-2.5-flash" },
      ],
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "!new",
    channelId: "discord-channel-3",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-3",
    channel: { id: "discord-channel-3", name: "memo-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord !new without binding → creates workspace", createdWorkspaces.length === 1);
  ok("Discord !new without binding → reuses active workspace parent agent", createdWorkspaces[0]?.parentAgent === "gemini2");
  ok("Discord !new without binding → binds new workspace to channel", boundChannels[0]?.discordChannelId === "discord-channel-3" && boundChannels[0]?.workspaceId === "ws-new");
  ok("Discord !new without binding → confirms workspace creation", replies.some((line) => String(line).includes("Started a new workspace")));
}

{
  const createdWorkspaces = [];
  const boundChannels = [];
  const replies = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => null,
      getWorkspace: () => null,
      getWorkspaceByName: () => null,
      getWorkspaceParentAgent: (workspaceId) => (workspaceId === "ws-active" ? "gemini2" : null),
      listWorkspaces: () => [{ id: "ws-active", name: "existing-workspace", isActive: true }],
      createWorkspace: ({ name, parentAgent }) => {
        createdWorkspaces.push({ name, parentAgent });
        return { id: "ws-created", name };
      },
      bindDiscordChannel: (payload) => {
        boundChannels.push(payload);
      },
    },
    bus: { on: () => () => {} },
    config: {
      codexWorkdir: process.cwd(),
      discordAllowedGuildIds: new Set(),
      discordAllowedChannelIds: new Set(),
    },
    attachments: {
      saveDiscordAttachments: async () => [],
    },
    agentRegistry: {
      hasAgents: () => true,
      names: () => ["claude", "gemini2"],
      list: () => [
        { name: "claude", type: "claude", model: "claude-sonnet-4.5" },
        { name: "gemini2", type: "gemini", model: "gemini-2.5-flash" },
      ],
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "workspace? ml003actual",
    channelId: "discord-channel-ml003",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-ml003",
    channel: { id: "discord-channel-ml003", name: "unbound-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord workspace? create without binding → creates workspace", createdWorkspaces.length === 1);
  ok("Discord workspace? create without binding → reuses active workspace parent agent", createdWorkspaces[0]?.parentAgent === "gemini2");
  ok("Discord workspace? create without binding → binds new workspace to channel", boundChannels[0]?.discordChannelId === "discord-channel-ml003" && boundChannels[0]?.workspaceId === "ws-created");
  ok("Discord workspace? create without binding → confirms workspace creation", replies.some((line) => String(line).includes("Started a new workspace")));
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

const PORT = 4300 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiCLI-discord-base-test-extended-"));

// Start server
const serverProc = spawn(process.execPath, ["--env-file=.env", "server/src/index.js"], {
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
      const req = http.request({ hostname: "127.0.0.1", port: PORT, path: "/api/stream", method: "GET" }, (res) => {
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

  // POST /api/agents/non-existent/run → 400
  {
    const r = await request("POST", `${BASE}/api/agents/nobody/run`, { prompt: "test" });
    ok("POST /api/agents/nobody/run → 400", r.status === 400);
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
    const agentsResponse = await request("GET", `${BASE}/api/agents`);
    const liveAgentList = Array.isArray(agentsResponse.json()) ? agentsResponse.json() : [];
    const parentAgent = liveAgentList[0]?.name;
    if (parentAgent) {
      const missingList = await request("GET", `${BASE}/api/workspaces/does-not-exist/agents`);
      ok("GET /api/workspaces/non-existent/agents → 404", missingList.status === 404);

      const missingAdd = await request("POST", `${BASE}/api/workspaces/does-not-exist/agents`, { agentName: parentAgent });
      ok("POST /api/workspaces/non-existent/agents → 404", missingAdd.status === 404);
    }
    const create = await request(
      "POST",
      `${BASE}/api/workspaces`,
      parentAgent ? { name: "edge-case-ws", parentAgent } : { name: "edge-case-ws" }
    );
    ok("create edge-case-ws → 201", create.status === 201);
    const wsId = create.json()?.id;
    if (wsId) {
      const members = await request("GET", `${BASE}/api/workspaces/${wsId}/agents`);
      ok("GET /api/workspaces/:id/agents → 200", members.status === 200 && Array.isArray(members.json()));

      const childAgent = liveAgentList.find((agent) => agent.name !== parentAgent)?.name;
      if (childAgent) {
        const addChild = await request("POST", `${BASE}/api/workspaces/${wsId}/agents`, { agentName: childAgent });
        ok("POST /api/workspaces/:id/agents → 201", addChild.status === 201);
      }

      const activate = await request("POST", `${BASE}/api/workspaces/${wsId}/activate`, {});
      ok("activate new workspace → 200", activate.status === 200);

      // Delete edge-case-ws
      const del = await request("DELETE", `${BASE}/api/workspaces/${wsId}`);
      ok("delete edge-case-ws → 200", del.status === 200);
    }
  }

  {
    const createAgent = await request("POST", `${BASE}/api/agents`, {
      name: "delete-me-api",
      type: "gemini",
      model: "gemini-2.5-flash",
      settings: {},
    });
    ok("POST /api/agents → 201", createAgent.status === 201);

    const createWs = await request("POST", `${BASE}/api/workspaces`, {
      name: "delete-agent-api-ws",
      parentAgent: "delete-me-api",
    });
    ok("create delete-agent-api-ws → 201", createWs.status === 201);

    const wsId = createWs.json()?.id;
    const deleteAgent = await request("DELETE", `${BASE}/api/agents/delete-me-api`);
    ok("DELETE /api/agents/:name → 200", deleteAgent.status === 200);

    const listAgents = await request("GET", `${BASE}/api/agents`);
    const remainingAgents = Array.isArray(listAgents.json()) ? listAgents.json() : [];
    ok(
      "DELETE /api/agents/:name → removed from list",
      !remainingAgents.some((agent) => agent.name === "delete-me-api"),
    );

    if (wsId) {
      const workspaceAgents = await request("GET", `${BASE}/api/workspaces/${wsId}/agents`);
      const workspaceAgentList = Array.isArray(workspaceAgents.json()) ? workspaceAgents.json() : [];
      ok(
        "DELETE /api/agents/:name → removed from workspace members",
        workspaceAgents.status === 200 && workspaceAgentList.every((entry) => entry.agentName !== "delete-me-api"),
      );
      await request("DELETE", `${BASE}/api/workspaces/${wsId}`);
    }
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

// ── 12. periodToSince ─────────────────────────────────────────────────────

section("12. periodToSince (コスト期間フィルター)");

// We test via AgentBridge.getCostSummary which internally calls periodToSince
// Seed a store with old and new runs, verify period filters correctly
{
  const db3 = createDatabase(":memory:", {});
  const store3 = new Store(db3);
  const registry3 = {
    setStore() {},
    switchWorkspace() {},
    list: () => [],
    get: () => null,
  };
  const ab3 = new AgentBridge({ agentRegistry: registry3, store: store3, bus: { publish: () => {} }, config: { codexWorkdir: process.cwd() } });

  store3.upsertAgent({ name: "gamma", type: "claude", model: "claude-sonnet-4-6" });
  const ws3 = store3.createWorkspace({ name: "gamma-ws" });

  // Insert a run that "happened" recently (real time)
  const run = store3.startRun({ agentName: "gamma", workspaceId: ws3.id, prompt: "test", source: "test" });
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

// ── 13. Gemini transcript sanitize ──────────────────────────────────────────

section("13. Gemini transcript sanitize");

{
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "User:",
      "[Context from recent workspace chat]",
      "You -> gemini2: test",
      "gemini2: テストメッセージありがとうございます。Gemini CLI です。",
      "現在、プロジェクトルート C:\\Users\\example\\workspace にて待機しております。",
      "",
      "テストメッセージありがとうございます。Gemini CLI です。",
      "現在、プロジェクトルート C:\\Users\\example\\workspace にて待機しております。",
      "",
      "テストメッセージありがとうございます。Gemini CLI です。",
      "現在、プロジェクトルート C:\\Users\\example\\workspace にて待機しております。",
      "設定されたルールに従い、以下の点に留意してサポートいたします：",
    ].join("\n"),
    "test"
  );
  ok("Gemini sanitize strips echoed user context", !/You -> gemini2:/i.test(sanitized));
  ok("Gemini sanitize strips echoed assistant speaker lines", !/^\s*gemini2:/im.test(sanitized));
  ok(
    "Gemini sanitize compacts duplicated lead-in paragraphs",
    (sanitized.match(/テストメッセージありがとうございます。Gemini CLI です。/g) || []).length === 1
  );
  ok(
    "Gemini sanitize keeps the richest final paragraph",
    sanitized.includes("設定されたルールに従い、以下の点に留意してサポートいたします：")
  );
}
{
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "User: previous prompt",
      "Model: 以前の応答です。",
      "User:",
      "[User prompt]",
      "新しいプロンプト",
      "Model: 1行目の要約です。",
      "2行目の説明です。",
      "3行目の補足です。",
      "workspace (/directory)",
      "~\\Desktop\\AI",
      "no sandbox /model",
      "gemini-3-flash-preview",
      "? for shortcuts",
      "Type your message or @path/to/file",
    ].join("\n"),
    "新しいプロンプト",
  );
  ok("Gemini sanitize keeps multi-line latest model block", sanitized.includes("2行目の説明です。") && sanitized.includes("3行目の補足です。"));
}
{
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "Model: agent-bridge.js の役割は以下の通りです。",
      "AIエージェントとシステムの各コンポーネントを",
      "",
      "workspace (/directory)",
      "~\\Desktop\\AI sandbox",
      "no san",
      "ndbox /model",
      "gemini-3-flash-preview",
      "AIエージェントとシステムの各コンポーネントを仲介します。",
      "エージェントへの要求や指示のルーティングを制御します。",
      "Type your message or @path/to/file",
    ].join("\n"),
  );
  ok("Gemini sanitize strips scaffold lines inserted mid-response", !/workspace \(\/directory\)|gemini-3-flash-preview|Type your message/i.test(sanitized));
  ok("Gemini sanitize prefers the richer completed line after a wrapped fragment", sanitized.includes("AIエージェントとシステムの各コンポーネントを仲介します。"));
}
{
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "workspace (/directory)",
      "~\\projects\\example-repo branch",
      "main sandbox",
      "no sandbox /model",
      "gemini-3-flash-preview",
      "auto-accept edits Shift+Tab to plan 2 context files",
      "Accepting edits no sandbox /model",
      "gemini-3-flash-preview",
      "AIエージェントとシステムの各コンポーネントを仲介します。",
      "エージェントへの要求や指示のルーティングを制御します。",
      "[User prompt]",
      "FIX04 prompt",
    ].join("\n"),
    "FIX04 prompt",
  );
  ok("Gemini sanitize skips wrapped workspace preamble lines", !/example-repo branch|main sandbox/i.test(sanitized));
  ok("Gemini sanitize keeps response after wrapped workspace preamble", sanitized.includes("AIエージェントとシステムの各コンポーネントを仲介します。"));
}
{
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "Model: FIX09-A Discord APIとの接続を維持し、ボットのライフサイクルを管理します。",
      "FIX09-B 受信したメッセージや ",
      " リアクションを内部の共通イベント形式に変換します。",
      "FIX09-C 処理結果や通知を、対象のDiscordチャンネルやユーザーへ配信し ",
      " ます。",
      "FIX09-D 添付ファイルのアップロードやDiscord固有のUI要素の構築を担当します。",
      "workspace (/directory)",
      "~\\projects\\example-repo branch",
      "main sandbox",
      "no sandbox /model",
      "gemini-3-flash-preview",
    ].join("\n"),
  );
  ok("Gemini sanitize merges indented continuation lines", sanitized.includes("FIX09-B 受信したメッセージやリアクションを内部の共通イベント形式に変換します。"));
  ok("Gemini sanitize merges wrapped trailing verb fragments", sanitized.includes("FIX09-C 処理結果や通知を、対象のDiscordチャンネルやユーザーへ配信します。"));
}
{
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "FIX10-A コスト確認やセッションリセットなどの",
      " 管理コマンドを実行し、その結果をユーザーに通知します。",
    ].join("\n"),
  );
  ok(
    "Gemini sanitize merges wrapped Japanese noun continuations without an extra space",
    sanitized.includes("FIX10-A コスト確認やセッションリセットなどの管理コマンドを実行し、その結果をユーザーに通知します。"),
  );
}
{
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "FIX11-A エージェント ",
      " からのメッセージをログファイ ",
      " ルとして保存します。",
    ].join("\n"),
  );
  ok(
    "Gemini sanitize removes wrapped intra-Japanese spaces in saved transcript text",
    sanitized.includes("FIX11-A エージェントからのメッセージをログファイルとして保存します。"),
  );
}
{
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "Model: DDISC-CLEAN-01-A 進行中の表示を行う progress message は、新規メッセージの到着やエラー発生時に適切に破棄または更新されます。",
      "DDISC-CLEAN-01-B エージェントの回答が完了した際は、文末まで確実に Discord チャンネルへ送信されることを保証する制御を行います。",
      "[User prompt]",
      "Say only: DDISC-OK-02",
      "DDISC-OK-02",
    ].join("\n"),
    "Say only: DDISC-OK-02",
  );
  ok(
    "Gemini sanitize scopes transcript to the current prompt instead of reusing a prior response block",
    sanitized === "DDISC-OK-02",
  );
}
{
  const normalized = ptyTestHooks.normalizePersistedAssistantText(
    "gemini",
    "FIX12-C インタラク ション",
  );
  ok(
    "Gemini persisted assistant normalization removes wrapped intra-Japanese spaces",
    normalized === "FIX12-C インタラクション",
  );
}
{
  const ptyService = new PtyService({
    agentRegistry: {
      get() {
        return { type: "gemini" };
      },
    },
    config: { codexWorkdir: "C:\\Users\\example\\workspace" },
  });
  const key = "ws-1:gemini2";
  ptyService._scrollback.set(
    key,
    [
      "Model: DDISC-CLEAN-01-A 古い応答です。",
      "[User prompt]",
      "Say only: DDISC-OK-03",
      "Model: DDISC-OK-03",
    ].join("\n"),
  );
  const text = ptyService._getStreamingTranscript(
    key,
    {
      agentName: "gemini2",
      promptText: "Say only: DDISC-OK-03",
      rawBuffer: "",
      scrollbackSnapshot: "",
    },
    "gemini",
  );
  ok(
    "Gemini transcript falls back to scrollback when the live raw buffer is empty",
    text === "DDISC-OK-03",
  );
}
{
  const writes = [];
  const fakePty = {
    write(value) {
      writes.push(value);
    },
  };
  await PtyService.prototype._writePromptToPty.call(
    {},
    fakePty,
    "line1\nline2",
    "gemini",
    { originalPrompt: "line1\nline2" },
  );
  ok(
    "Gemini multiline prompt sends a second Enter to submit composer content",
    writes.filter((value) => value === "\r").length === 2,
  );
}
{
  const writes = [];
  const fakePty = {
    write(value) {
      writes.push(value);
    },
  };
  await PtyService.prototype._writePromptToPty.call(
    {},
    fakePty,
    "[Context from recent workspace chat]\nold line\n\n[User prompt]\nSay only: DDISC-OK-04",
    "gemini",
    { originalPrompt: "Say only: DDISC-OK-04" },
  );
  ok(
    "Gemini context-prefixed single-line prompt still sends a second Enter because the pasted input is multiline",
    writes.filter((value) => value === "\r").length === 2,
  );
}

// ── 14. Gemini session list parse ───────────────────────────────────────────

section("14. Gemini session list parse");

{
  const sessions = ptyTestHooks.parseGeminiSessionListOutput(
    [
      "Available sessions for this project (2):",
      "  1. Say one word: test (3 days ago) [ba5ece57-2c8e-4bb4-b08b-22ac687bd0e0]",
      "  2. User wants to interact with the Gemini CLI. (1 day ago) [94b1510f-1f71-4813-b65b-6fcb5536fc84]",
      "Loaded cached credentials.",
    ].join("\n"),
  );
  ok("Gemini session list parser keeps numbered sessions", sessions.length === 2);
  ok(
    "Gemini session list parser reads the first session id",
    sessions[0]?.sessionRef === "ba5ece57-2c8e-4bb4-b08b-22ac687bd0e0",
  );
  ok(
    "Gemini session list parser ignores footer noise",
    sessions.every((session) => /^[0-9a-f-]{36}$/i.test(session.sessionRef)),
  );
  ok(
    "Gemini resume selector returns numeric index for known session",
    ptyTestHooks.selectGeminiResumeValue("94b1510f-1f71-4813-b65b-6fcb5536fc84", sessions) === "2",
  );
  ok(
    "Gemini resume selector skips stale unknown session",
    ptyTestHooks.selectGeminiResumeValue("47980b52-a2ba-461e-a0a7-5c0f5672ae6b", sessions) === null,
  );
  const resolvedKnownResume = ptyTestHooks.resolveGeminiResumeSession(
    "94b1510f-1f71-4813-b65b-6fcb5536fc84",
    sessions,
  );
  ok(
    "Gemini resume resolver keeps a known stored session ref for state/log use",
    resolvedKnownResume.sessionRef === "94b1510f-1f71-4813-b65b-6fcb5536fc84" && resolvedKnownResume.resumeValue === "2",
  );
  const resolvedStaleResume = ptyTestHooks.resolveGeminiResumeSession(
    "47980b52-a2ba-461e-a0a7-5c0f5672ae6b",
    sessions,
  );
  ok(
    "Gemini resume resolver clears stale stored session refs",
    resolvedStaleResume.sessionRef === null && resolvedStaleResume.resumeValue === null,
  );
}
{
  const upserts = [];
  const result = PtyService.prototype.backfillStoredSessionRefs.call({
    store: {
      listWorkspaces() {
        return [{ id: "ws-1", name: "workspace-1" }];
      },
      listWorkspaceAgents() {
        return [{ agentName: "gemini2" }];
      },
      getAgentSession() {
        return {
          providerSessionRef: "3167ab40-3e9c-47d5-ab5e-4aaa00e9bbdef",
          model: "gemini-2.5-pro",
          workdir: "C:\\work",
          lastRunState: "idle",
        };
      },
      upsertAgentSession(payload) {
        upserts.push(payload);
        return payload;
      },
    },
    agentRegistry: {
      get() {
        return { model: "gemini-2.5-pro" };
      },
    },
    _getSessionProviderType() {
      return "gemini";
    },
    _loadProviderSessionHistory() {
      return [{ sessionRef: "47980b52-a2ba-461e-a0a7-5c0f5672ae6b" }];
    },
    _resolveWorkspaceAgentWorkdir() {
      return "C:\\work";
    },
    _sessionRefExistsInHistory() {
      return false;
    },
    _buildWorkspacePromptFingerprint() {
      return { promptCount: 3 };
    },
    _findBestSessionHistoryMatch() {
      return { sessionRef: "47980b52-a2ba-461e-a0a7-5c0f5672ae6b", overlapCount: 3 };
    },
  });
  ok(
    "Session backfill does not overwrite an existing stored provider session ref",
    result.updatedCount === 0 && upserts.length === 0,
  );
}

// ── 15. Session backfill prompt normalization ───────────────────────────────

section("15. Session backfill prompt normalization");

{
  const extracted = ptyTestHooks.extractRecordedUserPrompt(
    [
      "[Context from recent workspace chat]",
      "You -> codex: Say only: UI170_CLEAN_CODEX_OK_05",
      "codex: UI170_CLEAN_CODEX_OK_05",
      "",
      "[User prompt]",
      "Say only: UI170_CLEAN_CODEX_OK_06",
    ].join("\n"),
  );
  ok(
    "Recorded prompt extractor keeps only the final user prompt",
    extracted === "Say only: UI170_CLEAN_CODEX_OK_06",
  );
  ok(
    "Prompt normalization trims nulls and whitespace",
    ptyTestHooks.normalizeSessionPromptText(" \u0000Say only: OK\r\n") === "Say only: OK",
  );
  ok(
    "Gemini project hash matches the saved projectHash format",
    ptyTestHooks.computeGeminiProjectHash("C:\\Users\\example\\workspace") ===
      "957d1e68f9e577057fe3c8f40a885c22471e8ae209d83dc359a079f92639dfbc",
  );
}

// ── 16. Streaming / Discord sync helpers ──────────────────────────────────────

section("16. Streaming / Discord sync helpers");

{
  const boundary = ptyTestHooks.findStreamingChunkBoundary("最初の文です。次の文はまだ");
  ok("Streaming boundary flushes at Japanese sentence ending", boundary === "最初の文です。".length);
}
{
  const boundary = ptyTestHooks.findStreamingChunkBoundary("```js\nconst x = 1;");
  ok("Streaming boundary waits for closing code fence", boundary === 0);
}
{
  const working = discordTestHooks.formatWorkingStatusContent(
    new Date(Date.now() - 125000).toISOString(),
    "gemini working",
  );
  ok("Discord working status uses minute label after one minute", working.includes("(2m)"));
}
{
  const suffix = discordTestHooks.getUnsyncedSuffix("Hello world!", "Hello ");
  ok("Discord unsynced suffix removes already-sent prefix", suffix === "world!");
}
{
  const sentMessages = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ workspaceId: "ws-stream", defaultAgent: null }),
      getWorkspace: (workspaceId) => (workspaceId === "ws-stream" ? { id: "ws-stream", name: "streaming-ws" } : null),
      getWorkspaceParentAgent: () => "gemini",
      runPrompt: async ({ onProgress }) => {
        await onProgress?.({ type: "message.delta", agentName: "gemini", workspaceId: "ws-stream", runId: "run-1", content: "最初の文です。\n" });
        await onProgress?.({ type: "message.delta", agentName: "gemini", workspaceId: "ws-stream", runId: "run-1", content: "次の文です。\n" });
        await onProgress?.({ type: "message.done", agentName: "gemini", workspaceId: "ws-stream", runId: "run-1", content: "最初の文です。\n次の文です。\n最終文です。" });
        return { text: "最初の文です。\n次の文です。\n最終文です。", usage: {} };
      },
    },
    bus: { on: () => () => {} },
    config: {
      codexWorkdir: process.cwd(),
      discordAllowedGuildIds: new Set(),
      discordAllowedChannelIds: new Set(),
    },
    attachments: {
      saveDiscordAttachments: async () => [],
    },
    agentRegistry: {
      hasAgents: () => true,
      names: () => ["gemini"],
      list: () => [{ name: "gemini", type: "gemini", model: "gemini-2.5-flash" }],
      get: (name) => (name === "gemini" ? { name: "gemini", model: "gemini-2.5-flash" } : null),
    },
  });
  const message = {
    content: "stream this",
    channelId: "discord-channel-stream",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-stream",
    channel: {
      id: "discord-channel-stream",
      name: "streaming-ws",
      send: async (content) => {
        sentMessages.push(String(content));
        return { delete: async () => null };
      },
    },
    reply: async () => null,
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord streaming prompt sends partial assistant text", sentMessages.some((entry) => entry.includes("最初の文です。")));
  ok("Discord streaming prompt sends final unsynced remainder", sentMessages.some((entry) => entry.includes("最終文です。")));
  ok("Discord streaming prompt keeps working tracker visible", sentMessages.some((entry) => entry.includes("gemini working")));
  ok("Discord streaming prompt ends with completion status", sentMessages.some((entry) => entry.includes("✅ gemini 完了")));
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
