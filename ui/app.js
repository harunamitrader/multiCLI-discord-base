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
  schedule: "Schedule",
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
const ENTER_SEND_STORAGE_KEY = "codicodi-enter-send-mode";
const DEFAULT_SCHEDULE_TIMEZONE = "Asia/Tokyo";
const VIRTUAL_SCHEDULE_SESSION_ID = "__schedule_defaults__";
const VIRTUAL_SCHEDULE_SESSION_TITLE = "未設定スケジュール";
const VIRTUAL_SCHEDULE_SESSION_SUBTITLE = "新規セッションを起動して実行するスケジュール用の既定設定です。";
const CRON_PRESETS = [
  { label: "毎分", value: "* * * * *" },
  { label: "毎時0分", value: "0 * * * *" },
  { label: "毎日0時", value: "0 0 * * *" },
  { label: "毎日12時", value: "0 12 * * *" },
  { label: "平日12時", value: "0 12 * * 1-5" },
  { label: "毎週月曜9時", value: "0 9 * * 1" },
  { label: "毎月1日0時", value: "0 0 1 * *" },
  { label: "15分毎", value: "*/15 * * * *" },
];

const state = {
  runtime: null,
  sessions: [],
  schedules: [],
  scheduleDefaults: null,
  activeSessionId: null,
  activeView: "chat",
  eventsBySession: new Map(),
  pendingAttachments: [],
  enterSendMode: false,
};

let liveTimerId = null;
let eventStream = null;
let streamReconnectTimerId = null;
let stateRefreshTimerId = null;
let hasSeenStreamOpen = false;
const UI_BUILD_VERSION =
  document.querySelector('meta[name="app-build-version"]')?.getAttribute("content") || "dev";
const RUNTIME_URL = new URL(window.location.href);
const IS_DESKTOP_APP = RUNTIME_URL.searchParams.get("desktop") === "1";

let deferredInstallPrompt = null;
let composerFeedbackTimerId = null;
let composerDragDepth = 0;
let messageInputIsComposing = false;
let createCronDescriptionTimerId = null;
let createCronDescriptionRequestId = 0;
let scheduleCardCronDescriptionRequestId = 0;
const cardCronDescriptionTimers = new WeakMap();
const cronDescriptionCache = new Map();

