const STATUS_LABELS = {
  idle: "idle",
  queued: "queued",
  running: "running",
  waiting_codex: "waiting_codex",
  completed: "completed",
  stopped: "stopped",
  error: "error",
};

const SOURCE_LABELS = {
  ui: "Local UI",
  discord: "Discord",
  codex: "Codex",
  system: "system",
};

const ROLE_LABELS = {
  user: "User",
  assistant: "AI",
};

const REASONING_LABELS = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

const WORKING_STATUSES = new Set(["queued", "running", "waiting_codex"]);
const TERMINAL_STATUSES = new Set(["completed", "stopped", "error"]);

const state = {
  runtime: null,
  sessions: [],
  activeSessionId: null,
  eventsBySession: new Map(),
  pendingAttachments: [],
};

let liveTimerId = null;
let eventStream = null;
let streamReconnectTimerId = null;
let stateRefreshTimerId = null;
let hasSeenStreamOpen = false;
let deferredInstallPrompt = null;

const sessionList = document.querySelector("#session-list");
const sessionCount = document.querySelector("#session-count");
const sessionTitle = document.querySelector("#session-title");
const sessionSubtitle = document.querySelector("#session-subtitle");
const sessionCard = document.querySelector("#session-card");
const sessionIdValue = document.querySelector("#session-id-value");
const discordChannelCard = document.querySelector("#discord-channel-card");
const discordIdValue = document.querySelector("#discord-id-value");
const modelOptions = document.querySelector("#model-options");
const reasoningOptions = document.querySelector("#reasoning-options");
const fastOnButton = document.querySelector("#fast-on-button");
const fastOffButton = document.querySelector("#fast-off-button");
const statusPill = document.querySelector("#status-pill");
const chatLog = document.querySelector("#chat-log");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const attachmentInput = document.querySelector("#attachment-input");
const attachmentButton = document.querySelector("#attachment-button");
const installAppButton = document.querySelector("#install-app-button");
const pendingAttachmentList = document.querySelector("#pending-attachment-list");
const newSessionButton = document.querySelector("#new-session-button");
const deleteSessionButton = document.querySelector("#delete-session-button");
const restoreSessionButton = document.querySelector("#restore-session-button");
const stopSessionButton = document.querySelector("#stop-session-button");
const channelPickerDialog = document.querySelector("#channel-picker-dialog");
const channelPickerList = document.querySelector("#channel-picker-list");

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) {
    return "No timestamp";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTime(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatAttachmentSize(value) {
  if (!value) {
    return "";
  }

  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }

  return `${value} B`;
}

function getStatusLabel(status) {
  return STATUS_LABELS[status] || status || "unknown";
}

function getSourceLabel(source) {
  return SOURCE_LABELS[source] || source || "unknown";
}

function getSourceClass(source) {
  if (source === "discord") {
    return "message-source-discord";
  }

  if (source === "ui") {
    return "message-source-ui";
  }

  if (source === "codex") {
    return "message-source-codex";
  }

  return "";
}

function getRoleLabel(role) {
  return ROLE_LABELS[role] || role || "unknown";
}

function getReasoningLabel(effort) {
  return REASONING_LABELS[effort] || effort || "unknown";
}

function formatDiscordChannel(session) {
  if (!session?.discordChannelId) {
    return "Not linked";
  }

  const channelName = session.discordChannelName || "unknown";
  return `${channelName} (${session.discordChannelId})`;
}

function getElapsedSeconds(startedAt, endedAt = Date.now()) {
  if (!startedAt) {
    return 0;
  }

  const startedAtMs = new Date(startedAt).getTime();
  const endedAtMs = new Date(endedAt).getTime();
  return Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
}

function getLatestRunState(events) {
  const statusEvents = events.filter((event) => event.eventType === "status.changed");
  if (statusEvents.length === 0) {
    return null;
  }

  const lastStatusEvent = statusEvents.at(-1);
  if (!lastStatusEvent) {
    return null;
  }

  let blockStartIndex = statusEvents.length - 1;
  while (blockStartIndex > 0) {
    const previousStatus = statusEvents[blockStartIndex - 1].payload.status;
    if (TERMINAL_STATUSES.has(previousStatus)) {
      break;
    }
    blockStartIndex -= 1;
  }

  const runEvents = statusEvents.slice(blockStartIndex);
  const workingEvents = runEvents.filter((event) => WORKING_STATUSES.has(event.payload.status));

  if (workingEvents.length === 0) {
    return null;
  }

  return {
    startedAt: workingEvents[0].createdAt,
    completedAt: TERMINAL_STATUSES.has(lastStatusEvent.payload.status) ? lastStatusEvent.createdAt : null,
    status: lastStatusEvent.payload.status,
    isActive: WORKING_STATUSES.has(lastStatusEvent.payload.status),
  };
}

function getLatestStatusFromEvents(events) {
  const statusEvents = events.filter((event) => event.eventType === "status.changed");
  return statusEvents.at(-1)?.payload?.status || null;
}

function getRunIndicatorLabel(runState) {
  if (runState.isActive) {
    return "Working";
  }

  if (runState.status === "stopped") {
    return "Stopped";
  }

  if (runState.status === "error") {
    return "Error";
  }

  return "Completed";
}

function formatChannelOption(channel) {
  return `${channel.name} (${channel.id})`;
}

function getCurrentSession() {
  return state.sessions.find((item) => item.id === state.activeSessionId) || null;
}

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function renderInstallAppButton() {
  installAppButton.hidden = isStandaloneMode() || !deferredInstallPrompt;
}

function renderPendingAttachments() {
  if (state.pendingAttachments.length === 0) {
    pendingAttachmentList.hidden = true;
    pendingAttachmentList.innerHTML = "";
    return;
  }

  pendingAttachmentList.hidden = false;
  pendingAttachmentList.innerHTML = state.pendingAttachments
    .map(
      (file, index) => `
        <div class="pending-attachment">
          <div class="pending-attachment-copy">
            <strong>${escapeHtml(file.name)}</strong>
            <small>${escapeHtml(formatAttachmentSize(file.size))}</small>
          </div>
          <button
            type="button"
            class="pending-attachment-remove"
            data-attachment-index="${index}"
            aria-label="Remove ${escapeHtml(file.name)}"
          >
            Remove
          </button>
        </div>
      `,
    )
    .join("");
}

function clearPendingAttachments() {
  state.pendingAttachments = [];
  attachmentInput.value = "";
  renderPendingAttachments();
}

function renderMessageAttachments(attachments = []) {
  const normalized = Array.isArray(attachments) ? attachments : [];
  if (normalized.length === 0) {
    return "";
  }

  return `
    <div class="message-attachments">
      ${normalized
        .map((attachment) => {
          if (attachment.kind === "image" && attachment.publicUrl) {
            return `
              <a
                class="message-attachment message-attachment-image"
                href="${escapeHtml(attachment.publicUrl)}"
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src="${escapeHtml(attachment.publicUrl)}"
                  alt="${escapeHtml(attachment.name || "image attachment")}"
                />
                <span>${escapeHtml(attachment.name || "image")}</span>
              </a>
            `;
          }

          return `
            <a
              class="message-attachment message-attachment-file"
              href="${escapeHtml(attachment.publicUrl || "#")}"
              target="_blank"
              rel="noreferrer"
            >
              <strong>${escapeHtml(attachment.name || "attachment")}</strong>
              <small>${escapeHtml(formatAttachmentSize(attachment.size))}</small>
            </a>
          `;
        })
        .join("")}
    </div>
  `;
}

async function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result || "");
      const [, base64 = ""] = result.split(",", 2);
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

