/**
 * multicodi フロントエンド
 *
 * - SSE /api/stream で CanonicalEvent を受信
 * - REST /api/agents/* でエージェント操作
 * - LINE風チャット UI
 */

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  agents: [],
  selectedAgent: null,
  workspaceId: "default",
  // agentName → [message objects]
  chatLogs: new Map(),
  // agentName → { toolId → toolCardEl }
  toolCards: new Map(),
  // agentName → typing indicator el
  typingEls: new Map(),
  // agentName → accumulated delta text (for streaming)
  deltaBuffers: new Map(),
  // agentName → current delta bubble el
  deltaBubbles: new Map(),
};

// ── DOM refs ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const agentListEl = $("agent-list");
const chatLogEl = $("chat-log");
const chatInputEl = $("chat-input");
const btnSendEl = $("btn-send");
const selectedAgentNameEl = $("selected-agent-name");
const workspaceSelectEl = $("workspace-select");
const btnWorkspaceAdd = $("btn-workspace-add");
const btnWorkspaceDel = $("btn-workspace-del");
const btnStopAll = $("btn-stop-all");
const terminalContainerEl = $("terminal-container");
const terminalAgentLabel = $("terminal-agent-label");
const btnTerminalKill = $("btn-terminal-kill");

// ── Helpers ────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scrollChatToBottom() {
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

// ── SSE ────────────────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource("/api/stream");

  es.onmessage = (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    handleCanonicalEvent(event);
  };

  es.onerror = () => {
    setTimeout(connectSSE, 3000);
    es.close();
  };
}

// ── Canonical Event handler ────────────────────────────────────────────────

function handleCanonicalEvent(event) {
  const { type, agentName } = event;

  switch (type) {
    case "session.init":
      updateAgentStatus(agentName, "idle");
      break;

    case "message.user":
      if (agentName === state.selectedAgent) {
        // Already shown optimistically on send
      }
      break;

    case "message.delta":
      appendDelta(agentName, event.content);
      break;

    case "message.done":
      finalizeDelta(agentName, event.content);
      break;

    case "tool.start":
      appendToolCard(agentName, event.toolId, event.toolName, event.input, false);
      break;

    case "tool.done":
      updateToolCard(agentName, event.toolId, event.output, event.isError);
      break;

    case "run.done":
      removeTyping(agentName);
      finalizeDelta(agentName);
      appendRunDone(agentName, event.usage);
      updateAgentStatus(agentName, "idle");
      break;

    case "run.error":
      removeTyping(agentName);
      finalizeDelta(agentName);
      if (agentName === state.selectedAgent) {
        appendSystemMsg(`❌ ${agentName} エラー: ${event.message}`);
      }
      updateAgentStatus(agentName, event.cancelled ? "idle" : "error");
      break;

    case "status.change":
      updateAgentStatus(agentName, event.status);
      if (event.status === "running" && agentName === state.selectedAgent) {
        showTyping(agentName);
      }
      break;
  }
}

// ── Agent sidebar ──────────────────────────────────────────────────────────

async function loadAgents() {
  const res = await fetch("/api/agents");
  if (!res.ok) return;
  state.agents = await res.json();
  renderAgentList();
}

function renderAgentList() {
  agentListEl.innerHTML = "";

  if (state.agents.length === 0) {
    agentListEl.innerHTML = '<p class="loading-note">.env に AGENT_*_TYPE を設定してください</p>';
    return;
  }

  for (const agent of state.agents) {
    const el = document.createElement("div");
    el.className = `agent-item ${agent.name === state.selectedAgent ? "active" : ""}`;
    el.dataset.agent = agent.name;
    el.innerHTML = `
      <div class="status-dot ${agent.status ?? "idle"}" id="dot-${agent.name}"></div>
      <div class="agent-info">
        <div class="agent-name">${escHtml(agent.name)}</div>
        <div class="agent-type">${escHtml(agent.type)} ${agent.model ? `· ${agent.model.split("-").slice(-1)[0]}` : ""}</div>
      </div>
    `;
    el.addEventListener("click", () => selectAgent(agent.name));
    agentListEl.appendChild(el);
  }
}