function loadEnterSendModePreference() {
  try {
    return window.localStorage.getItem(ENTER_SEND_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistEnterSendModePreference(value) {
  try {
    window.localStorage.setItem(ENTER_SEND_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Ignore storage failures and keep the in-memory preference.
  }
}

async function resetDesktopServiceWorkerState() {
  if (!IS_DESKTOP_APP || !("serviceWorker" in navigator)) {
    return false;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));

  if ("caches" in window) {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((cacheKey) => caches.delete(cacheKey)));
  }

  if (
    navigator.serviceWorker.controller &&
    sessionStorage.getItem("codicodi-desktop-sw-reset") !== UI_BUILD_VERSION
  ) {
    sessionStorage.setItem("codicodi-desktop-sw-reset", UI_BUILD_VERSION);
    window.location.replace(`/index.html?desktop=1&v=${encodeURIComponent(UI_BUILD_VERSION)}`);
    return true;
  }

  return false;
}

const sessionList = document.querySelector("#session-list");
const sessionCount = document.querySelector("#session-count");
const appVersionBadge = document.querySelector("#app-version-badge");
const sessionCardEyebrow = document.querySelector("#session-card-eyebrow");
const sessionTitle = document.querySelector("#session-title");
const sessionSubtitle = document.querySelector("#session-subtitle");
const sessionCardHint = document.querySelector("#session-card-hint");
const sessionCard = document.querySelector("#session-card");
const discordChannelCard = document.querySelector("#discord-channel-card");
const discordCardLabel = document.querySelector("#discord-card-label");
const discordIdValue = document.querySelector("#discord-id-value");
const discordCardHint = document.querySelector("#discord-card-hint");
const modelOptions = document.querySelector("#model-options");
const reasoningOptions = document.querySelector("#reasoning-options");
const fastOnButton = document.querySelector("#fast-on-button");
const fastOffButton = document.querySelector("#fast-off-button");
const developerToolsGroup = document.querySelector("#developer-tools-group");
const developerConsoleButton = document.querySelector("#developer-console-button");
const statusPill = document.querySelector("#status-pill");
const chatLog = document.querySelector("#chat-log");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const attachmentInput = document.querySelector("#attachment-input");
const attachmentButton = document.querySelector("#attachment-button");
const enterSendToggleButton = document.querySelector("#enter-send-toggle-button");
const installAppButton = document.querySelector("#install-app-button");
const pendingAttachmentList = document.querySelector("#pending-attachment-list");
const composerFeedback = document.querySelector("#composer-feedback");
const composerFooter = document.querySelector(".composer-footer");
const newSessionButton = document.querySelector("#new-session-button");
const showChatButton = document.querySelector("#show-chat-button");
const showSchedulesButton = document.querySelector("#show-schedules-button");
const showSettingsButton = document.querySelector("#show-settings-button");
const deleteSessionButton = document.querySelector("#delete-session-button");
const restoreSessionButton = document.querySelector("#restore-session-button");
const workdirValue = document.querySelector("#workdir-value");
const workdirBaseNote = document.querySelector("#workdir-base-note");
const browseWorkdirButton = document.querySelector("#browse-workdir-button");
const changeWorkdirButton = document.querySelector("#change-workdir-button");
const stopSessionButton = document.querySelector("#stop-session-button");
const channelPickerDialog = document.querySelector("#channel-picker-dialog");
const channelPickerList = document.querySelector("#channel-picker-list");
const workdirPickerDialog = document.querySelector("#workdir-picker-dialog");
const workdirPickerList = document.querySelector("#workdir-picker-list");
const mainSessionHeader = document.querySelector("#main-session-header");
const mainSessionHeading = document.querySelector("#main-session-heading");
const chatView = document.querySelector("#chat-view");
const settingsView = document.querySelector("#settings-view");
const scheduleView = document.querySelector("#schedule-view");
const scheduleForm = document.querySelector("#schedule-form");
const scheduleNameInput = document.querySelector("#schedule-name-input");
const scheduleCronInput = document.querySelector("#schedule-cron-input");
const scheduleTimezoneInput = document.querySelector("#schedule-timezone-input");
const schedulePromptInput = document.querySelector("#schedule-prompt-input");
const scheduleTargetSummary = document.querySelector("#schedule-target-summary");
const scheduleTargetNote = document.querySelector("#schedule-target-note");
const scheduleCronPresets = document.querySelector("#schedule-cron-presets");
const scheduleCronDescription = document.querySelector("#schedule-cron-description");
const scheduleCount = document.querySelector("#schedule-count");
const scheduleList = document.querySelector("#schedule-list");
const sendButton = messageForm?.querySelector('button[type="submit"]');
const DEFAULT_MESSAGE_PLACEHOLDER =
  messageInput?.getAttribute("placeholder") ||
  "Type here. This will be queued into the shared Codex session.";

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

function formatPreciseDateTime(value) {
  if (!value) {
    return "Not available";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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

function formatQueueNotice(turnsAhead) {
  if (!Number.isFinite(turnsAhead) || turnsAhead <= 0) {
    return "";
  }

  if (turnsAhead === 1) {
    return "Queued as next turn.";
  }

  return `Queued. ${turnsAhead} turns ahead.`;
}

function hideComposerFeedback() {
  if (!composerFeedback) {
    return;
  }

  composerFeedback.hidden = true;
  composerFeedback.textContent = "";
  updateComposerFooterVisibility();
  if (composerFeedbackTimerId != null) {
    window.clearTimeout(composerFeedbackTimerId);
    composerFeedbackTimerId = null;
  }
}

function showComposerFeedback(message) {
  if (!composerFeedback) {
    return;
  }

  if (!message) {
    hideComposerFeedback();
    return;
  }

  composerFeedback.hidden = false;
  composerFeedback.textContent = message;
  updateComposerFooterVisibility();
  if (composerFeedbackTimerId != null) {
    window.clearTimeout(composerFeedbackTimerId);
  }
  composerFeedbackTimerId = window.setTimeout(() => {
    composerFeedback.hidden = true;
    composerFeedback.textContent = "";
    updateComposerFooterVisibility();
    composerFeedbackTimerId = null;
  }, 6000);
}

function updateComposerFooterVisibility() {
  if (!composerFooter) {
    return;
  }

  const hasFeedback = !composerFeedback?.hidden && Boolean(composerFeedback?.textContent?.trim());
  const hasAttachments = state.pendingAttachments.length > 0;
  composerFooter.hidden = !hasFeedback && !hasAttachments;
}

function renderEnterSendToggle() {
  if (!enterSendToggleButton) {
    return;
  }

  const enabled = Boolean(state.enterSendMode);
  enterSendToggleButton.textContent = enabled ? "Enter Send On" : "Enter Send Off";
  enterSendToggleButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  enterSendToggleButton.title = enabled
    ? "Enter sends. Shift+Enter inserts a new line."
    : "Enter inserts a new line.";
}

function shouldSendOnEnter(event) {
  if (!state.enterSendMode) {
    return false;
  }

  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }

  if (event.isComposing || messageInputIsComposing || event.keyCode === 229) {
    return false;
  }

  return true;
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

  if (source === "schedule") {
    return "message-source-schedule";
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

function formatWorkdir(session) {
  return session?.workdir || state.runtime?.defaults?.workdir || "Not set";
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

function getCurrentSchedule(name) {
  return state.schedules.find((item) => item.name === name) || null;
}

function isVirtualScheduleDefaultsId(sessionId) {
  return sessionId === VIRTUAL_SCHEDULE_SESSION_ID;
}

function isVirtualScheduleDefaultsSelected() {
  return isVirtualScheduleDefaultsId(state.activeSessionId);
}

function normalizeScheduleTarget(target) {
  if (!target || String(target.type || "").trim().toLowerCase() === "spawn") {
    return {
      type: "spawn",
    };
  }

  const normalizedType = String(target.type || "").trim().toLowerCase();
  if (normalizedType !== "session") {
    return {
      type: "spawn",
    };
  }

  const sessionId = normalizeSessionReference(target.sessionId ?? target.session);
  if (!sessionId) {
    return {
      type: "spawn",
    };
  }

  return {
    type: "session",
    sessionId,
    sessionTitleSnapshot:
      normalizeSessionReference(target.sessionTitleSnapshot ?? target.sessionTitle) || sessionId,
  };
}

function normalizeSchedule(schedule) {
  const normalizedTarget = normalizeScheduleTarget(schedule?.target);
  return {
    ...schedule,
    target: normalizedTarget,
  };
}

function getScheduleDefaults() {
  const defaults = state.scheduleDefaults;
  if (defaults) {
    return defaults;
  }

  const runtimeDefaults = state.runtime?.defaults || {};
  return {
    model: runtimeDefaults.model || "gpt-5.4",
    reasoningEffort: runtimeDefaults.reasoningEffort || "medium",
    profile: runtimeDefaults.profile || "default",
    workdir: runtimeDefaults.workdir || "unknown",
    fastMode: Boolean(runtimeDefaults.fastMode),
    serviceTier: runtimeDefaults.serviceTier || (runtimeDefaults.fastMode ? "fast" : "flex"),
  };
}

function getVirtualScheduleSession() {
  const defaults = getScheduleDefaults();
  return {
    id: VIRTUAL_SCHEDULE_SESSION_ID,
    title: VIRTUAL_SCHEDULE_SESSION_TITLE,
    status: "idle",
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    profile: defaults.profile,
    workdir: defaults.workdir,
    fastMode: defaults.fastMode,
    serviceTier: defaults.serviceTier || (defaults.fastMode ? "fast" : "flex"),
  };
}

function getActiveSelection() {
  return isVirtualScheduleDefaultsSelected() ? getVirtualScheduleSession() : getCurrentSession();
}

function getActiveSelectionTitle() {
  return getActiveSelection()?.title || "No session selected";
}

function normalizeSessionReference(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function getCronPresetMarkup(currentValue, scope = "create") {
  const normalizedValue = String(currentValue || "").trim();
  const buttons = CRON_PRESETS.map((preset) => {
    const isActive = preset.value === normalizedValue;
    return `
      <button
        class="cron-preset-button${isActive ? " active" : ""}"
        type="button"
        data-cron-preset-button="true"
        data-cron-preset-scope="${escapeHtml(scope)}"
        data-cron-preset-value="${escapeHtml(preset.value)}"
        aria-pressed="${isActive ? "true" : "false"}"
      >
        <strong>${escapeHtml(preset.label)}</strong>
        <span>${escapeHtml(preset.value)}</span>
      </button>
    `;
  }).join("");

  return `
    <div class="cron-presets-shell">
      <div class="cron-presets-header">
        <span>プリセット</span>
      </div>
      <div class="cron-presets-grid">
        ${buttons}
      </div>
    </div>
  `;
}

function refreshCronPresetButtons(container, currentValue) {
  if (!container) {
    return;
  }

  const normalizedValue = String(currentValue || "").trim();
  const buttons = container.querySelectorAll("[data-cron-preset-button]");
  for (const button of buttons) {
    const isActive = String(button.dataset.cronPresetValue || "").trim() === normalizedValue;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

function renderCreateCronPresets() {
  if (!scheduleCronPresets || !scheduleCronInput) {
    return;
  }

  scheduleCronPresets.innerHTML = getCronPresetMarkup(scheduleCronInput.value, "create");
}

function updateCreateCronPresetSelection() {
  refreshCronPresetButtons(scheduleCronPresets, scheduleCronInput?.value || "");
}

function setCronDescriptionText(element, text, isError = false) {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.classList.toggle("error", Boolean(isError));
}

async function requestCronDescription(cronExpression) {
  const cronValue = String(cronExpression || "").trim();
  if (!cronValue) {
    return "cron を入力すると日本語で表示します。";
  }

  const cacheKey = cronValue;
  if (cronDescriptionCache.has(cacheKey)) {
    return cronDescriptionCache.get(cacheKey);
  }

  const payload = await requestJson("/api/cron/describe", {
    method: "POST",
    body: JSON.stringify({
      cron: cronValue,
    }),
  });

  const description = payload.descriptionJa || `カスタム cron: ${cronValue}`;
  cronDescriptionCache.set(cacheKey, description);
  return description;
}

async function performCreateCronDescriptionUpdate() {
  const requestId = ++createCronDescriptionRequestId;
  const cronValue = scheduleCronInput?.value || "";

  if (!cronValue.trim()) {
    setCronDescriptionText(scheduleCronDescription, "cron を入力すると日本語で表示します。");
    return;
  }

  setCronDescriptionText(scheduleCronDescription, "翻訳を確認しています…");

  try {
    const description = await requestCronDescription(cronValue);
    if (requestId !== createCronDescriptionRequestId) {
      return;
    }
    setCronDescriptionText(scheduleCronDescription, description);
  } catch (error) {
    if (requestId !== createCronDescriptionRequestId) {
      return;
    }
    setCronDescriptionText(
      scheduleCronDescription,
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
}

function scheduleCreateCronDescriptionUpdate({ immediate = false } = {}) {
  if (createCronDescriptionTimerId != null) {
    window.clearTimeout(createCronDescriptionTimerId);
    createCronDescriptionTimerId = null;
  }

  if (immediate) {
    performCreateCronDescriptionUpdate().catch((error) => {
      console.error(error);
    });
    return;
  }

  createCronDescriptionTimerId = window.setTimeout(() => {
    createCronDescriptionTimerId = null;
    performCreateCronDescriptionUpdate().catch((error) => {
      console.error(error);
    });
  }, 220);
}

function scheduleCardCronDescriptionUpdate(card, { immediate = false } = {}) {
  if (!card) {
    return;
  }

  const descriptionElement = card.querySelector("[data-cron-description]");
  const cronInput = card.querySelector('[data-field="cron"]');
  if (!descriptionElement || !cronInput) {
    return;
  }

  const existingTimer = cardCronDescriptionTimers.get(card);
  if (existingTimer != null) {
    window.clearTimeout(existingTimer);
    cardCronDescriptionTimers.delete(card);
  }

  const run = async () => {
    const requestId = String(++scheduleCardCronDescriptionRequestId);
    card.dataset.cronDescriptionRequestId = requestId;

    if (!cronInput.value.trim()) {
      setCronDescriptionText(descriptionElement, "cron を入力すると日本語で表示します。");
      return;
    }

    setCronDescriptionText(descriptionElement, "翻訳を確認しています…");

    try {
      const description = await requestCronDescription(cronInput.value);
      if (card.dataset.cronDescriptionRequestId !== requestId) {
        return;
      }
      setCronDescriptionText(descriptionElement, description);
    } catch (error) {
      if (card.dataset.cronDescriptionRequestId !== requestId) {
        return;
      }
      setCronDescriptionText(
        descriptionElement,
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  };

  if (immediate) {
    run().catch((error) => {
      console.error(error);
    });
    return;
  }

  const timerId = window.setTimeout(() => {
    cardCronDescriptionTimers.delete(card);
    run().catch((error) => {
      console.error(error);
    });
  }, 220);
  cardCronDescriptionTimers.set(card, timerId);
}

function matchesScheduleSessionTarget(target, session) {
  if (!session || normalizeScheduleTarget(target).type !== "session") {
    return false;
  }

  const reference = normalizeSessionReference(normalizeScheduleTarget(target).sessionId);
  if (!reference) {
    return false;
  }

  if (reference === session.id) {
    return true;
  }

  return reference.toLowerCase() === String(session.title || "").trim().toLowerCase();
}

function getSessionScheduleState(session) {
  if (!session) {
    return null;
  }

  const matchingSchedules = state.schedules.filter((schedule) =>
    matchesScheduleSessionTarget(schedule.target, session),
  );
  if (matchingSchedules.length === 0) {
    return null;
  }

  if (matchingSchedules.some((schedule) => schedule.active !== false)) {
    return "active";
  }

  return "paused";
}

function getSpawnScheduleState() {
  const matchingSchedules = state.schedules.filter(
    (schedule) => normalizeScheduleTarget(schedule.target).type === "spawn",
  );
  if (matchingSchedules.length === 0) {
    return null;
  }

  if (matchingSchedules.some((schedule) => schedule.active !== false)) {
    return "active";
  }

  return "paused";
}

function sortSchedules() {
  state.schedules.sort((left, right) => left.name.localeCompare(right.name, "ja"));
}

function upsertSchedule(schedule) {
  const normalizedSchedule = normalizeSchedule(schedule);
  const existingIndex = state.schedules.findIndex((item) => item.name === schedule.name);
  if (existingIndex >= 0) {
    state.schedules.splice(existingIndex, 1, normalizedSchedule);
  } else {
    state.schedules.push(normalizedSchedule);
  }

  sortSchedules();
}

function removeScheduleFromState(name) {
  const index = state.schedules.findIndex((item) => item.name === name);
  if (index >= 0) {
    state.schedules.splice(index, 1);
  }
}

function normalizeView(view) {
  if (view === "settings" || view === "schedules") {
    return view;
  }

  return "chat";
}

function renderMainSessionHeader() {
  if (!mainSessionHeader || !mainSessionHeading) {
    return;
  }

  const shouldShow = state.activeView === "chat" || state.activeView === "settings";
  mainSessionHeader.hidden = !shouldShow;
  if (!shouldShow) {
    return;
  }

  mainSessionHeading.textContent = getActiveSelectionTitle();
}

function setAppView(view) {
  state.activeView = normalizeView(view);
  document.body.dataset.view = state.activeView;
  showChatButton?.classList.toggle("active", state.activeView === "chat");
  showSchedulesButton?.classList.toggle("active", state.activeView === "schedules");
  showSettingsButton?.classList.toggle("active", state.activeView === "settings");
  chatView.hidden = state.activeView !== "chat";
  settingsView.hidden = state.activeView !== "settings";
  scheduleView.hidden = state.activeView !== "schedules";
  renderMainSessionHeader();
}

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function renderInstallAppButton() {
  installAppButton.hidden = isStandaloneMode() || !deferredInstallPrompt;
}

function renderAppVersion() {
  if (!appVersionBadge) {
    return;
  }

  appVersionBadge.textContent = `v${state.runtime?.app?.version || "unknown"}`;
}

function renderPendingAttachments() {
  if (state.pendingAttachments.length === 0) {
    pendingAttachmentList.hidden = true;
    pendingAttachmentList.innerHTML = "";
    updateComposerFooterVisibility();
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
  updateComposerFooterVisibility();
}

function resetComposerDragState() {
  composerDragDepth = 0;
  messageForm.classList.remove("composer-drag-active");
}

function setComposerDragState(isActive) {
  messageForm.classList.toggle("composer-drag-active", isActive);
}

function getAttachmentLimits() {
  return {
    maxAttachments: state.runtime?.attachments?.maxAttachmentsPerMessage || 5,
    maxBytes: state.runtime?.attachments?.maxAttachmentBytes || 20 * 1024 * 1024,
  };
}

function getFileExtensionFromType(type) {
  const normalized = String(type || "").toLowerCase();
  if (!normalized.includes("/")) {
    return "bin";
  }

  const [, subtype = "bin"] = normalized.split("/", 2);
  if (subtype === "jpeg") {
    return "jpg";
  }

  return subtype.replace(/[^a-z0-9]+/g, "-") || "bin";
}

function normalizeAttachmentFile(file, index = 0) {
  if (file?.name) {
    return file;
  }

  const extension = getFileExtensionFromType(file?.type);
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const fallbackName = `pasted-file-${timestamp}-${index + 1}.${extension}`;
  return new File([file], fallbackName, {
    type: file?.type || "application/octet-stream",
    lastModified: file?.lastModified || Date.now(),
  });
}

function addPendingAttachments(nextFiles) {
  const normalizedFiles = (Array.isArray(nextFiles) ? nextFiles : [])
    .filter((file) => file instanceof File)
    .map((file, index) => normalizeAttachmentFile(file, index));

  if (normalizedFiles.length === 0) {
    return false;
  }

  const { maxAttachments, maxBytes } = getAttachmentLimits();
  const mergedFiles = [...state.pendingAttachments, ...normalizedFiles];
  if (mergedFiles.length > maxAttachments) {
    alert(`You can attach up to ${maxAttachments} files per message.`);
    return false;
  }

  const oversizedFile = mergedFiles.find((file) => file.size > maxBytes);
  if (oversizedFile) {
    alert(`${oversizedFile.name} is too large. Limit is ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
    return false;
  }

  state.pendingAttachments = mergedFiles;
  renderPendingAttachments();
  return true;
}

function clearPendingAttachments() {
  state.pendingAttachments = [];
  attachmentInput.value = "";
  resetComposerDragState();
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

function dataTransferHasFiles(dataTransfer) {
  if (!dataTransfer?.types) {
    return false;
  }

  return [...dataTransfer.types].includes("Files");
}

function getClipboardFiles(clipboardData) {
  if (!clipboardData?.items) {
    return [];
  }

  return [...clipboardData.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file) => file instanceof File);
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
    throw new Error(payload.error || payload.message || "Request failed");
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

function isCountedUserPromptEvent(event) {
  return (
    event?.eventType === "message.user" &&
    (event?.source === "ui" || event?.source === "discord")
  );
}

function incrementSessionPromptCount(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return false;
  }

  session.userPromptCount = Number(session.userPromptCount || 0) + 1;
  return true;
}

function formatUserPromptCount(count) {
  const normalized = Number(count || 0);
  if (normalized > 99) {
    return "99+";
  }

  return String(normalized);
}

function getNextSessionIdAfterDelete(deletedSessionId) {
  const remaining = state.sessions.filter((session) => session.id !== deletedSessionId);
  return remaining[0]?.id || null;
}

function renderSessions() {
  sessionCount.textContent = `${state.sessions.length} sessions`;
  sessionList.innerHTML = "";

  const virtualButton = document.createElement("button");
  virtualButton.className = `session-card${isVirtualScheduleDefaultsSelected() ? " active" : ""}`;
  const spawnScheduleState = getSpawnScheduleState();
  const spawnScheduleIndicator =
    spawnScheduleState == null
      ? ""
      : `
        <span
          class="session-schedule-indicator session-schedule-indicator-${spawnScheduleState}"
          title="${escapeHtml(
            spawnScheduleState === "active"
              ? "新規セッション実行の有効なスケジュールがあります。"
              : "新規セッション実行の停止中スケジュールだけがあります。",
          )}"
          aria-label="${escapeHtml(
            spawnScheduleState === "active"
              ? "有効な新規セッションスケジュール"
              : "停止中の新規セッションスケジュール",
          )}"
        >
          ◷
        </span>
      `;
  virtualButton.innerHTML = `
    <span class="session-card-title-row">
      <strong>${escapeHtml(VIRTUAL_SCHEDULE_SESSION_TITLE)}</strong>
      <span class="session-card-meta">
        ${spawnScheduleIndicator}
      </span>
    </span>
    <small>${escapeHtml(VIRTUAL_SCHEDULE_SESSION_SUBTITLE)}</small>
  `;
  virtualButton.addEventListener("click", () => {
    setActiveSession(VIRTUAL_SCHEDULE_SESSION_ID).catch((error) => {
      alert(error.message);
    });
  });
  sessionList.appendChild(virtualButton);

  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.className = `session-card${session.id === state.activeSessionId ? " active" : ""}`;
    const scheduleState = getSessionScheduleState(session);
    const promptCountLabel = Number(session.userPromptCount || 0);
    const scheduleIndicator =
      scheduleState == null
        ? ""
        : `
          <span
            class="session-schedule-indicator session-schedule-indicator-${scheduleState}"
            title="${escapeHtml(
              scheduleState === "active"
                ? "このセッションには有効なスケジュールがあります。"
                : "このセッションには停止中のスケジュールだけがあります。",
            )}"
            aria-label="${escapeHtml(
              scheduleState === "active" ? "有効なスケジュール" : "停止中のスケジュール",
            )}"
          >
            ◷
          </span>
        `;
    const promptCountBadge = `
      <span
        class="session-prompt-count-badge"
        title="${escapeHtml(`ユーザー送信数: ${promptCountLabel}`)}"
        aria-label="${escapeHtml(`ユーザー送信数 ${promptCountLabel}`)}"
      >
        ${escapeHtml(formatUserPromptCount(promptCountLabel))}
      </span>
    `;
    button.innerHTML = `
      <span class="session-card-title-row">
        <strong>${escapeHtml(session.title)}</strong>
        <span class="session-card-meta">
          ${scheduleIndicator}
          ${promptCountBadge}
        </span>
      </span>
      <small>${escapeHtml(formatDateTime(session.updatedAt))}</small>
    `;
    button.addEventListener("click", () => {
      setActiveSession(session.id).catch((error) => {
        alert(error.message);
      });
    });
    sessionList.appendChild(button);
  }

  if (state.sessions.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "sidebar-empty";
    emptyState.innerHTML = `
      <p>No sessions yet.</p>
      <p>Use "New Session" to get started.</p>
    `;
    sessionList.appendChild(emptyState);
  }
}

function renderScheduleSessionOptions() {
  // Session target selection is derived from the active card.
}

function resetScheduleForm() {
  if (!scheduleForm) {
    return;
  }

  scheduleForm.reset();
  scheduleTimezoneInput.value = DEFAULT_SCHEDULE_TIMEZONE;
  renderScheduleCreateTarget();
  updateCreateCronPresetSelection();
  setCronDescriptionText(scheduleCronDescription, "cron を入力すると日本語で表示します。");
}

function getScheduleRuntimeStatus(schedule) {
  if (!schedule.active) {
    return "paused";
  }

  return schedule.lastStatus || "idle";
}

function getScheduleRuntimeLabel(schedule) {
  const status = getScheduleRuntimeStatus(schedule);
  if (status === "paused") {
    return "paused";
  }

  if (status === "running") {
    return "running";
  }

  if (status === "completed") {
    return "completed";
  }

  if (status === "error") {
    return "error";
  }

  return "idle";
}

function getScheduleLastRunStatusLabel(schedule) {
  const status = schedule?.lastStatus || null;
  if (!status) {
    return null;
  }

  if (status === "running") {
    return "running";
  }

  if (status === "completed") {
    return "completed";
  }

  if (status === "error") {
    return "error";
  }

  if (status === "paused") {
    return "paused";
  }

  return status;
}

function getCurrentScheduleTarget() {
  if (isVirtualScheduleDefaultsSelected()) {
    return {
      type: "spawn",
    };
  }

  const session = getCurrentSession();
  if (!session) {
    return null;
  }

  return {
    type: "session",
    sessionId: session.id,
    sessionTitleSnapshot: session.title,
  };
}

function getVisibleSchedules() {
  if (isVirtualScheduleDefaultsSelected()) {
    return state.schedules.filter((schedule) => normalizeScheduleTarget(schedule.target).type === "spawn");
  }

  const session = getCurrentSession();
  if (!session) {
    return [];
  }

  return state.schedules.filter((schedule) => matchesScheduleSessionTarget(schedule.target, session));
}

function formatScheduleTargetLabel(schedule) {
  const target = normalizeScheduleTarget(schedule?.target);
  if (target.type === "spawn") {
    return "新規セッション";
  }

  const matchedSession =
    state.sessions.find((session) => session.id === target.sessionId) ||
    state.sessions.find(
      (session) =>
        String(session.title || "").trim().toLowerCase() ===
        String(target.sessionId || "").trim().toLowerCase(),
    );
  return matchedSession?.title || target.sessionTitleSnapshot || target.sessionId;
}

function renderScheduleCreateTarget() {
  if (!scheduleTargetSummary || !scheduleTargetNote) {
    return;
  }

  if (isVirtualScheduleDefaultsSelected()) {
    scheduleTargetSummary.textContent = "新規セッションを作成して実行";
    scheduleTargetNote.textContent =
      "このカードで作成したスケジュールは、実行時に新しいセッションを起動します。";
    return;
  }

  const session = getCurrentSession();
  if (!session) {
    scheduleTargetSummary.textContent = "対象なし";
    scheduleTargetNote.textContent = "セッション一覧または未設定スケジュールカードを選択してください。";
    return;
  }

  scheduleTargetSummary.textContent = session.title;
  scheduleTargetNote.textContent = "このカードで作成したスケジュールは、選択中のセッションに送信されます。";
}

function readScheduleCardTarget(card) {
  const targetType = String(card?.dataset.targetType || "").trim().toLowerCase();
  if (targetType === "session") {
    return {
      type: "session",
      sessionId: normalizeSessionReference(card?.dataset.targetSessionId),
      sessionTitleSnapshot: normalizeSessionReference(card?.dataset.targetSessionTitle),
    };
  }

  return {
    type: "spawn",
  };
}

function formatScheduleLastRun(schedule) {
  if (!schedule.lastRunAt) {
    return "Not run yet";
  }

  const status = getScheduleLastRunStatusLabel(schedule);
  if (!status) {
    return formatPreciseDateTime(schedule.lastRunAt);
  }

  return `${formatPreciseDateTime(schedule.lastRunAt)} (${status})`;
}

function readScheduleCardPayload(card) {
  return {
    cron: card.querySelector('[data-field="cron"]')?.value?.trim() || "",
    target: readScheduleCardTarget(card),
    timezone:
      card.querySelector('[data-field="timezone"]')?.value?.trim() || DEFAULT_SCHEDULE_TIMEZONE,
    prompt: card.querySelector('[data-field="prompt"]')?.value?.trim() || "",
    active: String(card?.dataset.active || "true").trim() !== "false",
  };
}

function renderScheduleCard(schedule) {
  const runtimeStatus = getScheduleRuntimeStatus(schedule);
  const target = normalizeScheduleTarget(schedule.target);
  const errorBlock = schedule.lastError
    ? `<p class="schedule-error">${escapeHtml(schedule.lastError)}</p>`
    : "";

  return `
    <article
      class="schedule-card"
      data-schedule-name="${escapeHtml(schedule.name)}"
      data-target-type="${escapeHtml(target.type)}"
      data-target-session-id="${escapeHtml(target.sessionId || "")}"
      data-target-session-title="${escapeHtml(target.sessionTitleSnapshot || "")}"
      data-active="${schedule.active ? "true" : "false"}"
    >
      <div class="schedule-card-header">
        <div>
          <span class="eyebrow">Schedule</span>
          <h4>${escapeHtml(schedule.name)}</h4>
        </div>
        <div class="schedule-card-header-actions">
          <button
            class="outline-button schedule-action-button ${
              schedule.active ? "schedule-toggle-running" : "schedule-toggle-paused"
            }"
            type="button"
            data-schedule-action="toggle"
          >
            ${schedule.active ? "稼働中" : "停止中"}
          </button>
          <span class="schedule-status-pill" data-status="${escapeHtml(runtimeStatus)}">
            ${escapeHtml(getScheduleRuntimeLabel(schedule))}
          </span>
        </div>
      </div>

      <div class="schedule-form-grid schedule-card-grid">
        <label class="schedule-field">
          <span>Cron</span>
          <input data-field="cron" type="text" value="${escapeHtml(schedule.cron)}" />
        </label>
        <label class="schedule-field">
          <span>Timezone</span>
          <input
            data-field="timezone"
            type="text"
            value="${escapeHtml(schedule.timezone || DEFAULT_SCHEDULE_TIMEZONE)}"
          />
        </label>
      </div>

      <div class="cron-presets-panel cron-presets-panel-inline">
        ${getCronPresetMarkup(schedule.cron, "card")}
      </div>

      <div class="schedule-cron-translation">
        <span class="eyebrow">日本語翻訳</span>
        <strong data-cron-description>${escapeHtml(
          schedule.cronDescriptionJa || "cron を入力すると日本語で表示します。",
        )}</strong>
      </div>

      <label class="schedule-field schedule-field-full">
        <span>Prompt</span>
        <textarea data-field="prompt" rows="4">${escapeHtml(schedule.prompt)}</textarea>
      </label>

      <div class="schedule-meta-grid">
        <div class="schedule-meta-item">
          <span>Next run</span>
          <strong>${escapeHtml(formatPreciseDateTime(schedule.nextRunAt))}</strong>
        </div>
        <div class="schedule-meta-item">
          <span>Last run</span>
          <strong>${escapeHtml(formatScheduleLastRun(schedule))}</strong>
        </div>
        <div class="schedule-meta-item">
          <span>Target</span>
          <strong>${escapeHtml(formatScheduleTargetLabel(schedule))}</strong>
        </div>
        <div class="schedule-meta-item">
          <span>Last session</span>
          <strong>${escapeHtml(schedule.lastSessionTitle || "Not run yet")}</strong>
        </div>
      </div>

      ${errorBlock}

      <div class="schedule-card-actions">
        <button
          class="outline-button schedule-action-button schedule-action-save"
          type="button"
          data-schedule-action="save"
        >
          Save
        </button>
        <button class="secondary-button schedule-action-button" type="button" data-schedule-action="delete">
          Delete
        </button>
      </div>
    </article>
  `;
}

function renderScheduleView() {
  if (!scheduleList || !scheduleCount) {
    return;
  }

  renderScheduleCreateTarget();
  renderCreateCronPresets();
  scheduleCreateCronDescriptionUpdate({ immediate: true });
  const visibleSchedules = getVisibleSchedules();
  scheduleCount.textContent = `${visibleSchedules.length} schedules`;

  if (visibleSchedules.length === 0) {
    scheduleList.innerHTML = `
      <div class="empty-state compact-empty">
        <p>No schedules here yet.</p>
        <p>Create one above for the currently selected card.</p>
      </div>
    `;
    return;
  }

  scheduleList.innerHTML = visibleSchedules.map((schedule) => renderScheduleCard(schedule)).join("");
}

function renderSettingsButtons(session) {
  modelOptions.innerHTML = "";
  reasoningOptions.innerHTML = "";
  const isVirtual = isVirtualScheduleDefaultsId(session?.id);
  developerToolsGroup.hidden = isVirtual || !session;
  developerConsoleButton.disabled = isVirtual || !session;
  fastOnButton.classList.toggle("active", false);
  fastOffButton.classList.toggle("active", false);

  if (!state.runtime || !session) {
    fastOnButton.disabled = true;
    fastOffButton.disabled = true;
    return;
  }

  const updateHandler = isVirtual ? updateScheduleDefaultsSettings : updateSessionSettings;

  for (const model of state.runtime.availableModels) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `option-button${model.slug === session.model ? " active" : ""}`;
    button.textContent = model.displayName;
    button.title = model.description;
    button.addEventListener("click", async () => {
      try {
        await updateHandler({ model: model.slug });
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
        await updateHandler({ reasoningEffort: level.effort });
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

async function loadSelectableWorkdirs() {
  return requestJson("/api/workdirs");
}

function renderChannelPicker(channels, currentChannelId) {
  channelPickerList.innerHTML = "";

  const unlinkButton = document.createElement("button");
  unlinkButton.type = "button";
  unlinkButton.className = `channel-option${currentChannelId ? "" : " active"}`;
  unlinkButton.innerHTML = `
    <strong>Not linked</strong>
    <small>Disconnect this session from Discord</small>
  `;
  unlinkButton.addEventListener("click", async () => {
    try {
      await bindChannel(null);
      channelPickerDialog.close();
    } catch (error) {
      alert(error.message);
    }
  });
  channelPickerList.appendChild(unlinkButton);

  if (channels.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "channel-picker-empty";
    emptyState.innerHTML = "<p>No selectable Discord channels were found.</p>";
    channelPickerList.appendChild(emptyState);
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

function renderWorkdirPicker(payload, currentWorkdir) {
  workdirPickerList.innerHTML = "";
  const workdirs = payload?.workdirs || [];

  if (workdirs.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "channel-picker-empty";
    emptyState.innerHTML = "<p>No selectable folders were found under the base workdir.</p>";
    workdirPickerList.appendChild(emptyState);
    return;
  }

  for (const workdir of workdirs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `channel-option${workdir.path === currentWorkdir ? " active" : ""}`;
    const gitLabel = workdir.isGitRepo ? "Git repo" : "No Git repo";
    button.innerHTML = `
      <strong>${escapeHtml(workdir.label === "." ? "(base workdir)" : workdir.label)}</strong>
      <small>${escapeHtml(workdir.path)}</small>
      <small>${escapeHtml(gitLabel)}</small>
    `;
    button.addEventListener("click", async () => {
      try {
        await changeWorkdir(workdir.path);
        workdirPickerDialog.close();
      } catch (error) {
        alert(error.message);
      }
    });
    workdirPickerList.appendChild(button);
  }
}

async function openChannelPicker() {
  if (isVirtualScheduleDefaultsSelected()) {
    return;
  }

  const session = getCurrentSession();
  if (!session) {
    return;
  }

  const channels = await loadSelectableChannels();
  renderChannelPicker(channels, session.discordChannelId || null);
  channelPickerDialog.showModal();
}

async function openWorkdirPicker() {
  const selection = getActiveSelection();
  if (!selection) {
    return;
  }

  const payload = await loadSelectableWorkdirs();
  renderWorkdirPicker(payload, selection.workdir || null);
  workdirPickerDialog.showModal();
}

async function browseForWorkdir() {
  const selection = getActiveSelection();
  if (!selection) {
    return;
  }

  const browseResult = isVirtualScheduleDefaultsSelected()
    ? await requestJson("/api/schedule-defaults/workdir/browse", {
        method: "POST",
        body: JSON.stringify({
          initialPath: selection.workdir,
        }),
      })
    : await requestJson("/api/workdirs/browse", {
        method: "POST",
        body: JSON.stringify({
          sessionId: selection.id,
        }),
      });

  if (browseResult?.cancelled || !browseResult?.path) {
    return;
  }

  await changeWorkdir(browseResult.path);
}

async function changeWorkdir(nextWorkdir) {
  const selection = getActiveSelection();
  if (!selection || !nextWorkdir || nextWorkdir === selection.workdir) {
    return;
  }

  if (!isVirtualScheduleDefaultsSelected() && selection.codexThreadId) {
    const confirmed = window.confirm(
      "Changing the working directory will start a fresh Codex thread for this session. Continue?",
    );
    if (!confirmed) {
      return;
    }
  }

  const updated = isVirtualScheduleDefaultsSelected()
    ? await requestJson("/api/schedule-defaults", {
        method: "POST",
        body: JSON.stringify({
          workdir: nextWorkdir,
        }),
      })
    : await requestJson(`/api/sessions/${selection.id}/settings`, {
        method: "POST",
        body: JSON.stringify({
          workdir: nextWorkdir,
        }),
      });

  if (isVirtualScheduleDefaultsSelected()) {
    state.scheduleDefaults = updated;
  } else {
    upsertSession(updated);
  }
  renderSessions();
  renderActiveSession();
  showComposerFeedback(`Working directory updated to ${updated.workdir}.`);
}

function setComposerAvailability(enabled, placeholder = DEFAULT_MESSAGE_PLACEHOLDER) {
  messageInput.disabled = !enabled;
  messageInput.placeholder = placeholder;
  attachmentInput.disabled = !enabled;
  attachmentButton.disabled = !enabled;
  if (sendButton) {
    sendButton.disabled = !enabled;
  }
}

function renderEmptySession() {
  if (sessionCardEyebrow) {
    sessionCardEyebrow.textContent = "Active Session";
  }
  sessionTitle.textContent = "No session selected";
  sessionSubtitle.textContent = "Select a session from the list or create a new one to begin.";
  if (sessionCardHint) {
    sessionCardHint.textContent = "Select a session";
  }
  statusPill.textContent = getStatusLabel("idle");
  statusPill.dataset.status = "idle";
  sessionCard.setAttribute("aria-disabled", "true");
  if (discordCardLabel) {
    discordCardLabel.textContent = "Discord Channel";
  }
  discordIdValue.textContent = formatDiscordChannel(null);
  discordChannelCard.setAttribute("aria-disabled", "true");
  if (discordCardHint) {
    discordCardHint.textContent = "Select a session first";
  }
  deleteSessionButton.disabled = true;
  restoreSessionButton.disabled = true;
  browseWorkdirButton.disabled = true;
  changeWorkdirButton.disabled = true;
  workdirValue.textContent = formatWorkdir(null);
  workdirBaseNote.textContent = `Base workdir: ${state.runtime?.baseWorkdir || "unknown"}`;
  stopSessionButton.disabled = true;
  renderSettingsButtons(null);
  syncLiveTimer();
  renderMainSessionHeader();
  setComposerAvailability(false, "Select a session to start chatting.");
  chatLog.innerHTML = `
    <div class="empty-state">
      <p>Select a session to view its conversation here.</p>
    </div>
  `;
}

function renderScheduleDefaultsSession() {
  const defaults = getVirtualScheduleSession();
  if (sessionCardEyebrow) {
    sessionCardEyebrow.textContent = "Schedule Defaults";
  }
  sessionTitle.textContent = defaults.title;
  sessionSubtitle.textContent = VIRTUAL_SCHEDULE_SESSION_SUBTITLE;
  if (sessionCardHint) {
    sessionCardHint.textContent = "This card is not renameable";
  }
  statusPill.textContent = "defaults";
  statusPill.dataset.status = "idle";
  sessionCard.setAttribute("aria-disabled", "true");
  if (discordCardLabel) {
    discordCardLabel.textContent = "Discord";
  }
  discordIdValue.textContent = "Not available";
  discordChannelCard.setAttribute("aria-disabled", "true");
  if (discordCardHint) {
    discordCardHint.textContent = "Spawned sessions are created without Discord binding";
  }
  deleteSessionButton.disabled = true;
  restoreSessionButton.disabled = true;
  browseWorkdirButton.disabled = false;
  changeWorkdirButton.disabled = false;
  workdirValue.textContent = formatWorkdir(defaults);
  workdirBaseNote.textContent = `Base workdir: ${state.runtime?.baseWorkdir || "unknown"}`;
  stopSessionButton.disabled = true;
  renderSettingsButtons(defaults);
  syncLiveTimer();
  renderMainSessionHeader();
  setComposerAvailability(false, "AI Chat is not available for the 未設定スケジュール card.");
  chatLog.innerHTML = `
    <div class="empty-state">
      <p>このカードには AI Chat はありません。</p>
      <p>Schedules では新規セッション起動型のジョブを管理し、Settings ではその既定値を編集できます。</p>
    </div>
  `;
}

function renderEvent(event) {
  if (event.eventType === "message.user" || event.eventType === "message.assistant") {
    const role = event.payload.role;
    const timeLabel = formatTime(event.createdAt);
    const text = String(event.payload.text || "").trim();
    const renderedText =
      event.eventType === "message.user" &&
      event.source === "schedule" &&
      event.payload.scheduleName
        ? `⏰ ${event.payload.scheduleName}\n${text || event.payload.schedulePrompt || ""}`.trim()
        : text;
    const attachments = renderMessageAttachments(event.payload.attachments);

    return `
      <article class="message message-${role}">
        <div class="message-meta">
          <span class="message-author">${escapeHtml(getRoleLabel(role))}</span>
          <span class="message-source ${getSourceClass(event.source)}">${escapeHtml(getSourceLabel(event.source))}</span>
          <span class="message-time">${escapeHtml(timeLabel)}</span>
        </div>
        ${
          renderedText
            ? `
              <div class="message-bubble">
                <pre>${escapeHtml(renderedText)}</pre>
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
  const workdir = session?.workdir || state.runtime?.defaults?.workdir || "unknown";

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
  if (isVirtualScheduleDefaultsSelected()) {
    renderScheduleDefaultsSession();
    return;
  }

  const session = getCurrentSession();
  if (!session) {
    renderEmptySession();
    return;
  }

  if (sessionCardEyebrow) {
    sessionCardEyebrow.textContent = "Active Session";
  }
  sessionTitle.textContent = session.title;
  sessionSubtitle.textContent = `Updated ${formatDateTime(session.updatedAt)}`;
  if (sessionCardHint) {
    sessionCardHint.textContent = "Click to rename";
  }
  statusPill.textContent = getStatusLabel(session.status);
  statusPill.dataset.status = session.status;
  sessionCard.setAttribute("aria-disabled", "false");
  if (discordCardLabel) {
    discordCardLabel.textContent = "Discord Channel";
  }
  discordIdValue.textContent = formatDiscordChannel(session);
  discordChannelCard.setAttribute("aria-disabled", "false");
  if (discordCardHint) {
    discordCardHint.textContent = "Click to set";
  }
  deleteSessionButton.disabled = false;
  restoreSessionButton.disabled = false;
  browseWorkdirButton.disabled = WORKING_STATUSES.has(session.status);
  changeWorkdirButton.disabled = WORKING_STATUSES.has(session.status);
  workdirValue.textContent = formatWorkdir(session);
  workdirBaseNote.textContent = `Base workdir: ${state.runtime?.baseWorkdir || "unknown"}`;
  stopSessionButton.disabled = false;
  renderSettingsButtons(session);
  renderMainSessionHeader();
  setComposerAvailability(true);

  const events = state.eventsBySession.get(session.id) || [];
  syncLiveTimer(events);
  const content = `${renderTimeline(events)}${renderWorkingIndicator(session, events)}`;

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
}

async function loadRuntime() {
  state.runtime = await requestJson("/api/runtime");
  state.enterSendMode = loadEnterSendModePreference();
  renderAppVersion();
  renderEnterSendToggle();
}

async function loadSessions() {
  await syncSessions(state.activeSessionId);
}

async function loadScheduleDefaults() {
  await syncScheduleDefaults();
}

async function loadSchedules() {
  await syncSchedules();
}

async function setActiveSession(sessionId) {
  if (isVirtualScheduleDefaultsId(sessionId)) {
    state.activeSessionId = VIRTUAL_SCHEDULE_SESSION_ID;
    clearPendingAttachments();
    renderSessions();
    renderActiveSession();
    renderScheduleView();
    return;
  }

  const detail = await requestJson(`/api/sessions/${sessionId}`);
  upsertSession(detail.session);
  state.activeSessionId = sessionId;
  state.eventsBySession.set(sessionId, detail.events);
  clearPendingAttachments();
  renderSessions();
  renderActiveSession();
  renderScheduleView();
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

  let nextSessionId = null;
  if (isVirtualScheduleDefaultsId(preferredSessionId)) {
    nextSessionId = VIRTUAL_SCHEDULE_SESSION_ID;
  } else if (preferredSessionId && state.sessions.some((session) => session.id === preferredSessionId)) {
    nextSessionId = preferredSessionId;
  } else {
    nextSessionId = state.sessions[0]?.id || VIRTUAL_SCHEDULE_SESSION_ID;
  }

  state.activeSessionId = nextSessionId;

  if (!nextSessionId || isVirtualScheduleDefaultsId(nextSessionId)) {
    renderSessions();
    renderActiveSession();
    renderScheduleView();
    return;
  }

  const detail = await requestJson(`/api/sessions/${nextSessionId}`);
  upsertSession(detail.session);
  state.eventsBySession.set(nextSessionId, detail.events);
  renderSessions();
  renderActiveSession();
  renderScheduleView();
}

async function syncScheduleDefaults() {
  state.scheduleDefaults = await requestJson("/api/schedule-defaults");
  renderSessions();
  renderActiveSession();
  renderScheduleView();
}

async function syncSchedules() {
  const payload = await requestJson("/api/schedules");
  state.schedules = Array.isArray(payload?.schedules) ? payload.schedules.map(normalizeSchedule) : [];
  sortSchedules();
  renderSessions();
  renderScheduleView();
}

async function createSchedule(payload) {
  const schedule = await requestJson("/api/schedules", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  upsertSchedule(schedule);
  renderScheduleView();
  return schedule;
}

async function updateSchedule(name, patch) {
  const schedule = await requestJson(`/api/schedules/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

  upsertSchedule(schedule);
  renderScheduleView();
  return schedule;
}

async function deleteSchedule(name) {
  await requestJson(`/api/schedules/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });

  removeScheduleFromState(name);
  renderScheduleView();
}

async function createSession() {
  const activeSession = isVirtualScheduleDefaultsSelected()
    ? getScheduleDefaults()
    : getCurrentSession();
  const session = await requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      discordChannelId: isVirtualScheduleDefaultsSelected()
        ? null
        : activeSession?.discordChannelId || null,
      model: activeSession?.model || state.runtime?.defaults?.model,
      reasoningEffort:
        activeSession?.reasoningEffort || state.runtime?.defaults?.reasoningEffort,
      profile: activeSession?.profile || state.runtime?.defaults?.profile,
      workdir: activeSession?.workdir || state.runtime?.defaults?.workdir,
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

async function updateScheduleDefaultsSettings(patch) {
  const updated = await requestJson("/api/schedule-defaults", {
    method: "POST",
    body: JSON.stringify(patch),
  });

  state.scheduleDefaults = updated;
  renderSessions();
  renderActiveSession();
  renderScheduleView();
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

  state.activeSessionId = VIRTUAL_SCHEDULE_SESSION_ID;
  renderSessions();
  renderActiveSession();
  renderScheduleView();
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
    const restored = await requestJson(`/api/sessions/${session.id}/restore`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    upsertSession(restored.session);
    state.eventsBySession.set(session.id, restored.events || []);
    renderSessions();
    renderActiveSession();
    subscribeEvents();
    if (restored.recovered) {
      showComposerFeedback("Recovered a stale session state and reloaded the timeline.");
    }
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

  const result = await requestJson(`/api/sessions/${session.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, attachments }),
  });

  messageInput.value = "";
  clearPendingAttachments();
  showComposerFeedback(formatQueueNotice(result.queue?.turnsAhead));
  await syncSessions(session.id);
}

async function openDeveloperConsole() {
  const result = await requestJson("/api/developer/codex-console/open", {
    method: "POST",
  });

  showComposerFeedback(result.message || "Developer console opened.");
}

async function bindChannel(channel) {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  const updated = await requestJson(`/api/sessions/${session.id}/discord-bind`, {
    method: "POST",
    body: JSON.stringify({
      channelId: channel?.id || null,
      channelName: channel?.name || null,
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
      Promise.all([syncScheduleDefaults(), syncSessions(), syncSchedules()]).catch((error) => {
        console.error(error);
      });
    }
  });

  eventStream.addEventListener("session.created", async (event) => {
    const session = JSON.parse(event.data);
    upsertSession(session);
    renderSessions();
    renderScheduleView();
    if (!state.activeSessionId) {
      await setActiveSession(session.id);
    }
  });

  eventStream.addEventListener("session.updated", (event) => {
    const session = JSON.parse(event.data);
    upsertSession(session);
    renderSessions();
    renderScheduleView();
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
      const nextSessionId = state.sessions[0]?.id || VIRTUAL_SCHEDULE_SESSION_ID;
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
    renderScheduleView();
  });

  eventStream.addEventListener("message.created", (event) => {
    const payload = JSON.parse(event.data);
    pushEvent(payload);
    if (isCountedUserPromptEvent(payload) && incrementSessionPromptCount(payload.sessionId)) {
      renderSessions();
    }
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

  eventStream.addEventListener("schedule.changed", (event) => {
    const payload = JSON.parse(event.data);
    state.schedules = Array.isArray(payload?.schedules) ? payload.schedules.map(normalizeSchedule) : [];
    sortSchedules();
    renderSessions();
    renderScheduleView();
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
    Promise.all([syncScheduleDefaults(), syncSessions(), syncSchedules()]).catch((error) => {
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
  attachmentInput.value = "";
  addPendingAttachments(nextFiles);
});

enterSendToggleButton.addEventListener("click", () => {
  state.enterSendMode = !state.enterSendMode;
  persistEnterSendModePreference(state.enterSendMode);
  renderEnterSendToggle();
  showComposerFeedback(
    state.enterSendMode
      ? "Enter Send mode is on. Press Shift+Enter to insert a new line."
      : "Enter Send mode is off. Enter now inserts a new line.",
  );
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

messageInput.addEventListener("paste", (event) => {
  const clipboardFiles = getClipboardFiles(event.clipboardData);
  if (clipboardFiles.length === 0) {
    return;
  }

  event.preventDefault();
  addPendingAttachments(clipboardFiles);
});

messageInput.addEventListener("compositionstart", () => {
  messageInputIsComposing = true;
});

messageInput.addEventListener("compositionend", () => {
  messageInputIsComposing = false;
});

messageInput.addEventListener("keydown", async (event) => {
  if (!shouldSendOnEnter(event)) {
    return;
  }

  event.preventDefault();

  try {
    await sendMessage();
  } catch (error) {
    alert(error.message);
  }
});

messageForm.addEventListener("dragenter", (event) => {
  if (!dataTransferHasFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  composerDragDepth += 1;
  setComposerDragState(true);
});

messageForm.addEventListener("dragover", (event) => {
  if (!dataTransferHasFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  setComposerDragState(true);
});

messageForm.addEventListener("dragleave", (event) => {
  if (!dataTransferHasFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  composerDragDepth = Math.max(0, composerDragDepth - 1);

  if (composerDragDepth === 0 || !messageForm.contains(event.relatedTarget)) {
    resetComposerDragState();
  }
});

messageForm.addEventListener("drop", (event) => {
  if (!dataTransferHasFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  const droppedFiles = [...(event.dataTransfer.files || [])];
  resetComposerDragState();
  addPendingAttachments(droppedFiles);
});

messageForm.addEventListener("dragend", () => {
  resetComposerDragState();
});

newSessionButton.addEventListener("click", async () => {
  try {
    await createSession();
  } catch (error) {
    alert(error.message);
  }
});

showChatButton.addEventListener("click", () => {
  setAppView("chat");
});

showSchedulesButton.addEventListener("click", () => {
  setAppView("schedules");
  renderScheduleView();
});

showSettingsButton.addEventListener("click", () => {
  setAppView("settings");
});

scheduleCronInput?.addEventListener("input", () => {
  updateCreateCronPresetSelection();
  scheduleCreateCronDescriptionUpdate();
});

scheduleCronPresets?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-cron-preset-button]");
  if (!button || !scheduleCronInput) {
    return;
  }

  scheduleCronInput.value = String(button.dataset.cronPresetValue || "").trim();
  updateCreateCronPresetSelection();
  scheduleCreateCronDescriptionUpdate({ immediate: true });
  scheduleCronInput.focus();
});

scheduleForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const target = getCurrentScheduleTarget();
    if (!target) {
      alert("Select a session card or the 未設定スケジュール card first.");
      return;
    }

    await createSchedule({
      name: scheduleNameInput.value.trim(),
      cron: scheduleCronInput.value.trim(),
      target,
      timezone: scheduleTimezoneInput.value.trim() || DEFAULT_SCHEDULE_TIMEZONE,
      prompt: schedulePromptInput.value.trim(),
      active: true,
    });
    resetScheduleForm();
    setAppView("schedules");
  } catch (error) {
    alert(error.message);
  }
});

scheduleList.addEventListener("click", async (event) => {
  const activeToggleButton = event.target.closest('[data-field="active-toggle"]');
  if (activeToggleButton) {
    const currentActive = String(activeToggleButton.dataset.active || "true").trim() !== "false";
    const nextActive = !currentActive;
    activeToggleButton.dataset.active = nextActive ? "true" : "false";
    activeToggleButton.setAttribute("aria-pressed", nextActive ? "true" : "false");
    activeToggleButton.classList.toggle("active", nextActive);
    activeToggleButton.textContent = nextActive ? "稼働中" : "停止中";
    return;
  }

  const presetButton = event.target.closest("[data-cron-preset-button]");
  if (presetButton) {
    const card = presetButton.closest("[data-schedule-name]");
    const cronInput = card?.querySelector('[data-field="cron"]');
    const presetPanel = presetButton.closest(".cron-presets-panel");
    if (cronInput && presetPanel) {
      cronInput.value = String(presetButton.dataset.cronPresetValue || "").trim();
      refreshCronPresetButtons(presetPanel, cronInput.value);
      scheduleCardCronDescriptionUpdate(card, { immediate: true });
      cronInput.focus();
    }
    return;
  }

  const button = event.target.closest("[data-schedule-action]");
  if (!button) {
    return;
  }

  const card = button.closest("[data-schedule-name]");
  const name = card?.getAttribute("data-schedule-name");
  if (!card || !name) {
    return;
  }

  try {
    if (button.dataset.scheduleAction === "save") {
      await updateSchedule(name, readScheduleCardPayload(card));
      return;
    }

    if (button.dataset.scheduleAction === "toggle") {
      const current = getCurrentSchedule(name);
      if (!current) {
        await syncSchedules();
        return;
      }

      await updateSchedule(name, {
        ...readScheduleCardPayload(card),
        active: !current.active,
      });
      return;
    }

    if (button.dataset.scheduleAction === "delete") {
      const confirmed = window.confirm(`Delete schedule "${name}"?`);
      if (!confirmed) {
        return;
      }

      await deleteSchedule(name);
    }
  } catch (error) {
    alert(error.message);
  }
});

scheduleList.addEventListener("input", (event) => {
  const input = event.target.closest('[data-field="cron"]');
  if (!input) {
    return;
  }

  const card = input.closest("[data-schedule-name]");
  const presetPanel = card?.querySelector(".cron-presets-panel");
  refreshCronPresetButtons(presetPanel, input.value);
  scheduleCardCronDescriptionUpdate(card);
});

sessionCard.addEventListener("click", async () => {
  try {
    if (!getCurrentSession() || isVirtualScheduleDefaultsSelected()) {
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
    if (!getCurrentSession() || isVirtualScheduleDefaultsSelected()) {
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

changeWorkdirButton.addEventListener("click", async () => {
  try {
    await openWorkdirPicker();
  } catch (error) {
    alert(error.message);
  }
});

browseWorkdirButton.addEventListener("click", async () => {
  try {
    await browseForWorkdir();
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
    if (isVirtualScheduleDefaultsSelected()) {
      await updateScheduleDefaultsSettings({ fastMode: true });
      return;
    }

    await updateSessionSettings({ fastMode: true });
  } catch (error) {
    alert(error.message);
  }
});

fastOffButton.addEventListener("click", async () => {
  try {
    if (isVirtualScheduleDefaultsSelected()) {
      await updateScheduleDefaultsSettings({ fastMode: false });
      return;
    }

    await updateSessionSettings({ fastMode: false });
  } catch (error) {
    alert(error.message);
  }
});

developerConsoleButton.addEventListener("click", async () => {
  try {
    await openDeveloperConsole();
  } catch (error) {
    alert(error.message);
  }
});

async function bootstrapApp() {
  const didRedirectForDesktopReset = await resetDesktopServiceWorkerState();
  if (didRedirectForDesktopReset) {
    return;
  }

  await Promise.all([loadRuntime(), loadScheduleDefaults(), loadSessions(), loadSchedules()]);
  setAppView(state.activeView);
  resetScheduleForm();
  renderSessions();
  renderActiveSession();
  renderScheduleView();
  subscribeEvents();
  startBackgroundSync();
}

bootstrapApp().catch((error) => {
  console.error(error);
  alert(error.message);
});

window.addEventListener("focus", () => {
  Promise.all([syncScheduleDefaults(), syncSessions(), syncSchedules()]).catch((error) => {
    console.error(error);
  });
});

if ("serviceWorker" in navigator && !IS_DESKTOP_APP) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(UI_BUILD_VERSION)}`)
      .then(async (registration) => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations
            .filter((entry) => entry.scope === registration.scope && entry !== registration)
            .map((entry) => entry.unregister()),
        );
        await registration.update().catch(() => null);
      })
      .catch((error) => {
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