async function serializePendingAttachments() {
  return Promise.all(
    state.pendingAttachments.map(async (file) => ({
      name: file.name,
      type: file.type || "",
      size: file.size,
      base64: await readFileAsBase64(file),
    })),
  );
}

function getModelDefinition(slug) {
  return state.runtime?.availableModels?.find((model) => model.slug === slug) || null;
}

async function requestJson(url, options) {
  const method = options?.method || "GET";
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    cache: method === "GET" ? "no-store" : "default",
    ...options,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || "Request failed");
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function upsertSession(session) {
  const existingIndex = state.sessions.findIndex((item) => item.id === session.id);
  if (existingIndex >= 0) {
    state.sessions.splice(existingIndex, 1, session);
  } else {
    state.sessions.unshift(session);
  }

  state.sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function removeSession(sessionId) {
  const index = state.sessions.findIndex((item) => item.id === sessionId);
  if (index >= 0) {
    state.sessions.splice(index, 1);
  }
  state.eventsBySession.delete(sessionId);
}

function pushEvent(event) {
  const events = state.eventsBySession.get(event.sessionId) || [];
  events.push(event);
  state.eventsBySession.set(event.sessionId, events);
}

function getNextSessionIdAfterDelete(deletedSessionId) {
  const remaining = state.sessions.filter((session) => session.id !== deletedSessionId);
  return remaining[0]?.id || null;
}

function renderSessions() {
  sessionCount.textContent = `${state.sessions.length} sessions`;
  sessionList.innerHTML = "";

  if (state.sessions.length === 0) {
    sessionList.innerHTML = `
      <div class="sidebar-empty">
        <p>No sessions yet.</p>
        <p>Use "New Session" to get started.</p>
      </div>
    `;
    return;
  }

  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.className = `session-card${session.id === state.activeSessionId ? " active" : ""}`;
    button.innerHTML = `
      <div class="session-card-header">
        <strong>${escapeHtml(session.title)}</strong>
        <span class="session-status">${escapeHtml(getStatusLabel(session.status))}</span>
      </div>
      <small>${escapeHtml(formatDateTime(session.updatedAt))}</small>
      <small>${escapeHtml(session.model)} / ${escapeHtml(getReasoningLabel(session.reasoningEffort))}</small>
      <small>${escapeHtml(session.fastMode ? "Fast on" : "Fast off")}</small>
    `;
    button.addEventListener("click", () => {
      setActiveSession(session.id).catch((error) => {
        alert(error.message);
      });
    });
    sessionList.appendChild(button);
  }
}