function updateAgentStatus(agentName, status) {
  // Update state
  const agent = state.agents.find((a) => a.name === agentName);
  if (agent) agent.status = status;

  // Update dot
  const dot = document.getElementById(`dot-${agentName}`);
  if (dot) {
    dot.className = `status-dot ${status}`;
  }

  // Update send button if this is the selected agent
  if (agentName === state.selectedAgent) {
    btnSendEl.disabled = status === "running";
  }
}

function selectAgent(name) {
  state.selectedAgent = name;
  selectedAgentNameEl.textContent = name;

  // Update sidebar active state
  document.querySelectorAll(".agent-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.agent === name);
  });

  // Render chat log for this agent
  renderChatLog(name);

  // Update send button
  const agent = state.agents.find((a) => a.name === name);
  btnSendEl.disabled = agent?.status === "running";
}

// ── Chat rendering ─────────────────────────────────────────────────────────

function renderChatLog(agentName) {
  chatLogEl.innerHTML = "";
  state.deltaBubbles.delete(agentName);

  const msgs = state.chatLogs.get(agentName) ?? [];

  if (msgs.length === 0) {
    chatLogEl.innerHTML = `
      <div class="empty-chat">
        <div class="empty-chat-icon">🤖</div>
        <p>${escHtml(agentName)} にメッセージを送ってみましょう</p>
      </div>
    `;
    return;
  }

  for (const msg of msgs) {
    appendMsgEl(msg, false);
  }

  scrollChatToBottom();
}

function appendMsgEl(msg, scroll = true) {
  // Remove empty state if present
  const emptyEl = chatLogEl.querySelector(".empty-chat");
  if (emptyEl) emptyEl.remove();

  const el = document.createElement("div");
  el.className = `msg ${msg.role}`;

  if (msg.role === "user") {
    el.innerHTML = `
      <div class="msg-meta"><span>🧑 You</span><span>${msg.time}</span></div>
      <div class="msg-bubble">${escHtml(msg.content)}</div>
    `;
  } else if (msg.role === "agent") {
    el.innerHTML = `
      <div class="msg-meta"><span>🤖 ${escHtml(msg.agentName)}</span><span>${msg.time}</span></div>
      <div class="msg-bubble"></div>
    `;
    el.querySelector(".msg-bubble").textContent = msg.content;
  } else if (msg.role === "system") {
    el.innerHTML = `<div class="msg-bubble">${escHtml(msg.content)}</div>`;
  }

  chatLogEl.appendChild(el);
  if (scroll) scrollChatToBottom();
  return el;
}

function pushMsg(agentName, msg) {
  if (!state.chatLogs.has(agentName)) state.chatLogs.set(agentName, []);
  state.chatLogs.get(agentName).push(msg);
}

// Streaming delta
function appendDelta(agentName, content) {
  if (agentName !== state.selectedAgent) {
    // Buffer off-screen
    state.deltaBuffers.set(agentName, (state.deltaBuffers.get(agentName) ?? "") + content);
    return;
  }

  removeTyping(agentName);

  let bubble = state.deltaBubbles.get(agentName);
  if (!bubble) {
    const el = document.createElement("div");
    el.className = "msg agent";
    el.innerHTML = `
      <div class="msg-meta"><span>🤖 ${escHtml(agentName)}</span><span>${ts()}</span></div>
      <div class="msg-bubble"></div>
    `;
    chatLogEl.appendChild(el);
    bubble = el.querySelector(".msg-bubble");
    state.deltaBubbles.set(agentName, bubble);
  }

  bubble.textContent += content;
  scrollChatToBottom();
}

