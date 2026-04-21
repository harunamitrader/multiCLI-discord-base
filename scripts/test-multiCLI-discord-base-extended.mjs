/**
 * multiCLI-discord-base 拡張テストスクリプト
 *
 * test-multiCLI-discord-base.mjs でカバーしていない領域をテスト:
 *   6. コマンドパーサー エッジケース
 *   7. Canonical Event Normalizer エッジケース
 *   8. Store エッジケース (multi-agent / null handling)
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
import { createHttpServer } from "../server/src/http-server.js";
import { MemoryService } from "../server/src/memory-service.js";
import { PtyService, __testHooks as ptyTestHooks } from "../server/src/pty-service.js";
import { buildContextBlock, resolveWorkspaceContextPolicy } from "../server/src/context-policy.js";
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
  const bangIndex = trimmed.indexOf("!");
  const bang = bangIndex <= 0
    ? null
    : {
        raw: trimmed.slice(0, bangIndex + 1),
        command: trimmed.slice(0, bangIndex + 1).toLowerCase(),
        args: trimmed.slice(bangIndex + 1).trim(),
      };
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

section("6. コマンドパーサー エッジケース");

const agents = ["hanako", "taro", "jiro"];

// Case insensitivity
{
  const r = parseAgentCommand("STOP!", agents);
  ok("STOP! (uppercase) → verb=stop", r?.verb === "stop");
}
{
  const r = parseAgentCommand("AGENTS!", agents);
  ok("AGENTS! → verb=agents", r?.verb === "agents");
}
{
  const r = parseAgentCommand("WORKSPACE! foo", agents);
  ok("WORKSPACE! foo → prompt=foo", r?.verb === "workspace" && r?.prompt === "foo");
}
{
  const r = parseAgentCommand("AGENT!", agents);
  ok("AGENT! → null (exact match only)", r === null);
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

// workspace! with spaces in name
{
  const r = parseAgentCommand("workspace! my cool project", agents);
  ok("workspace! with spaces → full prompt", r?.prompt === "my cool project");
}

// Agent name that starts with a verb keyword
{
  const r = parseAgentCommand("stop!", agents);
  ok("stop! global (not an agent named stop)", r?.verb === "stop" && !r?.agent);
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

// ── 7. Canonical Event Normalizer エッジケース ────────────────────────────

section("7. Canonical Event Normalizer エッジケース");

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

// ── 8. Store エッジケース ────────────────────────────────────────────────

section("8. Store エッジケース");

const db = createDatabase(":memory:", {});
const store = new Store(db);
const primaryWorkspace = store.createWorkspace({ name: "primary-workspace" });
const primaryWorkspaceId = primaryWorkspace.id;

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
  ok("updateWorkspace null workdir clears value", updated?.workdir === null);
}

// workspace sidebar layout: active cap and sort normalization
{
  const layoutDb = createDatabase(":memory:", {});
  const layoutStore = new Store(layoutDb);
  const created = Array.from({ length: 6 }, (_, index) =>
    layoutStore.createWorkspace({ name: `layout-${index + 1}` })
  );
  const saved = layoutStore.saveWorkspaceLayout(created.map((workspace, index) => ({
    id: workspace.id,
    isSidebarActive: true,
    sortOrder: index,
  })));
  const active = saved.filter((workspace) => workspace.isSidebarActive);
  const inactive = saved.filter((workspace) => !workspace.isSidebarActive);
  ok("saveWorkspaceLayout → active capped to 5", active.length === 5);
  ok("saveWorkspaceLayout → overflow moved to inactive", inactive.length === 1);
  ok(
    "saveWorkspaceLayout → active sortOrder renumbered",
    active.every((workspace, index) => workspace.sortOrder === index),
  );
  ok(
    "saveWorkspaceLayout → overflow workspace becomes first inactive",
    inactive[0]?.id === created[5]?.id && inactive[0]?.sortOrder === 0,
  );
}

// listRuns
{
  store.upsertAgent({ name: "alpha", type: "claude", model: "claude-sonnet-4-6" });
  store.startRun({ agentName: "alpha", workspaceId: primaryWorkspaceId, prompt: "run-a", source: "test" });
  store.startRun({ agentName: "alpha", workspaceId: primaryWorkspaceId, prompt: "run-b", source: "test" });
  const runs = store.listRuns("alpha", primaryWorkspaceId, 5);
  ok("listRuns → returns runs array", Array.isArray(runs));
  ok("listRuns → most recent first", runs.length >= 2 && runs[0].startedAt >= runs[1].startedAt);
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
  ok("AgentBridge.createWorkspace() → single-agent default context policy is off", ws?.contextPolicy?.effective === false);

  const updatedWs = ab.updateWorkspace(ws.id, { contextInjectionEnabled: true });
  ok("AgentBridge.updateWorkspace() → contextInjectionEnabled=true", updatedWs?.contextInjectionEnabled === true);
  ok("AgentBridge.updateWorkspace() → context policy reflects explicit on", updatedWs?.contextPolicy?.effective === true);

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

  // runPrompt with non-existent agent → throws
  let threw2 = false;
  try { await ab.runPrompt({ agentName: "does-not-exist", prompt: "hi" }); } catch { threw2 = true; }
  ok("AgentBridge.runPrompt unknown agent → throws", threw2);
}

{
  const dbLayoutBridge = createDatabase(":memory:", {});
  const storeLayoutBridge = new Store(dbLayoutBridge);
  const workspaceA = storeLayoutBridge.createWorkspace({ name: "bridge-layout-a" });
  const workspaceB = storeLayoutBridge.createWorkspace({ name: "bridge-layout-b" });
  const workspaceC = storeLayoutBridge.createWorkspace({ name: "bridge-layout-c" });
  const abLayout = new AgentBridge({
    agentRegistry: {
      setStore() {},
      switchWorkspace() {},
      list: () => [],
      get: () => null,
    },
    store: storeLayoutBridge,
    bus: { publish() {} },
    config: { codexWorkdir: process.cwd() },
  });
  const updatedLayout = abLayout.updateWorkspaceLayout([
    { id: workspaceC.id, isSidebarActive: true, sortOrder: 0 },
    { id: workspaceA.id, isSidebarActive: true, sortOrder: 1 },
    { id: workspaceB.id, isSidebarActive: false, sortOrder: 0 },
  ]);
  ok("AgentBridge updateWorkspaceLayout → reordered active workspace first", updatedLayout[0]?.id === workspaceC.id);
  ok("AgentBridge updateWorkspaceLayout → keeps inactive section last", updatedLayout.at(-1)?.id === workspaceB.id);
}

{
  const dbPrewarmBridge = createDatabase(":memory:", {});
  const storePrewarmBridge = new Store(dbPrewarmBridge);
  storePrewarmBridge.upsertAgent({
    name: "prewarm-gemini",
    type: "gemini",
    model: "gemini-2.5-flash",
    status: "stopped",
    enabled: true,
    settings: { workdir: "C:\\workspace-agent" },
  });
  const workspace = storePrewarmBridge.createWorkspace({ name: "prewarm-workspace", workdir: "C:\\workspace-root" });
  storePrewarmBridge.addWorkspaceAgent({ workspaceId: workspace.id, agentName: "prewarm-gemini", isParent: true });
  const prewarmCalls = [];
  const abPrewarm = new AgentBridge({
    agentRegistry: {
      setStore() {},
      switchWorkspace() {},
      list: () => [storePrewarmBridge.getAgent("prewarm-gemini")],
      get: (name) => storePrewarmBridge.getAgent(name),
    },
    store: storePrewarmBridge,
    bus: { publish() {} },
    config: { codexWorkdir: process.cwd() },
    ptyService: {
      async prewarmAgent(payload) {
        prewarmCalls.push(payload);
        return { status: "idle", hasProcess: true, readyForPrompt: false };
      },
    },
  });
  const prewarmResult = await abPrewarm.prewarmWorkspaceAgent("prewarm-gemini", workspace.id);
  ok("AgentBridge prewarmWorkspaceAgent → delegates to ptyService", prewarmCalls.length === 1);
  ok(
    "AgentBridge prewarmWorkspaceAgent → resolves effective workdir",
    prewarmCalls[0]?.workdir === "C:\\workspace-agent",
  );
  ok("AgentBridge prewarmWorkspaceAgent → returns terminal state", prewarmResult?.hasProcess === true);
}

{
  const dbContextPrompt = createDatabase(":memory:", {});
  const storeContextPrompt = new Store(dbContextPrompt);
  const publishedEvents = [];
  const workspaceContextPrompt = storeContextPrompt.createWorkspace({
    name: "context-prompt",
    contextInjectionEnabled: true,
  });
  storeContextPrompt.addMessage({
    agentName: "claude-main",
    workspaceId: workspaceContextPrompt.id,
    runId: null,
    role: "user",
    content: "前の依頼です",
    source: "test",
  });
  storeContextPrompt.addMessage({
    agentName: "claude-main",
    workspaceId: workspaceContextPrompt.id,
    runId: null,
    role: "assistant",
    content: "前の返答です",
    source: "agent",
  });
  const abContextPrompt = new AgentBridge({
    agentRegistry: {
      setStore() {},
      hydrateFromStore() {},
      switchWorkspace() {},
      list: () => [],
      get: (name) => (name === "claude-main" ? { name: "claude-main", type: "claude", settings: {} } : null),
    },
    store: storeContextPrompt,
    bus: { publish: (type, payload) => publishedEvents.push({ type, payload }), on() {} },
    config: { codexWorkdir: process.cwd() },
    ptyService: {
      async assertPromptReady() {},
      async sendPrompt() {
        return { text: "OK", finalStatus: "completed" };
      },
      getAgentTerminalState() {
        return { status: "idle" };
      },
    },
  });
  await abContextPrompt.runPrompt({
    agentName: "claude-main",
    workspaceId: workspaceContextPrompt.id,
    prompt: "最新の依頼",
  });
  const savedUser = [...storeContextPrompt.listMessages("claude-main", workspaceContextPrompt.id, 10)]
    .reverse()
    .find((message) => message.role === "user");
  const emittedUser = publishedEvents.find((event) => event.type === "message.user");
  ok(
    "AgentBridge.runPrompt stores visible context metadata on user message",
    savedUser?.metadata?.inputMode === "prompt" && savedUser?.metadata?.context?.used === true,
  );
  ok(
    "AgentBridge.runPrompt emits user metadata with context visibility",
    emittedUser?.payload?.metadata?.context?.used === true,
  );
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
  const dbSlashBridge = createDatabase(":memory:", {});
  const storeSlashBridge = new Store(dbSlashBridge);
  const workspaceSlashBridge = storeSlashBridge.createWorkspace({ name: "slash-bridge" });
  let remoteCommandPayload = null;
  const abSlashBridge = new AgentBridge({
    agentRegistry: {
      setStore() {},
      hydrateFromStore() {},
      switchWorkspace() {},
      list: () => [],
      get: (name) => (name === "gemini" ? { name: "gemini", type: "gemini", settings: {} } : null),
    },
    store: storeSlashBridge,
    bus: { publish() {}, on() {} },
    config: { codexWorkdir: process.cwd() },
    ptyService: {
      async assertPromptReady() {},
      async sendRemoteCommand(payload) {
        remoteCommandPayload = payload;
        return { ok: true, text: "", finalStatus: "running" };
      },
      getAgentTerminalState() {
        return { status: "idle" };
      },
    },
  });
  const slashResult = await abSlashBridge.runPrompt({
    agentName: "gemini",
    workspaceId: workspaceSlashBridge.id,
    prompt: "/help",
    inputMode: "slash_command",
    source: "ui",
  });
  ok("AgentBridge.runPrompt slash_command delegates to sendRemoteCommand", remoteCommandPayload?.command === "/help");
  ok("AgentBridge.runPrompt slash_command keeps input metadata", remoteCommandPayload?.metadata?.inputMode === "slash_command");
  ok(
    "AgentBridge.runPrompt slash_command does not pre-save duplicate messages",
    storeSlashBridge.listMessages("gemini", workspaceSlashBridge.id, 10).length === 0 && slashResult?.finalStatus === "running",
  );
}

{
  const dbTerminalTurn = createDatabase(":memory:", {});
  const storeTerminalTurn = new Store(dbTerminalTurn);
  const workspaceTerminalTurn = storeTerminalTurn.createWorkspace({ name: "terminal-turn-source" });
  storeTerminalTurn.upsertAgent({ name: "gemini", type: "gemini", model: "gemini-2.5-flash" });
  const bridgeTerminalTurn = new AgentBridge({
    agentRegistry: {
      setStore() {},
      hydrateFromStore() {},
      switchWorkspace() {},
      list: () => [],
      get: (name) => (name === "gemini" ? { name: "gemini", type: "gemini", settings: {} } : null),
    },
    store: storeTerminalTurn,
    bus: { publish() {}, on() {} },
    config: { codexWorkdir: process.cwd() },
  });
  await bridgeTerminalTurn.recordTerminalTurn({
    agentName: "gemini",
    workspaceId: workspaceTerminalTurn.id,
    prompt: "/help",
    text: "ok",
    source: "discord-slash",
    metadata: { inputMode: "slash_command" },
  });
  await bridgeTerminalTurn.recordTerminalTurn({
    agentName: "gemini",
    workspaceId: workspaceTerminalTurn.id,
    prompt: "/status",
    text: "ok",
    source: "ui",
    metadata: { inputMode: "slash_command" },
  });
  await bridgeTerminalTurn.recordTerminalTurn({
    agentName: "gemini",
    workspaceId: workspaceTerminalTurn.id,
    prompt: "manual prompt",
    text: "ok",
  });
  const runs = storeTerminalTurn.listRuns("gemini", workspaceTerminalTurn.id, 10);
  const messages = storeTerminalTurn.listMessages("gemini", workspaceTerminalTurn.id, 20).filter((message) => message.role === "user");
  const slashRun = runs.find((run) => run.prompt === "/help");
  const uiRun = runs.find((run) => run.prompt === "/status");
  const terminalRun = runs.find((run) => run.prompt === "manual prompt");
  const slashMessage = messages.find((message) => message.content === "/help");
  const uiMessage = messages.find((message) => message.content === "/status");
  const terminalMessage = messages.find((message) => message.content === "manual prompt");
  ok(
    "recordTerminalTurn discord-slash keeps runs.source and messages.source aligned",
    slashRun?.source === "discord-slash" && slashMessage?.source === "discord-slash",
  );
  ok(
    "recordTerminalTurn ui keeps runs.source and messages.source aligned",
    uiRun?.source === "ui" && uiMessage?.source === "ui",
  );
  ok(
    "recordTerminalTurn defaults missing source to terminal",
    terminalRun?.source === "terminal" && terminalMessage?.source === "terminal",
  );
}

{
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multiCLI-discord-base-memory-"));
  const memoryService = new MemoryService({ rootDir: memoryRoot });
  const globalMemory = memoryService.setGlobalMemory("# global");
  const workspaceMemory = memoryService.setWorkspaceMemory("ws-1", "workspace memo");
  const agentMemory = memoryService.setAgentMemory("gemini", "agent memo");
  ok("MemoryService global memory persists text", globalMemory.content === "# global");
  ok("MemoryService workspace memory persists text", workspaceMemory.content === "workspace memo");
  ok("MemoryService agent memory persists text", agentMemory.content === "agent memo");
  fs.rmSync(memoryRoot, { recursive: true, force: true });
}

{
  const dbSnapshot = createDatabase(":memory:", {});
  const storeSnapshot = new Store(dbSnapshot);
  const workspaceSnapshot = storeSnapshot.createWorkspace({ name: "snapshot-ws" });
  storeSnapshot.upsertAgent({ name: "gemini", type: "gemini", model: "gemini-2.5-flash" });
  const interruptedRun = storeSnapshot.startRun({
    agentName: "gemini",
    workspaceId: workspaceSnapshot.id,
    prompt: "resume later",
    source: "test",
  });
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiCLI-discord-base-snapshot-"));
  const snapshotPath = path.join(snapshotDir, "state.json");
  fs.writeFileSync(snapshotPath, JSON.stringify({
    version: 1,
    entries: [{
      agentName: "gemini",
      workspaceId: workspaceSnapshot.id,
      workdir: process.cwd(),
      sessionRef: "session-123",
      status: "running",
      hasProcess: true,
      runId: interruptedRun.id,
    }],
  }), "utf8");
  const snapshotBusEvents = [];
  const ptySnapshot = new PtyService({
    agentRegistry: {
      get: (name) => (name === "gemini" ? { name, type: "gemini", model: "gemini-2.5-flash", settings: {} } : null),
      list: () => [{ name: "gemini", type: "gemini" }],
    },
    config: { codexWorkdir: process.cwd(), runtimeStatePath: snapshotPath },
    bus: { publish: (type, payload) => snapshotBusEvents.push({ type, payload }) },
    store: storeSnapshot,
  });
  const restored = ptySnapshot.restoreRuntimeSnapshot();
  const restoredState = ptySnapshot.getAgentTerminalState("gemini", workspaceSnapshot.id);
  const restoredRun = storeSnapshot.listRuns("gemini", workspaceSnapshot.id, 5)[0];
  ok("PtyService.restoreRuntimeSnapshot() → restores entry count", restored.restoredCount === 1);
  ok("PtyService.restoreRuntimeSnapshot() → marks interrupted run", restoredRun?.status === "interrupted");
  ok(
    "PtyService.restoreRuntimeSnapshot() → exposes recovery warning",
    restoredState.status === "idle" &&
      restoredState.warningCode === "runtime_recovered" &&
      restoredState.warningMessage.includes("safe idle"),
  );
  fs.rmSync(snapshotDir, { recursive: true, force: true });
}

{
  const dbApproval = createDatabase(":memory:", {});
  const storeApproval = new Store(dbApproval);
  const workspaceApproval = storeApproval.createWorkspace({ name: "approval-ws" });
  const writes = [];
  const approvalDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiCLI-discord-base-approval-"));
  const ptyApproval = new PtyService({
    agentRegistry: {
      get: (name) => (name === "gemini" ? { name, type: "gemini", settings: {} } : null),
      list: () => [{ name: "gemini", type: "gemini" }],
    },
    config: { codexWorkdir: process.cwd(), runtimeStatePath: path.join(approvalDir, "state.json") },
    bus: { publish() {} },
    store: storeApproval,
  });
  const approvalKey = `${workspaceApproval.id}:gemini`;
  const approvalState = ptyApproval._ensureState(approvalKey, "gemini", workspaceApproval.id);
  approvalState.status = "waiting_input";
  approvalState.approvalRequest = {
    id: "approval-1",
    status: "pending",
    summary: "approve access?",
    excerpt: "approve access?",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  ptyApproval._ptys.set(approvalKey, { write: (value) => writes.push(value) });
  const approvalResult = ptyApproval.respondToApproval("gemini", workspaceApproval.id, "approve");
  ok("PtyService.respondToApproval() → writes y+enter", writes[0] === "y\r");
  ok("PtyService.respondToApproval() → succeeds", approvalResult?.ok === true);
  fs.rmSync(approvalDir, { recursive: true, force: true });
}

{
  const dbDrift = createDatabase(":memory:", {});
  const storeDrift = new Store(dbDrift);
  const workspaceDrift = storeDrift.createWorkspace({ name: "drift-ws" });
  const driftDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiCLI-discord-base-drift-"));
  const driftEvents = [];
  const ptyDrift = new PtyService({
    agentRegistry: {
      get: (name) => ({ name, type: "gemini", settings: {} }),
      list: () => [{ name: "gemini", type: "gemini" }],
    },
    config: {
      codexWorkdir: process.cwd(),
      runtimeStatePath: path.join(driftDir, "state.json"),
      driftDetection: {
        pollMs: 5000,
        runningSilenceMs: 60000,
        readySilenceMs: 120000,
      },
    },
    bus: { publish: (type, payload) => driftEvents.push({ type, payload }) },
    store: storeDrift,
  });
  const driftKey = `${workspaceDrift.id}:gemini`;
  const driftState = ptyDrift._ensureState(driftKey, "gemini", workspaceDrift.id);
  driftState.status = "running";
  driftState.lastOutputAt = Date.now() - 61000;
  ptyDrift._ptys.set(driftKey, { write() {} });
  const stalledState = ptyDrift.getAgentTerminalState("gemini", workspaceDrift.id);
  ok("PtyService drift → stalled warningCode", stalledState.warningCode === "drift_stalled");
  ok("PtyService drift → stalled warningMessage has seconds", /61s|60s/.test(stalledState.warningMessage));
  ok(
    "PtyService drift → emits observer.notice",
    driftEvents.some((entry) => entry.type === "observer.notice" && entry.payload?.kind === "drift_stalled"),
  );

  driftState.status = "idle";
  driftState.readyForPrompt = true;
  driftState.lastOutputAt = Date.now() - 121000;
  driftState.lastObserverNoticeKey = "";
  const idleState = ptyDrift.getAgentTerminalState("gemini", workspaceDrift.id);
  ok("PtyService drift → idle warningCode", idleState.warningCode === "drift_idle");
  ptyDrift.stopAll();
  fs.rmSync(driftDir, { recursive: true, force: true });
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
  const remoteCommands = [];
  const replies = [];
  const reacted = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ workspaceId: "ws-discord-slash", defaultAgent: null }),
      getWorkspace: (workspaceId) => (workspaceId === "ws-discord-slash" ? { id: "ws-discord-slash", name: "workspace-slash" } : null),
      getWorkspaceParentAgent: () => "gemini",
      runPrompt: async (payload) => {
        runPrompts.push(payload);
        return { text: "ok", usage: {} };
      },
      sendRemoteCommand: async (...args) => {
        remoteCommands.push(args);
        return { ok: true, finalStatus: "running" };
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
    content: "/help",
    channelId: "discord-channel-slash",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-slash",
    channel: {
      id: "discord-channel-slash",
      name: "workspace-slash",
      send: async () => null,
    },
    reply: async (content) => {
      replies.push(content);
      return null;
    },
    react: async (emoji) => {
      reacted.push(emoji);
      return null;
    },
  };
  await adapter.handleMessage(message);
  ok("Discord slash passthrough routes to shared PTY remote command", remoteCommands[0]?.[2] === "/help");
  ok("Discord slash passthrough does not call runPrompt", runPrompts.length === 0);
  ok("Discord slash passthrough replies with routing notice", replies.some((text) => String(text).includes("shared PTY")));
  ok("Discord slash passthrough reacts success", reacted.includes("\u2611"));
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
  ok("Discord plain message without binding → shows binding guidance", replies.some((line) => String(line).includes("workspace! <名前>")));
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
    content: "new!",
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
  ok("Discord new! without binding → creates workspace", createdWorkspaces.length === 1);
  ok("Discord new! without binding → reuses active workspace parent agent", createdWorkspaces[0]?.parentAgent === "gemini2");
  ok("Discord new! without binding → binds new workspace to channel", boundChannels[0]?.discordChannelId === "discord-channel-3" && boundChannels[0]?.workspaceId === "ws-new");
  ok("Discord new! without binding → confirms workspace creation", replies.some((line) => String(line).includes("Started a new workspace")));
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
    content: "workspace! ml003actual",
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
  ok("Discord workspace! create without binding → creates workspace", createdWorkspaces.length === 1);
  ok("Discord workspace! create without binding → reuses active workspace parent agent", createdWorkspaces[0]?.parentAgent === "gemini2");
  ok("Discord workspace! create without binding → binds new workspace to channel", boundChannels[0]?.discordChannelId === "discord-channel-ml003" && boundChannels[0]?.workspaceId === "ws-created");
  ok("Discord workspace! create without binding → confirms workspace creation", replies.some((line) => String(line).includes("Started a new workspace")));
}

{
  const replies = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-status", workspaceId: "ws-status", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-status", name: "status-workspace" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [
        { agentName: "gemini", isParent: true },
        { agentName: "claude", isParent: false },
      ],
      getAgentTerminalState: (agentName) => (
        agentName === "gemini"
          ? {
              status: "waiting_input",
              hasProcess: true,
              readyForPrompt: false,
              lastOutputAt: Date.now() - 5000,
              warningCode: "drift_stalled",
            }
          : { status: "idle", hasProcess: true, readyForPrompt: true, lastOutputAt: Date.now() - 60000 }
      ),
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
      names: () => ["gemini", "claude"],
      list: () => [
        { name: "gemini", type: "gemini", model: "gemini-2.5-flash" },
        { name: "claude", type: "claude", model: "claude-sonnet-4.5" },
      ],
      get: (name) => ({ name }),
    },
  });
  adapter.workspacePromptQueues.set(adapter.getWorkspacePromptQueueKey("ws-status", "gemini"), {
    tail: Promise.resolve(),
    pendingCount: 3,
  });
  const message = {
    content: "status!",
    channelId: "discord-channel-status",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-status",
    channel: { id: "discord-channel-status", name: "status-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord status! → shows workspace name", replies.some((line) => String(line).includes("Workspace: status-workspace")));
  ok("Discord status! → shows waiting_input state", replies.some((line) => String(line).includes("status=waiting_input")));
  ok("Discord status! → shows queued turns", replies.some((line) => String(line).includes("queue=2")));
  ok("Discord status! → shows drift warning", replies.some((line) => String(line).includes("warning=drift_stalled")));
}

{
  const replies = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-output", workspaceId: "ws-output", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-output", name: "output-workspace" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [{ agentName: "gemini", isParent: true }],
      getAgentTerminalOutput: () => ({
        status: "waiting_input",
        hasProcess: true,
        text: "line 1\nline 2",
        totalLineCount: 2,
        lineLimit: 50,
        truncated: false,
      }),
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
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "output!",
    channelId: "discord-channel-output",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-output",
    channel: { id: "discord-channel-output", name: "output-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord output! → shows output header", replies.some((line) => String(line).includes("Latest PTY output: gemini")));
  ok("Discord output! → includes latest PTY lines", replies.some((line) => String(line).includes("> line 1")));
}

{
  const replies = [];
  const sentInputs = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-enter", workspaceId: "ws-enter", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-enter", name: "enter-workspace", workdir: "C:\\workdir" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [{ agentName: "gemini", isParent: true }],
      sendTerminalInput: (agentName, workspaceId, data) => {
        sentInputs.push({ agentName, workspaceId, data });
        return { ok: true, state: { status: "running" } };
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
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "enter!",
    channelId: "discord-channel-enter",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-enter",
    channel: { id: "discord-channel-enter", name: "enter-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord enter! → sends carriage return to PTY", sentInputs[0]?.agentName === "gemini" && sentInputs[0]?.workspaceId === "ws-enter" && sentInputs[0]?.data === "\r");
  ok("Discord enter! → confirms send", replies.some((line) => String(line).includes("Enter を送信しました")));
}

{
  const replies = [];
  const approvalDecisions = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-approval", workspaceId: "ws-approval", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-approval", name: "approval-workspace", workdir: "C:\\workdir" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [{ agentName: "gemini", isParent: true }],
      respondToApproval: (agentName, workspaceId, decision) => {
        approvalDecisions.push({ agentName, workspaceId, decision });
        return { ok: true, state: { status: "running" } };
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
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "approve!",
    channelId: "discord-channel-approval",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-approval",
    channel: { id: "discord-channel-approval", name: "approval-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord approve! → forwards approval decision", approvalDecisions[0]?.decision === "approve");
  ok("Discord approve! → confirms send", replies.some((line) => String(line).includes("approve を送信しました")));
}

{
  const replies = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-bindings", workspaceId: "ws-bindings", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-bindings", name: "bindings-workspace" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [{ agentName: "gemini", isParent: true }],
      listResumeBindings: () => [{ agentName: "gemini", providerSessionRef: "session-123", bindingStatus: "valid" }],
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
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "bindings!",
    channelId: "discord-channel-bindings",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-bindings",
    channel: { id: "discord-channel-bindings", name: "bindings-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord bindings! → shows session ref", replies.some((line) => String(line).includes("session-123")));
}

{
  const replies = [];
  const resumeCalls = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-resume", workspaceId: "ws-resume", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-resume", name: "resume-workspace", workdir: "C:\\workdir" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [{ agentName: "gemini", isParent: true }],
      resumeAgentSession: async (agentName, workspaceId) => {
        resumeCalls.push({ agentName, workspaceId });
        return { resumed: true, terminalState: { status: "waiting_input" } };
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
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "resume!",
    channelId: "discord-channel-resume",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-resume",
    channel: { id: "discord-channel-resume", name: "resume-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord resume! → calls resumeAgentSession", resumeCalls[0]?.agentName === "gemini" && resumeCalls[0]?.workspaceId === "ws-resume");
  ok("Discord resume! → confirms resume", replies.some((line) => String(line).includes("resume しました")));
}

{
  const replies = [];
  const restartCalls = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-restart", workspaceId: "ws-restart", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-restart", name: "restart-workspace", workdir: "C:\\workdir" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [{ agentName: "gemini", isParent: true }],
      restartAgent: async (agentName, workspaceId) => {
        restartCalls.push({ agentName, workspaceId });
        return { terminalState: { status: "waiting_input" } };
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
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "restart!",
    channelId: "discord-channel-restart",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-restart",
    channel: { id: "discord-channel-restart", name: "restart-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord restart! → calls restartAgent", restartCalls[0]?.agentName === "gemini" && restartCalls[0]?.workspaceId === "ws-restart");
  ok("Discord restart! → confirms restart", replies.some((line) => String(line).includes("再起動しました")));
}

{
  const replies = [];
  const checkpointCalls = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-checkpoints", workspaceId: "ws-checkpoints", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-checkpoints", name: "checkpoints-workspace" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [{ agentName: "gemini", isParent: true }],
      createWorkspaceCheckpoint: (workspaceId, options) => {
        checkpointCalls.push({ workspaceId, options });
        return { id: "cp-1" };
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
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "checkpoints! create nightly",
    channelId: "discord-channel-checkpoints",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-checkpoints",
    channel: { id: "discord-channel-checkpoints", name: "checkpoints-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord checkpoints! create → calls createWorkspaceCheckpoint", checkpointCalls[0]?.workspaceId === "ws-checkpoints" && checkpointCalls[0]?.options?.label === "nightly");
  ok("Discord checkpoints! create → confirms checkpoint", replies.some((line) => String(line).includes("cp-1")));
}

{
  const replies = [];
  const rollbackCalls = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-rollback", workspaceId: "ws-rollback", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-rollback", name: "rollback-workspace" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [{ agentName: "gemini", isParent: true }],
      previewWorkspaceRollback: (workspaceId, checkpointId) => {
        rollbackCalls.push({ workspaceId, checkpointId });
        return { blocked: false, reasons: [] };
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
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "rollback! preview cp-1",
    channelId: "discord-channel-rollback",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-rollback",
    channel: { id: "discord-channel-rollback", name: "rollback-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord rollback! preview → calls previewWorkspaceRollback", rollbackCalls[0]?.workspaceId === "ws-rollback" && rollbackCalls[0]?.checkpointId === "cp-1");
  ok("Discord rollback! preview → shows preview header", replies.some((line) => String(line).includes("Preview: cp-1")));
}

{
  const replies = [];
  const skillCalls = [];
  const adapter = new DiscordAdapter({
    bridge: {
      createSession: () => ({ id: "legacy-session" }),
      findSessionByDiscordChannel: () => null,
    },
    agentBridge: {
      getDiscordBinding: () => ({ discordChannelId: "discord-channel-skills", workspaceId: "ws-skills", defaultAgent: "gemini" }),
      getWorkspace: () => ({ id: "ws-skills", name: "skills-workspace" }),
      getWorkspaceParentAgent: () => "gemini",
      listWorkspaceAgents: () => [{ agentName: "gemini", isParent: true }],
      applyWorkspaceSkillSync: (workspaceId, options) => {
        skillCalls.push({ workspaceId, options });
        return { changes: [{ action: "copy", target: ".gemini\\skills\\workspace-overview.md" }] };
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
      get: (name) => ({ name }),
    },
  });
  const message = {
    content: "skills! apply gemini",
    channelId: "discord-channel-skills",
    guildId: "guild-1",
    attachments: new Map(),
    id: "discord-message-skills",
    channel: { id: "discord-channel-skills", name: "skills-channel", send: async () => null },
    reply: async (content) => {
      replies.push(content);
      return { edit: async () => null, delete: async () => null };
    },
    react: async () => null,
  };
  await adapter.handleMessage(message);
  ok("Discord skills! apply → calls applyWorkspaceSkillSync", skillCalls[0]?.workspaceId === "ws-skills" && skillCalls[0]?.options?.agentName === "gemini");
  ok("Discord skills! apply → confirms sync", replies.some((line) => String(line).includes("skill sync を適用しました")));
}

// ── 11. API エラーケース ───────────────────────────────────────────────────

section("11. REST API エラーケース");

// HTTP helpers
function request(method, url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.pathname + opts.search,
      method,
      headers: {
        ...extraHeaders,
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

{
  let prepareCalls = 0;
  let runCalls = 0;
  const isolatedServer = createHttpServer({
    config: {
      uiDir: path.resolve("ui"),
      uploadsDir: path.resolve("uploads"),
      xtermDir: path.resolve("node_modules/xterm"),
      xtermAddonFitPath: path.resolve("node_modules/@xterm/addon-fit/lib/addon-fit.js"),
    },
    bridge: {
      getRuntimeInfo() {
        return {};
      },
      listSessions() {
        return [];
      },
    },
    agentBridge: {
      store: {
        getWorkspace(id) {
          return id === "ws-http" ? { id: "ws-http", name: "http-test" } : null;
        },
      },
      getActiveWorkspace() {
        return null;
      },
      async preparePrompt() {
        prepareCalls += 1;
        return {
          agent: { name: "gemini", type: "gemini", settings: {} },
          workspace: { id: "ws-http", name: "http-test" },
          effectiveWorkdir: process.cwd(),
        };
      },
      async runPrompt() {
        runCalls += 1;
        throw new Error("Terminal に未送信の入力があります。Enter で送信するか Ctrl+C で取り消してから再送してください。");
      },
    },
    bus: { on() {}, publish() {} },
    discord: null,
    attachments: null,
    scheduler: {
      listJobs() {
        return [];
      },
    },
    restartServer: async () => {},
    ptyService: null,
  });
  await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
  const isolatedPort = isolatedServer.address().port;
  const isolatedBase = `http://127.0.0.1:${isolatedPort}`;
  const slashFailure = await request("POST", `${isolatedBase}/api/agents/gemini/run`, {
    prompt: "/help",
    workspaceId: "ws-http",
    inputMode: "slash_command",
  });
  ok("HTTP slash_command failure returns conflict instead of false success", slashFailure.status === 409);
  ok("HTTP slash_command failure still runs awaited prompt path", prepareCalls === 1 && runCalls === 1);
  await new Promise((resolve) => isolatedServer.close(resolve));
}

{
  let checkpointCalls = 0;
  const isolatedServer = createHttpServer({
    config: {
      uiDir: path.resolve("ui"),
      uploadsDir: path.resolve("uploads"),
      xtermDir: path.resolve("node_modules/xterm"),
      xtermAddonFitPath: path.resolve("node_modules/@xterm/addon-fit/lib/addon-fit.js"),
      apiAuth: {
        token: "test-token",
        allowLoopback: false,
      },
    },
    bridge: {
      getRuntimeInfo() {
        return {};
      },
      listSessions() {
        return [];
      },
    },
    agentBridge: {
      getWorkspace(id) {
        return id === "ws-http-auth" ? { id: "ws-http-auth", name: "http-auth" } : null;
      },
      createWorkspaceCheckpoint() {
        checkpointCalls += 1;
        return { id: "cp-auth-1" };
      },
    },
    bus: { on() {}, publish() {} },
    discord: null,
    attachments: null,
    scheduler: {
      listJobs() {
        return [];
      },
    },
    restartServer: async () => {},
    ptyService: null,
  });
  await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
  const isolatedPort = isolatedServer.address().port;
  const isolatedBase = `http://127.0.0.1:${isolatedPort}`;
  const denied = await request("POST", `${isolatedBase}/api/workspaces/ws-http-auth/checkpoints`, { label: "auth-test" });
  ok("Sensitive checkpoint POST without token → 403", denied.status === 403);
  const allowed = await request(
    "POST",
    `${isolatedBase}/api/workspaces/ws-http-auth/checkpoints`,
    { label: "auth-test" },
    { Authorization: "Bearer test-token" },
  );
  ok("Sensitive checkpoint POST with bearer token → 201", allowed.status === 201);
  ok("Sensitive checkpoint POST with bearer token → handler called", checkpointCalls === 1);
  await new Promise((resolve) => isolatedServer.close(resolve));
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

  // Health response shape
  {
    const r = await request("GET", `${BASE}/api/health`);
    const j = r.json();
    ok("health response has ok field", "ok" in j);
  }

  {
    const patchGlobalMemory = await request("PATCH", `${BASE}/api/memory/global`, { content: "global note" });
    const getGlobalMemory = await request("GET", `${BASE}/api/memory/global`);
    ok("PATCH /api/memory/global → 200", patchGlobalMemory.status === 200);
    ok("GET /api/memory/global → returns saved content", getGlobalMemory.json()?.content === "global note");
  }

  // Create workspace then try to activate it
  {
    const agentsResponse = await request("GET", `${BASE}/api/agents`);
    const liveAgentList = Array.isArray(agentsResponse.json()) ? agentsResponse.json() : [];
    const parentAgent = liveAgentList[0]?.name;
    const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiCLI-discord-base-http-workspace-"));
    const tempViewerPath = path.join(tempWorkspaceDir, "viewer-note.txt");
    fs.writeFileSync(tempViewerPath, "alpha\nbeta\n", "utf8");
    if (parentAgent) {
      const missingList = await request("GET", `${BASE}/api/workspaces/does-not-exist/agents`);
      ok("GET /api/workspaces/non-existent/agents → 404", missingList.status === 404);

      const missingAdd = await request("POST", `${BASE}/api/workspaces/does-not-exist/agents`, { agentName: parentAgent });
      ok("POST /api/workspaces/non-existent/agents → 404", missingAdd.status === 404);
    }
    const create = await request(
      "POST",
      `${BASE}/api/workspaces`,
      parentAgent ? { name: "edge-case-ws", parentAgent, workdir: tempWorkspaceDir } : { name: "edge-case-ws", workdir: tempWorkspaceDir }
    );
    ok("create edge-case-ws → 201", create.status === 201);
    const wsId = create.json()?.id;
    if (wsId) {
      const members = await request("GET", `${BASE}/api/workspaces/${wsId}/agents`);
      ok("GET /api/workspaces/:id/agents → 200", members.status === 200 && Array.isArray(members.json()));

      const workspaceMemoryPatch = await request("PATCH", `${BASE}/api/memory/workspaces/${wsId}`, {
        content: "workspace note",
      });
      const workspaceMemoryGet = await request("GET", `${BASE}/api/memory/workspaces/${wsId}`);
      ok("PATCH /api/memory/workspaces/:id → 200", workspaceMemoryPatch.status === 200);
      ok("GET /api/memory/workspaces/:id → saved content", workspaceMemoryGet.json()?.content === "workspace note");

      const fileViewer = await request("GET", `${BASE}/api/files/view?path=${encodeURIComponent(tempViewerPath)}`);
      ok("GET /api/files/view → 200", fileViewer.status === 200);
      ok("GET /api/files/view → first line", fileViewer.json()?.lines?.[0]?.text === "alpha");

      const bindings = await request("GET", `${BASE}/api/workspaces/${wsId}/bindings`);
      ok("GET /api/workspaces/:id/bindings → 200", bindings.status === 200 && Array.isArray(bindings.json()));

      const terminalStates = await request("GET", `${BASE}/api/workspaces/${wsId}/terminal-states`);
      ok("GET /api/workspaces/:id/terminal-states → 200", terminalStates.status === 200 && Array.isArray(terminalStates.json()));

      const checkpoints = await request("GET", `${BASE}/api/workspaces/${wsId}/checkpoints`);
      ok("GET /api/workspaces/:id/checkpoints → 200", checkpoints.status === 200 && Array.isArray(checkpoints.json()));

      const audits = await request("GET", `${BASE}/api/workspaces/${wsId}/audits`);
      ok("GET /api/workspaces/:id/audits → 200", audits.status === 200 && Array.isArray(audits.json()));

      const consolidationPreview = await request("GET", `${BASE}/api/workspaces/${wsId}/memory/consolidation/preview`);
      ok("GET /api/workspaces/:id/memory/consolidation/preview → 200", consolidationPreview.status === 200);
      ok("GET /api/workspaces/:id/memory/consolidation/preview → scope=workspace", consolidationPreview.json()?.scope === "workspace");

      const diaryPreview = await request("GET", `${BASE}/api/workspaces/${wsId}/memory/diary/preview`);
      ok("GET /api/workspaces/:id/memory/diary/preview → 200", diaryPreview.status === 200);
      ok("GET /api/workspaces/:id/memory/diary/preview → scope=diary", diaryPreview.json()?.scope === "diary");

      const skillsRegistry = await request("GET", `${BASE}/api/skills/registry`);
      ok("GET /api/skills/registry → 200", skillsRegistry.status === 200);
      ok("GET /api/skills/registry → has skillCount", Number.isFinite(skillsRegistry.json()?.skillCount));

      const skillPlan = await request("POST", `${BASE}/api/workspaces/${wsId}/skills/sync`, {});
      ok("POST /api/workspaces/:id/skills/sync → 200", skillPlan.status === 200);
      ok("POST /api/workspaces/:id/skills/sync → plans array", Array.isArray(skillPlan.json()?.plans));

      const childAgent = liveAgentList.find((agent) => agent.name !== parentAgent)?.name;
      if (childAgent) {
        const addChild = await request("POST", `${BASE}/api/workspaces/${wsId}/agents`, { agentName: childAgent });
        ok("POST /api/workspaces/:id/agents → 201", addChild.status === 201);
      }

      if (parentAgent) {
        const agentMemoryPatch = await request("PATCH", `${BASE}/api/memory/agents/${encodeURIComponent(parentAgent)}`, {
          content: "agent note",
        });
        const agentMemoryGet = await request("GET", `${BASE}/api/memory/agents/${encodeURIComponent(parentAgent)}`);
        ok("PATCH /api/memory/agents/:name → 200", agentMemoryPatch.status === 200);
        ok("GET /api/memory/agents/:name → saved content", agentMemoryGet.json()?.content === "agent note");
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
  const prompt = "Reply exactly this line:\n日本語MIX_OK 😀 `code` https://example.com/path?q=1&x=2 **bold** § ※";
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "User:",
      "[User prompt]",
      prompt,
      "Model: 日本語MIX_OK 😀 code https://example.com/pathq=1&x=2 bold § ※",
      "Type your message or @path/to/file",
    ].join("\n"),
    prompt,
  );
  ok(
    "Gemini sanitize restores exact mixed-character line when the rendered transcript only dropped markdown punctuation",
    sanitized === "日本語MIX_OK 😀 `code` https://example.com/path?q=1&x=2 **bold** § ※",
  );
}
{
  const prompt = `Reply only H203R_OK ${Array.from({ length: 24 }, (_, index) => `hf-${String(index + 1).padStart(4, "0")}`).join(" ")}`;
  const wrappedEcho = prompt.replace(/ /g, "\n");
  const stripped = ptyTestHooks.stripPromptEcho(
    [
      "responding…",
      wrappedEcho,
      "Type your message or @path/to/file",
    ].join("\n"),
    prompt,
  );
  ok(
    "Gemini prompt echo stripping removes whitespace-wrapped long single-line echoes before ready-return heuristics run",
    !stripped.includes("H203R_OK") && stripped.includes("Type your message or @path/to/file"),
  );
}
{
  const target = `H203RECOVER_OK ${Array.from({ length: 12 }, (_, index) => `hr-${String(index + 1).padStart(4, "0")}`).join(" ")}`;
  const prompt = `Reply only ${target}`;
  const sanitized = ptyTestHooks.sanitizeGeminiTranscript(
    [
      "User:",
      "[User prompt]",
      prompt,
      "workspace (/directory)",
      "~\\Desktop\\AI\\repos\\github\\harunamitrader\\multiCLI-discord-base branch",
      `main sandbox ${prompt}`,
      "Type your message or @path/to/file",
    ].join("\n"),
    prompt,
  );
  ok(
    "Gemini sanitize recovers the exact single-line target from a Reply only prompt even when prompt echo and scaffold text contaminate the transcript",
    sanitized === target,
  );
}
{
  const prompt = "Reply with exactly these two lines:\nCODEX_ML_A\nCODEX_ML_B";
  const sanitized = ptyTestHooks.sanitizeCodexTranscript(
    [
      "› Say CODEX_ROUTE",
      "• CODEX_ROUTE",
      "› gpt-5.4 · ready",
      "› Reply with exactly these two lines:",
      "CODEX_ML_A",
      "CODEX_ML_B",
      "• CODEX_ML_A",
      "• CODEX_ML_B",
      "› gpt-5.4 · ready",
    ].join("\n"),
    prompt,
  );
  ok(
    "Codex sanitize scopes multiline extraction to the current prompt instead of leaking a prior turn",
    sanitized === "CODEX_ML_A\nCODEX_ML_B",
  );
}
{
  const prompt = "Reply with exactly these two lines:\nCODEX_ML_A\nCODEX_ML_B";
  const shouldWait = ptyTestHooks.codexLooksReadyReturn(
    [
      "› Reply with exactly these two lines:",
      "CODEX_ML_A",
      "CODEX_ML_B",
      "• CODEX_ML_A",
      "› gpt-5.4 · ready",
    ].join("\n"),
    prompt,
  );
  ok(
    "Codex ready-return does not complete early while an exact multiline target is still incomplete",
    shouldWait === false,
  );
}
{
  const prompt = "Reply with exactly these two lines:\nISO_A\nISO_B";
  const sanitized = ptyTestHooks.sanitizeCodexTranscript(
    [
      "› Reply with exactly these two lines:",
      "ISO_A",
      "ISO_B",
      "› Implement {feature}",
      "gpt-5.4 medium · workspace",
      "• Working (0s • esc to interrupt)",
      "ki2",
      "• ISO_A",
      "› Implement {feature}",
      "gpt-5.4 medium · workspace",
      "ISO_B",
    ].join("\n"),
    prompt,
  );
  ok(
    "Codex sanitize recovers an exact multiline target from raw transcript lines even when the second line only survives outside bullet extraction",
    sanitized === "ISO_A\nISO_B",
  );
}
{
  const prompt = "Reply with exactly these two lines:\nCODEX_ML_A\nCODEX_ML_B";
  ok(
    "Exact reply matcher rejects an incomplete multiline Codex reply",
    ptyTestHooks.exactReplyMatchesTarget(prompt, "CODEX_ML_A") === false,
  );
  ok(
    "Exact reply matcher accepts a complete multiline Codex reply",
    ptyTestHooks.exactReplyMatchesTarget(prompt, "CODEX_ML_A\nCODEX_ML_B") === true,
  );
}
{
  const prompt = "Reply with exactly these two lines:\nCODEX_ML_A\nCODEX_ML_B";
  const preferred = ptyTestHooks.choosePreferredTranscript(
    "codex",
    "CODEX_ML_A",
    "CODEX_ML_A\nCODEX_ML_B",
    prompt,
  );
  ok(
    "Transcript chooser prefers the fallback when it covers more lines of an exact multiline target",
    preferred === "CODEX_ML_A\nCODEX_ML_B",
  );
}
{
  const sanitized = ptyTestHooks.sanitizeCodexTranscript(
    [
      "› Reply with exactly this line:",
      "CODEX_G3_OK",
      "• g3",
      "• CODEX_G3_OK",
      "› gpt-5.4 · ready",
    ].join("\n"),
    "Reply with exactly this line:\nCODEX_G3_OK",
  );
  ok(
    "Codex sanitize drops short model fragments like g3 that can leak ahead of the real reply",
    sanitized === "CODEX_G3_OK",
  );
}
{
  const isDetected = ptyTestHooks.isCodexUpdateSelectionPrompt(
    [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "1. Update now (runs `npm install -g @openai/codex`)",
      "2. Skip",
      "3. Skip until next version",
      "Press enter to continue",
    ].join("\n"),
  );
  ok("Codex startup detects the blocking update-selection prompt", isDetected === true);
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
  const forwarded = [];
  const ptyService = new PtyService({
    agentRegistry: {
      get() {
        return { type: "gemini" };
      },
    },
    config: { codexWorkdir: process.cwd() },
  });
  ptyService.assertPromptReady = async () => ({ key: "ws-remote:gemini", ptyProc: { id: "pty-1" } });
  ptyService._forwardTerminalInput = (payload) => {
    forwarded.push(payload);
    return payload.ptyProc;
  };
  const remoteResult = await ptyService.sendRemoteCommand({
    agentName: "gemini",
    workspaceId: "ws-remote",
    command: "/help",
    source: "discord-slash",
    metadata: { inputMode: "slash_command" },
  });
  ok("PtyService.sendRemoteCommand forwards slash command text first", forwarded[0]?.data === "/help");
  ok("PtyService.sendRemoteCommand forwards enter as second write", forwarded[1]?.data === "\r");
  ok("PtyService.sendRemoteCommand keeps source metadata", forwarded[0]?.source === "discord-slash" && forwarded[0]?.metadata?.inputMode === "slash_command");
  ok("PtyService.sendRemoteCommand returns running state", remoteResult?.finalStatus === "running");
}
{
  const ptyService = new PtyService({
    agentRegistry: {
      get() {
        return { type: "gemini" };
      },
    },
    config: { codexWorkdir: process.cwd() },
  });
  const key = "ws-h602:gemini2";
  const state = ptyService._ensureState(key, "gemini2", "ws-h602");
  ptyService.ensureAgentPty = () => ({
    write() {},
  });
  state.status = "idle";
  state.readyForPrompt = true;
  state.manualInputBuffer = "DRAFT_H602";
  state.manualInputDirty = true;

  ptyService._handleOutput(key, "Type your message or @path/to/file");

  let busyError = null;
  try {
    await ptyService.sendRemoteCommand({
      agentName: "gemini2",
      workspaceId: "ws-h602",
      command: "/help",
      source: "ui",
      metadata: { inputMode: "slash_command" },
    });
  } catch (error) {
    busyError = error;
  }

  ok(
    "Idle ready redraw preserves terminal draft so slash command remains blocked",
    state.manualInputDirty === true && state.manualInputBuffer === "DRAFT_H602",
  );
  ok(
    "PtyService.sendRemoteCommand rejects when a preserved terminal draft exists",
    busyError?.message === "Terminal に未送信の入力があります。Enter で送信するか Ctrl+C で取り消してから再送してください。",
  );
}
{
  const ptyService = new PtyService({
    agentRegistry: {
      get() {
        return { type: "gemini" };
      },
    },
    config: { codexWorkdir: process.cwd() },
  });
  const key = "ws-h902:gemini";
  const state = ptyService._ensureState(key, "gemini", "ws-h902");
  state.status = "manual_running";
  state.readyForPrompt = false;
  state.promptText = "/model";
  state.manualTurnPersist = true;

  ptyService._handleOutput(
    key,
    "Type your message or @path/to/file\nSelect Model\n(Press Esc to close)\n",
  );

  ok("Gemini selector marks shared PTY as waiting_input", state.status === "waiting_input");
  ok("Gemini selector keeps readyForPrompt false", state.readyForPrompt === false);
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
    "Reply with exactly these two lines:\nCODEX_BP_A\nCODEX_BP_B",
    "codex",
    { originalPrompt: "Reply with exactly these two lines:\nCODEX_BP_A\nCODEX_BP_B" },
  );
  ok(
    "Codex multiline prompt uses bracketed paste and a second Enter so embedded newlines submit as one turn",
    writes[0] === "\u001b[200~Reply with exactly these two lines:\rCODEX_BP_A\rCODEX_BP_B\u001b[201~" &&
      writes[1] === "\r" &&
      writes[2] === "\r" &&
      writes.length === 3,
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
    "H203_LONG_OK " + "filler ".repeat(120),
    "gemini",
    { originalPrompt: "H203_LONG_OK " + "filler ".repeat(120) },
  );
  ok(
    "Gemini long single-line prompt sends a second Enter to flush the composer",
    writes.filter((value) => value === "\r").length === 2,
  );
}
{
  const ptyService = new PtyService({
    agentRegistry: {
      get() {
        return { type: "gemini" };
      },
    },
    config: { codexWorkdir: process.cwd() },
  });
  const key = "ws-h402:gemini2";
  const state = ptyService._ensureState(key, "gemini2", "ws-h402");
  state.status = "manual_running";
  state.readyForPrompt = false;
  state.promptText = "Count from 1 to 200, one per line, then END_H402B";
  state.turnActivitySeen = true;
  state.rawBuffer = [
    "workspace (/directory)",
    "C:\\Users\\example\\workspace",
    "main sandbox",
  ].join("\n");

  const delays = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return 1;
  };
  globalThis.clearTimeout = () => {};
  try {
    ptyService._handleOutput(key, "Type your message or @path/to/file");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  ok(
    "Gemini manual turn does not arm completion on a short ready-return scaffold before response text appears",
    state._completedByReadyReturn === false && delays.length === 0,
  );
}
{
  const contaminatedTranscript = [
    "127",
    "128",
    "129",
    "END_H402_POSTFIX",
    "C workspace (/directory) Count Count from workspace (/directory) Count from 1 to workspace (/directory) Count from 1 to 50, workspace (/directory) Count from 1 to 50, one per li workspace (/directory) Count from 1 to 50, one per line, then END_H402_FA workspace (/directory)",
    "Type your message or @path/to/file",
  ].join("\n");
  ok(
    "Gemini contaminated manual transcript is recognized as prompt echo noise",
    ptyTestHooks.transcriptLooksContaminatedByPromptEcho(
      "gemini",
      contaminatedTranscript,
      "Count from 1 to 50, one per line, then END_H402_FAST",
    ) === true,
  );
}
{
  const ptyService = new PtyService({
    agentRegistry: {
      get() {
        return { type: "gemini" };
      },
    },
    config: { codexWorkdir: process.cwd() },
  });
  const key = "ws-h402-stale:gemini2";
  const state = ptyService._ensureState(key, "gemini2", "ws-h402-stale");
  state.status = "manual_running";
  state.readyForPrompt = false;
  state.promptText = "Count from 1 to 50, one per line, then END_H402_FAST";
  state.turnActivitySeen = true;
  state.rawBuffer = [
    "127",
    "128",
    "129",
    "END_H402_POSTFIX",
    "C workspace (/directory) Count Count from workspace (/directory) Count from 1 to workspace (/directory) Count from 1 to 50, workspace (/directory) Count from 1 to 50, one per li workspace (/directory) Count from 1 to 50, one per line, then END_H402_FA workspace (/directory)",
  ].join("\n");

  const delays = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return 1;
  };
  globalThis.clearTimeout = () => {};
  try {
    ptyService._handleOutput(key, "Type your message or @path/to/file");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  ok(
    "Gemini manual turn does not schedule completion on stale transcript plus prompt echo",
    state._completedByReadyReturn === false && delays.length === 0,
  );
}
{
  const ptyService = new PtyService({
    agentRegistry: {
      get() {
        return { type: "gemini" };
      },
    },
    config: { codexWorkdir: process.cwd() },
  });
  const key = "ws-h403-ctrlc:gemini2";
  const state = ptyService._ensureState(key, "gemini2", "ws-h403-ctrlc");
  state.status = "running";
  state.readyForPrompt = false;
  state.runId = "run-h403";
  let cancelledErr = null;
  state.pendingReject = (err) => {
    cancelledErr = err;
  };
  const oldPty = {
    writeCalls: [],
    killed: false,
    write(data) {
      this.writeCalls.push(data);
    },
    kill() {
      this.killed = true;
    },
  };
  const newPty = {
    writeCalls: [],
    kill() {},
    write(data) {
      this.writeCalls.push(data);
    },
  };
  ptyService._ptys.set(key, oldPty);
  ptyService._scrollback.set(key, "stale output");
  let respawnCount = 0;
  ptyService.ensureAgentPty = (agentName, workspaceId) => {
    respawnCount += 1;
    ptyService._ptys.set(key, newPty);
    const nextState = ptyService._ensureState(key, agentName, workspaceId);
    nextState.status = "starting";
    nextState.readyForPrompt = false;
    return newPty;
  };

  const returnedPty = ptyService._forwardTerminalInput({
    key,
    agentName: "gemini2",
    workspaceId: "ws-h403-ctrlc",
    workdir: process.cwd(),
    data: "\u0003",
    ptyProc: oldPty,
  });

  ok(
    "Ctrl+C during running respawns the shared PTY instead of leaving the run stuck",
    returnedPty === newPty && respawnCount === 1 && ptyService._ptys.get(key) === newPty,
  );
  ok(
    "Ctrl+C during running cancels the pending run and kills the old PTY",
    oldPty.killed === true && cancelledErr?.cancelled === true && state.runId === null,
  );
  ok(
    "Ctrl+C during running clears stale scrollback and does not write raw input to the old PTY",
    ptyService._scrollback.get(key) === "" && oldPty.writeCalls.length === 0,
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
  const policy = resolveWorkspaceContextPolicy({
    workspace: { contextInjectionEnabled: null },
    workspaceAgentCount: 1,
    requestedIncludeContext: true,
  });
  ok("Context policy defaults single-agent workspace to off", policy.effective === false && policy.mode === "default");
}
{
  const contextBlock = buildContextBlock([
    { role: "user", agentName: "gemini", content: "前回の依頼です" },
    { role: "assistant", agentName: "gemini", content: "前回の返答です" },
  ], "gemini");
  ok("Context block builds compact visible transcript", contextBlock?.messageCount === 2 && contextBlock?.totalChars > 0);
}
{
  const localInput = discordTestHooks.formatLocalInputMessage({
    text: "/help",
    metadata: { inputMode: "slash_command" },
  });
  ok("Discord local input formatter labels raw slash passthrough", localInput.includes("Mode: / passthrough"));
}
{
  ok("Discord slash helper accepts single-line slash commands", discordTestHooks.isSlashPassthroughInput("/help") === true);
  ok("Discord slash helper rejects multiline slash input", discordTestHooks.isSlashPassthroughInput("/help\nmore") === false);
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