function renderSettingsButtons(session) {
  modelOptions.innerHTML = "";
  reasoningOptions.innerHTML = "";

  if (!state.runtime || !session) {
    fastOnButton.disabled = true;
    fastOffButton.disabled = true;
    return;
  }

  for (const model of state.runtime.availableModels) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `option-button${model.slug === session.model ? " active" : ""}`;
    button.textContent = model.displayName;
    button.title = model.description;
    button.addEventListener("click", async () => {
      try {
        await updateSessionSettings({ model: model.slug });
      } catch (error) {
        alert(error.message);
      }
    });
    modelOptions.appendChild(button);
  }

  const modelDefinition = getModelDefinition(session.model);
  const levels = modelDefinition?.supportedReasoningLevels || [];
  for (const level of levels) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `option-button${level.effort === session.reasoningEffort ? " active" : ""}`;
    button.textContent = getReasoningLabel(level.effort);
    button.title = level.description;
    button.addEventListener("click", async () => {
      try {
        await updateSessionSettings({ reasoningEffort: level.effort });
      } catch (error) {
        alert(error.message);
      }
    });
    reasoningOptions.appendChild(button);
  }

  fastOnButton.disabled = false;
  fastOffButton.disabled = false;
  fastOnButton.classList.toggle("active", session.fastMode);
  fastOffButton.classList.toggle("active", !session.fastMode);
}

async function loadSelectableChannels() {
  const payload = await requestJson("/api/discord/channels");
  return payload.channels || [];
}