function finalizeDelta(agentName, fullContent) {
  const buffered = state.deltaBuffers.get(agentName) ?? "";
  const bubble = state.deltaBubbles.get(agentName);
  const content = fullContent ?? (bubble ? bubble.textContent : buffered);

  // If we have a bubble, it's already rendered
  if (!bubble && content && agentName === state.selectedAgent) {
    const msg = { role: "agent", agentName, content, time: ts() };
    pushMsg(agentName, msg);
    appendMsgEl(msg);
  } else if (content) {
    pushMsg(agentName, { role: "agent", agentName, content, time: ts() });
  }

  state.deltaBubbles.delete(agentName);
  state.deltaBuffers.delete(agentName);
}

function appendSystemMsg(text) {
  const el = document.createElement("div");
  el.className = "msg system";
  el.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  chatLogEl.appendChild(el);
  scrollChatToBottom();
}

function appendRunDone(agentName, usage) {
  if (agentName !== state.selectedAgent) return;

  const parts = [];
  if (usage?.inputTokens) parts.push(`in: ${usage.inputTokens.toLocaleString()}`);
  if (usage?.outputTokens) parts.push(`out: ${usage.outputTokens.toLocaleString()}`);
  if (usage?.costUsd) {
    const jpy = (usage.costUsd * 150).toFixed(1);
    parts.push(`¥${jpy}`);
  }

  if (parts.length === 0) return;

  const badge = document.createElement("div");
  badge.className = "run-done-badge";
  badge.textContent = `✅ 完了 📊 ${parts.join(" / ")}`;
  chatLogEl.appendChild(badge);
  scrollChatToBottom();
}

// Tool cards
function appendToolCard(agentName, toolId, toolName, input, isError) {
  if (agentName !== state.selectedAgent) return;

  const card = document.createElement("div");
  card.className = "msg tool";
  card.innerHTML = `
    <div class="tool-card" id="tool-${toolId}">
      <div class="tool-card-header">
        🔧 <span>${escHtml(toolName)}</span>
        <span style="margin-left:auto;font-size:10px;color:#aaa">▼</span>
      </div>
      <div class="tool-card-body">${input ? escHtml(JSON.stringify(input, null, 2)) : ""}</div>
    </div>
  `;
  const header = card.querySelector(".tool-card-header");
  header.addEventListener("click", () => card.querySelector(".tool-card").classList.toggle("open"));
  chatLogEl.appendChild(card);

  if (!state.toolCards.has(agentName)) state.toolCards.set(agentName, new Map());
  state.toolCards.get(agentName).set(toolId, card.querySelector(".tool-card"));

  scrollChatToBottom();
}

function updateToolCard(agentName, toolId, output, isError) {
  const card = state.toolCards.get(agentName)?.get(toolId);
  if (!card) return;

  const body = card.querySelector(".tool-card-body");
  if (output) body.textContent = output;
  if (isError) card.style.borderColor = "#fcc";
  card.querySelector(".tool-card-header span:last-child").textContent = isError ? "❌" : "✅";
}

// Typing indicator
function showTyping(agentName) {
  if (state.typingEls.has(agentName)) return;
  const el = document.createElement("div");
  el.className = "typing-indicator";
  el.innerHTML = `<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>`;
  chatLogEl.appendChild(el);
  state.typingEls.set(agentName, el);
  scrollChatToBottom();
}

function removeTyping(agentName) {
  const el = state.typingEls.get(agentName);
  if (el) { el.remove(); state.typingEls.delete(agentName); }
}

// ── Send message ───────────────────────────────────────────────────────────