function renderChannelPicker(channels, currentChannelId) {
  channelPickerList.innerHTML = "";

  if (channels.length === 0) {
    channelPickerList.innerHTML = `
      <div class="channel-picker-empty">
        <p>No selectable Discord channels were found.</p>
      </div>
    `;
    return;
  }

  for (const channel of channels) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `channel-option${channel.id === currentChannelId ? " active" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(channel.name)}</strong>
      <small>${escapeHtml(channel.id)}</small>
    `;
    button.addEventListener("click", async () => {
      try {
        await bindChannel(channel);
        channelPickerDialog.close();
      } catch (error) {
        alert(error.message);
      }
    });
    channelPickerList.appendChild(button);
  }
}

async function openChannelPicker() {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  const channels = await loadSelectableChannels();
  renderChannelPicker(channels, session.discordChannelId || null);
  channelPickerDialog.showModal();
}

function renderEmptySession() {
  sessionTitle.textContent = "No session selected";
  sessionSubtitle.textContent = "Select a session from the list or create a new one to begin.";
  statusPill.textContent = getStatusLabel("idle");
  statusPill.dataset.status = "idle";
  sessionIdValue.textContent = "Not selected";
  sessionCard.setAttribute("aria-disabled", "true");
  discordIdValue.textContent = formatDiscordChannel(null);
  discordChannelCard.setAttribute("aria-disabled", "true");
  deleteSessionButton.disabled = true;
  restoreSessionButton.disabled = true;
  stopSessionButton.disabled = true;
  renderSettingsButtons(null);
  syncLiveTimer();
  chatLog.innerHTML = `
    <div class="empty-state">
      <p>Select a session to view its conversation here.</p>
    </div>
  `;
}

function renderEvent(event) {
  if (event.eventType === "message.user" || event.eventType === "message.assistant") {
    const role = event.payload.role;
    const timeLabel = formatTime(event.createdAt);
    const text = String(event.payload.text || "").trim();
    const attachments = renderMessageAttachments(event.payload.attachments);

    return `
      <article class="message message-${role}">
        <div class="message-meta">
          <span class="message-author">${escapeHtml(getRoleLabel(role))}</span>
          <span class="message-source ${getSourceClass(event.source)}">${escapeHtml(getSourceLabel(event.source))}</span>
          <span class="message-time">${escapeHtml(timeLabel)}</span>
        </div>
        ${
          text
            ? `
              <div class="message-bubble">
                <pre>${escapeHtml(text)}</pre>
              </div>
            `
            : ""
        }
        ${attachments}
      </article>
    `;
  }

  if (event.eventType === "status.changed") {
    return `
      <article class="meta-line">
        <span>Status</span>
        <strong>${escapeHtml(getStatusLabel(event.payload.status))}</strong>
      </article>
    `;
  }

  if (event.eventType === "error.created") {
    return `
      <article class="meta-line error">
        <span>Error</span>
        <strong>${escapeHtml(event.payload.message)}</strong>
      </article>
    `;
  }

  if (event.eventType === "command.started") {
    return `
      <article class="meta-line command-line">
        <span>Running</span>
        <code>${escapeHtml(event.payload.command || "")}</code>
      </article>
    `;
  }

  return "";
}

function renderStatusGroup(events) {
  const parts = events
    .map(
      (event) =>
        `<strong class="meta-status-chip">${escapeHtml(getStatusLabel(event.payload.status))}</strong>`,
    )
    .join('<span class="meta-status-arrow">&rarr;</span>');

  return `
    <article class="meta-line status-group">
      <span>Status</span>
      ${parts}
    </article>
  `;
}

function renderTimeline(events) {
  const items = [];
  let pendingStatuses = [];

  function flushStatuses() {
    if (pendingStatuses.length === 0) {
      return;
    }

    items.push(renderStatusGroup(pendingStatuses));
    pendingStatuses = [];
  }

  for (const event of events) {
    if (event.eventType === "status.changed") {
      pendingStatuses.push(event);
      continue;
    }

    flushStatuses();
    items.push(renderEvent(event));
  }

  flushStatuses();
  return items.join("");
}