async function sendMessage() {
  const prompt = chatInputEl.value.trim();
  if (!prompt || !state.selectedAgent) return;

  const agentName = state.selectedAgent;
  chatInputEl.value = "";
  chatInputEl.style.height = "";
  btnSendEl.disabled = true;

  // Show optimistic user message
  const msg = { role: "user", content: prompt, time: ts() };
  pushMsg(agentName, msg);
  if (agentName === state.selectedAgent) appendMsgEl(msg);

  try {
    const res = await fetch(`/api/agents/${agentName}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "送信失敗" }));
      appendSystemMsg(`❌ ${err.error ?? "送信失敗"}`);
      btnSendEl.disabled = false;
    }
    // Success: result comes via SSE events
  } catch (e) {
    appendSystemMsg(`❌ ネットワークエラー: ${e.message}`);
    btnSendEl.disabled = false;
  }
}

// ── Workspace ──────────────────────────────────────────────────────────────

async function loadWorkspaces() {
  const res = await fetch("/api/workspaces");
  if (!res.ok) return;
  const workspaces = await res.json();

  workspaceSelectEl.innerHTML = "";
  for (const ws of workspaces) {
    const opt = document.createElement("option");
    opt.value = ws.id;
    opt.textContent = ws.name;
    if (ws.isActive) { opt.selected = true; state.workspaceId = ws.id; }
    workspaceSelectEl.appendChild(opt);
  }
}

workspaceSelectEl.addEventListener("change", async () => {
  const wsId = workspaceSelectEl.value;
  await fetch(`/api/workspaces/${wsId}/activate`, { method: "POST" });
  state.workspaceId = wsId;
  // Clear cached chat history — workspace switch invalidates it
  state.chatLogs.clear();
  state.deltaBuffers.clear();
  state.deltaBubbles.clear();
  // Reload agents (session refs may have changed)
  await loadAgents();
  // Reload history for current agent in new workspace
  if (state.selectedAgent) await selectAgentWithHistory(state.selectedAgent);
});

btnWorkspaceAdd.addEventListener("click", async () => {
  const name = prompt("新しいワークスペース名:");
  if (!name?.trim()) return;
  const res = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!res.ok) { alert("作成に失敗しました"); return; }
  await loadWorkspaces();
  // Auto-switch to new workspace
  const ws = await res.json();
  workspaceSelectEl.value = ws.id;
  workspaceSelectEl.dispatchEvent(new Event("change"));
});

btnWorkspaceDel.addEventListener("click", async () => {
  const wsId = workspaceSelectEl.value;
  if (wsId === "default") { alert("defaultワークスペースは削除できません。"); return; }
  const name = workspaceSelectEl.options[workspaceSelectEl.selectedIndex]?.text;
  if (!confirm(`ワークスペース "${name}" を削除しますか？\n（エージェントのセッション履歴は残ります）`)) return;
  const res = await fetch(`/api/workspaces/${wsId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error ?? "削除に失敗しました");
    return;
  }
  // Switch to default after delete
  await loadWorkspaces();
  workspaceSelectEl.value = "default";
  workspaceSelectEl.dispatchEvent(new Event("change"));
});

// ── Event listeners ────────────────────────────────────────────────────────

btnSendEl.addEventListener("click", sendMessage);

chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
chatInputEl.addEventListener("input", () => {
  chatInputEl.style.height = "";
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 120) + "px";
});