function renderWorkingIndicator(session, events) {
  const runState = getLatestRunState(events);
  if (!runState) {
    return "";
  }

  const sessionStatus = session?.status || null;
  const resolvedRunState =
    sessionStatus && TERMINAL_STATUSES.has(sessionStatus) && runState.isActive
      ? {
          ...runState,
          status: sessionStatus,
          isActive: false,
          completedAt: session.updatedAt || runState.completedAt || runState.startedAt,
        }
      : runState;

  const seconds = resolvedRunState.isActive
    ? getElapsedSeconds(resolvedRunState.startedAt)
    : getElapsedSeconds(resolvedRunState.startedAt, resolvedRunState.completedAt);
  const label = getRunIndicatorLabel(resolvedRunState);
  const modifierClass = resolvedRunState.isActive ? "" : " working-indicator-finished";
  const dotClass = resolvedRunState.isActive ? "" : " working-indicator-dot-finished";
  return `
    <div
      id="working-indicator"
      class="working-indicator${modifierClass}"
      data-started-at="${escapeHtml(resolvedRunState.startedAt)}"
      aria-live="polite"
    >
      <span class="working-indicator-dot${dotClass}"></span>
      <strong class="working-indicator-label">${label}</strong>
      <span class="working-indicator-time">(${seconds}s)</span>
    </div>
  `;
}

function refreshLiveWorkingIndicator() {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  const indicator = document.querySelector("#working-indicator");
  const timeNode = indicator?.querySelector(".working-indicator-time");
  if (!indicator || !timeNode) {
    return;
  }

  const startedAt = indicator.getAttribute("data-started-at");
  timeNode.textContent = `(${getElapsedSeconds(startedAt)}s)`;
}

function syncLiveTimer(events = []) {
  const shouldRun = Boolean(getLatestRunState(events)?.isActive);
  if (shouldRun && liveTimerId == null) {
    liveTimerId = window.setInterval(() => {
      refreshLiveWorkingIndicator();
    }, 1000);
    return;
  }

  if (!shouldRun && liveTimerId != null) {
    window.clearInterval(liveTimerId);
    liveTimerId = null;
  }
}

function renderOverviewCard(session) {
  const version = state.runtime?.codexVersion || "unknown";
  const workdir = state.runtime?.workdir || "unknown";

  return `
    <article class="overview-card">
      <div class="overview-title">OpenAI Codex <span>(v${escapeHtml(version)})</span></div>
      <div class="overview-row"><span>model</span><strong>${escapeHtml(session.model)}</strong></div>
      <div class="overview-row"><span>reasoning</span><strong>${escapeHtml(getReasoningLabel(session.reasoningEffort))}</strong></div>
      <div class="overview-row"><span>fast mode</span><strong>${escapeHtml(session.fastMode ? "on" : "off")}</strong></div>
      <div class="overview-row"><span>directory</span><strong>${escapeHtml(workdir)}</strong></div>
    </article>
  `;
}

function renderActiveSession() {
  const session = getCurrentSession();
  if (!session) {
    renderEmptySession();
    return;
  }

  sessionTitle.textContent = session.title;
  sessionSubtitle.textContent = `Updated ${formatDateTime(session.updatedAt)}`;
  statusPill.textContent = getStatusLabel(session.status);
  statusPill.dataset.status = session.status;
  sessionIdValue.textContent = session.title;
  sessionCard.setAttribute("aria-disabled", "false");
  discordIdValue.textContent = formatDiscordChannel(session);
  discordChannelCard.setAttribute("aria-disabled", "false");
  deleteSessionButton.disabled = false;
  restoreSessionButton.disabled = false;
  stopSessionButton.disabled = false;
  renderSettingsButtons(session);

  const events = state.eventsBySession.get(session.id) || [];
  syncLiveTimer(events);
  const content = `${renderOverviewCard(session)}${renderTimeline(events)}${renderWorkingIndicator(session, events)}`;

  if (!events.length) {
    chatLog.innerHTML = `
      ${content}
      <div class="empty-state compact-empty">
        <p>Send a message below to start the conversation.</p>
      </div>
    `;
    return;
  }

  chatLog.innerHTML = content;
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function loadRuntime() {
  state.runtime = await requestJson("/api/runtime");
}

async function loadSessions() {
  await syncSessions(state.activeSessionId);
}

async function setActiveSession(sessionId) {
  const detail = await requestJson(`/api/sessions/${sessionId}`);
  upsertSession(detail.session);
  state.activeSessionId = sessionId;
  state.eventsBySession.set(sessionId, detail.events);
  clearPendingAttachments();
  renderSessions();
  renderActiveSession();
}

function pruneCachedEvents() {
  const validSessionIds = new Set(state.sessions.map((session) => session.id));
  for (const sessionId of [...state.eventsBySession.keys()]) {
    if (!validSessionIds.has(sessionId)) {
      state.eventsBySession.delete(sessionId);
    }
  }
}

async function syncSessions(preferredSessionId = state.activeSessionId) {
  state.sessions = await requestJson("/api/sessions");
  pruneCachedEvents();

  const nextSessionId =
    preferredSessionId && state.sessions.some((session) => session.id === preferredSessionId)
      ? preferredSessionId
      : state.sessions[0]?.id || null;

  state.activeSessionId = nextSessionId;

  if (!nextSessionId) {
    renderSessions();
    renderActiveSession();
    return;
  }

  const detail = await requestJson(`/api/sessions/${nextSessionId}`);
  upsertSession(detail.session);
  state.eventsBySession.set(nextSessionId, detail.events);
  renderSessions();
  renderActiveSession();
}

async function createSession() {
  const activeSession = getCurrentSession();
  const session = await requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      discordChannelId: activeSession?.discordChannelId || null,
      model: activeSession?.model || state.runtime?.defaults?.model,
      reasoningEffort:
        activeSession?.reasoningEffort || state.runtime?.defaults?.reasoningEffort,
      profile: activeSession?.profile || state.runtime?.defaults?.profile,
      fastMode: activeSession?.fastMode ?? state.runtime?.defaults?.fastMode,
    }),
  });

  upsertSession(session);
  await setActiveSession(session.id);
}

async function updateSessionSettings(patch) {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  const updated = await requestJson(`/api/sessions/${session.id}/settings`, {
    method: "POST",
    body: JSON.stringify(patch),
  });

  upsertSession(updated);
  renderSessions();
  renderActiveSession();
}

async function renameActiveSession() {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  const title = window.prompt("Enter a new session name.", session.title);
  if (title == null) {
    return;
  }

  if (!title.trim()) {
    alert("Session name cannot be empty.");
    return;
  }

  const updated = await requestJson(`/api/sessions/${session.id}/rename`, {
    method: "POST",
    body: JSON.stringify({ title: title.trim() }),
  });

  upsertSession(updated);
  renderSessions();
  renderActiveSession();
}

async function deleteActiveSession() {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  const confirmed = window.confirm(`Delete session "${session.title}"? This cannot be undone.`);
  if (!confirmed) {
    return;
  }

  const nextSessionId = getNextSessionIdAfterDelete(session.id);
  await requestJson(`/api/sessions/${session.id}`, {
    method: "DELETE",
  });

  removeSession(session.id);

  if (nextSessionId) {
    state.activeSessionId = nextSessionId;
    await setActiveSession(nextSessionId);
    return;
  }

  state.activeSessionId = null;
  renderSessions();
  renderActiveSession();
}

async function restoreActiveSession() {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  restoreSessionButton.disabled = true;
  const originalLabel = restoreSessionButton.textContent;
  restoreSessionButton.textContent = "Restoring...";

  try {
    if (eventStream) {
      eventStream.close();
      eventStream = null;
    }

    hasSeenStreamOpen = false;
    await syncSessions(session.id);
    subscribeEvents();
    restoreSessionButton.textContent = "Restored";
    window.setTimeout(() => {
      restoreSessionButton.textContent = originalLabel;
    }, 1200);
  } finally {
    restoreSessionButton.disabled = false;
  }
}