// Tab switching
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${tab}`);
    });
  });
});

// Stop all
btnStopAll.addEventListener("click", async () => {
  if (!confirm("全エージェントを停止しますか？")) return;
  for (const agent of state.agents) {
    if (agent.status === "running") {
      await fetch(`/api/agents/${agent.name}/cancel`, { method: "POST" });
    }
  }
});

// ── Load history from API ──────────────────────────────────────────────────

async function loadMessageHistory(agentName) {
  try {
    const res = await fetch(`/api/agents/${agentName}/messages?limit=100`);
    if (!res.ok) return;
    const messages = await res.json();
    state.chatLogs.set(agentName, messages.map((m) => ({
      role: m.role === "user" ? "user" : "agent",
      agentName,
      content: m.content ?? "",
      time: new Date(m.createdAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
    })));
  } catch {
    // ignore
  }
}

// Override selectAgent to load history
const _selectAgent = selectAgent;
async function selectAgentWithHistory(name) {
  if (!state.chatLogs.has(name)) {
    await loadMessageHistory(name);
  }
  _selectAgent(name);
}
// Rebind
agentListEl.addEventListener("click", (e) => {
  const item = e.target.closest(".agent-item");
  if (item) selectAgentWithHistory(item.dataset.agent);
}, true);

// ── Terminal (xterm.js + WebSocket PTY) ───────────────────────────────────

const terminal = {
  xterm: null,       // Terminal instance
  fitAddon: null,    // FitAddon instance
  ws: null,          // WebSocket
  agentName: null,   // currently connected agent
  resizeObserver: null,
};

function initXterm() {
  if (terminal.xterm) return; // already initialized
  // xterm.js is loaded as a global via <script>
  const { Terminal } = window;
  const { FitAddon } = window;
  if (!Terminal || !FitAddon) {
    console.warn("xterm.js not loaded");
    return;
  }
  terminal.xterm = new Terminal({
    theme: { background: "#0d0d0d", foreground: "#d4d4d4", cursor: "#7289da" },
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    fontSize: 13,
    cursorBlink: true,
    allowTransparency: true,
    scrollback: 5000,
  });
  terminal.fitAddon = new FitAddon();
  terminal.xterm.loadAddon(terminal.fitAddon);
  terminal.xterm.open(terminalContainerEl);
  terminal.fitAddon.fit();

  // Send input to PTY
  terminal.xterm.onData((data) => {
    if (terminal.ws?.readyState === WebSocket.OPEN) {
      terminal.ws.send(data);
    }
  });

  // Resize observer to keep terminal fitted
  terminal.resizeObserver = new ResizeObserver(() => {
    try {
      terminal.fitAddon.fit();
      if (terminal.ws?.readyState === WebSocket.OPEN) {
        const { cols, rows } = terminal.xterm;
        terminal.ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    } catch {}
  });
  terminal.resizeObserver.observe(terminalContainerEl);
}

function connectTerminal(agentName) {
  if (terminal.agentName === agentName && terminal.ws?.readyState === WebSocket.OPEN) {
    return; // already connected to this agent
  }

  // Disconnect previous
  if (terminal.ws) {
    terminal.ws.close();
    terminal.ws = null;
  }

  initXterm();
  if (!terminal.xterm) return;

  terminal.agentName = agentName;
  terminalAgentLabel.textContent = `🖥 ${agentName} — PTY`;
  btnTerminalKill.disabled = false;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/pty?agent=${encodeURIComponent(agentName)}`);
  terminal.ws = ws;

  ws.onopen = () => {
    const { cols, rows } = terminal.xterm;
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  };

  ws.onmessage = (e) => {
    terminal.xterm.write(e.data);
  };

  ws.onerror = () => {
    terminal.xterm.writeln("\r\n\x1b[31m[WebSocket error — reconnecting in 3s]\x1b[0m");
  };

  ws.onclose = () => {
    terminal.xterm.writeln("\r\n\x1b[33m[接続が切れました]\x1b[0m");
    btnTerminalKill.disabled = true;
    terminal.ws = null;
  };
}

btnTerminalKill.addEventListener("click", async () => {
  if (!terminal.agentName) return;
  if (!confirm(`${terminal.agentName} のターミナルセッションを終了しますか？`)) return;
  // Close WebSocket — server PTY will be killed when no clients remain OR on next connect
  if (terminal.ws) { terminal.ws.close(); terminal.ws = null; }
  terminal.xterm?.writeln("\r\n\x1b[33m[セッションを終了しました]\x1b[0m");
  btnTerminalKill.disabled = true;
});

// Connect terminal when switching to Terminal tab
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab === "terminal" && state.selectedAgent) {
      // Defer slightly to let the tab become visible first (needed for fit)
      requestAnimationFrame(() => connectTerminal(state.selectedAgent));
    }
  });
});

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  await loadWorkspaces();
  await loadAgents();

  // Auto-select first agent
  if (state.agents.length > 0) {
    await selectAgentWithHistory(state.agents[0].name);
  }

  connectSSE();

  // Poll agent statuses every 5s
  setInterval(loadAgents, 5000);
}

boot();