async function stopActiveSession() {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  const result = await requestJson(`/api/sessions/${session.id}/stop`, {
    method: "POST",
  });

  if (!result.stopped) {
    alert("Nothing is currently running for this session.");
  }

  await syncSessions(session.id);
}

async function sendMessage() {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  const text = messageInput.value.trim();
  const attachments = await serializePendingAttachments();
  if (!text && attachments.length === 0) {
    return;
  }

  await requestJson(`/api/sessions/${session.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, attachments }),
  });

  messageInput.value = "";
  clearPendingAttachments();
  await syncSessions(session.id);
}

async function bindChannel(channel) {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  if (!channel?.id) {
    throw new Error("Discord channel ID is required");
  }

  const updated = await requestJson(`/api/sessions/${session.id}/discord-bind`, {
    method: "POST",
    body: JSON.stringify({
      channelId: channel.id,
      channelName: channel.name || "unknown",
    }),
  });

  upsertSession(updated);
  renderSessions();
  renderActiveSession();
}

function clearStreamReconnectTimer() {
  if (streamReconnectTimerId != null) {
    window.clearTimeout(streamReconnectTimerId);
    streamReconnectTimerId = null;
  }
}

function scheduleStreamReconnect() {
  if (streamReconnectTimerId != null) {
    return;
  }

  streamReconnectTimerId = window.setTimeout(() => {
    streamReconnectTimerId = null;
    subscribeEvents();
  }, 2000);
}

function subscribeEvents() {
  if (eventStream) {
    eventStream.close();
  }

  clearStreamReconnectTimer();
  eventStream = new EventSource("/api/stream");

  eventStream.addEventListener("open", () => {
    const shouldResync = hasSeenStreamOpen;
    hasSeenStreamOpen = true;
    if (shouldResync) {
      syncSessions().catch((error) => {
        console.error(error);
      });
    }
  });

  eventStream.addEventListener("session.created", async (event) => {
    const session = JSON.parse(event.data);
    upsertSession(session);
    renderSessions();
    if (!state.activeSessionId) {
      await setActiveSession(session.id);
    }
  });

  eventStream.addEventListener("session.updated", (event) => {
    const session = JSON.parse(event.data);
    upsertSession(session);
    renderSessions();
    if (session.id === state.activeSessionId) {
      const events = state.eventsBySession.get(session.id) || [];
      const latestStatus = getLatestStatusFromEvents(events);
      if (session.status !== latestStatus) {
        syncSessions(session.id).catch((error) => {
          console.error(error);
        });
        return;
      }

      renderActiveSession();
    }
  });

  eventStream.addEventListener("session.deleted", async (event) => {
    const payload = JSON.parse(event.data);
    removeSession(payload.sessionId);

    if (payload.sessionId === state.activeSessionId) {
      const nextSessionId = state.sessions[0]?.id || null;
      state.activeSessionId = nextSessionId;
      renderSessions();

      if (nextSessionId) {
        await setActiveSession(nextSessionId);
      } else {
        renderActiveSession();
      }

      return;
    }

    renderSessions();
  });

  eventStream.addEventListener("message.created", (event) => {
    const payload = JSON.parse(event.data);
    pushEvent(payload);
    if (payload.sessionId === state.activeSessionId) {
      renderActiveSession();
    }
  });

  eventStream.addEventListener("status.changed", (event) => {
    const payload = JSON.parse(event.data);
    pushEvent(payload);
    if (payload.sessionId === state.activeSessionId) {
      renderActiveSession();
    }
  });

  eventStream.addEventListener("error.created", (event) => {
    const payload = JSON.parse(event.data);
    pushEvent(payload);
    if (payload.sessionId === state.activeSessionId) {
      renderActiveSession();
    }
  });

  eventStream.addEventListener("error", () => {
    if (eventStream) {
      eventStream.close();
      eventStream = null;
    }
    scheduleStreamReconnect();
  });
}

function startBackgroundSync() {
  if (stateRefreshTimerId != null) {
    return;
  }

  stateRefreshTimerId = window.setInterval(() => {
    syncSessions().catch((error) => {
      console.error(error);
    });
  }, 15000);
}

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await sendMessage();
  } catch (error) {
    alert(error.message);
  }
});

attachmentButton.addEventListener("click", () => {
  attachmentInput.click();
});

attachmentInput.addEventListener("change", (event) => {
  const nextFiles = [...(event.target.files || [])];
  if (nextFiles.length === 0) {
    return;
  }

  const maxAttachments = state.runtime?.attachments?.maxAttachmentsPerMessage || 5;
  const maxBytes = state.runtime?.attachments?.maxAttachmentBytes || 20 * 1024 * 1024;
  const mergedFiles = [...state.pendingAttachments, ...nextFiles];
  if (mergedFiles.length > maxAttachments) {
    alert(`You can attach up to ${maxAttachments} files per message.`);
    attachmentInput.value = "";
    return;
  }

  const oversizedFile = mergedFiles.find((file) => file.size > maxBytes);
  if (oversizedFile) {
    alert(`${oversizedFile.name} is too large. Limit is ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
    attachmentInput.value = "";
    return;
  }

  state.pendingAttachments = mergedFiles;
  attachmentInput.value = "";
  renderPendingAttachments();
});

pendingAttachmentList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-attachment-index]");
  if (!button) {
    return;
  }

  const index = Number(button.getAttribute("data-attachment-index"));
  state.pendingAttachments.splice(index, 1);
  renderPendingAttachments();
});

newSessionButton.addEventListener("click", async () => {
  try {
    await createSession();
  } catch (error) {
    alert(error.message);
  }
});

sessionCard.addEventListener("click", async () => {
  try {
    if (!getCurrentSession()) {
      return;
    }
    await renameActiveSession();
  } catch (error) {
    alert(error.message);
  }
});

sessionCard.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();

  try {
    if (!getCurrentSession()) {
      return;
    }
    await renameActiveSession();
  } catch (error) {
    alert(error.message);
  }
});

deleteSessionButton.addEventListener("click", async () => {
  try {
    await deleteActiveSession();
  } catch (error) {
    alert(error.message);
  }
});

restoreSessionButton.addEventListener("click", async () => {
  try {
    await restoreActiveSession();
  } catch (error) {
    alert(error.message);
  }
});

stopSessionButton.addEventListener("click", async () => {
  try {
    await stopActiveSession();
  } catch (error) {
    alert(error.message);
  }
});

discordChannelCard.addEventListener("click", async () => {
  try {
    if (!getCurrentSession()) {
      return;
    }
    await openChannelPicker();
  } catch (error) {
    alert(error.message);
  }
});

discordChannelCard.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();

  try {
    if (!getCurrentSession()) {
      return;
    }
    await openChannelPicker();
  } catch (error) {
    alert(error.message);
  }
});

fastOnButton.addEventListener("click", async () => {
  try {
    await updateSessionSettings({ fastMode: true });
  } catch (error) {
    alert(error.message);
  }
});

fastOffButton.addEventListener("click", async () => {
  try {
    await updateSessionSettings({ fastMode: false });
  } catch (error) {
    alert(error.message);
  }
});

Promise.all([loadRuntime(), loadSessions()])
  .then(() => {
    renderSessions();
    renderActiveSession();
    subscribeEvents();
    startBackgroundSync();
  })
  .catch((error) => {
    console.error(error);
    alert(error.message);
  });

window.addEventListener("focus", () => {
  syncSessions().catch((error) => {
    console.error(error);
  });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  renderInstallAppButton();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  renderInstallAppButton();
});

installAppButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    return;
  }

  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  renderInstallAppButton();
  await promptEvent.prompt();
  await promptEvent.userChoice.catch(() => null);
});

renderInstallAppButton();
