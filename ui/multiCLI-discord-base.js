/**
 * multiCLI-discord-base フロントエンド
 *
 * - SSE /api/stream で CanonicalEvent を受信
 * - REST /api/agents/* でエージェント操作
 * - LINE風チャット UI
 */

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  agents: [],
  selectedAgent: null,
  workspaceId: null,
  workspaces: [],
  workspaceAgents: new Map(),
  workspaceTerminalStates: new Map(),
  workspaceTerminalStateLoaded: new Set(),
  workspaceTerminalStatePending: new Set(),
  discordChannels: [],
  activeTab: "chat",
  bootReady: false,
  runtimeInfo: null,
  runtimeInfoPromise: null,
  expandedSessions: new Set(),
  childAgentMenu: null,
  settingsScope: "global",
  settingsWorkspaceId: null,
  settingsAgentName: null,
  settingsAgentMeta: null,
  // agentName → [message objects]
  chatLogs: new Map(),
  // agentName → { toolId → toolCardEl }
  toolCards: new Map(),
  // agentName → typing indicator el
  typingEls: new Map(),
  // agentName → typing timer id
  typingTimers: new Map(),
  // agentName → accumulated delta text (for streaming)
  deltaBuffers: new Map(),
  // agentName → current delta bubble el
  deltaBubbles: new Map(),
  // workspaceId:agentName → fallback history sync timer
  messageCatchups: new Map(),
  sidebarDrag: null,
  sidebarPendingRender: false,
  activeBootstrapSignature: "",
  activeBootstrapPromise: null,
  pendingActiveBootstrapSignature: "",
  settingsRollbackPreview: null,
  settingsWorkspaceProfile: null,
  settingsReviewSnapshot: null,
  settingsWorktreeStatus: null,
  settingsLockConflict: null,
  settingsExtensionsOverview: null,
  settingsMemoryAutomationPreview: null,
  settingsSkillPlan: null,
  settingsMcpPlan: null,
};

const MAX_ACTIVE_WORKSPACES = 5;

// ── DOM refs ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const agentListEl = $("agent-list");
const sessionSidebarEl = $("session-sidebar");
const chatLogEl = $("chat-log");
const chatInputEl = $("chat-input");
const chatRouteHintEl = $("chat-route-hint");
const chatFileViewerEl = $("chat-file-viewer");
const chatFileViewerPathEl = $("chat-file-viewer-path");
const chatFileViewerMetaEl = $("chat-file-viewer-meta");
const chatFileViewerContentEl = $("chat-file-viewer-content");
const chatFileViewerOpenEl = $("chat-file-viewer-open");
const btnChatFileViewerCloseEl = $("btn-chat-file-viewer-close");
const btnSendEl = $("btn-send");
const selectedAgentSummaryWrapEl = $("selected-agent-summary");
const selectedAgentNameEl = $("selected-agent-name");
const selectedAgentStatusEl = $("selected-agent-status");
const workspaceSelectEl = $("workspace-select");
const btnWorkspaceAdd = $("btn-workspace-add");
const btnWorkspaceDel = $("btn-workspace-del");
const btnStopAll = $("btn-stop-all");
const terminalShellEl = $("terminal-shell");
const terminalContainerEl = $("terminal-container");
const terminalFallbackEl = $("terminal-fallback-output");
const terminalLayoutEl = $("terminal-layout");
const terminalSessionPaneEl = $("terminal-session-pane");
const terminalSessionCountEl = $("terminal-session-count");
const terminalSessionHintEl = $("terminal-session-hint");
const terminalSessionListEl = $("terminal-session-list");
const terminalToolbarEl = $("terminal-toolbar");
const terminalAgentLabel = $("terminal-agent-label");
const terminalWorkspaceLabelEl = $("terminal-workspace-label");
const terminalStatusBadgeEl = $("terminal-status-badge");
const terminalSharedHintEl = $("terminal-shared-hint");
const terminalConfigWarningEl = $("terminal-config-warning");
const terminalApprovalBannerEl = $("terminal-approval-banner");
const terminalApprovalTextEl = $("terminal-approval-text");
const btnTerminalApproveEl = $("btn-terminal-approve");
const btnTerminalDenyEl = $("btn-terminal-deny");
const btnTerminalKill = $("btn-terminal-kill");
const btnTerminalReconnectEl = $("btn-terminal-reconnect");
const btnTerminalLayoutSideEl = $("btn-terminal-layout-side");
const btnTerminalLayoutBottomEl = $("btn-terminal-layout-bottom");
const btnTerminalClearEl = $("btn-terminal-clear");
const btnTerminalCopyEl = $("btn-terminal-copy");
const btnTerminalPasteEl = $("btn-terminal-paste");
const btnTerminalSearchEl = $("btn-terminal-search");
const terminalSearchBarEl = $("terminal-search-bar");
const terminalSearchInputEl = $("terminal-search-input");
const terminalSearchCountEl = $("terminal-search-count");
const terminalSearchCaseEl = $("terminal-search-case");
const terminalSearchWordEl = $("terminal-search-word");
const terminalSearchRegexEl = $("terminal-search-regex");
const btnTerminalSearchPrevEl = $("btn-terminal-search-prev");
const btnTerminalSearchNextEl = $("btn-terminal-search-next");
const btnTerminalSearchCloseEl = $("btn-terminal-search-close");
const terminalMarkerPaneEl = $("terminal-marker-pane");
const terminalMarkerCountEl = $("terminal-marker-count");
const terminalMarkerSummaryEl = $("terminal-marker-summary");
const terminalMarkerOverviewEl = $("terminal-marker-overview");
const terminalMarkerListEl = $("terminal-marker-list");
const btnTerminalMarkerPrevEl = $("btn-terminal-marker-prev");
const btnTerminalMarkerNextEl = $("btn-terminal-marker-next");
const terminalInputEl = $("terminal-input");
const btnTerminalSendEl = $("btn-terminal-send");
const toastContainerEl = $("toast-container");
const settingsWorkdirEl = $("settings-workdir");
const btnSaveWorkdirEl = $("btn-save-workdir");
const globalMemoryInputEl = $("global-memory-input");
const btnSaveGlobalMemoryEl = $("btn-save-global-memory");
const btnSettingsGlobalEl = $("btn-settings-global");
const btnSettingsSessionEl = $("btn-settings-session");
const btnSettingsAgentEl = $("btn-settings-agent");
const settingsContextChipEl = $("settings-context-chip");
const globalSettingsSectionEl = $("global-settings-section");
const sessionCreatePanelEl = $("session-create-panel");
const sessionCreateNameEl = $("session-create-name");
const sessionCreateParentAgentEl = $("session-create-parent-agent");
const sessionCreateWorkdirEl = $("session-create-workdir");
const btnSessionCreateSaveEl = $("btn-session-create-save");
const sessionSettingsSectionEl = $("session-settings-section");
const sessionSettingsTitleEl = $("session-settings-title");
const sessionNameInputEl = $("session-name-input");
const sessionWorkdirInputEl = $("session-workdir-input");
const sessionParentAgentEl = $("session-parent-agent");
const sessionDiscordChannelEl = $("session-discord-channel");
const sessionContextModeEl = $("session-context-mode");
const sessionContextHintEl = $("session-context-hint");
const sessionMemoryInputEl = $("session-memory-input");
const btnSessionDurabilityRefreshEl = $("btn-session-durability-refresh");
const sessionDurabilityHintEl = $("session-durability-hint");
const sessionResumeBindingsEl = $("session-resume-bindings");
const sessionOperationAuditsEl = $("session-operation-audits");
const sessionCheckpointLabelEl = $("session-checkpoint-label");
const btnSessionCheckpointCreateEl = $("btn-session-checkpoint-create");
const sessionCheckpointsEl = $("session-checkpoints");
const sessionRollbackPreviewEl = $("session-rollback-preview");
const sessionCoordinationHintEl = $("session-coordination-hint");
const sessionCoordinationSummaryEl = $("session-coordination-summary");
const sessionClaimAgentEl = $("session-claim-agent");
const sessionClaimTaskEl = $("session-claim-task");
const btnSessionClaimEl = $("btn-session-claim");
const sessionHandoffFromEl = $("session-handoff-from");
const sessionHandoffToEl = $("session-handoff-to");
const sessionHandoffTaskEl = $("session-handoff-task");
const btnSessionHandoffEl = $("btn-session-handoff");
const sessionClaimsPanelEl = $("session-claims-panel");
const sessionHandoffsPanelEl = $("session-handoffs-panel");
const sessionProfileHintEl = $("session-profile-hint");
const sessionProfileModeEl = $("session-profile-mode");
const sessionProfilePersonaEl = $("session-profile-persona");
const sessionProfileAutonomyEl = $("session-profile-autonomy");
const sessionProfileNotesEl = $("session-profile-notes");
const btnSessionProfileSaveEl = $("btn-session-profile-save");
const btnSessionReviewRefreshEl = $("btn-session-review-refresh");
const sessionReviewHintEl = $("session-review-hint");
const sessionReviewSummaryEl = $("session-review-summary");
const sessionReviewChangesEl = $("session-review-changes");
const sessionWorktreePanelEl = $("session-worktree-panel");
const sessionLockAgentEl = $("session-lock-agent");
const sessionLockFileEl = $("session-lock-file");
const sessionLockSymbolEl = $("session-lock-symbol");
const btnSessionLockClaimEl = $("btn-session-lock-claim");
const sessionLockConflictEl = $("session-lock-conflict");
const sessionLocksPanelEl = $("session-locks-panel");
const btnSessionAutomationRefreshEl = $("btn-session-automation-refresh");
const sessionAutomationHintEl = $("session-automation-hint");
const sessionExtensionDashboardPanelEl = $("session-extension-dashboard-panel");
const sessionTaskBoardPanelEl = $("session-task-board-panel");
const sessionValidationPanelEl = $("session-validation-panel");
const sessionDriftPanelEl = $("session-drift-panel");
const sessionMemoryAutomationPanelEl = $("session-memory-automation-panel");
const sessionMemoryAutomationPreviewEl = $("session-memory-automation-preview");
const sessionSkillsPanelEl = $("session-skills-panel");
const sessionMcpPanelEl = $("session-mcp-panel");
const btnSaveSessionMemoryEl = $("btn-save-session-memory");
const btnSessionSaveEl = $("btn-session-save");
const btnSessionDeleteEl = $("btn-session-delete");
const agentSettingsSectionEl = $("agent-settings-section");
const agentSettingsTitleEl = $("agent-settings-title");
const agentSettingsNoteEl = $("agent-settings-note");
const agentNameInputEl = $("agent-name-input");
const agentTypeDisplayLabelEl = $("agent-type-display-label");
const agentTypeDisplayEl = $("agent-type-display");
const agentModelInputEl = $("agent-model-input");
const agentModelControlsEl = $("agent-model-controls");
const agentModelDetailInputEl = $("agent-model-detail-input");
const agentModelHintEl = $("agent-model-hint");
const agentWorkdirInputEl = $("agent-workdir-input");
const agentReasoningInputLabelEl = $("agent-reasoning-input-label");
const agentReasoningInputEl = $("agent-reasoning-input");
const agentFastModeInputLabelEl = $("agent-fast-mode-input-label");
const agentFastModeInputEl = $("agent-fast-mode-input");
const agentPlanModeLabelEl = $("agent-plan-mode-label");
const agentPlanModeControlsEl = $("agent-plan-mode-controls");
const agentPlanModeInputEl = $("agent-plan-mode-input");
const agentPlanModeHintEl = $("agent-plan-mode-hint");
const agentInstructionsInputEl = $("agent-instructions-input");
const agentMemoryInputEl = $("agent-memory-input");
const btnSaveAgentMemoryEl = $("btn-save-agent-memory");
const btnAgentSaveEl = $("btn-agent-save");
const btnAgentDeleteEl = $("btn-agent-delete");
const agentsListEl = $("agents-list");
const agentsCreateNameEl = $("agents-create-name");
const agentsCreateTypeEl = $("agents-create-type");
const agentsCreateModelEl = $("agents-create-model");
const agentsCreateModelControlsEl = $("agents-create-model-controls");
const agentsCreateModelDetailEl = $("agents-create-model-detail");
const agentsCreateModelHintEl = $("agents-create-model-hint");
const agentsCreateWorkdirEl = $("agents-create-workdir");
const agentsCreateReasoningLabelEl = $("agents-create-reasoning-label");
const agentsCreateReasoningEl = $("agents-create-reasoning");
const agentsCreateFastModeLabelEl = $("agents-create-fast-mode-label");
const agentsCreateFastModeEl = $("agents-create-fast-mode");
const agentsCreatePlanModeLabelEl = $("agents-create-plan-mode-label");
const agentsCreatePlanModeControlsEl = $("agents-create-plan-mode-controls");
const agentsCreatePlanModeEl = $("agents-create-plan-mode");
const agentsCreatePlanModeHintEl = $("agents-create-plan-mode-hint");
const agentsCreateInstructionsEl = $("agents-create-instructions");
const btnAgentCreateEl = $("btn-agent-create");

if (btnSendEl) {
  btnSendEl.disabled = true;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const AGENT_THEME_PRESETS = Object.freeze({
  gemini: Object.freeze({
    accent: "#1a73e8",
    soft: "#e8f0fe",
    border: "#a8c7fa",
    ink: "#174ea6",
    bubble: "#ffffff",
    glow: "rgba(26, 115, 232, 0.18)",
    terminalTint: "rgba(26, 115, 232, 0.2)",
  }),
  claude: Object.freeze({
    accent: "#d97706",
    soft: "#fff1e6",
    border: "#f6c28b",
    ink: "#9a4f06",
    bubble: "#fffdf8",
    glow: "rgba(217, 119, 6, 0.18)",
    terminalTint: "rgba(217, 119, 6, 0.22)",
  }),
  codex: Object.freeze({
    accent: "#10b981",
    soft: "#e7fff7",
    border: "#8ee7cd",
    ink: "#047857",
    bubble: "#f8fffd",
    glow: "rgba(16, 185, 129, 0.18)",
    terminalTint: "rgba(16, 185, 129, 0.2)",
  }),
  copilot: Object.freeze({
    accent: "#7c3aed",
    soft: "#f3edff",
    border: "#c4b5fd",
    ink: "#5b21b6",
    bubble: "#fcfaff",
    glow: "rgba(124, 58, 237, 0.18)",
    terminalTint: "rgba(124, 58, 237, 0.22)",
  }),
  fallback: Object.freeze({
    accent: "#3b82f6",
    soft: "#eaf2ff",
    border: "#93c5fd",
    ink: "#1d4ed8",
    bubble: "#ffffff",
    glow: "rgba(59, 130, 246, 0.18)",
    terminalTint: "rgba(59, 130, 246, 0.2)",
  }),
});

const TERMINAL_UI_POLICY = Object.freeze({
  layout: false,
  search: false,
  clipboard: false,
  clear: false,
  markers: false,
});

const AGENT_TYPE_OPTIONS = Object.freeze([
  { value: "claude", label: "claude" },
  { value: "gemini", label: "gemini" },
  { value: "copilot", label: "copilot" },
  { value: "codex", label: "codex" },
]);

const AGENT_MODEL_MENU_PRESETS = Object.freeze({
  claude: Object.freeze([
    { value: "", label: "Default (recommended)", description: "Claude Code の既定モデルを使います" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6", description: "既定モデルを明示的に固定します" },
    { value: "opus", label: "Opus", description: "最も高性能な長考向けです" },
    { value: "haiku", label: "Haiku", description: "最速寄りの軽量モデルです" },
    { value: "claude-sonnet-4-5", label: "Sonnet 4.5", description: "旧互換モデルです" },
    { value: "claude-opus-4", label: "Opus 4", description: "旧互換モデルです" },
    { value: "claude-haiku-3-5", label: "Haiku 3.5", description: "旧互換モデルです" },
  ]),
  gemini: Object.freeze({
    primary: Object.freeze([
      { value: "", label: "Auto (Gemini 3)", description: "Gemini 3 系の auto 選択を使います" },
      { value: "gemini-2.5", label: "Auto (Gemini 2.5)", description: "Gemini 2.5 系の auto 選択を使います" },
      { value: "manual", label: "Manual", description: "個別モデルを直接選びます" },
    ]),
    manual: Object.freeze([
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", description: "最新 preview の高性能モデルです" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", description: "最新 preview の高速モデルです" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", description: "高品質寄りの長考向けです" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", description: "高速寄りの既定候補です" },
      { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", description: "軽量な lite 系モデルです" },
      { value: "gemini-2.5-flash-lite-preview", label: "Gemini 2.5 Flash Lite Preview", description: "軽量な preview 系です" },
      { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash", description: "旧互換用の fallback です" },
    ]),
  }),
  copilot: Object.freeze([
    { value: "", label: "Default (recommended)", description: "Copilot CLI の既定モデルを使います" },
    { value: "gpt-5.4", label: "GPT-5.4", description: "標準の高品質モデルです" },
    { value: "gpt-5.3-codex", label: "GPT-5.3-Codex", description: "コーディング特化寄りです" },
    { value: "gpt-5.2-codex", label: "GPT-5.2-Codex", description: "旧 codex 系の互換候補です" },
    { value: "gpt-5.2", label: "GPT-5.2", description: "安定寄りの標準モデルです" },
    { value: "gpt-5.1", label: "GPT-5.1", description: "旧互換モデルです" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 mini", description: "高速・低コストです" },
    { value: "gpt-5-mini", label: "GPT-5 mini", description: "高速・低コストです" },
    { value: "gpt-4.1", label: "GPT-4.1", description: "高速寄りの fallback です" },
    { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", description: "標準クラスです" },
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", description: "標準クラスです" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5", description: "高速・低コストです" },
    { value: "claude-opus-4.6", label: "Claude Opus 4.6", description: "最も高性能です" },
    { value: "claude-opus-4.5", label: "Claude Opus 4.5", description: "最も高性能です" },
    { value: "claude-sonnet-4", label: "Claude Sonnet 4", description: "旧互換モデルです" },
  ]),
});

const CODEX_MODEL_FALLBACKS = Object.freeze([
  { value: "gpt-5.4", label: "GPT-5.4", description: "標準の高品質モデルです" },
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex", description: "コーディング特化寄りです" },
  { value: "gpt-5.2-codex", label: "GPT-5.2-Codex", description: "旧 codex 系の互換候補です" },
  { value: "gpt-5.2", label: "GPT-5.2", description: "安定寄りの標準モデルです" },
  { value: "gpt-5.1", label: "GPT-5.1", description: "旧互換モデルです" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini", description: "高速・低コストです" },
  { value: "gpt-5-mini", label: "GPT-5 mini", description: "高速・低コストです" },
  { value: "gpt-4.1", label: "GPT-4.1", description: "高速寄りの fallback です" },
]);

const AGENT_REASONING_PRESETS = Object.freeze({
  claude: Object.freeze([
    { value: "", label: "Default (recommended)", description: "Claude Code の既定 effort を使います" },
    { value: "low", label: "Low", description: "速さ優先です" },
    { value: "medium", label: "Medium", description: "標準バランスです" },
    { value: "high", label: "High", description: "精度重視です" },
    { value: "max", label: "Max", description: "最も深く考えます" },
  ]),
  copilot: Object.freeze([
    { value: "", label: "Default (recommended)", description: "Copilot CLI の既定 effort を使います" },
    { value: "low", label: "Low", description: "速さ優先です" },
    { value: "medium", label: "Medium", description: "標準バランスです" },
    { value: "high", label: "High", description: "精度重視です" },
    { value: "xhigh", label: "Extra high", description: "最も深く考えます" },
  ]),
});

const AGENT_PLAN_MODE_PRESETS = Object.freeze({
  claude: Object.freeze([
    { value: "", label: "Off", description: "通常の対話モードです" },
    { value: "plan", label: "/plan", description: "Plan mode に切り替えます" },
    { value: "ultraplan", label: "/ultraplan", description: "より深い計画モード向けです" },
    { value: "batch", label: "/batch", description: "まとめ実行寄りの補助モードです" },
  ]),
  codex: Object.freeze([
    { value: "", label: "Off", description: "通常の対話モードです" },
    { value: "plan", label: "/plan", description: "Plan mode に切り替える想定です" },
  ]),
});

function terminalFeatureEnabled(feature) {
  return Boolean(TERMINAL_UI_POLICY[feature]);
}

function setElementHidden(el, hidden) {
  if (el) {
    el.hidden = Boolean(hidden);
  }
}

function normalizeSelectOption(rawOption) {
  if (typeof rawOption === "string") {
    const normalized = rawOption.trim();
    return normalized ? { value: normalized, label: normalized, description: "" } : null;
  }
  if (!rawOption || typeof rawOption !== "object") {
    return null;
  }
  const hasValue = Object.prototype.hasOwnProperty.call(rawOption, "value");
  const value = hasValue ? String(rawOption.value ?? "").trim() : "";
  const label = String(rawOption.label ?? value).trim();
  const description = String(rawOption.description ?? "").trim();
  if (!label) return null;
  return { value, label, description };
}

function buildSelectOptions(values = [], { includeDefaultLabel = null, currentValue = "" } = {}) {
  const seen = new Set();
  const options = [];
  const pushOption = (rawOption) => {
    const option = normalizeSelectOption(rawOption);
    if (!option || seen.has(option.value)) return;
    seen.add(option.value);
    options.push(option);
  };
  if (includeDefaultLabel != null) {
    if (typeof includeDefaultLabel === "string") {
      pushOption({ value: "", label: includeDefaultLabel });
    } else {
      pushOption({ value: "", ...includeDefaultLabel });
    }
  }
  for (const value of values) {
    pushOption(value);
  }
  const normalizedCurrent = String(currentValue ?? "").trim();
  if (normalizedCurrent && !seen.has(normalizedCurrent)) {
    options.push({
      value: normalizedCurrent,
      label: `${normalizedCurrent} (current)`,
      description: "現在保存されている値です",
    });
  }
  return options;
}

function populateSelectOptions(selectEl, options = [], selectedValue = "") {
  if (!selectEl) return;
  const normalizedSelected = String(selectedValue ?? "").trim();
  selectEl.innerHTML = "";
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    if (option.description) {
      opt.dataset.description = option.description;
    }
    if (option.value === normalizedSelected) {
      opt.selected = true;
    }
    selectEl.appendChild(opt);
  }
  if (!options.some((option) => option.value === normalizedSelected)) {
    selectEl.value = options[0]?.value ?? "";
  }
}

function findOptionByValue(options = [], value = "") {
  const normalizedValue = String(value ?? "").trim();
  return options.find((option) => option.value === normalizedValue) || null;
}

function setInlineHint(el, text = "") {
  if (!el) return;
  const normalizedText = String(text ?? "").trim();
  el.textContent = normalizedText;
  el.hidden = !normalizedText;
}

function shortenRef(value = "", maxLength = 18) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function summarizeAuditDetails(details = {}) {
  const normalized = details && typeof details === "object" ? details : {};
  const parts = [];
  if (Array.isArray(normalized.blockedReasons) && normalized.blockedReasons.length > 0) {
    parts.push(`blocked: ${normalized.blockedReasons.join(" / ")}`);
  }
  if (normalized.state?.status) {
    parts.push(`state=${normalized.state.status}`);
  }
  if (Number.isFinite(Number(normalized.dirtyCount))) {
    parts.push(`dirty=${Number(normalized.dirtyCount)}`);
  }
  if (normalized.currentHeadSha) {
    parts.push(`head=${shortenRef(normalized.currentHeadSha, 12)}`);
  }
  if (normalized.checkpointId) {
    parts.push(`checkpoint=${shortenRef(normalized.checkpointId, 12)}`);
  }
  if (normalized.backupPath) {
    parts.push(`backup=${shortenRef(normalized.backupPath, 32)}`);
  }
  if (normalized.diaryPath) {
    parts.push(`diary=${shortenRef(normalized.diaryPath, 32)}`);
  }
  if (Number.isFinite(Number(normalized.appliedCount))) {
    parts.push(`applied=${Number(normalized.appliedCount)}`);
  }
  if (Number.isFinite(Number(normalized.tokenEstimate))) {
    parts.push(`tokens≈${Number(normalized.tokenEstimate)}`);
  }
  if (typeof normalized.force === "boolean") {
    parts.push(normalized.force ? "force" : "normal");
  }
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  const raw = JSON.stringify(normalized);
  return raw && raw !== "{}" ? shortenRef(raw, 120) : "";
}

function renderSessionResumeBindings(bindings = []) {
  if (!sessionResumeBindingsEl) return;
  if (!Array.isArray(bindings) || bindings.length === 0) {
    sessionResumeBindingsEl.innerHTML = `
      <div class="settings-inspector-title">Resume bindings</div>
      <p class="settings-inspector-empty">保存済み resume binding はまだありません。</p>
    `;
    return;
  }

  const rows = bindings.map((entry) => {
    const metaParts = [
      `state=${entry.lastRunState || "-"}`,
      `updated=${entry.updatedAt ? formatSettingsDateTime(entry.updatedAt) : "-"}`,
    ];
    if (entry.model) metaParts.push(`model=${entry.model}`);
    if (entry.workdir) metaParts.push(`workdir=${entry.workdir}`);
    const reasons = Array.isArray(entry.reasons) ? entry.reasons.filter(Boolean) : [];
    return `
      <tr>
        <td>
          <strong>${escHtml(entry.agentName || "-")}</strong>
          <div class="settings-binding-meta">${escHtml(metaParts.join(" · "))}</div>
          ${reasons.length > 0 ? `<div class="settings-binding-reasons">${escHtml(reasons.join(" / "))}</div>` : ""}
        </td>
        <td>
          <div><code title="${escHtml(entry.providerSessionRef || "")}">${escHtml(shortenRef(entry.providerSessionRef || "none", 28))}</code></div>
          <div class="settings-binding-meta">binding=${escHtml(entry.bindingStatus || "unknown")}</div>
          <div class="settings-row-actions">
            <button
              type="button"
              class="btn-outline"
              data-session-resume-agent="${escHtml(entry.agentName || "")}"
              ${entry.bindingStatus !== "valid" ? "disabled" : ""}
            >resume</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  sessionResumeBindingsEl.innerHTML = `
    <div class="settings-inspector-title">Resume bindings</div>
    <table class="settings-table"><tbody>${rows}</tbody></table>
  `;
}

function renderSessionOperationAudits(audits = []) {
  if (!sessionOperationAuditsEl) return;
  if (!Array.isArray(audits) || audits.length === 0) {
    sessionOperationAuditsEl.innerHTML = `
      <div class="settings-inspector-title">Recent operation audit</div>
      <p class="settings-inspector-empty">operation audit はまだありません。</p>
    `;
    return;
  }

  const rows = audits.map((entry) => {
    const meta = [
      entry.createdAt ? formatSettingsDateTime(entry.createdAt) : "-",
      entry.agentName || "workspace",
      entry.status || "-",
      entry.source || "-",
    ].join(" · ");
    const detailSummary = summarizeAuditDetails(entry.details);
    const targetRef = entry.targetRef ? `<div class="settings-audit-meta">target=${escHtml(entry.targetRef)}</div>` : "";
    return `
      <tr>
        <td>
          <strong>${escHtml(entry.operationType || "-")}</strong>
          <div class="settings-audit-meta">${escHtml(meta)}</div>
        </td>
        <td>
          ${detailSummary ? `<div>${escHtml(detailSummary)}</div>` : `<div class="settings-inspector-empty">details なし</div>`}
          ${targetRef}
        </td>
      </tr>
    `;
  }).join("");

  sessionOperationAuditsEl.innerHTML = `
    <div class="settings-inspector-title">Recent operation audit</div>
    <table class="settings-table"><tbody>${rows}</tbody></table>
  `;
}

async function loadSessionDurability(workspaceId) {
  if (!workspaceId) return;
  try {
    const [bindingsRes, auditsRes] = await Promise.all([
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/bindings`),
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/audits?limit=8`),
    ]);
    const bindings = bindingsRes.ok ? await bindingsRes.json() : [];
    const audits = auditsRes.ok ? await auditsRes.json() : [];
    renderSessionResumeBindings(bindings);
    renderSessionOperationAudits(audits);
    setInlineHint(
      sessionDurabilityHintEl,
      `resume binding ${Array.isArray(bindings) ? bindings.length : 0} 件 / audit ${Array.isArray(audits) ? audits.length : 0} 件`,
    );
  } catch {
    renderSessionResumeBindings([]);
    renderSessionOperationAudits([]);
    setInlineHint(sessionDurabilityHintEl, "durability 情報の取得に失敗しました。");
  }
}

function populateWorkspaceMemberSelect(selectEl, workspaceId, { includeBlank = false, preferredValue = "" } = {}) {
  if (!selectEl) return;
  const members = getWorkspaceAgents(workspaceId);
  const currentValue = preferredValue || selectEl.value;
  selectEl.innerHTML = "";
  if (includeBlank) {
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "未設定";
    selectEl.appendChild(blank);
  }
  for (const member of members) {
    const option = document.createElement("option");
    option.value = member.agentName;
    option.textContent = member.isParent ? `${member.agentName} (parent)` : member.agentName;
    selectEl.appendChild(option);
  }
  if ([...selectEl.options].some((option) => option.value === currentValue)) {
    selectEl.value = currentValue;
  } else if (selectEl.options.length > 0) {
    selectEl.selectedIndex = 0;
  }
}

function renderSessionCheckpoints(checkpoints = []) {
  if (!sessionCheckpointsEl) return;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    sessionCheckpointsEl.innerHTML = `
      <div class="settings-inspector-title">Checkpoints</div>
      <p class="settings-inspector-empty">checkpoint はまだありません。</p>
    `;
    return;
  }
  const rows = checkpoints.map((entry) => `
    <tr>
      <td>
        <strong>${escHtml(entry.label || entry.id)}</strong>
        <div class="settings-audit-meta">${escHtml(([
          entry.id,
          entry.kind || "manual",
          entry.createdAt ? formatSettingsDateTime(entry.createdAt) : "-",
        ]).join(" · "))}</div>
      </td>
      <td>
        <div>${escHtml(shortenRef(entry.gitHeadSha || "-", 20))}</div>
        <div class="settings-row-actions">
          <button type="button" class="btn-outline" data-checkpoint-preview="${escHtml(entry.id)}">preview</button>
        </div>
      </td>
    </tr>
  `).join("");
  sessionCheckpointsEl.innerHTML = `
    <div class="settings-inspector-title">Checkpoints</div>
    <table class="settings-table"><tbody>${rows}</tbody></table>
  `;
}

function renderSessionRollbackPreview(preview = null) {
  if (!sessionRollbackPreviewEl) return;
  state.settingsRollbackPreview = preview || null;
  if (!preview?.checkpoint) {
    sessionRollbackPreviewEl.innerHTML = `
      <div class="settings-inspector-title">Rollback preview</div>
      <p class="settings-inspector-empty">preview を選ぶと rollback 条件をここに表示します。</p>
    `;
    return;
  }
  const blockedReasons = Array.isArray(preview.blockedReasons) ? preview.blockedReasons.filter(Boolean) : [];
  sessionRollbackPreviewEl.innerHTML = `
    <div class="settings-inspector-title">Rollback preview</div>
    <table class="settings-table">
      <tbody>
        <tr><td>checkpoint</td><td><code>${escHtml(preview.checkpoint.id || "-")}</code></td></tr>
        <tr><td>label</td><td>${escHtml(preview.checkpoint.label || "-")}</td></tr>
        <tr><td>workdir</td><td>${escHtml(preview.current?.rootDir || preview.checkpoint.workdir || "-")}</td></tr>
        <tr><td>head</td><td><code>${escHtml(preview.checkpoint.gitHeadSha || "-")}</code></td></tr>
        <tr><td>dirtyCount</td><td>${escHtml(String(preview.current?.status?.dirtyCount ?? "-"))}</td></tr>
      </tbody>
    </table>
    ${blockedReasons.length > 0 ? `<div class="settings-warning-box">${escHtml(blockedReasons.join(" / "))}</div>` : ""}
    <div class="settings-inspector-actions">
      <button
        id="btn-session-rollback-apply"
        type="button"
        class="btn-settings-save"
        ${blockedReasons.length > 0 ? "disabled" : ""}
      >rollback apply</button>
    </div>
  `;
}

async function loadSessionGitSafety(workspaceId) {
  if (!workspaceId) return;
  try {
    const checkpointsRes = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/checkpoints?limit=12`);
    const checkpoints = checkpointsRes.ok ? await checkpointsRes.json() : [];
    renderSessionCheckpoints(checkpoints);
    if (state.settingsRollbackPreview?.checkpoint?.workspaceId === workspaceId) {
      renderSessionRollbackPreview(state.settingsRollbackPreview);
    } else {
      renderSessionRollbackPreview(null);
    }
  } catch {
    renderSessionCheckpoints([]);
    renderSessionRollbackPreview(null);
  }
}

function renderSessionCoordinationSummary(context = null) {
  if (!sessionCoordinationSummaryEl) return;
  const claims = Array.isArray(context?.claims) ? context.claims : [];
  const handoffs = Array.isArray(context?.handoffQueue) ? context.handoffQueue : [];
  sessionCoordinationSummaryEl.innerHTML = `
    <div class="settings-inspector-title">Current owner / task</div>
    <div class="settings-pill-row">
      <span class="settings-pill">owner: ${escHtml(context?.ownerAgentName || "none")}</span>
      <span class="settings-pill">task: ${escHtml(context?.currentTask || "none")}</span>
      <span class="settings-pill">claims: ${escHtml(String(claims.length))}</span>
      <span class="settings-pill">handoffs: ${escHtml(String(handoffs.length))}</span>
    </div>
  `;
}

function renderSessionClaimsPanel(context = null) {
  if (!sessionClaimsPanelEl) return;
  const claims = Array.isArray(context?.claims) ? context.claims : [];
  if (claims.length === 0) {
    sessionClaimsPanelEl.innerHTML = `
      <div class="settings-inspector-title">Active claims</div>
      <p class="settings-inspector-empty">active claim はありません。</p>
    `;
    return;
  }
  const rows = claims.map((entry) => `
    <tr>
      <td>
        <strong>${escHtml(entry.agentName)}</strong>
        <div class="settings-audit-meta">${escHtml(entry.updatedAt ? formatSettingsDateTime(entry.updatedAt) : "-")}</div>
      </td>
      <td>
        <div>${escHtml(entry.task)}</div>
        <div class="settings-row-actions">
          <button type="button" class="btn-outline" data-claim-release-agent="${escHtml(entry.agentName)}">release</button>
        </div>
      </td>
    </tr>
  `).join("");
  sessionClaimsPanelEl.innerHTML = `
    <div class="settings-inspector-title">Active claims</div>
    <table class="settings-table"><tbody>${rows}</tbody></table>
  `;
}

function renderSessionHandoffsPanel(context = null) {
  if (!sessionHandoffsPanelEl) return;
  const handoffs = Array.isArray(context?.handoffQueue) ? context.handoffQueue : [];
  if (handoffs.length === 0) {
    sessionHandoffsPanelEl.innerHTML = `
      <div class="settings-inspector-title">Handoff queue</div>
      <p class="settings-inspector-empty">handoff queue は空です。</p>
    `;
    return;
  }
  const rows = handoffs.map((entry) => `
    <tr>
      <td>
        <strong>${escHtml(`${entry.fromAgentName} → ${entry.toAgentName}`)}</strong>
        <div class="settings-audit-meta">${escHtml(entry.updatedAt ? formatSettingsDateTime(entry.updatedAt) : "-")}</div>
      </td>
      <td>${escHtml(entry.task)}</td>
    </tr>
  `).join("");
  sessionHandoffsPanelEl.innerHTML = `
    <div class="settings-inspector-title">Handoff queue</div>
    <table class="settings-table"><tbody>${rows}</tbody></table>
  `;
}

async function loadSessionCoordination(workspaceId) {
  if (!workspaceId) return;
  populateWorkspaceMemberSelect(sessionClaimAgentEl, workspaceId);
  populateWorkspaceMemberSelect(sessionHandoffFromEl, workspaceId);
  populateWorkspaceMemberSelect(sessionHandoffToEl, workspaceId);
  try {
    const contextRes = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`);
    const context = contextRes.ok ? await contextRes.json() : null;
    renderSessionCoordinationSummary(context);
    renderSessionClaimsPanel(context);
    renderSessionHandoffsPanel(context);
    setInlineHint(
      sessionCoordinationHintEl,
      `owner=${context?.ownerAgentName || "none"} / claims=${Array.isArray(context?.claims) ? context.claims.length : 0} / handoffs=${Array.isArray(context?.handoffQueue) ? context.handoffQueue.length : 0}`,
    );
  } catch {
    renderSessionCoordinationSummary(null);
    renderSessionClaimsPanel(null);
    renderSessionHandoffsPanel(null);
    setInlineHint(sessionCoordinationHintEl, "coordination 情報の取得に失敗しました。");
  }
}

function applySessionProfile(profile = null) {
  const normalized = {
    mode: profile?.mode || "standard",
    persona: profile?.persona || "balanced",
    autonomy: profile?.autonomy || "guided",
    notes: profile?.notes || "",
  };
  state.settingsWorkspaceProfile = normalized;
  if (sessionProfileModeEl) sessionProfileModeEl.value = normalized.mode;
  if (sessionProfilePersonaEl) sessionProfilePersonaEl.value = normalized.persona;
  if (sessionProfileAutonomyEl) sessionProfileAutonomyEl.value = normalized.autonomy;
  if (sessionProfileNotesEl) sessionProfileNotesEl.value = normalized.notes;
  setInlineHint(
    sessionProfileHintEl,
    `mode=${normalized.mode} / persona=${normalized.persona} / autonomy=${normalized.autonomy}`,
  );
}

async function loadSessionProfile(workspaceId) {
  if (!workspaceId) return;
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/profile`);
    const profile = res.ok ? await res.json() : null;
    applySessionProfile(profile);
  } catch {
    applySessionProfile(null);
    setInlineHint(sessionProfileHintEl, "workspace profile の取得に失敗しました。");
  }
}

function joinWindowsPath(basePath, childPath = "") {
  const base = String(basePath ?? "").replace(/[\\/]+$/g, "");
  const child = String(childPath ?? "").replace(/^[\\/]+/g, "").replace(/\//g, "\\");
  if (!child) return base;
  return /^[A-Za-z]:\\/u.test(child) ? child : `${base}\\${child}`;
}

function renderSessionReviewSummary(review = null) {
  if (!sessionReviewSummaryEl) return;
  state.settingsReviewSnapshot = review || null;
  const repo = review?.repository;
  if (!repo?.isGitRepository) {
    sessionReviewSummaryEl.innerHTML = `
      <div class="settings-inspector-title">Review summary</div>
      <p class="settings-inspector-empty">Git repository ではありません。</p>
    `;
    return;
  }
  sessionReviewSummaryEl.innerHTML = `
    <div class="settings-inspector-title">Review summary</div>
    <div class="settings-pill-row">
      <span class="settings-pill">root: ${escHtml(shortenRef(repo.rootDir || "-", 40))}</span>
      <span class="settings-pill">branch: ${escHtml(repo.branch || "detached")}</span>
      <span class="settings-pill">dirty: ${escHtml(String(repo.status?.dirtyCount ?? 0))}</span>
      <span class="settings-pill">untracked: ${escHtml(String(repo.status?.untrackedCount ?? 0))}</span>
      <span class="settings-pill">worktrees: ${escHtml(String(Array.isArray(review?.worktrees) ? review.worktrees.length : 0))}</span>
    </div>
  `;
}

function renderSessionReviewChanges(review = null) {
  if (!sessionReviewChangesEl) return;
  const repo = review?.repository;
  const changes = Array.isArray(review?.changes) ? review.changes : [];
  if (!repo?.isGitRepository) {
    sessionReviewChangesEl.innerHTML = `
      <div class="settings-inspector-title">Changed files</div>
      <p class="settings-inspector-empty">review 対象の repository がありません。</p>
    `;
    return;
  }
  if (changes.length === 0) {
    sessionReviewChangesEl.innerHTML = `
      <div class="settings-inspector-title">Changed files</div>
      <p class="settings-inspector-empty">変更ファイルはありません。</p>
    `;
    return;
  }
  const items = changes.map((entry) => {
    const absolutePath = joinWindowsPath(repo.rootDir || "", entry.path || "");
    return `
      <details class="settings-review-item">
        <summary>${escHtml(entry.path || "-")}</summary>
        <div class="settings-review-meta">${escHtml([
          entry.kind || "tracked",
          `${entry.indexStatus || " "} / ${entry.worktreeStatus || " "}`.trim(),
        ].filter(Boolean).join(" · "))}</div>
        <div class="settings-action-grid">
          <button type="button" class="btn-outline" data-review-open-path="${escHtml(absolutePath)}">open</button>
        </div>
        <pre class="settings-code-block">${escHtml(entry.diffPreview || "(diff なし)")}</pre>
      </details>
    `;
  }).join("");
  sessionReviewChangesEl.innerHTML = `
    <div class="settings-inspector-title">Changed files</div>
    <div class="settings-review-list">${items}</div>
  `;
}

function renderSessionWorktreePanel(status = null) {
  if (!sessionWorktreePanelEl) return;
  state.settingsWorktreeStatus = status || null;
  if (!status?.isGitRepository) {
    sessionWorktreePanelEl.innerHTML = `
      <div class="settings-inspector-title">Git worktree</div>
      <p class="settings-inspector-empty">Git repository ではないため worktree を作成できません。</p>
    `;
    return;
  }
  sessionWorktreePanelEl.innerHTML = `
    <div class="settings-inspector-title">Git worktree</div>
    <table class="settings-table">
      <tbody>
        <tr><td>current</td><td>${escHtml(status.currentWorkdir || "-")}</td></tr>
        <tr><td>repoRoot</td><td>${escHtml(status.repoRoot || "-")}</td></tr>
        <tr><td>isolated</td><td>${escHtml(status.isIsolated ? "yes" : "no")}</td></tr>
        <tr><td>suggested</td><td>${escHtml(status.suggestedWorktreePath || "-")}</td></tr>
      </tbody>
    </table>
    <div class="settings-inspector-actions">
      <button id="btn-session-worktree-ensure" type="button" class="btn-settings-save" ${status.isIsolated ? "disabled" : ""}>isolated worktree を作成</button>
    </div>
  `;
}

function renderSessionLockConflict(payload = null) {
  if (!sessionLockConflictEl) return;
  state.settingsLockConflict = payload || null;
  const conflicts = Array.isArray(payload?.conflicts) ? payload.conflicts : [];
  if (conflicts.length === 0) {
    sessionLockConflictEl.innerHTML = `
      <div class="settings-inspector-title">Conflict warning</div>
      <p class="settings-inspector-empty">contested symbol はありません。</p>
    `;
    return;
  }
  const rows = conflicts.map((entry) => `<li>${escHtml(`${entry.agentName} :: ${entry.filePath} :: ${entry.symbol}`)}</li>`).join("");
  sessionLockConflictEl.innerHTML = `
    <div class="settings-inspector-title">Conflict warning</div>
    <div class="settings-warning-box">
      <strong>${escHtml(payload?.error || "同じ symbol が他 agent により lock 中です。")}</strong>
      <ul>${rows}</ul>
    </div>
  `;
}

function renderSessionLocksPanel(locks = []) {
  if (!sessionLocksPanelEl) return;
  if (!Array.isArray(locks) || locks.length === 0) {
    sessionLocksPanelEl.innerHTML = `
      <div class="settings-inspector-title">Semantic locks</div>
      <p class="settings-inspector-empty">lock はありません。</p>
    `;
    return;
  }
  const rows = locks.map((entry) => `
    <tr>
      <td>
        <strong>${escHtml(entry.agentName)}</strong>
        <div class="settings-audit-meta">${escHtml(`${entry.filePath} :: ${entry.symbol}`)}</div>
      </td>
      <td>
        <div>${escHtml(entry.note || "-")}</div>
        <div class="settings-row-actions">
          <button type="button" class="btn-outline" data-lock-release-id="${escHtml(entry.id)}">release</button>
        </div>
      </td>
    </tr>
  `).join("");
  sessionLocksPanelEl.innerHTML = `
    <div class="settings-inspector-title">Semantic locks</div>
    <table class="settings-table"><tbody>${rows}</tbody></table>
  `;
}

function renderSessionExtensionDashboard(overview = null) {
  if (!sessionExtensionDashboardPanelEl) return;
  state.settingsExtensionsOverview = overview || null;
  const dashboard = overview?.dashboard;
  if (!dashboard) {
    sessionExtensionDashboardPanelEl.innerHTML = `
      <div class="settings-inspector-title">Daemon / dashboard</div>
      <p class="settings-inspector-empty">dashboard 情報はまだありません。</p>
    `;
    return;
  }
  sessionExtensionDashboardPanelEl.innerHTML = `
    <div class="settings-inspector-title">Daemon / dashboard</div>
    <div class="settings-pill-row">
      <span class="settings-pill">transport: ${escHtml(dashboard.runtime?.transportMode || "-")}</span>
      <span class="settings-pill">app: ${escHtml(dashboard.runtime?.appVersion || "-")}</span>
      <span class="settings-pill">codex: ${escHtml(dashboard.runtime?.codexVersion || "-")}</span>
      <span class="settings-pill">auth: ${escHtml(dashboard.security?.authMode || "-")}</span>
    </div>
    <table class="settings-table">
      <tbody>
        <tr><td>baseWorkdir</td><td>${escHtml(dashboard.runtime?.baseWorkdir || "-")}</td></tr>
        <tr><td>defaultProfile</td><td>${escHtml(dashboard.runtime?.defaultProfile || "-")}</td></tr>
        <tr><td>sandbox</td><td>${escHtml(dashboard.security?.codexSandboxMode || "default")}</td></tr>
        <tr><td>approval</td><td>${escHtml(dashboard.security?.codexApprovalPolicy || "default")}</td></tr>
      </tbody>
    </table>
    <div class="settings-pill-row">
      <span class="settings-pill">claims ${escHtml(String(dashboard.counts?.claims ?? 0))}</span>
      <span class="settings-pill">handoffs ${escHtml(String(dashboard.counts?.handoffs ?? 0))}</span>
      <span class="settings-pill">schedules ${escHtml(String(dashboard.counts?.schedules ?? 0))}</span>
      <span class="settings-pill">warnings ${escHtml(String(dashboard.counts?.terminalWarnings ?? 0))}</span>
      <span class="settings-pill">locks ${escHtml(String(dashboard.counts?.locks ?? 0))}</span>
      <span class="settings-pill">changes ${escHtml(String(dashboard.counts?.changedFiles ?? 0))}</span>
    </div>
  `;
}

function renderSessionTaskBoard(board = null) {
  if (!sessionTaskBoardPanelEl) return;
  const columns = Array.isArray(board?.columns) ? board.columns : [];
  if (columns.length === 0) {
    sessionTaskBoardPanelEl.innerHTML = `
      <div class="settings-inspector-title">Task board</div>
      <p class="settings-inspector-empty">task board はまだありません。</p>
    `;
    return;
  }
  const content = columns.map((column) => {
    const items = Array.isArray(column.items) ? column.items : [];
    return `
      <section class="settings-kanban-column">
        <h5>${escHtml(column.title || "-")}</h5>
        ${items.length > 0
          ? items.map((item) => `
              <article class="settings-kanban-item">
                <strong>${escHtml(item.title || "-")}</strong>
                <div class="settings-audit-meta">${escHtml(item.meta || "-")}</div>
                <div class="settings-review-meta">${escHtml(item.detail || "-")}</div>
              </article>
            `).join("")
          : `<p class="settings-inspector-empty">empty</p>`}
      </section>
    `;
  }).join("");
  sessionTaskBoardPanelEl.innerHTML = `
    <div class="settings-inspector-title">Task board</div>
    <div class="settings-kanban">${content}</div>
  `;
}

function renderSessionValidationPanel(validation = null) {
  if (!sessionValidationPanelEl) return;
  const checks = Array.isArray(validation?.checks) ? validation.checks : [];
  if (checks.length === 0) {
    sessionValidationPanelEl.innerHTML = `
      <div class="settings-inspector-title">Workflow validation</div>
      <p class="settings-inspector-empty">validation 結果はまだありません。</p>
    `;
    return;
  }
  const rows = checks.map((entry) => `
    <tr>
      <td>
        <span class="settings-status-badge status-${escHtml(entry.status || "info")}">${escHtml(entry.status || "info")}</span>
      </td>
      <td>
        <strong>${escHtml(entry.summary || "-")}</strong>
        <div class="settings-audit-meta">${escHtml(entry.detail || "-")}</div>
      </td>
    </tr>
  `).join("");
  sessionValidationPanelEl.innerHTML = `
    <div class="settings-inspector-title">Workflow validation</div>
    <div class="settings-pill-row">
      <span class="settings-pill">overall: ${escHtml(validation?.status || "ok")}</span>
    </div>
    <table class="settings-table"><tbody>${rows}</tbody></table>
  `;
}

function renderSessionDriftPanel(terminalStates = []) {
  if (!sessionDriftPanelEl) return;
  const warned = (Array.isArray(terminalStates) ? terminalStates : []).filter((entry) => entry.warningCode || entry.warningMessage);
  if (warned.length === 0) {
    sessionDriftPanelEl.innerHTML = `
      <div class="settings-inspector-title">Drift detection</div>
      <p class="settings-inspector-empty">drift warning はありません。</p>
    `;
    return;
  }
  const rows = warned.map((entry) => `
    <tr>
      <td><strong>${escHtml(entry.agentName || "-")}</strong></td>
      <td>${escHtml(entry.warningCode || "-")}<div class="settings-audit-meta">${escHtml(entry.warningMessage || "-")}</div></td>
    </tr>
  `).join("");
  sessionDriftPanelEl.innerHTML = `
    <div class="settings-inspector-title">Drift detection</div>
    <table class="settings-table"><tbody>${rows}</tbody></table>
  `;
}

function renderSessionMemoryAutomationPanel() {
  if (!sessionMemoryAutomationPanelEl) return;
  sessionMemoryAutomationPanelEl.innerHTML = `
    <div class="settings-inspector-title">Memory automation</div>
    <div class="settings-action-grid">
      <button type="button" class="btn-outline" data-memory-preview-scope="consolidation">workspace memory preview</button>
      <button type="button" class="btn-outline" data-memory-preview-scope="diary">AI diary preview</button>
      <button type="button" class="btn-outline" data-memory-preview-scope="dreaming">Dreaming preview</button>
    </div>
  `;
}

function renderSessionMemoryAutomationPreview(preview = null) {
  if (!sessionMemoryAutomationPreviewEl) return;
  state.settingsMemoryAutomationPreview = preview || null;
  if (!preview?.scope) {
    sessionMemoryAutomationPreviewEl.innerHTML = `
      <div class="settings-inspector-title">Automation preview</div>
      <p class="settings-inspector-empty">preview を選ぶと diff をここに表示します。</p>
    `;
    return;
  }
  const targetPath = preview.diaryPath || preview.path || "";
  sessionMemoryAutomationPreviewEl.innerHTML = `
    <div class="settings-inspector-title">Automation preview · ${escHtml(preview.scope)}</div>
    <table class="settings-table">
      <tbody>
        <tr><td>workspace</td><td>${escHtml(preview.workspaceName || preview.workspaceId || "-")}</td></tr>
        <tr><td>target</td><td>${escHtml(targetPath || "-")}</td></tr>
        <tr><td>backup</td><td>${escHtml(preview.backupPath || "-")}</td></tr>
        <tr><td>tokenEstimate</td><td>${escHtml(String(preview.tokenEstimate ?? "-"))}</td></tr>
      </tbody>
    </table>
    <pre class="settings-code-block">${escHtml(preview.diff || "(diff なし)")}</pre>
    <div class="settings-inspector-actions">
      <button id="btn-session-memory-automation-apply" type="button" class="btn-settings-save">apply</button>
    </div>
  `;
}

function renderSessionSkillsPanel(registry = null, plan = null) {
  if (!sessionSkillsPanelEl) return;
  state.settingsSkillPlan = plan || null;
  const rows = [];
  for (const agentPlan of Array.isArray(plan?.plans) ? plan.plans : []) {
    for (const target of Array.isArray(agentPlan.targets) ? agentPlan.targets : []) {
      for (const operation of Array.isArray(target.operations) ? target.operations : []) {
        rows.push(`
          <tr>
            <td><strong>${escHtml(agentPlan.agentName)}</strong><div class="settings-audit-meta">${escHtml(operation.skillId || "-")}</div></td>
            <td>${escHtml(operation.action || "-")}<div class="settings-audit-meta">${escHtml(operation.destinationPath || "-")}</div></td>
          </tr>
        `);
      }
    }
  }
  sessionSkillsPanelEl.innerHTML = `
    <div class="settings-inspector-title">Skill registry</div>
    <div class="settings-pill-row">
      <span class="settings-pill">skills: ${escHtml(String(registry?.skillCount ?? 0))}</span>
      <span class="settings-pill">targets: ${escHtml(String(Array.isArray(registry?.targetTypes) ? registry.targetTypes.length : 0))}</span>
    </div>
    <div class="settings-action-grid">
      <button type="button" class="btn-outline" data-skill-sync-action="plan">plan</button>
      <button type="button" class="btn-settings-save" data-skill-sync-action="apply">apply</button>
    </div>
    ${rows.length > 0 ? `<table class="settings-table"><tbody>${rows.join("")}</tbody></table>` : `<p class="settings-inspector-empty">plan はまだありません。</p>`}
  `;
}

function renderSessionMcpPanel(registry = null, plan = null) {
  if (!sessionMcpPanelEl) return;
  state.settingsMcpPlan = plan || null;
  const rows = [];
  for (const agentPlan of Array.isArray(plan?.plans) ? plan.plans : []) {
    for (const target of Array.isArray(agentPlan.targets) ? agentPlan.targets : []) {
      rows.push(`
        <tr>
          <td><strong>${escHtml(agentPlan.agentName)}</strong><div class="settings-audit-meta">${escHtml((target.serverIds || []).join(", ") || "-")}</div></td>
          <td>${escHtml(target.action || "-")}<div class="settings-audit-meta">${escHtml(target.destinationPath || "-")}</div></td>
        </tr>
      `);
    }
  }
  sessionMcpPanelEl.innerHTML = `
    <div class="settings-inspector-title">MCP settings</div>
    <div class="settings-pill-row">
      <span class="settings-pill">servers: ${escHtml(String(registry?.serverCount ?? 0))}</span>
      <span class="settings-pill">targets: ${escHtml(String(Array.isArray(registry?.targetTypes) ? registry.targetTypes.length : 0))}</span>
    </div>
    <div class="settings-action-grid">
      <button type="button" class="btn-outline" data-mcp-sync-action="plan">plan</button>
      <button type="button" class="btn-settings-save" data-mcp-sync-action="apply">apply</button>
    </div>
    ${rows.length > 0 ? `<table class="settings-table"><tbody>${rows.join("")}</tbody></table>` : `<p class="settings-inspector-empty">plan はまだありません。</p>`}
  `;
}

function renderSessionAutomationLoading() {
  const loadingText = `<p class="settings-inspector-empty">読み込み中...</p>`;
  if (sessionExtensionDashboardPanelEl) {
    sessionExtensionDashboardPanelEl.innerHTML = `
      <div class="settings-inspector-title">Daemon / dashboard</div>
      ${loadingText}
    `;
  }
  if (sessionTaskBoardPanelEl) {
    sessionTaskBoardPanelEl.innerHTML = `
      <div class="settings-inspector-title">Task board</div>
      ${loadingText}
    `;
  }
  if (sessionValidationPanelEl) {
    sessionValidationPanelEl.innerHTML = `
      <div class="settings-inspector-title">Workflow validation</div>
      ${loadingText}
    `;
  }
  if (sessionDriftPanelEl) {
    sessionDriftPanelEl.innerHTML = `
      <div class="settings-inspector-title">Drift detection</div>
      ${loadingText}
    `;
  }
  if (sessionMemoryAutomationPanelEl) {
    sessionMemoryAutomationPanelEl.innerHTML = `
      <div class="settings-inspector-title">Memory automation</div>
      ${loadingText}
    `;
  }
  if (sessionMemoryAutomationPreviewEl && !state.settingsMemoryAutomationPreview?.scope) {
    sessionMemoryAutomationPreviewEl.innerHTML = `
      <div class="settings-inspector-title">Automation preview</div>
      ${loadingText}
    `;
  }
  if (sessionSkillsPanelEl) {
    sessionSkillsPanelEl.innerHTML = `
      <div class="settings-inspector-title">Skill registry</div>
      ${loadingText}
    `;
  }
  if (sessionMcpPanelEl) {
    sessionMcpPanelEl.innerHTML = `
      <div class="settings-inspector-title">MCP settings</div>
      ${loadingText}
    `;
  }
}

async function loadSessionReview(workspaceId) {
  if (!workspaceId) return;
  populateWorkspaceMemberSelect(sessionLockAgentEl, workspaceId);
  try {
    const [reviewRes, worktreeRes, locksRes] = await Promise.all([
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/review`),
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/worktree`),
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/locks`),
    ]);
    const review = reviewRes.ok ? await reviewRes.json() : null;
    const worktree = worktreeRes.ok ? await worktreeRes.json() : null;
    const locks = locksRes.ok ? await locksRes.json() : [];
    renderSessionReviewSummary(review);
    renderSessionReviewChanges(review);
    renderSessionWorktreePanel(worktree);
    renderSessionLocksPanel(locks);
    if (!state.settingsLockConflict?.conflicts?.length) {
      renderSessionLockConflict(null);
    }
    setInlineHint(
      sessionReviewHintEl,
      `dirty=${review?.repository?.status?.dirtyCount ?? 0} / locks=${Array.isArray(locks) ? locks.length : 0} / isolated=${worktree?.isIsolated ? "yes" : "no"}`,
    );
  } catch {
    renderSessionReviewSummary(null);
    renderSessionReviewChanges(null);
    renderSessionWorktreePanel(null);
    renderSessionLocksPanel([]);
    renderSessionLockConflict(null);
    setInlineHint(sessionReviewHintEl, "review 情報の取得に失敗しました。");
  }
}

async function loadSessionAutomation(workspaceId) {
  if (!workspaceId) return;
  renderSessionAutomationLoading();
  setInlineHint(sessionAutomationHintEl, "automation 情報を読み込み中です...");
  try {
    const [overviewRes, terminalStatesRes, skillsRegistryRes, skillPlanRes, mcpRegistryRes, mcpPlanRes] = await Promise.all([
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/extensions/overview`),
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal-states`),
      fetch("/api/skills/registry"),
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      fetch("/api/mcp/registry"),
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    ]);
    const overview = overviewRes.ok ? await overviewRes.json() : null;
    const terminalStates = terminalStatesRes.ok ? await terminalStatesRes.json() : [];
    const skillsRegistry = skillsRegistryRes.ok ? await skillsRegistryRes.json() : null;
    const skillPlan = skillPlanRes.ok ? await skillPlanRes.json() : null;
    const mcpRegistry = mcpRegistryRes.ok ? await mcpRegistryRes.json() : null;
    const mcpPlan = mcpPlanRes.ok ? await mcpPlanRes.json() : null;
    renderSessionExtensionDashboard(overview);
    renderSessionTaskBoard(overview?.board);
    renderSessionValidationPanel(overview?.validation);
    renderSessionDriftPanel(terminalStates);
    renderSessionMemoryAutomationPanel();
    if (state.settingsMemoryAutomationPreview?.workspaceId !== workspaceId) {
      renderSessionMemoryAutomationPreview(null);
    } else {
      renderSessionMemoryAutomationPreview(state.settingsMemoryAutomationPreview);
    }
    renderSessionSkillsPanel(skillsRegistry, skillPlan);
    renderSessionMcpPanel(mcpRegistry, mcpPlan);
    setInlineHint(
      sessionAutomationHintEl,
      `warnings=${Array.isArray(terminalStates) ? terminalStates.filter((entry) => entry.warningCode).length : 0} / schedules=${overview?.dashboard?.counts?.schedules ?? 0} / skills=${skillsRegistry?.skillCount ?? 0} / mcp=${mcpRegistry?.serverCount ?? 0}`,
    );
  } catch {
    renderSessionExtensionDashboard(null);
    renderSessionTaskBoard(null);
    renderSessionValidationPanel(null);
    renderSessionDriftPanel([]);
    renderSessionMemoryAutomationPanel();
    renderSessionMemoryAutomationPreview(null);
    renderSessionSkillsPanel(null, null);
    renderSessionMcpPanel(null, null);
    setInlineHint(sessionAutomationHintEl, "automation 情報の取得に失敗しました。");
  }
}

async function refreshSessionInspector(workspaceId) {
  if (!workspaceId) return;
  await Promise.all([
    loadSessionDurability(workspaceId),
    loadSessionGitSafety(workspaceId),
    loadSessionCoordination(workspaceId),
    loadSessionProfile(workspaceId),
    loadSessionReview(workspaceId),
    loadSessionAutomation(workspaceId),
  ]);
}

async function loadRuntimeInfo(force = false) {
  if (!force && state.runtimeInfo) {
    return state.runtimeInfo;
  }
  if (!force && state.runtimeInfoPromise) {
    return state.runtimeInfoPromise;
  }
  state.runtimeInfoPromise = fetch("/api/runtime")
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .then((runtimeInfo) => {
      state.runtimeInfo = runtimeInfo;
      state.runtimeInfoPromise = null;
      return runtimeInfo;
    });
  return state.runtimeInfoPromise;
}

function getCodexModelOptions(runtimeInfo, currentModel = "") {
  const runtimeModels = (runtimeInfo?.availableModels || []).map((model) => ({
    value: model.slug,
    label: model.slug,
    description: model.description || "",
  }));
  return buildSelectOptions([...runtimeModels, ...CODEX_MODEL_FALLBACKS], {
    includeDefaultLabel: {
      label: runtimeInfo?.defaults?.model ? `Default (${runtimeInfo.defaults.model})` : "Default",
      description: "Codex CLI の既定モデルを使います",
    },
    currentValue: currentModel,
  });
}

function getAgentModelControlStateFromUi(agentType, runtimeInfo, primaryValue = "", detailValue = "") {
  if (agentType === "gemini") {
    const preset = AGENT_MODEL_MENU_PRESETS.gemini;
    const primaryOptions = preset.primary;
    const normalizedPrimary = primaryOptions.some((option) => option.value === String(primaryValue ?? "").trim())
      ? String(primaryValue ?? "").trim()
      : primaryOptions[0]?.value ?? "";
    const detailOptions = buildSelectOptions(preset.manual, { currentValue: detailValue });
    const normalizedDetail = detailOptions.some((option) => option.value === String(detailValue ?? "").trim())
      ? String(detailValue ?? "").trim()
      : detailOptions[0]?.value ?? "";
    const detailVisible = normalizedPrimary === "manual";
    const primaryOption = findOptionByValue(primaryOptions, normalizedPrimary);
    const detailOption = findOptionByValue(detailOptions, normalizedDetail);
    return {
      primaryOptions,
      primaryValue: normalizedPrimary,
      detailOptions,
      detailValue: normalizedDetail,
      detailVisible,
      hint: detailVisible
        ? detailOption?.description || primaryOption?.description || ""
        : primaryOption?.description || "",
    };
  }
  const primaryOptions = agentType === "codex"
    ? getCodexModelOptions(runtimeInfo, primaryValue)
    : buildSelectOptions(AGENT_MODEL_MENU_PRESETS[agentType] || [], { currentValue: primaryValue });
  const normalizedPrimary = primaryOptions.some((option) => option.value === String(primaryValue ?? "").trim())
    ? String(primaryValue ?? "").trim()
    : primaryOptions[0]?.value ?? "";
  const primaryOption = findOptionByValue(primaryOptions, normalizedPrimary);
  return {
    primaryOptions,
    primaryValue: normalizedPrimary,
    detailOptions: [],
    detailValue: "",
    detailVisible: false,
    hint: primaryOption?.description || "",
  };
}

function getAgentModelControlState(agentType, runtimeInfo, currentModel = "") {
  const normalizedModel = String(currentModel ?? "").trim();
  if (agentType === "gemini" && normalizedModel === "gemini-3") {
    return getAgentModelControlStateFromUi(agentType, runtimeInfo, "", "");
  }
  if (agentType === "gemini" && normalizedModel && normalizedModel !== "gemini-2.5") {
    return getAgentModelControlStateFromUi(agentType, runtimeInfo, "manual", normalizedModel);
  }
  return getAgentModelControlStateFromUi(agentType, runtimeInfo, normalizedModel, normalizedModel);
}

function applyModelControlState(primaryEl, detailEl, hintEl, controlState) {
  if (!primaryEl || !controlState) return;
  populateSelectOptions(primaryEl, controlState.primaryOptions, controlState.primaryValue);
  if (detailEl) {
    if (controlState.detailVisible) {
      populateSelectOptions(detailEl, controlState.detailOptions, controlState.detailValue);
    } else {
      detailEl.innerHTML = "";
    }
    detailEl.hidden = !controlState.detailVisible;
  }
  setInlineHint(hintEl, controlState.hint);
}

function resolveConfiguredModelValue(agentType, primaryValue = "", detailValue = "") {
  const normalizedPrimary = String(primaryValue ?? "").trim();
  if (agentType === "gemini" && normalizedPrimary === "manual") {
    return String(detailValue ?? "").trim();
  }
  return normalizedPrimary;
}

function formatReasoningEffortLabel(value = "") {
  switch (String(value ?? "").trim()) {
    case "xhigh":
      return "Extra high";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "max":
      return "Max";
    default:
      return value || "";
  }
}

function getCodexModelDefinition(modelSlug, runtimeInfo) {
  const normalizedSlug = String(modelSlug ?? "").trim();
  const availableModels = runtimeInfo?.availableModels || [];
  return availableModels.find((model) => model.slug === normalizedSlug) || availableModels[0] || null;
}

function getCodexReasoningOptions(modelSlug, runtimeInfo, currentValue = "") {
  const modelDefinition = getCodexModelDefinition(modelSlug, runtimeInfo);
  const levels = (modelDefinition?.supportedReasoningLevels || []).map((level) => ({
    value: level.effort,
    label: formatReasoningEffortLabel(level.effort),
    description: level.description || "",
  }));
  return buildSelectOptions(levels, {
    includeDefaultLabel: modelDefinition?.defaultReasoningLevel
      ? {
          label: `Default (${formatReasoningEffortLabel(modelDefinition.defaultReasoningLevel)})`,
          description: "Codex CLI の既定 reasoning を使います",
        }
      : {
          label: "Default",
          description: "Codex CLI の既定 reasoning を使います",
        },
    currentValue,
  });
}

function getFastModeSelectValue(rawValue) {
  if (rawValue === true || rawValue === "true" || rawValue === "fast") {
    return "fast";
  }
  if (rawValue === false || rawValue === "false" || rawValue === "flex") {
    return "flex";
  }
  return "";
}

function setAgentSettingRowVisible(labelEl, inputEl, visible) {
  setElementHidden(labelEl, !visible);
  setElementHidden(inputEl, !visible);
}

function getAgentReasoningOptions(agentType, runtimeInfo, modelValue = "", currentValue = "") {
  if (agentType === "codex") {
    const effectiveModel = modelValue || runtimeInfo?.defaults?.model || "";
    return getCodexReasoningOptions(effectiveModel, runtimeInfo, currentValue);
  }
  return buildSelectOptions(AGENT_REASONING_PRESETS[agentType] || [], { currentValue });
}

function configureReasoningControls({
  agentType,
  runtimeInfo,
  modelValue = "",
  currentValue = "",
  labelEl,
  selectEl,
}) {
  const visible = ["claude", "copilot", "codex"].includes(agentType);
  setAgentSettingRowVisible(labelEl, selectEl, visible);
  if (!visible) {
    selectEl.innerHTML = "";
    return;
  }
  populateSelectOptions(
    selectEl,
    getAgentReasoningOptions(agentType, runtimeInfo, modelValue, currentValue),
    currentValue,
  );
}

function getAgentPlanModeState(agentType, currentValue = "") {
  const preset = AGENT_PLAN_MODE_PRESETS[agentType];
  if (!preset?.length) {
    return { visible: false, options: [], selectedValue: "", hint: "" };
  }
  const options = buildSelectOptions(preset, { currentValue });
  const normalizedValue = options.some((option) => option.value === String(currentValue ?? "").trim())
    ? String(currentValue ?? "").trim()
    : options[0]?.value ?? "";
  return {
    visible: true,
    options,
    selectedValue: normalizedValue,
    hint: findOptionByValue(options, normalizedValue)?.description || "",
  };
}

function configurePlanModeControls({
  agentType,
  currentValue = "",
  labelEl,
  controlsEl,
  selectEl,
  hintEl,
}) {
  const planState = getAgentPlanModeState(agentType, currentValue);
  setAgentSettingRowVisible(labelEl, controlsEl, planState.visible);
  if (!planState.visible) {
    selectEl.innerHTML = "";
    setInlineHint(hintEl, "");
    return planState;
  }
  populateSelectOptions(selectEl, planState.options, planState.selectedValue);
  setInlineHint(hintEl, planState.hint);
  return planState;
}

function configureAgentSettingsControls(agent, runtimeInfo) {
  if (!agent) return;
  populateSelectOptions(agentTypeDisplayEl, AGENT_TYPE_OPTIONS, agent.type || "");
  const modelControlState = getAgentModelControlState(agent.type, runtimeInfo, agent.model || "");
  applyModelControlState(agentModelInputEl, agentModelDetailInputEl, agentModelHintEl, modelControlState);

  const selectedModel = resolveConfiguredModelValue(
    agent.type,
    modelControlState.primaryValue,
    modelControlState.detailValue,
  );
  configureReasoningControls({
    agentType: agent.type,
    runtimeInfo,
    modelValue: selectedModel,
    currentValue: agent.settings?.reasoningEffort || "",
    labelEl: agentReasoningInputLabelEl,
    selectEl: agentReasoningInputEl,
  });

  const codexControlsVisible = agent.type === "codex";
  setAgentSettingRowVisible(agentFastModeInputLabelEl, agentFastModeInputEl, codexControlsVisible);
  if (codexControlsVisible) {
    populateSelectOptions(
      agentFastModeInputEl,
      [
        { value: "", label: runtimeInfo?.defaults?.serviceTier ? `default (${runtimeInfo.defaults.serviceTier})` : "default" },
        { value: "flex", label: "flex" },
        { value: "fast", label: "fast" },
      ],
      getFastModeSelectValue(agent.settings?.fastMode),
    );
  } else {
    agentFastModeInputEl.innerHTML = "";
  }
  configurePlanModeControls({
    agentType: agent.type,
    currentValue: agent.settings?.planMode || "",
    labelEl: agentPlanModeLabelEl,
    controlsEl: agentPlanModeControlsEl,
    selectEl: agentPlanModeInputEl,
    hintEl: agentPlanModeHintEl,
  });
}

function getFastModeOptions(runtimeInfo) {
  return [
    { value: "", label: runtimeInfo?.defaults?.serviceTier ? `default (${runtimeInfo.defaults.serviceTier})` : "default" },
    { value: "flex", label: "flex" },
    { value: "fast", label: "fast" },
  ];
}

function configureAgentCreateControls(agentType = agentsCreateTypeEl?.value || "gemini", runtimeInfo = state.runtimeInfo) {
  if (!agentsCreateTypeEl || !agentsCreateModelEl) return;
  const normalizedType = String(agentType || "gemini").trim().toLowerCase();
  const modelControlState = getAgentModelControlState(
    normalizedType,
    runtimeInfo,
    resolveConfiguredModelValue(normalizedType, agentsCreateModelEl.value, agentsCreateModelDetailEl?.value),
  );
  applyModelControlState(agentsCreateModelEl, agentsCreateModelDetailEl, agentsCreateModelHintEl, modelControlState);

  configureReasoningControls({
    agentType: normalizedType,
    runtimeInfo,
    modelValue: resolveConfiguredModelValue(
      normalizedType,
      modelControlState.primaryValue,
      modelControlState.detailValue,
    ),
    currentValue: agentsCreateReasoningEl.value.trim(),
    labelEl: agentsCreateReasoningLabelEl,
    selectEl: agentsCreateReasoningEl,
  });

  const codexControlsVisible = normalizedType === "codex";
  setAgentSettingRowVisible(agentsCreateFastModeLabelEl, agentsCreateFastModeEl, codexControlsVisible);
  if (codexControlsVisible) {
    populateSelectOptions(
      agentsCreateFastModeEl,
      getFastModeOptions(runtimeInfo),
      getFastModeSelectValue(agentsCreateFastModeEl.value),
    );
  } else {
    agentsCreateFastModeEl.innerHTML = "";
  }
  configurePlanModeControls({
    agentType: normalizedType,
    currentValue: agentsCreatePlanModeEl.value.trim(),
    labelEl: agentsCreatePlanModeLabelEl,
    controlsEl: agentsCreatePlanModeControlsEl,
    selectEl: agentsCreatePlanModeEl,
    hintEl: agentsCreatePlanModeHintEl,
  });
}

function getEditableAgentSettingsFields(agentType) {
  const fields = ["model"];
  if (["claude", "copilot", "codex"].includes(agentType)) {
    fields.push("reasoning");
  }
  if (agentType === "codex") {
    fields.push("fast");
  }
  if (AGENT_PLAN_MODE_PRESETS[agentType]?.length) {
    fields.push("plan mode");
  }
  fields.push("workdir", "instructions");
  return fields.join("、");
}

function refreshAgentSettingsModelControls(runtimeInfo = state.runtimeInfo) {
  const agentType = state.settingsAgentMeta?.type || agentTypeDisplayEl?.value?.trim() || "";
  if (!agentType || !runtimeInfo) return;
  const modelState = getAgentModelControlStateFromUi(
    agentType,
    runtimeInfo,
    agentModelInputEl?.value,
    agentModelDetailInputEl?.value,
  );
  applyModelControlState(agentModelInputEl, agentModelDetailInputEl, agentModelHintEl, modelState);
  configureReasoningControls({
    agentType,
    runtimeInfo,
    modelValue: resolveConfiguredModelValue(agentType, modelState.primaryValue, modelState.detailValue),
    currentValue: agentReasoningInputEl?.value?.trim() || "",
    labelEl: agentReasoningInputLabelEl,
    selectEl: agentReasoningInputEl,
  });
}

function refreshAgentCreateModelControls(runtimeInfo = state.runtimeInfo) {
  const agentType = agentsCreateTypeEl?.value?.trim() || "gemini";
  if (!agentType || !runtimeInfo) return;
  const modelState = getAgentModelControlStateFromUi(
    agentType,
    runtimeInfo,
    agentsCreateModelEl?.value,
    agentsCreateModelDetailEl?.value,
  );
  applyModelControlState(agentsCreateModelEl, agentsCreateModelDetailEl, agentsCreateModelHintEl, modelState);
  configureReasoningControls({
    agentType,
    runtimeInfo,
    modelValue: resolveConfiguredModelValue(agentType, modelState.primaryValue, modelState.detailValue),
    currentValue: agentsCreateReasoningEl?.value?.trim() || "",
    labelEl: agentsCreateReasoningLabelEl,
    selectEl: agentsCreateReasoningEl,
  });
}

function refreshAgentSettingsPlanControls() {
  const agentType = state.settingsAgentMeta?.type || agentTypeDisplayEl?.value?.trim() || "";
  if (!agentType) return;
  configurePlanModeControls({
    agentType,
    currentValue: agentPlanModeInputEl?.value?.trim() || "",
    labelEl: agentPlanModeLabelEl,
    controlsEl: agentPlanModeControlsEl,
    selectEl: agentPlanModeInputEl,
    hintEl: agentPlanModeHintEl,
  });
}

function refreshAgentCreatePlanControls() {
  const agentType = agentsCreateTypeEl?.value?.trim() || "gemini";
  configurePlanModeControls({
    agentType,
    currentValue: agentsCreatePlanModeEl?.value?.trim() || "",
    labelEl: agentsCreatePlanModeLabelEl,
    controlsEl: agentsCreatePlanModeControlsEl,
    selectEl: agentsCreatePlanModeEl,
    hintEl: agentsCreatePlanModeHintEl,
  });
}

function resolveAgentThemeKey(agentName = state.selectedAgent) {
  const lowerAgentName = String(agentName ?? "").toLowerCase();
  const agent = getSelectedAgentInfo(agentName);
  const candidates = [agent?.type, lowerAgentName];
  for (const rawCandidate of candidates) {
    const candidate = String(rawCandidate ?? "").toLowerCase();
    if (!candidate) continue;
    if (AGENT_THEME_PRESETS[candidate]) return candidate;
    if (candidate.includes("gemini")) return "gemini";
    if (candidate.includes("claude")) return "claude";
    if (candidate.includes("codex")) return "codex";
    if (candidate.includes("copilot")) return "copilot";
  }
  return "fallback";
}

function getAgentTheme(agentName = state.selectedAgent) {
  const key = resolveAgentThemeKey(agentName);
  return { key, ...AGENT_THEME_PRESETS[key] };
}

function getAgentThemeVarEntries(agentName = state.selectedAgent) {
  const theme = getAgentTheme(agentName);
  return [
    ["--agent-accent", theme.accent],
    ["--agent-accent-soft", theme.soft],
    ["--agent-accent-border", theme.border],
    ["--agent-accent-ink", theme.ink],
    ["--agent-bubble-bg", theme.bubble],
    ["--agent-accent-glow", theme.glow],
    ["--agent-terminal-tint", theme.terminalTint],
  ];
}

function applyAgentThemeToElement(element, agentName = state.selectedAgent) {
  const theme = getAgentTheme(agentName);
  if (!element) return theme;
  for (const [name, value] of getAgentThemeVarEntries(agentName)) {
    element.style.setProperty(name, value);
  }
  element.dataset.agentTheme = theme.key;
  return theme;
}

function buildAgentThemeStyle(agentName = state.selectedAgent) {
  return getAgentThemeVarEntries(agentName)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

function normalizeMessageDate(value = Date.now()) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  const raw = String(value ?? "").trim();
  if (!raw) return new Date();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    return new Date(raw.replace(" ", "T") + "Z");
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatMessageTime(value = Date.now()) {
  return normalizeMessageDate(value).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function formatSettingsDateTime(value = Date.now()) {
  return normalizeMessageDate(value).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ts() {
  return formatMessageTime();
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderStrongText(text) {
  return escHtml(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderInlineMarkdown(text) {
  const raw = String(text ?? "");
  const parts = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const codeStart = raw.indexOf("`", cursor);
    if (codeStart < 0) {
      parts.push(renderStrongText(raw.slice(cursor)));
      break;
    }
    if (codeStart > cursor) {
      parts.push(renderStrongText(raw.slice(cursor, codeStart)));
    }
    const codeEnd = raw.indexOf("`", codeStart + 1);
    if (codeEnd < 0) {
      parts.push(renderStrongText(raw.slice(codeStart)));
      break;
    }
    parts.push(`<code>${escHtml(raw.slice(codeStart + 1, codeEnd))}</code>`);
    cursor = codeEnd + 1;
  }

  return parts.join("");
}

function renderMarkdownCodeBlock(code, language = "") {
  const lang = String(language ?? "").trim();
  const label = lang ? `<div class="msg-code-lang">${escHtml(lang)}</div>` : "";
  return `<pre class="msg-code-block">${label}<code>${escHtml(String(code ?? "").replace(/\n+$/g, ""))}</code></pre>`;
}

function renderAgentMarkdown(content) {
  const source = String(content ?? "").replace(/\r/g, "");
  if (!source) return "";

  const lines = source.split("\n");
  const blocks = [];
  let paragraphLines = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push(`<p>${paragraphLines.map((line) => renderInlineMarkdown(line)).join("<br>")}</p>`);
    paragraphLines = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    const fenceMatch = line.match(/^```([A-Za-z0-9._+-]*)\s*$/);
    if (fenceMatch) {
      flushParagraph();
      index += 1;
      const codeLines = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length && /^```\s*$/.test(lines[index])) {
        index += 1;
      }
      blocks.push(renderMarkdownCodeBlock(codeLines.join("\n"), fenceMatch[1]));
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const level = Math.min(headingMatch[1].length, 6);
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    const unorderedMatch = line.match(/^[-*]\s+(.*)$/);
    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (unorderedMatch || orderedMatch) {
      flushParagraph();
      const isOrdered = Boolean(orderedMatch);
      const items = [];
      while (index < lines.length) {
        const candidate = lines[index];
        const match = candidate.match(isOrdered ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/);
        if (!match) break;
        items.push(`<li>${renderInlineMarkdown(match[1].trim())}</li>`);
        index += 1;
      }
      blocks.push(`<${isOrdered ? "ol" : "ul"}>${items.join("")}</${isOrdered ? "ol" : "ul"}>`);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraphLines.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks.join("") || escHtml(source);
}

function normalizeLinkedFilePath(rawPath) {
  let value = String(rawPath ?? "").trim();
  if (!value) return "";
  if (/^file:\/\/\//i.test(value)) {
    value = decodeURIComponent(value.replace(/^file:\/\/\/?/i, ""));
    value = value.replace(/\//g, "\\");
  }
  return value;
}

function splitLinkTrailingPunctuation(rawValue) {
  let value = String(rawValue ?? "");
  let trailing = "";
  while (/[),.;!?]$/.test(value)) {
    trailing = value.slice(-1) + trailing;
    value = value.slice(0, -1);
  }
  return { value, trailing };
}

function createLinkifiedFragment(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /(https?:\/\/[^\s<]+|file:\/\/\/[A-Za-z]:[^\s<]+|[A-Za-z]:\\[^\r\n<>"]+)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index;
    const rawToken = match[0];
    if (start > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
    }
    const { value, trailing } = splitLinkTrailingPunctuation(rawToken);
    if (/^https?:\/\//i.test(value)) {
      const anchor = document.createElement("a");
      anchor.className = "msg-link";
      anchor.href = value;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = value;
      fragment.appendChild(anchor);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "msg-file-link";
      button.dataset.filePath = normalizeLinkedFilePath(value);
      button.textContent = value;
      fragment.appendChild(button);
    }
    if (trailing) {
      fragment.appendChild(document.createTextNode(trailing));
    }
    lastIndex = start + rawToken.length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return fragment;
}

function enhanceBubbleLinks(rootEl) {
  if (!rootEl) return;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let current;
  while ((current = walker.nextNode())) {
    if (!current.nodeValue?.trim()) continue;
    const parent = current.parentElement;
    if (parent?.closest("a, code, pre, button")) continue;
    if (!/(https?:\/\/|file:\/\/\/|[A-Za-z]:\\)/.test(current.nodeValue)) continue;
    nodes.push(current);
  }
  nodes.forEach((node) => {
    node.replaceWith(createLinkifiedFragment(node.nodeValue));
  });
}

function closeChatFileViewer() {
  if (!chatFileViewerEl) return;
  chatFileViewerEl.hidden = true;
  if (chatFileViewerPathEl) chatFileViewerPathEl.textContent = "-";
  if (chatFileViewerMetaEl) chatFileViewerMetaEl.textContent = "";
  if (chatFileViewerContentEl) chatFileViewerContentEl.textContent = "";
  if (chatFileViewerOpenEl) {
    chatFileViewerOpenEl.href = "#";
    chatFileViewerOpenEl.hidden = true;
  }
}

async function openChatFileViewer(rawPath) {
  const filePath = normalizeLinkedFilePath(rawPath);
  if (!filePath) {
    showToast("❌ ファイルパスを解釈できません", "error");
    return;
  }
  if (chatFileViewerEl) chatFileViewerEl.hidden = false;
  if (chatFileViewerPathEl) chatFileViewerPathEl.textContent = filePath;
  if (chatFileViewerMetaEl) chatFileViewerMetaEl.textContent = "読み込み中…";
  if (chatFileViewerContentEl) chatFileViewerContentEl.textContent = "";
  if (chatFileViewerOpenEl) {
    chatFileViewerOpenEl.hidden = false;
    chatFileViewerOpenEl.href = `file:///${filePath.replace(/\\/g, "/")}`;
  }
  try {
    const res = await fetch(`/api/files/view?path=${encodeURIComponent(filePath)}`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error || `HTTP ${res.status}`);
    }
    if (chatFileViewerMetaEl) {
      chatFileViewerMetaEl.textContent =
        payload.kind === "text"
          ? `Lines ${payload.startLine}-${payload.endLine} / ${payload.totalLines}`
          : "binary preview is not available in-app";
    }
    if (chatFileViewerOpenEl && payload.downloadUrl) {
      chatFileViewerOpenEl.href = payload.downloadUrl;
    }
    if (chatFileViewerContentEl) {
      chatFileViewerContentEl.textContent =
        payload.kind === "text"
          ? (payload.lines || []).map((line) => `${line.number}. ${line.text}`).join("\n")
          : "このファイルは viewer 内では表示せず、外部で開きます。";
    }
    chatFileViewerEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (error) {
    if (chatFileViewerMetaEl) chatFileViewerMetaEl.textContent = "読み込み失敗";
    if (chatFileViewerContentEl) {
      chatFileViewerContentEl.textContent = error instanceof Error ? error.message : String(error);
    }
    showToast(`❌ file viewer: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function setAgentBubbleContent(bubbleEl, content, { streaming = false } = {}) {
  if (!bubbleEl) return;
  bubbleEl.dataset.rawContent = String(content ?? "");
  bubbleEl.classList.toggle("is-streaming", streaming);
  if (streaming) {
    bubbleEl.textContent = String(content ?? "");
    return;
  }
  bubbleEl.innerHTML = renderAgentMarkdown(content);
  enhanceBubbleLinks(bubbleEl);
}

function scrollChatToBottom() {
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function isTerminalTabActive() {
  return state.activeTab === "terminal";
}

function getStatusLabel(status) {
  switch (status) {
    case "manual_running": return "running";
    case "waiting_input": return "waiting input";
    case "quota_wait": return "quota wait";
    case "running": return "running";
    case "error": return "error";
    case "ready":
    case "idle":
      return "ready";
    default:
      return "disconnected";
  }
}

function getWorkspaceById(workspaceId = state.workspaceId) {
  return state.workspaces.find((ws) => ws.id === workspaceId) ?? null;
}

function getSidebarActiveWorkspaces() {
  return [...state.workspaces];
}

function getSidebarInactiveWorkspaces() {
  return [];
}

function getWorkspaceTerminalStateKey(workspaceId, agentName) {
  return `${workspaceId}:${agentName}`;
}

function normalizeWorkspaceTerminalState(workspaceId, agentName, snapshot = {}) {
  return {
    agentName,
    workspaceId,
    status: String(snapshot.status || "idle"),
    hasProcess: Boolean(snapshot.hasProcess),
    readyForPrompt: Boolean(snapshot.readyForPrompt),
    lastOutputAt: snapshot.lastOutputAt ?? null,
    runId: snapshot.runId ?? null,
    configStale: Boolean(snapshot.configStale),
    configWarning: String(snapshot.configWarning || ""),
    warningCode: String(snapshot.warningCode || ""),
    warningMessage: String(snapshot.warningMessage || ""),
    approvalRequest: snapshot.approvalRequest || null,
    quotaNotice: snapshot.quotaNotice || null,
  };
}

function setWorkspaceTerminalState(workspaceId, agentName, snapshot = {}) {
  if (!workspaceId || !agentName) {
    return normalizeWorkspaceTerminalState(workspaceId, agentName, snapshot);
  }
  const normalized = normalizeWorkspaceTerminalState(workspaceId, agentName, snapshot);
  state.workspaceTerminalStates.set(getWorkspaceTerminalStateKey(workspaceId, agentName), normalized);
  return normalized;
}

function getWorkspaceTerminalStateSnapshot(workspaceId, agentName) {
  return state.workspaceTerminalStates.get(getWorkspaceTerminalStateKey(workspaceId, agentName))
    ?? normalizeWorkspaceTerminalState(workspaceId, agentName, {});
}

function getSidebarTerminalStateMeta(workspaceId, agentName) {
  const snapshot = getWorkspaceTerminalStateSnapshot(workspaceId, agentName);
  if (!snapshot.hasProcess) {
    return { snapshot, label: "起動前", badgeClass: "not-started", dotStatus: "stopped", canStart: true };
  }
  if (snapshot.status === "error") {
    return { snapshot, label: "エラー", badgeClass: "error", dotStatus: "error", canStart: false };
  }
  if (snapshot.status === "running") {
    return { snapshot, label: "実行中", badgeClass: "running", dotStatus: "running", canStart: false };
  }
  if (snapshot.status === "waiting_input") {
    return { snapshot, label: "入力待ち", badgeClass: "waiting-input", dotStatus: "waiting_input", canStart: false };
  }
  if (snapshot.status === "quota_wait") {
    return { snapshot, label: "利用制限待ち", badgeClass: "quota-wait", dotStatus: "waiting_input", canStart: false };
  }
  if (snapshot.readyForPrompt || snapshot.status === "idle") {
    return { snapshot, label: "稼働中", badgeClass: "ready", dotStatus: "idle", canStart: false };
  }
  return { snapshot, label: "起動中", badgeClass: "starting", dotStatus: "running", canStart: false };
}

function clearSidebarDragState() {
  state.sidebarDrag = null;
  sessionSidebarEl?.querySelectorAll(".dragging").forEach((el) => {
    el.classList.remove("dragging");
  });
  clearSidebarDropIndicators();
  if (state.sidebarPendingRender) {
    renderSessionSidebar();
  }
}

function clearSidebarDropIndicators() {
  sessionSidebarEl?.querySelectorAll(".drop-target, .drop-before, .drop-after").forEach((el) => {
    el.classList.remove("drop-target", "drop-before", "drop-after");
  });
}

function setSidebarDropTarget(card, position = "after") {
  if (!sessionSidebarEl || !card) return;
  sessionSidebarEl
    .querySelectorAll(".session-card.drop-target, .session-card.drop-before, .session-card.drop-after")
    .forEach((el) => {
      if (el !== card) {
        el.classList.remove("drop-target", "drop-before", "drop-after");
      }
    });
  card.classList.add("drop-target");
  card.classList.toggle("drop-before", position === "before");
  card.classList.toggle("drop-after", position !== "before");
}

function getSidebarDropPosition(card, clientY, target = null) {
  const header = card?.querySelector(".session-card-header");
  const accordion = card?.querySelector(".session-card-accordion");
  if (accordion && !accordion.hidden && target && accordion.contains(target)) {
    return "after";
  }
  if (header) {
    const headerRect = header.getBoundingClientRect();
    if (clientY >= headerRect.bottom) {
      return "after";
    }
    return clientY < headerRect.top + headerRect.height / 2 ? "before" : "after";
  }
  const rect = card.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function getSidebarSections() {
  return sessionSidebarEl ? [...sessionSidebarEl.querySelectorAll(".session-sidebar-section")] : [];
}

function getSidebarSectionForPoint(clientX, clientY) {
  const sections = getSidebarSections();
  if (sections.length === 0) return null;
  const containing = sections.find((section) => {
    const rect = section.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  });
  if (containing) return containing;
  return sections.reduce((best, section) => {
    const rect = section.getBoundingClientRect();
    const verticalDistance = clientY < rect.top
      ? rect.top - clientY
      : clientY > rect.bottom
        ? clientY - rect.bottom
        : 0;
    if (!best || verticalDistance < best.distance) {
      return { section, distance: verticalDistance };
    }
    return best;
  }, null)?.section ?? sections[0];
}

function resolveSidebarDropDestination(event) {
  if (!sessionSidebarEl || !state.sidebarDrag) return null;
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const pointTarget = document.elementFromPoint(clientX, clientY);
  const eventTarget = event?.target instanceof Element ? event.target : null;
  const targetEl = pointTarget instanceof Element ? pointTarget : eventTarget;
  const sectionEl = targetEl?.closest(".session-sidebar-section") ?? getSidebarSectionForPoint(clientX, clientY);
  if (!sectionEl) return null;
  const sectionKey = sectionEl.dataset.sidebarSection;
  const cards = [...sectionEl.querySelectorAll(".session-card")]
    .filter((card) => card.dataset.workspaceId !== state.sidebarDrag.workspaceId);
  const pointedCard = targetEl?.closest(".session-card");
  if (pointedCard && pointedCard.dataset.workspaceId !== state.sidebarDrag.workspaceId) {
    return {
      sectionEl,
      sectionKey,
      card: pointedCard,
      position: getSidebarDropPosition(pointedCard, clientY, targetEl),
    };
  }
  if (cards.length === 0) {
    return { sectionEl, sectionKey, card: null, position: "after" };
  }
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      return { sectionEl, sectionKey, card, position: "before" };
    }
    if (clientY <= rect.bottom) {
      return {
        sectionEl,
        sectionKey,
        card,
        position: getSidebarDropPosition(card, clientY, targetEl),
      };
    }
  }
  return {
    sectionEl,
    sectionKey,
    card: cards.at(-1) ?? null,
    position: "after",
  };
}

function applySidebarDropDestination(destination) {
  clearSidebarDropIndicators();
  if (!destination?.sectionEl) return;
  destination.sectionEl.classList.add("drop-target");
  if (destination.card) {
    setSidebarDropTarget(destination.card, destination.position);
  }
}

function commitSidebarDrop(destination) {
  if (!state.sidebarDrag || !destination?.sectionKey) return;
  const layout = buildWorkspaceLayoutForDrop(
    state.sidebarDrag.workspaceId,
    destination.card?.dataset.workspaceId ?? null,
    destination.sectionKey,
    destination.position ?? "after",
  );
  clearSidebarDragState();
  void saveWorkspaceLayout(layout);
}

function buildWorkspaceLayoutFromIds(workspaceIds) {
  return workspaceIds.map((id, index) => ({ id, isSidebarActive: true, sortOrder: index }));
}

function buildWorkspaceLayoutForDrop(draggedWorkspaceId, targetWorkspaceId, targetSection, position = "after") {
  const workspaceIds = getSidebarActiveWorkspaces().map((workspace) => workspace.id).filter((id) => id !== draggedWorkspaceId);
  const fallbackIndex = workspaceIds.length;
  const targetIndex = targetWorkspaceId
    ? workspaceIds.indexOf(targetWorkspaceId)
    : -1;
  const insertIndex =
    targetIndex < 0
      ? fallbackIndex
      : position === "before"
        ? targetIndex
        : targetIndex + 1;

  workspaceIds.splice(Math.max(0, insertIndex), 0, draggedWorkspaceId);
  return buildWorkspaceLayoutFromIds(workspaceIds);
}

function hasWorkspaceSelection(workspaceId = state.workspaceId) {
  return Boolean(workspaceId && getWorkspaceById(workspaceId));
}

function isSlashCommandInput(text) {
  const normalized = String(text ?? "").trim();
  return normalized.startsWith("/") && !/[\r\n]/u.test(normalized);
}

function getWorkspaceContextModeValue(workspace) {
  if (workspace?.contextInjectionEnabled === true) return "on";
  if (workspace?.contextInjectionEnabled === false) return "off";
  return "default";
}

function formatWorkspaceContextHint(workspace) {
  const policy = workspace?.contextPolicy;
  if (!policy) {
    return "";
  }
  const effectiveLabel = policy.effective ? "ON" : "OFF";
  return `現在の有効状態: ${effectiveLabel} (${policy.reason})`;
}

function formatUserInputMetadata(metadata) {
  const chips = [];
  const normalized = metadata && typeof metadata === "object" ? metadata : null;
  if (!normalized) return chips;
  if (normalized.inputMode === "slash_command") {
    chips.push("/ passthrough");
  }
  if (normalized.context?.used) {
    const count = Number(normalized.context.messageCount || 0);
    const chars = Number(normalized.context.totalChars || 0);
    chips.push(count > 0 ? `context ${count}件 / ${chars} chars` : "context attached");
  }
  return chips;
}

function updateChatComposerState() {
  const hasWorkspace = hasWorkspaceSelection();
  const canSend = Boolean(
    state.bootReady &&
    hasWorkspace &&
    (getWorkspaceParentAgentName(state.workspaceId) || state.selectedAgent)
  );
  if (btnSendEl) btnSendEl.disabled = !canSend;
  if (chatInputEl) {
    chatInputEl.disabled = !hasWorkspace;
    chatInputEl.placeholder = hasWorkspace
      ? "メッセージを入力… bare prompt は親agentへ、agentName? prompt で対象agentへ、/command は raw passthrough"
      : "ワークスペースがありません。左の「＋ workspace 作成」から始めてください";
  }
}

function getWorkspaceAgents(workspaceId = state.workspaceId) {
  return state.workspaceAgents.get(workspaceId) ?? [];
}

function getWorkspaceParentAgentName(workspaceId = state.workspaceId) {
  const members = getWorkspaceAgents(workspaceId);
  return members.find((entry) => entry.isParent)?.agentName ?? members[0]?.agentName ?? null;
}

function getSelectedAgentInfo(agentName = state.selectedAgent) {
  return state.agents.find((agent) => agent.name === agentName) ?? null;
}

function isChatVisibleForWorkspace(workspaceId) {
  return state.activeTab === "chat" && state.workspaceId === workspaceId;
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tab}`);
  });
  if (tab === "terminal") {
    requestAnimationFrame(() => scheduleTerminalFit());
  }
  if (tab === "chat") {
    renderChatLog(state.workspaceId);
    renderChatRouteHint();
  }
  if (tab === "settings") {
    void renderSettingsScope();
  }
  if (tab === "agents") {
    renderAgentsScreen();
  }
  updateChatComposerState();
  renderSelectedAgentSummary();
}

function ensureExpandedSession(workspaceId) {
  state.expandedSessions.add(workspaceId);
}

function toggleExpandedSession(workspaceId) {
  if (state.expandedSessions.has(workspaceId)) {
    state.expandedSessions.delete(workspaceId);
  } else {
    state.expandedSessions.add(workspaceId);
    void loadWorkspaceTerminalStates(workspaceId);
  }
  renderSessionSidebar();
}

function populateAgentSelect(selectEl, { includeBlank = false } = {}) {
  if (!selectEl) return;
  const currentValue = selectEl.value;
  selectEl.innerHTML = "";
  if (includeBlank) {
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "未設定";
    selectEl.appendChild(blank);
  }
  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.name;
    option.textContent = `${agent.name} (${agent.type})`;
    selectEl.appendChild(option);
  }
  if ([...selectEl.options].some((option) => option.value === currentValue)) {
    selectEl.value = currentValue;
  } else if (selectEl.options.length > 0) {
    selectEl.selectedIndex = 0;
  }
}

function populateDiscordChannelSelect(selectEl, selectedValue = "") {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = Array.isArray(state.discordChannels) && state.discordChannels.length > 0
    ? "未設定"
    : "選択可能な Discord channel がありません";
  selectEl.appendChild(blank);
  for (const channel of Array.isArray(state.discordChannels) ? state.discordChannels : []) {
    const option = document.createElement("option");
    option.value = channel.id;
    option.textContent = channel.name ? `#${channel.name}` : channel.id;
    selectEl.appendChild(option);
  }
  selectEl.value = selectedValue || "";
}

function renderChatRouteHint() {
  if (!chatRouteHintEl) return;
  if (!hasWorkspaceSelection()) {
    applyAgentThemeToElement(chatRouteHintEl, state.selectedAgent);
    chatRouteHintEl.textContent = "ワークスペースがありません。左の「＋ workspace 作成」から始めてください";
    return;
  }
  const parentAgent = getWorkspaceParentAgentName(state.workspaceId);
  applyAgentThemeToElement(chatRouteHintEl, parentAgent ?? state.selectedAgent);
  chatRouteHintEl.innerHTML = parentAgent
    ? `bare prompt は <code>${escHtml(parentAgent)}</code> へ、<code>agentName? prompt</code> で子 agent へ送信、<code>/command</code> は raw passthrough`
    : `workspace を選択すると main chat を開始できます`;
}

function renderSelectedAgentSummary() {
  const workspace = getWorkspaceById();
  const agent = getSelectedAgentInfo(state.selectedAgent);
  let summaryAgentName = getWorkspaceParentAgentName(state.workspaceId) || state.selectedAgent;
  if (state.activeTab === "terminal" && state.selectedAgent) {
    summaryAgentName = state.selectedAgent;
    selectedAgentNameEl.textContent = workspace
      ? `${state.selectedAgent} · ${workspace.name}`
      : "ワークスペースがありません";
  } else if (state.activeTab === "agents") {
    selectedAgentNameEl.textContent = "Agents";
  } else if (state.activeTab === "settings") {
    summaryAgentName =
      state.settingsScope === "agent" && state.settingsAgentName
        ? state.settingsAgentName
        : getWorkspaceParentAgentName(state.settingsWorkspaceId || state.workspaceId) || state.selectedAgent;
    selectedAgentNameEl.textContent =
      state.settingsScope === "agent" && state.settingsAgentName
        ? `Agent settings · ${state.settingsAgentName}`
        : state.settingsScope === "session" && state.settingsWorkspaceId
          ? `Workspace settings · ${getWorkspaceById(state.settingsWorkspaceId)?.name ?? state.settingsWorkspaceId}`
          : state.settingsScope === "create-session"
            ? "workspace 作成"
            : "Default settings";
  } else {
    selectedAgentNameEl.textContent = workspace?.name ?? "ワークスペースがありません";
  }
  applyAgentThemeToElement(selectedAgentSummaryWrapEl, summaryAgentName);
  if (!selectedAgentStatusEl) return;
  const terminalOwnsSelectedAgent =
    terminal.agentName === state.selectedAgent &&
    terminal.workspaceId === state.workspaceId;
  const selectedAgentStatus =
    getSelectedAgentInfo(state.selectedAgent)?.status ??
    getSelectedAgentInfo(getWorkspaceParentAgentName(state.workspaceId))?.status ??
    "disconnected";
  const rawStatus =
    state.activeTab === "terminal" && terminalOwnsSelectedAgent
      ? getTerminalBadgeState()
      : selectedAgentStatus;
  const normalizedStatus = rawStatus === "idle" ? "ready" : rawStatus;
  selectedAgentStatusEl.className = `selected-agent-status ${normalizedStatus}`;
  selectedAgentStatusEl.textContent = getStatusLabel(normalizedStatus);
}

function stripTerminalAnsi(text) {
  return String(text ?? "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "");
}

function escapeTerminalRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── SSE ────────────────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource("/api/stream");

  const handleEvent = (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    handleCanonicalEvent(event);
  };
  es.onmessage = handleEvent;
  es.onopen = () => {
    void loadWorkspaces();
    void loadAgents();
    if (state.workspaceId) {
      void refreshMessageHistory(state.workspaceId);
    }
  };
  [
    "session.init",
    "message.user",
    "message.delta",
    "message.done",
    "tool.start",
    "tool.done",
    "run.done",
    "run.error",
    "status.change",
    "observer.notice",
    "approval.requested",
    "approval.expired",
    "approval.resolved",
    "coordination.updated",
    "coordination.notice",
    "schedule.changed",
    "semantic-lock.updated",
    "semantic-lock.notice",
    "workspace.rollback",
    "workspace.worktree.updated",
    "workspace.switched",
  ].forEach((type) => es.addEventListener(type, handleEvent));

  es.onerror = () => {
    setTimeout(connectSSE, 3000);
    es.close();
  };
}

// ── Canonical Event handler ────────────────────────────────────────────────

function handleCanonicalEvent(event) {
  const workspaceId = event.workspaceId ?? state.workspaceId;
  const { type, agentName } = event;
  const relevantToTerminal = isTerminalEventRelevant(agentName, workspaceId);

  switch (type) {
    case "session.init":
      updateAgentStatus(agentName, "idle");
      break;

    case "message.user":
      if (relevantToTerminal) {
        terminal.remoteTurnPromptSummary = summarizeTerminalMarkerText(event.content, `${agentName} prompt`);
        registerTerminalMarker("user", terminal.remoteTurnPromptSummary);
      }
      if (!hasWorkspaceMessage(workspaceId, (entry) =>
        entry.role === "user" &&
        entry.runId === event.runId &&
        entry.agentName === agentName
      )) {
        const msg = {
          role: "user",
          agentName,
          content: event.content ?? "",
          metadata: event.metadata ?? null,
          time: ts(),
          runId: event.runId,
        };
        pushMsg(workspaceId, msg);
        if (isChatVisibleForWorkspace(workspaceId)) appendMsgEl(msg);
      }
      break;

    case "message.delta":
      appendDelta(agentName, event.content, workspaceId);
      break;

    case "message.done":
      clearMessageCatchup(workspaceId, agentName);
      finalizeDelta(agentName, event.content, workspaceId, { runId: event.runId ?? null });
      if (relevantToTerminal) {
        registerTerminalMarker("model-done", summarizeTerminalResponse(agentName, event.content) || event.content);
        terminal.remoteTurnPromptSummary = "";
      }
      break;

    case "tool.start":
      appendToolCard(agentName, event.toolId, event.toolName, event.input, false, workspaceId);
      break;

    case "tool.done":
      updateToolCard(agentName, event.toolId, event.output, event.isError, workspaceId);
      break;

    case "run.done":
      clearMessageCatchup(workspaceId, agentName);
      removeTyping(agentName, workspaceId);
      finalizeDelta(agentName, event.text, workspaceId, { runId: event.runId ?? null });
      appendRunDone(agentName, workspaceId);
      updateAgentStatus(
        agentName,
        event.finalStatus === "waiting_input" || event.finalStatus === "quota_wait"
          ? event.finalStatus
          : event.finalStatus === "timeout"
            ? "running"
            : "idle",
      );
      if (!event.text) {
        void refreshMessageHistory(workspaceId);
      }
      break;

    case "run.error":
      clearMessageCatchup(workspaceId, agentName);
      removeTyping(agentName, workspaceId);
      finalizeDelta(agentName, undefined, workspaceId);
      if (relevantToTerminal) {
        registerTerminalMarker(event.cancelled ? "notice" : "error", event.message);
        terminal.remoteTurnPromptSummary = "";
      }
      if (isChatVisibleForWorkspace(workspaceId)) {
        appendSystemMsg(`❌ ${agentName} エラー: ${event.message}`);
      }
      updateAgentStatus(agentName, event.cancelled ? "idle" : "error");
      void refreshMessageHistory(workspaceId);
      break;

    case "status.change":
      if (workspaceId && agentName) {
        const currentSnapshot = getWorkspaceTerminalStateSnapshot(workspaceId, agentName);
        setWorkspaceTerminalState(workspaceId, agentName, {
          ...currentSnapshot,
          status: event.status,
          hasProcess: event.status !== "idle" ? true : currentSnapshot.hasProcess,
          readyForPrompt: event.status === "idle" ? true : currentSnapshot.readyForPrompt,
        });
      }
      if (relevantToTerminal && event.status === "running" && terminal.runtimeState !== "running") {
        registerTerminalMarker("model-start", terminal.remoteTurnPromptSummary || `${agentName} responding`, {
          activate: false,
        });
      }
      if (relevantToTerminal && event.status === "waiting_input" && terminal.runtimeState !== "waiting_input") {
        registerTerminalMarker("waiting-input", terminal.remoteTurnPromptSummary || "input required", {
          activate: false,
        });
      }
      if (relevantToTerminal && event.status === "quota_wait" && terminal.runtimeState !== "quota_wait") {
        registerTerminalMarker("notice", `${agentName} quota wait`, {
          activate: false,
        });
      }
      updateAgentStatus(agentName, event.status);
      if (event.status === "running") {
        showTyping(agentName, workspaceId);
      }
      break;

    case "observer.notice":
      if (relevantToTerminal) {
        registerTerminalMarker("notice", event.message || `${agentName} notice`, {
          activate: false,
        });
        if (event.kind === "quota_wait") {
          terminal.warningMessage = event.message || "";
        }
      }
      if (workspaceId === state.workspaceId && event.message) {
        showToast(`ℹ️ ${event.message}`, "warning", 4500);
      }
      break;

    case "approval.requested":
      if (relevantToTerminal) {
        terminal.approvalRequest = event.approval || null;
        registerTerminalMarker("waiting-input", event.approval?.summary || "approval required", {
          activate: false,
        });
        renderTerminalHeader();
      }
      if (workspaceId === state.workspaceId && event.approval?.summary) {
        showToast(`🛂 ${event.approval.summary}`, "warning", 5000);
      }
      break;

    case "approval.expired":
      if (relevantToTerminal) {
        terminal.approvalRequest = event.approval || null;
        renderTerminalHeader();
      }
      if (workspaceId === state.workspaceId) {
        showToast("⌛ 承認待ちが期限切れになりました", "warning", 5000);
      }
      break;

    case "approval.resolved":
      if (relevantToTerminal) {
        terminal.approvalRequest = event.approval || null;
        renderTerminalHeader();
      }
      break;

    case "coordination.updated":
      if ((state.settingsWorkspaceId || state.workspaceId) === workspaceId) {
        renderSessionCoordinationSummary(event.context || null);
        renderSessionClaimsPanel(event.context || null);
        renderSessionHandoffsPanel(event.context || null);
        setInlineHint(
          sessionCoordinationHintEl,
          `owner=${event.context?.ownerAgentName || "none"} / claims=${Array.isArray(event.context?.claims) ? event.context.claims.length : 0} / handoffs=${Array.isArray(event.context?.handoffQueue) ? event.context.handoffQueue.length : 0}`,
        );
        void loadSessionDurability(workspaceId);
      }
      break;

    case "coordination.notice":
      if (relevantToTerminal && event.message) {
        registerTerminalMarker("notice", event.message, { activate: false });
      }
      if (workspaceId === state.workspaceId && event.message) {
        showToast(`🧭 ${event.message}`, "info", 4500);
      }
      break;

    case "schedule.changed":
      if (state.settingsWorkspaceId || state.workspaceId) {
        void loadSessionAutomation(state.settingsWorkspaceId || state.workspaceId);
      }
      break;

    case "semantic-lock.updated":
      if ((state.settingsWorkspaceId || state.workspaceId) === workspaceId) {
        renderSessionLocksPanel(event.locks || []);
        setInlineHint(
          sessionReviewHintEl,
          `dirty=${state.settingsReviewSnapshot?.repository?.status?.dirtyCount ?? 0} / locks=${Array.isArray(event.locks) ? event.locks.length : 0} / isolated=${state.settingsWorktreeStatus?.isIsolated ? "yes" : "no"}`,
        );
      }
      break;

    case "semantic-lock.notice":
      if (terminal.workspaceId === workspaceId && event.message) {
        registerTerminalMarker("notice", event.message, { activate: false });
      }
      if (workspaceId === state.workspaceId && event.message) {
        showToast(`🔒 ${event.message}`, "warning", 5000);
      }
      break;

    case "workspace.rollback":
      if (workspaceId === state.workspaceId) {
        showToast("↩️ rollback を適用しました", "warning", 5000);
        void refreshSessionInspector(workspaceId);
        void refreshMessageHistory(workspaceId);
      }
      break;

    case "workspace.worktree.updated":
      if (workspaceId) {
        void loadWorkspaces();
        void loadSessionReview(workspaceId);
      }
      if (workspaceId === state.workspaceId && event.worktreePath) {
        showToast(`🌿 isolated worktree: ${event.worktreePath}`, "success", 5000);
      }
      break;

    case "workspace.switched":
      void loadWorkspaces();
      break;
  }
}

// ── Agent sidebar ──────────────────────────────────────────────────────────

async function loadAgents() {
  const res = await fetch("/api/agents");
  if (!res.ok) return;
  state.agents = await res.json();
  const validAgentNames = new Set(state.agents.map((agent) => agent.name));
  if (state.selectedAgent && !validAgentNames.has(state.selectedAgent)) {
    const workspaceMembers = hasWorkspaceSelection()
      ? getWorkspaceAgents(state.workspaceId).filter((member) => validAgentNames.has(member.agentName))
      : [];
    state.selectedAgent =
      getWorkspaceParentAgentName(state.workspaceId) ||
      workspaceMembers[0]?.agentName ||
      state.agents[0]?.name ||
      null;
  }
  if (state.settingsScope === "agent" && state.settingsAgentName && !validAgentNames.has(state.settingsAgentName)) {
    state.settingsScope = "global";
    state.settingsAgentName = null;
    state.settingsAgentMeta = null;
  }
  if (terminal.agentName && !validAgentNames.has(terminal.agentName)) {
    if (terminal.ws) {
      terminal.suppressNextCloseNotice = true;
      const previousWs = terminal.ws;
      terminal.ws = null;
      try { previousWs.close(); } catch {}
    }
    terminal.agentName = null;
    terminal.workspaceId = null;
    resetTerminalView();
    setTerminalConnectionState("disconnected");
    setTerminalRuntimeState("disconnected");
    setTerminalInputEnabled(false);
  }
  renderAgentList();
  populateAgentSelect(sessionCreateParentAgentEl);
  renderSessionSidebar();
  renderAgentsScreen();
  renderChatRouteHint();
  renderSelectedAgentSummary();
}

function renderAgentList() {
  if (!agentListEl) return;
  agentListEl.innerHTML = "";

  if (state.agents.length === 0) {
    agentListEl.innerHTML = '<p class="loading-note">agent がありません。config/agents.json を作成するか、ここで custom agent を追加してください</p>';
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

function renderSessionSidebar() {
  if (!sessionSidebarEl) return;
  if (state.sidebarDrag) {
    state.sidebarPendingRender = true;
    return;
  }
  state.sidebarPendingRender = false;
  state.sidebarDrag = null;
  sessionSidebarEl.innerHTML = "";

  const createCard = document.createElement("div");
  createCard.className = "session-create-card";
  createCard.innerHTML = `
    <button type="button" class="session-create-btn" ${state.bootReady ? "" : "disabled"}>
      <span>＋ workspace 作成</span>
      <span>${state.bootReady ? "ready" : "loading"}</span>
    </button>
  `;
  createCard.querySelector("button")?.addEventListener("click", () => {
    if (!state.bootReady) return;
    openSessionCreate();
  });
  sessionSidebarEl.appendChild(createCard);

  if (state.workspaces.length === 0) {
    const empty = document.createElement("div");
    empty.className = "loading-note";
    empty.textContent = "workspace がまだありません";
    sessionSidebarEl.appendChild(empty);
    return;
  }

  const sections = [
    {
      key: "all",
      label: `workspaces (${getSidebarActiveWorkspaces().length})`,
      hint: "CLI は Start ボタン、main chat、terminal 補助入力の送信時に起動します",
      workspaces: getSidebarActiveWorkspaces(),
    },
  ];

  for (const section of sections) {
    const sectionEl = document.createElement("section");
    sectionEl.className = "session-sidebar-section";
    sectionEl.dataset.sidebarSection = section.key;
    sectionEl.innerHTML = `
      <div class="session-sidebar-section-head">
        <div class="session-sidebar-section-title">${escHtml(section.label)}</div>
        <div class="session-sidebar-section-hint">${escHtml(section.hint)}</div>
      </div>
      <div class="session-sidebar-section-body"></div>
    `;
    const bodyEl = sectionEl.querySelector(".session-sidebar-section-body");

    if (section.workspaces.length === 0) {
      const empty = document.createElement("div");
      empty.className = "session-sidebar-section-empty";
      empty.textContent = "workspace はまだありません";
      bodyEl?.appendChild(empty);
    }

    for (const workspace of section.workspaces) {
      const parentAgent = getWorkspaceParentAgentName(workspace.id);
      const members = getWorkspaceAgents(workspace.id);
      const children = members.filter((entry) => !entry.isParent);
      const isExpanded = state.expandedSessions.has(workspace.id);
      if (isExpanded && !state.workspaceTerminalStateLoaded.has(workspace.id) && !state.workspaceTerminalStatePending.has(workspace.id)) {
        void loadWorkspaceTerminalStates(workspace.id);
      }
      const parentTheme = getAgentTheme(parentAgent);
      const card = document.createElement("div");
      card.className = `session-card ${workspace.id === state.workspaceId ? "active" : ""}`;
      card.dataset.agentTheme = parentTheme.key;
      card.dataset.workspaceId = workspace.id;
      card.dataset.sidebarSection = section.key;
      card.setAttribute("style", buildAgentThemeStyle(parentAgent));
      card.innerHTML = `
        <div class="session-card-header">
          <button
            type="button"
            class="session-drag-handle"
            data-session-drag="${workspace.id}"
            draggable="true"
            title="並び替え"
            aria-label="${escHtml(workspace.name)} をドラッグして並び替え"
          >⋮⋮</button>
          <button type="button" class="session-card-main" data-session-open="${workspace.id}">
            <div class="session-card-title">${escHtml(workspace.name)}</div>
            <div class="session-card-meta">
              <span class="session-parent-chip">${escHtml(parentAgent ?? "親agent未設定")}</span>
              <span>${members.length} agents</span>
            </div>
          </button>
          <div class="session-card-actions">
            <button type="button" class="session-action-btn" data-session-toggle="${workspace.id}" title="agent 一覧">${isExpanded ? "▼" : "▶"}</button>
            <button type="button" class="session-action-btn" data-session-settings="${workspace.id}" title="workspace 設定">⚙</button>
          </div>
        </div>
        <div class="session-card-accordion" ${isExpanded ? "" : "hidden"}></div>
      `;
      const dragHandle = card.querySelector(`[data-session-drag="${workspace.id}"]`);
      dragHandle?.addEventListener("dragstart", (event) => {
        state.sidebarDrag = { workspaceId: workspace.id, sourceSection: section.key };
        card.classList.add("dragging");
        event.dataTransfer?.setData("text/plain", workspace.id);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
        }
      });
      dragHandle?.addEventListener("dragend", () => {
        clearSidebarDragState();
      });
      const accordion = card.querySelector(".session-card-accordion");
      for (const member of members) {
        const agent = getSelectedAgentInfo(member.agentName);
        const terminalStateMeta = getSidebarTerminalStateMeta(workspace.id, member.agentName);
        const row = document.createElement("div");
        const rowTheme = getAgentTheme(member.agentName);
        row.className = `session-agent-row ${workspace.id === state.workspaceId && state.selectedAgent === member.agentName && state.activeTab === "terminal" ? "active" : ""}`;
        row.dataset.agentTheme = rowTheme.key;
        row.setAttribute("style", buildAgentThemeStyle(member.agentName));
        row.innerHTML = `
          <div class="status-dot ${terminalStateMeta.dotStatus}"></div>
          <button type="button" class="session-agent-main" data-session-terminal="${workspace.id}" data-agent-name="${member.agentName}">
            <div class="session-agent-head">
              <div class="session-agent-name" title="${escHtml(member.agentName)}">${escHtml(member.agentName)}</div>
            </div>
            <div class="session-agent-meta">
              <span class="session-agent-chip">${member.isParent ? "parent" : escHtml(agent?.type ?? "agent")}</span>
              <span class="session-agent-status-badge ${terminalStateMeta.badgeClass}">${terminalStateMeta.label}</span>
              <span class="session-agent-meta-text">${member.isParent ? "parent agent" : `${agent?.type ?? "agent"} · ${agent?.model || "model 未設定"}`}</span>
            </div>
          </button>
          <div class="session-agent-actions">
            ${terminalStateMeta.canStart ? `<button type="button" class="session-action-btn session-agent-start-btn" data-agent-start="${member.agentName}" data-start-workspace="${workspace.id}" title="CLI を起動">Start</button>` : ""}
            <button type="button" class="session-action-btn" data-agent-settings="${member.agentName}" data-settings-workspace="${workspace.id}" title="agent 設定">⚙</button>
            ${member.isParent ? "" : `<button type="button" class="session-action-btn" data-agent-remove="${member.agentName}" data-remove-workspace="${workspace.id}" title="child agent を外す">－</button>`}
          </div>
        `;
        accordion?.appendChild(row);
      }
      const availableChildAgents = state.agents.filter((agent) => !members.some((entry) => entry.agentName === agent.name));
      for (let index = children.length; index < 3; index += 1) {
        const emptySlot = document.createElement("div");
        const isMenuOpen = state.childAgentMenu?.workspaceId === workspace.id && state.childAgentMenu?.slotIndex === index;
        emptySlot.className = "session-empty-agent-slot";
        emptySlot.innerHTML = `
          <div class="session-empty-agent-slot-header">
            <span>child agent slot</span>
            <button
              type="button"
              class="session-empty-agent-slot-add"
              data-add-child="${workspace.id}"
              data-child-slot="${index}"
              title="child agent を追加"
              aria-expanded="${isMenuOpen ? "true" : "false"}"
              ${availableChildAgents.length === 0 ? "disabled" : ""}
            >＋</button>
          </div>
          ${isMenuOpen ? `
            <div class="session-add-child-menu" role="menu" aria-label="child agent 選択">
              ${availableChildAgents.map((agent) => `
                <button
                  type="button"
                  class="session-add-child-option"
                  role="menuitem"
                  data-add-child-option="${workspace.id}"
                  data-add-agent-name="${escHtml(agent.name)}"
                >
                  <span class="session-add-child-option-name">${escHtml(agent.name)}</span>
                  <span class="session-add-child-option-meta">${escHtml(agent.type ?? "agent")} · ${escHtml(agent.model || "model 未設定")}</span>
                </button>
              `).join("")}
            </div>
          ` : ""}
        `;
        accordion?.appendChild(emptySlot);
      }
      bodyEl?.appendChild(card);
    }

    sessionSidebarEl.appendChild(sectionEl);
  }
}

async function saveWorkspaceLayout(items) {
  const res = await fetch("/api/workspaces/layout", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ workspace 並び替えに失敗: ${err.error ?? res.status}`, "error");
    renderSessionSidebar();
    return;
  }
  await res.json().catch(() => null);
  await loadWorkspaces();
}

async function openWorkspaceChat(workspaceId) {
  const nextAgent = getWorkspaceParentAgentName(workspaceId) || state.selectedAgent;
  const switched = workspaceId === state.workspaceId
    ? true
    : await activateWorkspace(workspaceId, { preferredAgentName: nextAgent });
  if (!switched) return;
  switchTab("chat");
  renderChatRouteHint();
  renderSelectedAgentSummary();
  renderSessionSidebar();
  await refreshMessageHistory(workspaceId);
}

async function openAgentTerminal(workspaceId, agentName) {
  const switched = workspaceId === state.workspaceId
    ? true
    : await activateWorkspace(workspaceId, { preferredAgentName: agentName });
  if (!switched) return;
  selectAgent(agentName);
  await loadWorkspaceTerminalStates(workspaceId);
  const snapshot = getWorkspaceTerminalStateSnapshot(workspaceId, agentName);
  if (terminal.agentName !== agentName || terminal.workspaceId !== workspaceId) {
    resetTerminalView();
  }
  switchTab("terminal");
  renderSessionSidebar();
  requestAnimationFrame(() => {
    if (snapshot.hasProcess) {
      connectTerminal(agentName);
    } else {
      initXterm();
      if (terminal.xterm) {
        terminal.xterm.reset();
        terminal.xterm.clearSelection?.();
      }
      if (terminalFallbackEl) {
        terminalFallbackEl.textContent = "";
      }
      terminal.agentName = agentName;
      terminal.workspaceId = workspaceId;
      setTerminalConnectionState("disconnected");
      setTerminalRuntimeState("not_started");
      setTerminalInputEnabled(false);
      renderTerminalHeader();
      scheduleTerminalFit();
    }
    scheduleTerminalFit();
  });
}

function openSessionCreate() {
  state.settingsScope = "create-session";
  state.settingsWorkspaceId = null;
  populateAgentSelect(sessionCreateParentAgentEl);
  sessionCreateNameEl.value = "";
  sessionCreateWorkdirEl.value = "";
  switchTab("settings");
  renderSettingsScope();
}

function prepareSettingsScopeForTabOpen() {
  const activeWorkspace = getWorkspaceById(state.workspaceId);
  if (activeWorkspace) {
    state.settingsScope = "session";
    state.settingsWorkspaceId = activeWorkspace.id;
  } else {
    state.settingsScope = "global";
    state.settingsWorkspaceId = null;
  }
  state.settingsAgentName = null;
  populateAgentSelect(sessionCreateParentAgentEl);
}

async function openSessionSettings(workspaceId) {
  state.settingsScope = "session";
  state.settingsWorkspaceId = workspaceId;
  switchTab("settings");
  await renderSettingsScope();
}

async function openAgentSettings(agentName, workspaceId = state.workspaceId) {
  state.settingsScope = "agent";
  state.settingsAgentName = agentName;
  state.settingsWorkspaceId = workspaceId;
  switchTab("settings");
  await renderSettingsScope();
}

function toggleChildAgentMenu(workspaceId, slotIndex) {
  const isSameTarget = state.childAgentMenu?.workspaceId === workspaceId
    && state.childAgentMenu?.slotIndex === slotIndex;
  state.childAgentMenu = isSameTarget ? null : { workspaceId, slotIndex };
  renderSessionSidebar();
}

async function addChildAgentToWorkspace(workspaceId, agentName) {
  state.childAgentMenu = null;
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentName: agentName.trim() }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ child agent 追加に失敗: ${err.error ?? res.status}`, "error");
    renderSessionSidebar();
    return;
  }
  await loadWorkspaceAgents(workspaceId);
  renderSessionSidebar();
}

async function removeWorkspaceAgentFromSession(workspaceId, agentName) {
  if (!confirm(`${agentName} をこの session から外しますか？`)) return;
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentName)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ child agent 削除に失敗: ${err.error ?? res.status}`, "error");
    return;
  }
  await loadWorkspaceAgents(workspaceId);
  if (state.selectedAgent === agentName && state.workspaceId === workspaceId) {
    state.selectedAgent = getWorkspaceParentAgentName(workspaceId);
  }
  if (terminal.agentName === agentName && terminal.workspaceId === workspaceId) {
    switchTab("chat");
  }
  renderSessionSidebar();
  renderSelectedAgentSummary();
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

  btnSendEl.disabled = !state.bootReady;

  renderSessionSidebar();
  renderAgentsScreen();
  renderSelectedAgentSummary();
  syncTerminalStatusFromAgent(agentName, status);
}

function selectAgent(name) {
  state.selectedAgent = name;
  renderSelectedAgentSummary();
  renderSessionSidebar();

  // Update sidebar active state
  document.querySelectorAll(".agent-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.agent === name);
  });

  updateChatComposerState();
  renderTerminalHeader();
}

// ── Chat rendering ─────────────────────────────────────────────────────────

function getWorkspaceStreamKey(workspaceId, agentName) {
  return `${workspaceId}:${agentName}`;
}

function renderChatLog(workspaceId = state.workspaceId) {
  chatLogEl.innerHTML = "";
  if (!hasWorkspaceSelection(workspaceId)) {
    chatLogEl.innerHTML = `
      <div class="empty-chat">
        <div class="empty-chat-icon">🗂</div>
        <p>ワークスペースがありません</p>
        <p>左の「＋ workspace 作成」から始めてください。</p>
        <button type="button" class="btn-outline" data-empty-chat-action="create-workspace">workspace を作成</button>
      </div>
    `;
    return;
  }
  for (const key of [...state.deltaBubbles.keys()]) {
    if (key.startsWith(`${workspaceId}:`)) {
      state.deltaBubbles.delete(key);
    }
  }
  for (const key of [...state.typingEls.keys()]) {
    if (key.startsWith(`${workspaceId}:`)) {
      state.typingEls.delete(key);
    }
  }

  const msgs = state.chatLogs.get(workspaceId) ?? [];
  const workspace = getWorkspaceById(workspaceId);
  const parentAgent = getWorkspaceParentAgentName(workspaceId);
  applyAgentThemeToElement(chatLogEl, parentAgent ?? state.selectedAgent);

  if (msgs.length === 0) {
    chatLogEl.innerHTML = `
      <div class="empty-chat">
        <div class="empty-chat-icon">🤖</div>
        <p>${escHtml(workspace?.name ?? workspaceId)} の main chat</p>
        <p>${parentAgent ? `bare prompt は ${escHtml(parentAgent)} に送信されます` : "workspace を作成すると会話を開始できます"}</p>
      </div>
    `;
    return;
  }

  for (const msg of msgs) {
    appendMsgEl(msg, false);
  }

  scrollChatToBottom();
}

function stripGeminiContextEchoLinesForDisplay(text) {
  let cleaned = String(text ?? "");
  const hasWorkspaceContextEcho =
    /\[Context from recent workspace chat\]/i.test(cleaned) ||
    /(?:^|\n)\s*You -> [A-Za-z0-9_-]+:/m.test(cleaned);
  if (!hasWorkspaceContextEcho) return cleaned;
  cleaned = cleaned.replace(/(?:^|\n)\s*You -> [A-Za-z0-9_-]+:\s*[^\n]*\n?/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*[a-z][a-z0-9_-]{0,63}:\s*[^\n]*\n?/g, "\n");
  return cleaned;
}

function getGeminiDisplayParagraphLead(paragraph) {
  const lines = String(paragraph ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    first: lines[0] ?? "",
    pair: lines.slice(0, 2).join("\n"),
  };
}

function compactRepeatedGeminiDisplayParagraphs(text) {
  const paragraphs = String(text ?? "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const compacted = [];

  for (const paragraph of paragraphs) {
    const previous = compacted.at(-1);
    if (!previous) {
      compacted.push(paragraph);
      continue;
    }
    if (paragraph === previous || previous.startsWith(paragraph)) {
      continue;
    }

    const previousLead = getGeminiDisplayParagraphLead(previous);
    const nextLead = getGeminiDisplayParagraphLead(paragraph);
    const sameLead =
      (previousLead.pair && previousLead.pair === nextLead.pair) ||
      (previousLead.first && previousLead.first === nextLead.first);

    if (paragraph.startsWith(previous) || sameLead) {
      if (paragraph.length >= previous.length) {
        compacted[compacted.length - 1] = paragraph;
      }
      continue;
    }

    compacted.push(paragraph);
  }

  return compacted.join("\n\n").trim();
}

function sanitizeHistoricalGeminiMessage(content) {
  const raw = String(content ?? "").replace(/\u0007/g, "").replace(/\r/g, "");

  let cleaned = raw
    .replace(/[╭╮╰╯│]+/g, "\n")
    .replace(/[▀▄■□▪▁▂▃▄▅▆▇█]+/g, "\n")
    .replace(/[─━]{4,}/g, "\n")
    .replace(/(?:^|\n)\s*\[Context from recent workspace chat\]\s*\n?/gi, "\n")
    .replace(/\[Context from recent workspace chat\][\s\S]*?\[User prompt\]/gi, "\n")
    .replace(/(?:^|\n)\s*\?\s*for shortcuts\s*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*Shortcuts See \/help for more[\s\S]*?(?=\n(?:auto-accept edits|shell mode enabled|workspace \(\/directory\)|\/model|$))/gi, "\n")
    .replace(/(?:^|\n)\s*(?:auto-accept edits|shell mode enabled)[^\n]*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*Waiting for authentication\.\.\.[^\n]*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*\[User prompt\]\s*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*User:\s*\n?/g, "\n")
    .replace(/(?:^|\n)\s*workspace \(\/directory\)\s*\n[^\n]*\n(?:[^\n]*\n)?\s*\/model\s*\n[^\n]*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*\/model\s*\n[^\n]*\n?/gi, "\n")
    .trim();

  cleaned = stripGeminiContextEchoLinesForDisplay(cleaned);
  cleaned = compactRepeatedGeminiDisplayParagraphs(
    cleaned
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );

  if (!cleaned) {
    return raw.trim() || "[old Gemini terminal transcript hidden]";
  }
  if (/(?:Shortcuts See \/help|workspace \(\/directory\)|Double Esc clear|shell mode enabled|Waiting for authentication)/i.test(cleaned)) {
    return "[old Gemini terminal transcript hidden]";
  }
  return cleaned;
}

function isGeminiAgentMessage(msg) {
  const agentType = getSelectedAgentInfo(msg?.agentName)?.type ?? "";
  return agentType === "gemini" || /^gemini(?:[\d_-].*)?$/i.test(String(msg?.agentName ?? ""));
}

function getDisplayMessageContent(msg) {
  if ((msg?.role === "agent" || msg?.role === "assistant") && isGeminiAgentMessage(msg)) {
    return sanitizeHistoricalGeminiMessage(msg.content);
  }
  return String(msg?.content ?? "");
}

function appendMsgEl(msg, scroll = true) {
  // Remove empty state if present
  const emptyEl = chatLogEl.querySelector(".empty-chat");
  if (emptyEl) emptyEl.remove();

  const el = document.createElement("div");
  el.className = `msg ${msg.role}`;
  const displayContent = getDisplayMessageContent(msg);

  if (msg.role === "user") {
    const metadataChips = formatUserInputMetadata(msg.metadata);
    const targetLabel = msg.agentName
      ? `<span class="msg-target-chip" style="${buildAgentThemeStyle(msg.agentName)}" data-agent-theme="${getAgentTheme(msg.agentName).key}">${escHtml(msg.agentName)}</span>`
      : "";
    const metadataLabel = metadataChips.length > 0
      ? `<span class="msg-input-meta">${metadataChips.map((chip) => `<span class="msg-input-meta-chip">${escHtml(chip)}</span>`).join("")}</span>`
      : "";
    el.innerHTML = `
      <div class="msg-meta"><span class="msg-meta-main"><span class="msg-author-chip user">You</span>${targetLabel}${metadataLabel}</span><span>${msg.time}</span></div>
      <div class="msg-bubble">${escHtml(displayContent)}</div>
    `;
    enhanceBubbleLinks(el.querySelector(".msg-bubble"));
  } else if (msg.role === "agent") {
    const theme = getAgentTheme(msg.agentName);
    el.dataset.agentTheme = theme.key;
    el.setAttribute("style", buildAgentThemeStyle(msg.agentName));
    el.innerHTML = `
      <div class="msg-meta"><span class="msg-agent-chip">${escHtml(msg.agentName)}</span><span>${msg.time}</span></div>
      <div class="msg-bubble"></div>
    `;
    setAgentBubbleContent(el.querySelector(".msg-bubble"), displayContent);
  } else if (msg.role === "system") {
    el.innerHTML = `<div class="msg-bubble">${escHtml(displayContent)}</div>`;
    enhanceBubbleLinks(el.querySelector(".msg-bubble"));
  }

  chatLogEl.appendChild(el);
  if (scroll) scrollChatToBottom();
  return el;
}

function pushMsg(workspaceId, msg) {
  if (!state.chatLogs.has(workspaceId)) state.chatLogs.set(workspaceId, []);
  state.chatLogs.get(workspaceId).push(msg);
}

function hasWorkspaceMessage(workspaceId, predicate) {
  const messages = state.chatLogs.get(workspaceId) ?? [];
  return messages.some(predicate);
}

function getWorkspaceAgentMessageCount(workspaceId, agentName, role = "agent") {
  const messages = state.chatLogs.get(workspaceId) ?? [];
  return messages.filter((entry) => entry.role === role && entry.agentName === agentName).length;
}

function clearMessageCatchup(workspaceId, agentName) {
  const key = getWorkspaceStreamKey(workspaceId, agentName);
  const existing = state.messageCatchups.get(key);
  if (existing?.timerId) {
    clearTimeout(existing.timerId);
  }
  state.messageCatchups.delete(key);
}

function scheduleMessageCatchup(workspaceId, agentName, baselineAgentMessageCount, {
  attempts = 10,
  intervalMs = 1500,
} = {}) {
  if (!workspaceId || !agentName) return;
  clearMessageCatchup(workspaceId, agentName);
  const key = getWorkspaceStreamKey(workspaceId, agentName);
  const runCatchup = async () => {
    const current = state.messageCatchups.get(key);
    if (!current) return;
    await refreshMessageHistory(workspaceId);
    const latestAgentMessageCount = getWorkspaceAgentMessageCount(workspaceId, agentName, "agent");
    if (latestAgentMessageCount > current.baselineAgentMessageCount || current.remainingAttempts <= 1) {
      clearMessageCatchup(workspaceId, agentName);
      return;
    }
    current.remainingAttempts -= 1;
    current.timerId = setTimeout(() => {
      void runCatchup();
    }, intervalMs);
  };
  state.messageCatchups.set(key, {
    baselineAgentMessageCount,
    remainingAttempts: attempts,
    timerId: setTimeout(() => {
      void runCatchup();
    }, intervalMs),
  });
}

// Streaming delta
function appendDelta(agentName, content, workspaceId) {
  const streamKey = getWorkspaceStreamKey(workspaceId, agentName);
  if (!isChatVisibleForWorkspace(workspaceId)) {
    // Buffer off-screen
    state.deltaBuffers.set(streamKey, (state.deltaBuffers.get(streamKey) ?? "") + content);
    return;
  }

  let bubble = state.deltaBubbles.get(streamKey);
  if (!bubble) {
    const theme = getAgentTheme(agentName);
    const el = document.createElement("div");
    el.className = "msg agent";
    el.dataset.agentTheme = theme.key;
    el.setAttribute("style", buildAgentThemeStyle(agentName));
    el.innerHTML = `
      <div class="msg-meta"><span class="msg-agent-chip">${escHtml(agentName)}</span><span>${ts()}</span></div>
      <div class="msg-bubble"></div>
    `;
    chatLogEl.appendChild(el);
    bubble = el.querySelector(".msg-bubble");
    state.deltaBubbles.set(streamKey, bubble);
  }

  const nextContent = `${bubble.dataset.rawContent ?? ""}${String(content ?? "")}`;
  setAgentBubbleContent(bubble, nextContent, { streaming: true });
  pinTypingIndicator(agentName, workspaceId);
  scrollChatToBottom();
}

function finalizeDelta(agentName, fullContent, workspaceId, { runId = null } = {}) {
  const streamKey = getWorkspaceStreamKey(workspaceId, agentName);
  const buffered = state.deltaBuffers.get(streamKey) ?? "";
  const bubble = state.deltaBubbles.get(streamKey);
  const content = fullContent ?? (bubble ? bubble.dataset.rawContent : buffered);
  const hasExistingMessage = runId
    ? hasWorkspaceMessage(workspaceId, (entry) =>
      entry.role === "agent" &&
      entry.runId === runId &&
      entry.agentName === agentName
    )
    : false;

  // If we have a bubble, it's already rendered
  if (!bubble && content && !hasExistingMessage && isChatVisibleForWorkspace(workspaceId)) {
    const msg = { role: "agent", agentName, content, time: ts(), runId };
    pushMsg(workspaceId, msg);
    appendMsgEl(msg);
  } else if (content && !hasExistingMessage) {
    if (bubble) {
      setAgentBubbleContent(bubble, content);
    }
    pushMsg(workspaceId, { role: "agent", agentName, content, time: ts(), runId });
  } else if (content && bubble) {
    setAgentBubbleContent(bubble, content);
  }

  state.deltaBubbles.delete(streamKey);
  state.deltaBuffers.delete(streamKey);
}

function appendSystemMsg(text) {
  const el = document.createElement("div");
  el.className = "msg system";
  el.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  chatLogEl.appendChild(el);
  scrollChatToBottom();
}

function appendRunDone(agentName, workspaceId) {
  if (!isChatVisibleForWorkspace(workspaceId)) return;

  const badge = document.createElement("div");
  badge.className = "run-done-badge";
  badge.textContent = `✅ ${agentName} 完了`;
  chatLogEl.appendChild(badge);
  scrollChatToBottom();
}

// Tool cards
function appendToolCard(agentName, toolId, toolName, input, isError, workspaceId) {
  if (!isChatVisibleForWorkspace(workspaceId)) return;

  const theme = getAgentTheme(agentName);
  const card = document.createElement("div");
  card.className = "msg tool";
  card.dataset.agentTheme = theme.key;
  card.setAttribute("style", buildAgentThemeStyle(agentName));
  card.innerHTML = `
    <div class="tool-card" id="tool-${toolId}">
      <div class="tool-card-header">
        <span class="tool-card-badge">${escHtml(agentName)}</span>
        <span>${escHtml(toolName)}</span>
        <span style="margin-left:auto;font-size:10px;color:#6b7280">▼</span>
      </div>
      <div class="tool-card-body">${input ? escHtml(JSON.stringify(input, null, 2)) : ""}</div>
    </div>
  `;
  const header = card.querySelector(".tool-card-header");
  header.addEventListener("click", () => card.querySelector(".tool-card").classList.toggle("open"));
  chatLogEl.appendChild(card);

  const streamKey = getWorkspaceStreamKey(workspaceId, agentName);
  if (!state.toolCards.has(streamKey)) state.toolCards.set(streamKey, new Map());
  state.toolCards.get(streamKey).set(toolId, card.querySelector(".tool-card"));

  scrollChatToBottom();
}

function updateToolCard(agentName, toolId, output, isError, workspaceId) {
  const card = state.toolCards.get(getWorkspaceStreamKey(workspaceId, agentName))?.get(toolId);
  if (!card) return;

  const body = card.querySelector(".tool-card-body");
  if (output) body.textContent = output;
  if (isError) card.style.borderColor = "#fcc";
  card.querySelector(".tool-card-header span:last-child").textContent = isError ? "❌" : "✅";
}

// Typing indicator
function formatTypingElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return `working... (${seconds}s)`;
}

function updateTypingIndicator(agentName, workspaceId) {
  const streamKey = getWorkspaceStreamKey(workspaceId, agentName);
  const el = state.typingEls.get(streamKey);
  if (!el) return;
  const statusEl = el.querySelector("[data-typing-status]");
  if (!statusEl) return;
  const startedAt = Number(el.dataset.startedAt || Date.now());
  statusEl.textContent = formatTypingElapsed(startedAt);
}

function pinTypingIndicator(agentName, workspaceId) {
  const streamKey = getWorkspaceStreamKey(workspaceId, agentName);
  const el = state.typingEls.get(streamKey);
  if (!el || !isChatVisibleForWorkspace(workspaceId)) return;
  chatLogEl.appendChild(el);
}

function showTyping(agentName, workspaceId) {
  if (!isChatVisibleForWorkspace(workspaceId)) return;
  const streamKey = getWorkspaceStreamKey(workspaceId, agentName);
  if (state.typingEls.has(streamKey)) {
    updateTypingIndicator(agentName, workspaceId);
    pinTypingIndicator(agentName, workspaceId);
    scrollChatToBottom();
    return;
  }
  const theme = getAgentTheme(agentName);
  const el = document.createElement("div");
  el.className = "typing-indicator";
  el.dataset.agentTheme = theme.key;
  el.dataset.startedAt = String(Date.now());
  el.setAttribute("style", buildAgentThemeStyle(agentName));
  el.innerHTML = `
    <span class="typing-label">${escHtml(agentName)}</span>
    <span class="typing-status-text" data-typing-status></span>
  `;
  chatLogEl.appendChild(el);
  state.typingEls.set(streamKey, el);
  state.typingTimers.set(streamKey, setInterval(() => updateTypingIndicator(agentName, workspaceId), 1000));
  updateTypingIndicator(agentName, workspaceId);
  scrollChatToBottom();
}

function removeTyping(agentName, workspaceId) {
  const streamKey = getWorkspaceStreamKey(workspaceId, agentName);
  const timerId = state.typingTimers.get(streamKey);
  if (timerId) {
    clearInterval(timerId);
    state.typingTimers.delete(streamKey);
  }
  const el = state.typingEls.get(streamKey);
  if (el) { el.remove(); state.typingEls.delete(streamKey); }
}

// ── Send message ───────────────────────────────────────────────────────────

function resolveChatTarget(rawPrompt) {
  const prompt = String(rawPrompt || "").trim();
  const workspaceMembers = getWorkspaceAgents(state.workspaceId)
    .map((entry) => String(entry.agentName || "").trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const genericPrefixedMatch = prompt.match(/^(\S+)\?\s*([\s\S]*)$/);
  const prefixedAgent = workspaceMembers.find((agentName) =>
    prompt.toLowerCase().startsWith(`${agentName}?`)
  );
  if (prefixedAgent) {
    const routedPrompt = prompt.slice(prefixedAgent.length + 1).trim();
    return {
      agentName: prefixedAgent,
      prompt: routedPrompt,
      displayPrompt: routedPrompt,
      inputMode: isSlashCommandInput(routedPrompt) ? "slash_command" : "prompt",
    };
  }
  if (genericPrefixedMatch) {
    const targetAgent = genericPrefixedMatch[1].toLowerCase();
    throw new Error(`agent "${targetAgent}" はこの session に追加されていません。`);
  }
  const parentAgent = getWorkspaceParentAgentName(state.workspaceId);
  if (!parentAgent) {
    throw new Error("この session に親 agent が設定されていません。");
  }
  return {
    agentName: parentAgent,
    prompt,
    displayPrompt: prompt,
    inputMode: isSlashCommandInput(prompt) ? "slash_command" : "prompt",
  };
}

async function sendMessage() {
  if (btnSendEl.disabled) return;
  const workspaceId = state.workspaceId;
  const prompt = chatInputEl.value.trim();
  if (!prompt || !workspaceId) return;

  let route;
  try {
    route = resolveChatTarget(prompt);
  } catch (error) {
    showToast(`❌ ${error.message}`, "error");
    return;
  }

  const agentName = route.agentName;
  const baselineAgentMessageCount = getWorkspaceAgentMessageCount(workspaceId, agentName, "agent");
  btnSendEl.disabled = true;

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: route.prompt,
        workspaceId,
        inputMode: route.inputMode || "prompt",
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "送信失敗" }));
      showToast(`❌ ${err.error ?? "送信失敗"}`, "error");
      return;
    }

    chatInputEl.value = "";
    chatInputEl.style.height = "";
    void loadWorkspaceTerminalStates(workspaceId, { force: true });
    scheduleMessageCatchup(workspaceId, agentName, baselineAgentMessageCount);
  } catch (e) {
    showToast(`❌ ネットワークエラー: ${e.message}`, "error");
  } finally {
    btnSendEl.disabled = false;
  }
}

// ── Workspace ──────────────────────────────────────────────────────────────

async function loadWorkspaces() {
  const res = await fetch("/api/workspaces");
  if (!res.ok) return;
  const workspaces = await res.json();
  state.workspaces = workspaces;
  const previousWorkspaceId = state.workspaceId;
  const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const activeWorkspaceId = workspaces.find((workspace) => workspace.isActive)?.id
    ?? workspaces[0]?.id
    ?? null;
  const nextWorkspaceId = validWorkspaceIds.has(previousWorkspaceId)
    ? previousWorkspaceId
    : activeWorkspaceId;
  for (const workspaceId of [...state.workspaceAgents.keys()]) {
    if (!validWorkspaceIds.has(workspaceId)) {
      state.workspaceAgents.delete(workspaceId);
    }
  }
  for (const workspaceId of [...state.chatLogs.keys()]) {
    if (!validWorkspaceIds.has(workspaceId)) {
      state.chatLogs.delete(workspaceId);
    }
  }
  for (const workspaceId of [...state.expandedSessions]) {
    if (!validWorkspaceIds.has(workspaceId)) {
      state.expandedSessions.delete(workspaceId);
    }
  }
  for (const workspaceKey of [...state.workspaceTerminalStates.keys()]) {
    const separatorIndex = workspaceKey.indexOf(":");
    const workspaceId = separatorIndex >= 0 ? workspaceKey.slice(0, separatorIndex) : workspaceKey;
    if (!validWorkspaceIds.has(workspaceId)) {
      state.workspaceTerminalStates.delete(workspaceKey);
    }
  }
  for (const workspaceId of [...state.workspaceTerminalStateLoaded]) {
    if (!validWorkspaceIds.has(workspaceId)) {
      state.workspaceTerminalStateLoaded.delete(workspaceId);
    }
  }
  for (const workspaceId of [...state.workspaceTerminalStatePending]) {
    if (!validWorkspaceIds.has(workspaceId)) {
      state.workspaceTerminalStatePending.delete(workspaceId);
    }
  }

  workspaceSelectEl.innerHTML = "";
  for (const ws of workspaces) {
    const opt = document.createElement("option");
    opt.value = ws.id;
    opt.textContent = ws.name;
    if (ws.id === nextWorkspaceId) {
      opt.selected = true;
    }
    workspaceSelectEl.appendChild(opt);
  }
  state.workspaceId = nextWorkspaceId;
  if (nextWorkspaceId && workspaceSelectEl.value !== nextWorkspaceId) {
    workspaceSelectEl.value = nextWorkspaceId;
  }
  if (!nextWorkspaceId) {
    state.selectedAgent = null;
    if (terminal.ws) {
      terminal.suppressNextCloseNotice = true;
      const previousWs = terminal.ws;
      terminal.ws = null;
      try { previousWs.close(); } catch {}
    }
    terminal.agentName = null;
    terminal.workspaceId = null;
    resetTerminalView();
    setTerminalConnectionState("disconnected");
    setTerminalRuntimeState("disconnected");
    setTerminalInputEnabled(false);
  }
  await loadAllWorkspaceAgents();
  pruneTerminalSessions();
  refreshTerminalSessionLabels();
  renderTerminalSessions();
  renderSessionSidebar();
  renderChatRouteHint();
  updateChatComposerState();
  renderSelectedAgentSummary();
  renderTerminalHeader();
  if (nextWorkspaceId && previousWorkspaceId !== nextWorkspaceId) {
    await refreshMessageHistory(nextWorkspaceId);
  } else if (!nextWorkspaceId) {
    renderChatLog(null);
  }
}

async function loadWorkspaceAgents(workspaceId) {
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`);
    if (!res.ok) return;
    const members = await res.json();
    state.workspaceAgents.set(workspaceId, members);
  } catch {}
}

async function loadAllWorkspaceAgents() {
  await Promise.all(state.workspaces.map((workspace) => loadWorkspaceAgents(workspace.id)));
}

async function loadWorkspaceTerminalStates(workspaceId, { force = false } = {}) {
  if (!workspaceId) return;
  if (!force && (state.workspaceTerminalStateLoaded.has(workspaceId) || state.workspaceTerminalStatePending.has(workspaceId))) {
    return;
  }
  state.workspaceTerminalStatePending.add(workspaceId);
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal-states`);
    if (!res.ok) {
      throw new Error("terminal states の取得に失敗しました");
    }
    const snapshots = await res.json();
    for (const snapshot of snapshots) {
      if (snapshot?.agentName) {
        setWorkspaceTerminalState(workspaceId, snapshot.agentName, snapshot);
      }
    }
    const members = getWorkspaceAgents(workspaceId);
    for (const member of members) {
      if (!state.workspaceTerminalStates.has(getWorkspaceTerminalStateKey(workspaceId, member.agentName))) {
        setWorkspaceTerminalState(workspaceId, member.agentName, {});
      }
    }
    state.workspaceTerminalStateLoaded.add(workspaceId);
    if (state.workspaceId === workspaceId || state.expandedSessions.has(workspaceId)) {
      renderSessionSidebar();
    }
  } catch (error) {
    console.warn("[multiCLI] failed to load workspace terminal states", workspaceId, error);
  } finally {
    state.workspaceTerminalStatePending.delete(workspaceId);
  }
}

async function startWorkspaceAgentCli(workspaceId, agentName, { silent = false } = {}) {
  if (!workspaceId || !agentName) return false;
  setWorkspaceTerminalState(workspaceId, agentName, { status: "starting", hasProcess: true, readyForPrompt: false });
  renderSessionSidebar();
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/prewarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, waitForReadyMs: 4000 }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "CLI 起動に失敗しました" }));
      throw new Error(err.error || "CLI 起動に失敗しました");
    }
    await loadWorkspaceTerminalStates(workspaceId, { force: true });
    if (!silent) {
      showToast(`✅ ${agentName} を起動しました`, "success");
    }
    return true;
  } catch (error) {
    setWorkspaceTerminalState(workspaceId, agentName, {
      status: "error",
      hasProcess: false,
      readyForPrompt: false,
      warningMessage: error.message,
    });
    renderSessionSidebar();
    if (!silent) {
      showToast(`❌ ${error.message}`, "error");
    }
    return false;
  }
}

async function activateWorkspace(wsId, { preferredAgentName = state.selectedAgent } = {}) {
  if (!wsId) return false;
  const res = await fetch(`/api/workspaces/${wsId}/activate`, { method: "POST" });
  if (!res.ok) {
    showToast("❌ ワークスペース切り替えに失敗しました", "error");
    return false;
  }
  state.workspaceId = wsId;
  if (workspaceSelectEl.value !== wsId) {
    workspaceSelectEl.value = wsId;
  }
  renderTerminalHeader();
  renderChatRouteHint();
  await loadAgents();
  await loadWorkspaceAgents(wsId);
  const nextAgentName = preferredAgentName && state.agents.some((agent) => agent.name === preferredAgentName)
    ? preferredAgentName
    : getWorkspaceParentAgentName(wsId) ?? state.agents[0]?.name ?? null;
  if (nextAgentName) {
    selectAgent(nextAgentName);
  } else {
    state.selectedAgent = null;
    updateChatComposerState();
  }
  await refreshMessageHistory(wsId);
  renderSessionSidebar();
  return true;
}

workspaceSelectEl.addEventListener("change", async () => {
  await activateWorkspace(workspaceSelectEl.value);
});

btnWorkspaceAdd.addEventListener("click", async () => {
  const name = prompt("新しいワークスペース名:");
  if (!name?.trim()) return;
  // Auto-select if only one agent; otherwise prompt
  let parentAgent;
  if (state.agents.length === 1) {
    parentAgent = state.agents[0].name;
  } else {
    const agentNames = state.agents.map((a) => a.name).join(", ");
    parentAgent = prompt(`親エージェントを選択してください (${agentNames}):`);
    if (!parentAgent?.trim()) return;
  }
  const res = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim(), parentAgent: parentAgent.trim() }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ ワークスペース作成に失敗: ${err.error || res.status}`, "error");
    return;
  }
  const ws = await res.json();
  showToast(`✅ ワークスペース "${ws.name}" を作成しました`, "success");
  await loadWorkspaces();
  workspaceSelectEl.value = ws.id;
  await activateWorkspace(ws.id);
});

btnWorkspaceDel.addEventListener("click", async () => {
  const wsId = workspaceSelectEl.value;
  if (!wsId) { showToast("削除できる workspace がありません。", "error"); return; }
  const name = workspaceSelectEl.options[workspaceSelectEl.selectedIndex]?.text;
  if (!confirm(`ワークスペース "${name}" を削除しますか？\n（エージェントのセッション履歴は残ります）`)) return;
  const res = await fetch(`/api/workspaces/${wsId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(err.error ?? "❌ 削除に失敗しました", "error");
    return;
  }
  await loadWorkspaces();
  const fallbackWorkspaceId = state.workspaces.find((workspace) => workspace.isActive)?.id ?? state.workspaces[0]?.id ?? null;
  if (fallbackWorkspaceId) {
    workspaceSelectEl.value = fallbackWorkspaceId;
    await activateWorkspace(fallbackWorkspaceId);
  } else {
    renderChatLog(null);
  }
});

sessionSidebarEl?.addEventListener("click", (event) => {
  const createButton = event.target.closest(".session-create-btn");
  if (createButton) {
    openSessionCreate();
    return;
  }
  const sessionOpen = event.target.closest("[data-session-open]");
  if (sessionOpen) {
    void openWorkspaceChat(sessionOpen.getAttribute("data-session-open"));
    return;
  }
  const toggleButton = event.target.closest("[data-session-toggle]");
  if (toggleButton) {
    toggleExpandedSession(toggleButton.getAttribute("data-session-toggle"));
    return;
  }
  const sessionSettings = event.target.closest("[data-session-settings]");
  if (sessionSettings) {
    void openSessionSettings(sessionSettings.getAttribute("data-session-settings"));
    return;
  }
  const terminalButton = event.target.closest("[data-session-terminal]");
  if (terminalButton) {
    void openAgentTerminal(
      terminalButton.getAttribute("data-session-terminal"),
      terminalButton.getAttribute("data-agent-name"),
    );
    return;
  }
  const startAgent = event.target.closest("[data-agent-start]");
  if (startAgent) {
    void startWorkspaceAgentCli(
      startAgent.getAttribute("data-start-workspace"),
      startAgent.getAttribute("data-agent-start"),
    );
    return;
  }
  const agentSettings = event.target.closest("[data-agent-settings]");
  if (agentSettings) {
    void openAgentSettings(
      agentSettings.getAttribute("data-agent-settings"),
      agentSettings.getAttribute("data-settings-workspace") || state.workspaceId,
    );
    return;
  }
  const addChildOption = event.target.closest("[data-add-child-option]");
  if (addChildOption) {
    void addChildAgentToWorkspace(
      addChildOption.getAttribute("data-add-child-option"),
      addChildOption.getAttribute("data-add-agent-name"),
    );
    return;
  }
  const addChild = event.target.closest("[data-add-child]");
  if (addChild) {
    const workspaceId = addChild.getAttribute("data-add-child");
    const slotIndex = Number.parseInt(addChild.getAttribute("data-child-slot") || "0", 10);
    const members = getWorkspaceAgents(workspaceId).map((entry) => entry.agentName);
    const available = state.agents.filter((agent) => !members.includes(agent.name));
    if (available.length === 0) {
      showToast("追加できる agent がありません", "info");
      return;
    }
    toggleChildAgentMenu(workspaceId, slotIndex);
    return;
  }
  const removeChild = event.target.closest("[data-agent-remove]");
  if (removeChild) {
    void removeWorkspaceAgentFromSession(
      removeChild.getAttribute("data-remove-workspace"),
      removeChild.getAttribute("data-agent-remove"),
    );
  }
});

sessionSidebarEl?.addEventListener("dragover", (event) => {
  if (!state.sidebarDrag) return;
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
  applySidebarDropDestination(resolveSidebarDropDestination(event));
});

sessionSidebarEl?.addEventListener("drop", (event) => {
  if (!state.sidebarDrag) return;
  event.preventDefault();
  commitSidebarDrop(resolveSidebarDropDestination(event));
});

sessionSidebarEl?.addEventListener("dragleave", (event) => {
  if (!state.sidebarDrag) return;
  const nextTarget = event.relatedTarget instanceof Element ? event.relatedTarget : null;
  if (!nextTarget || !sessionSidebarEl.contains(nextTarget)) {
    clearSidebarDropIndicators();
  }
});

document.addEventListener("click", (event) => {
  if (!state.childAgentMenu) return;
  if (event.target.closest(".session-empty-agent-slot")) return;
  state.childAgentMenu = null;
  renderSessionSidebar();
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

chatLogEl?.addEventListener("click", (event) => {
  const fileLink = event.target.closest(".msg-file-link");
  if (fileLink) {
    event.preventDefault();
    void openChatFileViewer(fileLink.dataset.filePath || "");
    return;
  }
  const action = event.target.closest("[data-empty-chat-action]");
  if (!action) return;
  if (action.getAttribute("data-empty-chat-action") === "create-workspace") {
    openSessionCreate();
  }
});

btnChatFileViewerCloseEl?.addEventListener("click", () => {
  closeChatFileViewer();
});

// Tab switching
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    if (tab === "settings") {
      prepareSettingsScopeForTabOpen();
    }
    switchTab(tab);
    if (tab === "chat") {
      renderChatLog(state.workspaceId);
      renderChatRouteHint();
    }
    if (tab === "settings") {
      void renderSettingsScope();
    }
    if (tab === "agents") {
      renderAgentsScreen();
    }
    updateChatComposerState();
    renderSelectedAgentSummary();
  });
});

// Stop all
btnStopAll.addEventListener("click", async () => {
  if (!confirm("全エージェントを停止しますか？")) return;
  if (!state.workspaceId) return;
  for (const agent of state.agents) {
    if (agent.status === "running" || agent.status === "waiting_input") {
      await fetch(`/api/agents/${agent.name}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: state.workspaceId }),
      });
    }
  }
});

// ── Load history from API ──────────────────────────────────────────────────

async function loadMessageHistory(workspaceId) {
  if (!workspaceId) {
    return;
  }
  try {
    const res = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/messages?limit=100`
    );
    if (!res.ok) return;
    const messages = await res.json();
    state.chatLogs.set(workspaceId, messages.map((m) => ({
      role: m.role === "user" ? "user" : "agent",
      agentName: m.agentName,
      content: m.content ?? "",
      metadata: m.metadata ?? null,
      time: formatMessageTime(m.createdAt),
    })));
  } catch {
    // ignore
  }
}

async function refreshMessageHistory(workspaceId) {
  if (!workspaceId) {
    renderChatLog(null);
    return;
  }
  await loadMessageHistory(workspaceId);
  if (workspaceId === state.workspaceId && state.activeTab === "chat") {
    renderChatLog(workspaceId);
  }
}

// Override selectAgent to load history
const _selectAgent = selectAgent;
async function selectAgentWithHistory(name) {
  _selectAgent(name);
}
// Rebind
agentListEl.addEventListener("click", (e) => {
  const item = e.target.closest(".agent-item");
  if (item) selectAgentWithHistory(item.dataset.agent);
}, true);

// ── Terminal (xterm.js + WebSocket PTY) ───────────────────────────────────

const TERMINAL_SUBMIT_DELAY_MS = 120;
const TERMINAL_INPUT_MAX_HEIGHT = 120;
const TERMINAL_LAYOUT_STORAGE_KEY = "multiCLI-discord-base.terminalLayout.v1";
const TERMINAL_SESSION_LIMIT = 12;
const TERMINAL_LOCAL_COMPLETION_DELAY_MS = 400;
const TERMINAL_STATUS_TEXT = {
  disconnected: "disconnected",
  not_started: "not started",
  starting: "starting",
  ready: "ready",
  running: "running",
  waiting_input: "waiting input",
  quota_wait: "quota wait",
  error: "error",
};
const TERMINAL_MARKER_LIMIT = 120;
const TERMINAL_MARKER_META = {
  user: { label: "User submit", icon: "↗", color: "#5a9cf8" },
  "model-start": { label: "Model start", icon: "⋯", color: "#f4a261" },
  "model-done": { label: "Model done", icon: "✓", color: "#43b581" },
  "waiting-input": { label: "Waiting input", icon: "?", color: "#f1c40f" },
  error: { label: "Error", icon: "!", color: "#f04747" },
  notice: { label: "Notice", icon: "•", color: "#aab9ff" },
};
const TERMINAL_HEURISTICS = {
  gemini: {
    readyRe: /Type your message or @path/,
    waitingInputRe: /approve|allow|confirm\?|continue\?|y\/n|yes\/no|login:|auth:|password:|credentials|how would you like to authenticate|enter the authorization code|use enter to select|please visit the following url|select model|press esc to close/i,
    authRequiredRe: /Waiting for authentication|Sign in with Google|Use Gemini API key|Continue in your browser|Open this URL|How would you like to authenticate|Please visit the following URL to authorize the application|Enter the authorization code|Authentication consent could not be obtained|Failed to authenticate with authorization code|Failed to authenticate with user code/i,
    quotaRe: /usage limit|rate limit|quota|too many requests|retry after|available again|try again later/i,
    stillRunningRe: /thinking|running|processing|elapsed|\d{1,3}:\d{2}/i,
    readyReturnRe: /Type your message or @path/,
  },
  claude: {
    readyRe: /(?:^|\n)\s*(?:❯|>)\s*$/m,
    waitingInputRe: /Allow external CLAUDE\.md file imports\?|Do you trust the contents of this directory\?|approve|allow|confirm\?|continue\?|y\/n|yes\/no/i,
    authRequiredRe: /Allow external CLAUDE\.md file imports\?|Do you trust the contents of this directory\?/i,
    quotaRe: /usage limit|rate limit|quota|too many requests|try again later|available again/i,
    stillRunningRe: /thinking|running|processing|shimmying|gusting|\d{1,3}:\d{2}/i,
    readyReturnRe: /(?:^|\n)\s*(?:❯|>)\s*$/m,
  },
  copilot: {
    readyRe: /Type @ to mention files, # for issues\/PRs, \/ for commands, or \? for shortcuts/i,
    waitingInputRe: /Do you trust the files in this folder\?|↑↓ to navigate|Enter to select|Esc to cancel|approve|allow|confirm\?|continue\?|y\/n|yes\/no/i,
    authRequiredRe: /Confirm folder trust|Do you trust the files in this folder\?|Sign in to GitHub|Log in to GitHub|Open this URL|Enter verification code/i,
    quotaRe: /usage limit|rate limit|quota|too many requests|try again later|available again/i,
    stillRunningRe: /thinking|running|processing|remaining reqs/i,
    readyReturnRe: /Type @ to mention files, # for issues\/PRs, \/ for commands, or \? for shortcuts/i,
  },
  codex: {
    waitingInputRe: /Do you trust the contents of this directory\?|approve|allow|confirm\?|continue\?|y\/n|yes\/no/i,
    authRequiredRe: /Do you trust the contents of this directory\?/i,
    quotaRe: /usage limit|rate limit|quota|too many requests|try again later|available again/i,
    stillRunningRe: /working|thinking|running|processing|booting mcp server|esc to interrupt/i,
  },
};

function readTerminalLayoutPrefs() {
  try {
    const raw = window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const recentSessions = Array.isArray(parsed.recentSessions)
      ? parsed.recentSessions
        .map((entry) => ({
          id: String(entry?.id ?? ""),
          agentName: String(entry?.agentName ?? ""),
          workspaceId: String(entry?.workspaceId ?? ""),
          workspaceName: String(entry?.workspaceName ?? ""),
          lastUsedAt: Number(entry?.lastUsedAt ?? 0),
        }))
        .filter((entry) => entry.id && entry.agentName && entry.workspaceId)
        .slice(0, TERMINAL_SESSION_LIMIT)
      : [];
    return {
      markerLayout: parsed.markerLayout === "bottom" ? "bottom" : "side",
      activeSessionId: typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : null,
      recentSessions,
    };
  } catch {
    return {
      markerLayout: "side",
      activeSessionId: null,
      recentSessions: [],
    };
  }
}

function normalizeCodexTerminalLines(text) {
  return String(text ?? "")
    .replace(/\u0007/g, "")
    .replace(/\r/g, "")
    .replace(/[╭╮╰╯─│]+/g, "\n")
    .replace(/■\s+/g, "\n■ ")
    .replace(/›\s+/g, "\n› ")
    .replace(/[▐▛▜▌▝▘█]+/g, " ")
    .replace(/[\u2800-\u28ff]/g, " ")
    .replace(/[◐◓◑◒]/g, " ")
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean);
}

function normalizeClaudeTerminalLines(text) {
  return String(text ?? "")
    .replace(/\u0007/g, "")
    .replace(/\r/g, "")
    .replace(/[╭╮╰╯─│]+/g, "\n")
    .replace(/[▐▛▜▌▝▘█]+/g, " ")
    .replace(/[\u2800-\u28ff]/g, " ")
    .replace(/[✻✶✢✳✽◐◓◑◒]/g, " ")
    .replace(/cx\s*▱.*$/gim, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean);
}

function claudeTerminalLooksReady(text) {
  return normalizeClaudeTerminalLines(text)
    .slice(-8)
    .some((line) => /^(?:❯|>)\s*$/.test(line));
}

function codexTerminalLooksReady(text, promptText = "") {
  const promptRe = promptText ? new RegExp(escapeTerminalRegExp(promptText), "g") : null;
  const normalizedText = promptRe ? String(text ?? "").replace(promptRe, " ") : String(text ?? "");
  const lines = normalizeCodexTerminalLines(normalizedText).slice(-6);
  if (lines.length < 2) return false;
  const lastLine = lines.at(-1) ?? "";
  const previousLine = lines.at(-2) ?? "";
  if (
    /Booting MCP server|Working\s*\(|esc to interrupt/i.test(lastLine) ||
    /Booting MCP server|Working\s*\(|esc to interrupt/i.test(previousLine)
  ) {
    return false;
  }
  return /^[›>]\s*/.test(previousLine) && /^gpt-\d[\w.\- ]*·/i.test(lastLine);
}

function matchesTerminalHeuristic(heuristics, key, text, promptText = "") {
  if (!heuristics) return false;
  const testFn = heuristics[`${key}Test`];
  if (typeof testFn === "function") {
    return testFn(text, promptText);
  }
  const pattern = heuristics[key];
  return pattern ? pattern.test(text) : false;
}

TERMINAL_HEURISTICS.codex.readyReTest = codexTerminalLooksReady;
TERMINAL_HEURISTICS.claude.readyReTest = claudeTerminalLooksReady;
TERMINAL_HEURISTICS.claude.readyReturnReTest = claudeTerminalLooksReady;

const initialTerminalLayoutPrefs = readTerminalLayoutPrefs();

const terminal = {
  xterm: null,
  fitAddon: null,
  searchAddon: null,
  searchResultsDisposable: null,
  webLinksAddon: null,
  fileLinkProviderDisposable: null,
  ws: null,
  agentName: null,
  workspaceId: null,
  resizeObserver: null,
  fallbackActive: false,
  plainBuffer: "",
  connectionState: "disconnected",
  runtimeState: "disconnected",
  lastRuntimeState: "disconnected",
  hasProcess: false,
  searchVisible: false,
  suppressNextCloseNotice: false,
  markers: [],
  markerSeq: 0,
  activeMarkerId: null,
  draftInputBuffer: "",
  localTurn: null,
  remoteTurnPromptSummary: "",
  seenReadyPrompt: false,
  configWarning: "",
  warningMessage: "",
  approvalRequest: null,
  quotaNotice: null,
  markerLayout: initialTerminalLayoutPrefs.markerLayout,
  recentSessions: initialTerminalLayoutPrefs.recentSessions,
  activeSessionId: initialTerminalLayoutPrefs.activeSessionId,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTerminalLocalCompletionDelay(agentName = terminal.agentName) {
  const agentType = getSelectedAgentInfo(agentName)?.type ?? "codex";
  if (agentType === "codex") return 2000;
  if (agentType === "copilot") return 800;
  return TERMINAL_LOCAL_COMPLETION_DELAY_MS;
}

function getTerminalHeuristics(agentName = terminal.agentName) {
  return TERMINAL_HEURISTICS[getSelectedAgentInfo(agentName)?.type ?? "codex"] ?? TERMINAL_HEURISTICS.codex;
}

function getTerminalSessionKey(agentName, workspaceId) {
  return `${workspaceId}:${agentName}`;
}

function getWorkspaceOptionLabel(workspaceId) {
  const option = [...(workspaceSelectEl?.options ?? [])].find((candidate) => candidate.value === workspaceId);
  return option?.textContent?.trim() || workspaceId;
}

function persistTerminalLayoutPrefs() {
  try {
    window.localStorage.setItem(
      TERMINAL_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        markerLayout: terminal.markerLayout,
        activeSessionId: terminal.activeSessionId,
        recentSessions: terminal.recentSessions.slice(0, TERMINAL_SESSION_LIMIT),
      }),
    );
  } catch {
    // ignore
  }
}

function pruneTerminalSessions() {
  const validWorkspaceIds = new Set([...(workspaceSelectEl?.options ?? [])].map((option) => option.value));
  const nextSessions = terminal.recentSessions.filter((entry) => validWorkspaceIds.has(entry.workspaceId));
  if (nextSessions.length === terminal.recentSessions.length) return;
  terminal.recentSessions = nextSessions;
  if (!terminal.recentSessions.some((entry) => entry.id === terminal.activeSessionId)) {
    terminal.activeSessionId = terminal.recentSessions[0]?.id ?? null;
  }
  persistTerminalLayoutPrefs();
}

function refreshTerminalSessionLabels() {
  terminal.recentSessions = terminal.recentSessions.map((entry) => ({
    ...entry,
    workspaceName: getWorkspaceOptionLabel(entry.workspaceId),
  }));
}

function renderTerminalSessions() {
  if (!terminalSessionListEl) return;
  const currentSessionId = terminal.agentName && terminal.workspaceId
    ? getTerminalSessionKey(terminal.agentName, terminal.workspaceId)
    : terminal.activeSessionId;
  if (terminalSessionCountEl) {
    terminalSessionCountEl.textContent = String(terminal.recentSessions.length);
  }
  if (terminalSessionHintEl) {
    terminalSessionHintEl.hidden = terminal.recentSessions.length > 0;
  }
  if (terminal.recentSessions.length === 0) {
    terminalSessionListEl.innerHTML = '<div class="terminal-session-empty">まだ recent CLI session はありません</div>';
    return;
  }

  terminalSessionListEl.innerHTML = "";
  for (const entry of terminal.recentSessions) {
    const row = document.createElement("div");
    row.className = `terminal-session-item${entry.id === currentSessionId ? " active" : ""}`;
    row.innerHTML = `
      <button type="button" class="terminal-session-target" data-session-id="${escHtml(entry.id)}">
        <span class="terminal-session-agent">${escHtml(entry.agentName)}</span>
        <span class="terminal-session-workspace">${escHtml(entry.workspaceName || entry.workspaceId)}</span>
        <span class="terminal-session-key">${escHtml(entry.id)}</span>
      </button>
      <button type="button" class="terminal-session-remove" data-session-remove="${escHtml(entry.id)}" title="一覧から外す">×</button>
    `;
    terminalSessionListEl.appendChild(row);
  }
}

function setTerminalLayoutMode(nextMode, { persist = true } = {}) {
  if (!terminalFeatureEnabled("layout")) return;
  terminal.markerLayout = nextMode === "bottom" ? "bottom" : "side";
  if (terminalLayoutEl) {
    terminalLayoutEl.dataset.markerLayout = terminal.markerLayout;
  }
  btnTerminalLayoutSideEl?.classList.toggle("active", terminal.markerLayout === "side");
  btnTerminalLayoutBottomEl?.classList.toggle("active", terminal.markerLayout === "bottom");
  if (persist) {
    persistTerminalLayoutPrefs();
  }
}

function rememberTerminalSession(agentName, workspaceId) {
  if (!agentName || !workspaceId) return;
  const sessionId = getTerminalSessionKey(agentName, workspaceId);
  const nextEntry = {
    id: sessionId,
    agentName,
    workspaceId,
    workspaceName: getWorkspaceOptionLabel(workspaceId),
    lastUsedAt: Date.now(),
  };
  terminal.recentSessions = [
    nextEntry,
    ...terminal.recentSessions.filter((entry) => entry.id !== sessionId),
  ].slice(0, TERMINAL_SESSION_LIMIT);
  terminal.activeSessionId = sessionId;
  persistTerminalLayoutPrefs();
  renderTerminalSessions();
}

function removeTerminalSession(sessionId) {
  terminal.recentSessions = terminal.recentSessions.filter((entry) => entry.id !== sessionId);
  if (terminal.activeSessionId === sessionId) {
    terminal.activeSessionId = terminal.recentSessions[0]?.id ?? null;
  }
  persistTerminalLayoutPrefs();
  renderTerminalSessions();
}

function inferTerminalFocusTarget() {
  const activeEl = document.activeElement;
  if (terminalSessionPaneEl?.contains(activeEl)) return "sessions";
  if (terminalMarkerPaneEl?.contains(activeEl)) return "markers";
  if (activeEl === terminalInputEl) return "composer";
  if (terminalShellEl?.contains(activeEl) || activeEl === terminalShellEl) return "terminal";
  return "terminal";
}

function getTerminalFocusTargets() {
  return [
    terminalSessionPaneEl ? "sessions" : null,
    "terminal",
    terminalMarkerPaneEl ? "markers" : null,
    terminalInputEl ? "composer" : null,
  ].filter(Boolean);
}

function focusTerminalPane(target) {
  switch (target) {
    case "sessions": {
      const targetButton = terminalSessionListEl?.querySelector(".terminal-session-item.active .terminal-session-target, .terminal-session-target");
      if (targetButton instanceof HTMLElement) {
        targetButton.focus();
      } else {
        terminalSessionPaneEl?.focus();
      }
      return;
    }
    case "markers": {
      const activeMarker = terminalMarkerListEl?.querySelector(".terminal-marker-item.active, .terminal-marker-item");
      if (activeMarker instanceof HTMLElement) {
        activeMarker.focus();
      } else {
        terminalMarkerPaneEl?.focus();
      }
      return;
    }
    case "composer":
      terminalInputEl?.focus();
      return;
    case "terminal":
    default:
      focusTerminalPrimaryInput();
  }
}

function cycleTerminalPaneFocus(direction = 1) {
  const targets = getTerminalFocusTargets();
  if (targets.length === 0) return;
  const currentIndex = targets.indexOf(inferTerminalFocusTarget());
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + direction + targets.length) % targets.length;
  focusTerminalPane(targets[nextIndex]);
}

function createTerminalFileLinkPatterns() {
  return [
    /["']((?:[A-Za-z]:[\\/]|\\\\)[^"'\r\n]+?(?::\d+(?::\d+)?)?)["']/g,
    /((?:[A-Za-z]:[\\/]|\\\\)[^\s<>"'\r\n]+(?:\:\d+(?::\d+)?)?)/g,
  ];
}

function normalizeTerminalFileLink(rawText) {
  const text = String(rawText ?? "")
    .trim()
    .replace(/^["'([{<]+/, "")
    .replace(/["')\]}>.,;:]+$/, "");
  const match = text.match(/^(?<path>(?:[A-Za-z]:[\\/]|\\\\).+?)(?::(?<line>\d+)(?::(?<column>\d+))?)?$/);
  if (!match?.groups?.path) return null;
  return {
    path: match.groups.path.replace(/\//g, "\\"),
    line: match.groups.line ? Number(match.groups.line) : null,
    column: match.groups.column ? Number(match.groups.column) : null,
  };
}

function getTerminalMarkerMeta(type) {
  return TERMINAL_MARKER_META[type] ?? TERMINAL_MARKER_META.notice;
}

function summarizeTerminalMarkerText(text, fallback = "") {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const base = normalized || fallback;
  if (!base) return "";
  return base.length > 140 ? `${base.slice(0, 137)}...` : base;
}

function summarizeCopilotTerminalResponse(rawText, promptSummary = "") {
  let cleaned = String(rawText ?? "").replace(/\r/g, "");
  if (promptSummary) {
    cleaned = cleaned.replace(new RegExp(escapeTerminalRegExp(promptSummary), "g"), " ");
  }
  cleaned = cleaned
    .replace(/[╭╮╰╯─│]+/g, "\n")
    .replace(/[█▘▝╴╶]+/g, " ")
    .replace(/(?:^|\n)\s*Type @ to mention files, # for issues\/PRs, \/ for commands, or \? for shortcuts\s*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*shift\+tab switch mode[^\n]*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*Remaining reqs\.[^\n]*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*Environment loaded:[^\n]*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*Describe a task to get started\.\s*\n?/gi, "\n")
    .replace(/(?:^|\n)\s*[◐◓◑◒]\s+[^\n]*\n?/g, "\n")
    .replace(/(?:^|\n)\s*●\s*Thinking[^\n]*\n?/gi, "\n");

  const responseBlocks = [...cleaned.matchAll(/(?:^|\n)●\s+(?!Thinking\b)([\s\S]*?)(?=\n(?:●\s*Thinking|❯\s|Type @ to mention files|shift\+tab switch mode|Remaining reqs\.|Environment loaded:|Describe a task to get started\.|$))/gi)]
    .map((match) => summarizeTerminalMarkerText(match[1]))
    .filter(Boolean);
  if (responseBlocks.length > 0) {
    return responseBlocks.at(-1) ?? "";
  }

  const cleanedLines = cleaned
    .split("\n")
    .map((line) => line.replace(/^[●❯]\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^(Type @ to mention files|shift\+tab switch mode|Remaining reqs\.|Environment loaded:|Describe a task to get started\.|Confirm folder trust|Do you trust the files in this folder\?)/i.test(line));
  return summarizeTerminalMarkerText(cleanedLines.at(-1) ?? "", "response");
}

function isCodexTerminalNoiseLine(line, promptSummary = "") {
  const trimmedLine = String(line ?? "").trim();
  const normalizedLine = trimmedLine.replace(/^[■•›>]\s*/, "").trim();
  const trimmedPrompt = String(promptSummary ?? "").trim();

  if (!normalizedLine) return true;
  if (trimmedPrompt && (
    normalizedLine === trimmedPrompt ||
    trimmedLine === trimmedPrompt ||
    trimmedLine === `› ${trimmedPrompt}` ||
    trimmedLine === `> ${trimmedPrompt}`
  )) {
    return true;
  }

  return /^(?:OpenAI Codex(?:\s+v[\d.]+)?|model:|directory:|Tip:|Booting MCP server:|Working\b|esc to interrupt\b|Use \/skills to list available skills|gpt-\d[\w.\- ]*·|Implement \{feature\}|Explain this codebase|Write tests for @filename|Find and fix a bug in @filename)$/i.test(normalizedLine);
}

function summarizeCodexTerminalResponse(rawText, promptSummary = "") {
  let cleaned = String(rawText ?? "").replace(/\r/g, "");
  if (promptSummary) {
    cleaned = cleaned.replace(new RegExp(escapeTerminalRegExp(promptSummary), "g"), " ");
  }

  const lines = normalizeCodexTerminalLines(cleaned);
  const usageIndex = lines.findIndex((line) => /You've hit your usage limit/i.test(line));
  if (usageIndex >= 0) {
    const usageSummary = lines
      .slice(usageIndex, usageIndex + 3)
      .map((line) => line.replace(/^■\s*/, "").replace(/\s+[›>].*$/u, "").trim())
      .filter(Boolean)
      .filter((line) => !/^Use \/skills to list available skills$/i.test(line))
      .filter((line) => !/^gpt-\d[\w.\- ]*·/i.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (usageSummary) {
      return summarizeTerminalMarkerText(usageSummary);
    }
  }

  const blocks = [];
  let currentBlock = null;

  for (const line of lines) {
    if (isCodexTerminalNoiseLine(line, promptSummary)) {
      if (currentBlock?.length) {
        blocks.push(currentBlock.join("\n").trim());
        currentBlock = null;
      }
      continue;
    }

    if (line.startsWith("■ ")) {
      if (currentBlock?.length) {
        blocks.push(currentBlock.join("\n").trim());
      }
      currentBlock = [line.slice(2).trim()];
      continue;
    }

    if (line.startsWith("› ") || line.startsWith("> ")) {
      if (currentBlock?.length) {
        blocks.push(currentBlock.join("\n").trim());
        currentBlock = null;
      }
      continue;
    }

    if (currentBlock) {
      currentBlock.push(line.trim());
    } else {
      currentBlock = [line.trim()];
    }
  }

  if (currentBlock?.length) {
    blocks.push(currentBlock.join("\n").trim());
  }

  const blockSummary = blocks
    .map((block) => summarizeTerminalMarkerText(block))
    .filter(Boolean)
    .at(-1);
  if (blockSummary) {
    return blockSummary;
  }

  const cleanedLines = lines
    .map((line) => line.replace(/^[■•›>]\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !isCodexTerminalNoiseLine(line, promptSummary));
  return summarizeTerminalMarkerText(cleanedLines.at(-1) ?? "", "response");
}

function summarizeTerminalResponse(agentName, rawText, promptSummary = "") {
  const agentType = getSelectedAgentInfo(agentName)?.type ?? "codex";
  const plain = stripTerminalAnsi(rawText).replace(/\r/g, "");
  if (!plain.trim()) return "";
  const scopeIndex = promptSummary
    ? (agentType === "codex" ? plain.indexOf(promptSummary) : plain.lastIndexOf(promptSummary))
    : -1;
  const scopedPlain = scopeIndex >= 0 ? plain.slice(scopeIndex) : plain;

  if (agentType === "gemini") {
    const inlineModelLines = [...scopedPlain.matchAll(/Model:\s*([^\n]+)/g)]
      .map((match) => summarizeTerminalMarkerText(match[1]))
      .filter(Boolean);
    if (inlineModelLines.length > 0) {
      return inlineModelLines.at(-1) ?? "";
    }
    const modelBlocks = [...scopedPlain.matchAll(/Model:\s*([\s\S]*?)(?=\n(?:workspace \(\/directory\)|User:|responding\b|auto-accept edits\b|Accepting edits\b|Type your message|$))/g)]
      .map((match) => summarizeTerminalMarkerText(match[1]))
      .filter(Boolean);
    if (modelBlocks.length > 0) {
      return modelBlocks.at(-1) ?? "";
    }
    if (promptSummary) {
      return "";
    }
  }

  if (agentType === "copilot") {
    return summarizeCopilotTerminalResponse(scopedPlain, promptSummary);
  }

  if (agentType === "codex") {
    return summarizeCodexTerminalResponse(scopedPlain, promptSummary);
  }

  const cleanedLines = scopedPlain
    .split("\n")
    .map((line) => line.replace(/^\s*Model:\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^(User:|workspace \(\/directory\)|no sandbox \/model|auto-accept edits|Accepting edits|Type your message|responding\b|\?\s*for shortcuts|gemini-\S+|Type @ to mention files|shift\+tab switch mode|Remaining reqs\.|Environment loaded:|Describe a task to get started\.)/i.test(line));
  return summarizeTerminalMarkerText(cleanedLines.at(-1) ?? "", "response");
}

function formatTerminalMarkerTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function getTerminalCurrentLine() {
  if (!terminal.xterm) return 0;
  const buffer = terminal.xterm.buffer.active;
  return Math.max(0, (buffer?.baseY ?? 0) + (buffer?.cursorY ?? 0));
}

function getTerminalMarkerLine(entry) {
  if (entry.marker && entry.marker.line >= 0) {
    return entry.marker.line;
  }
  return entry.lineSnapshot ?? 0;
}

function getOrderedTerminalMarkers() {
  return [...terminal.markers].sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
}

function removeTerminalMarker(markerId) {
  const index = terminal.markers.findIndex((entry) => entry.id === markerId);
  if (index < 0) return;
  terminal.markers.splice(index, 1);
  if (terminal.activeMarkerId === markerId) {
    terminal.activeMarkerId = terminal.markers.at(-1)?.id ?? null;
  }
  renderTerminalMarkers();
}

function disposeTerminalMarker(entry) {
  try { entry.disposeListener?.dispose?.(); } catch {}
  try { entry.decoration?.dispose?.(); } catch {}
  try { entry.marker?.dispose?.(); } catch {}
}

function clearTerminalMarkers() {
  if (terminal.localTurn?.completionTimer) {
    clearTimeout(terminal.localTurn.completionTimer);
  }
  const existing = [...terminal.markers];
  terminal.markers = [];
  for (const entry of existing) {
    disposeTerminalMarker(entry);
  }
  terminal.activeMarkerId = null;
  terminal.markerSeq = 0;
  terminal.draftInputBuffer = "";
  terminal.localTurn = null;
  terminal.remoteTurnPromptSummary = "";
  renderTerminalMarkers();
}

function setActiveTerminalMarker(markerId, { scroll = true } = {}) {
  const entry = terminal.markers.find((candidate) => candidate.id === markerId);
  if (!entry) return;
  terminal.activeMarkerId = markerId;
  if (scroll && terminal.xterm) {
    terminal.xterm.scrollToLine(Math.max(0, getTerminalMarkerLine(entry) - 2));
    focusTerminalPrimaryInput();
  }
  renderTerminalMarkers();
}

function navigateTerminalMarkers(direction) {
  if (!terminalFeatureEnabled("markers")) return;
  const ordered = getOrderedTerminalMarkers();
  if (ordered.length === 0) return;
  const activeIndex = ordered.findIndex((entry) => entry.id === terminal.activeMarkerId);
  const fallbackIndex = direction < 0 ? ordered.length - 1 : 0;
  const nextIndex = activeIndex < 0
    ? fallbackIndex
    : Math.max(0, Math.min(ordered.length - 1, activeIndex + direction));
  setActiveTerminalMarker(ordered[nextIndex].id);
}

function renderTerminalMarkers() {
  const ordered = getOrderedTerminalMarkers();
  if (terminalMarkerCountEl) {
    terminalMarkerCountEl.textContent = String(ordered.length);
  }

  if (ordered.length === 0) {
    if (terminalMarkerSummaryEl) {
      terminalMarkerSummaryEl.textContent = "AI turn marker はまだありません";
    }
    if (terminalMarkerOverviewEl) {
      terminalMarkerOverviewEl.innerHTML = "";
    }
    if (terminalMarkerListEl) {
      terminalMarkerListEl.innerHTML = '<div class="terminal-marker-empty">まだ marker はありません</div>';
    }
    if (btnTerminalMarkerPrevEl) btnTerminalMarkerPrevEl.disabled = true;
    if (btnTerminalMarkerNextEl) btnTerminalMarkerNextEl.disabled = true;
    return;
  }

  const activeMarker = ordered.find((entry) => entry.id === terminal.activeMarkerId) ?? ordered.at(-1) ?? null;
  if (activeMarker && !terminal.activeMarkerId) {
    terminal.activeMarkerId = activeMarker.id;
  }

  if (terminalMarkerSummaryEl) {
    const meta = activeMarker ? getTerminalMarkerMeta(activeMarker.type) : getTerminalMarkerMeta("notice");
    terminalMarkerSummaryEl.textContent = activeMarker
      ? `${meta.label}: ${activeMarker.summary}`
      : "AI turn marker はまだありません";
  }

  const totalLines = Math.max(1, terminal.xterm?.buffer.active.length ?? ordered.length);
  if (terminalMarkerOverviewEl) {
    terminalMarkerOverviewEl.innerHTML = "";
    const overviewEntries = ordered.map((entry, index) => ({
      entry,
      index,
      ratio: Math.max(0, Math.min(1, getTerminalMarkerLine(entry) / totalLines)),
    }));
    const offsetById = new Map();
    const lanePattern = [0, -14, 14, -28, 28, -42, 42];
    const flushOverviewCluster = (cluster) => {
      if (cluster.length === 0) return;
      for (const [clusterIndex, item] of cluster.entries()) {
        offsetById.set(item.entry.id, lanePattern[clusterIndex] ?? 0);
      }
    };
    let cluster = [];
    for (const item of [...overviewEntries].sort((left, right) => left.ratio - right.ratio || left.index - right.index)) {
      if (!cluster.length || Math.abs(item.ratio - cluster.at(-1).ratio) <= 0.03) {
        cluster.push(item);
        continue;
      }
      flushOverviewCluster(cluster);
      cluster = [item];
    }
    flushOverviewCluster(cluster);

    for (const [index, { entry, ratio }] of overviewEntries.entries()) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `terminal-marker-overview-item ${entry.type}${entry.id === terminal.activeMarkerId ? " active" : ""}`;
      item.title = `${getTerminalMarkerMeta(entry.type).label}: ${entry.summary}`;
      item.style.top = `calc(${ratio * 100}% - 3px)`;
      item.style.setProperty("--marker-offset", `${offsetById.get(entry.id) ?? 0}px`);
      item.style.zIndex = String(10 + index);
      item.addEventListener("click", () => setActiveTerminalMarker(entry.id));
      terminalMarkerOverviewEl.appendChild(item);
    }
  }

  if (terminalMarkerListEl) {
    terminalMarkerListEl.innerHTML = "";
    for (const entry of [...ordered].reverse()) {
      const meta = getTerminalMarkerMeta(entry.type);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `terminal-marker-item ${entry.type}${entry.id === terminal.activeMarkerId ? " active" : ""}`;
      button.innerHTML = `
        <div class="terminal-marker-item-header">
          <span class="terminal-marker-icon">${meta.icon}</span>
          <div class="terminal-marker-meta">
            <span class="terminal-marker-label">${meta.label}</span>
            <span class="terminal-marker-time">${formatTerminalMarkerTime(entry.createdAt)}</span>
          </div>
        </div>
        <div class="terminal-marker-text">${escHtml(entry.summary)}</div>
      `;
      button.addEventListener("click", () => setActiveTerminalMarker(entry.id));
      terminalMarkerListEl.appendChild(button);
    }
  }

  if (btnTerminalMarkerPrevEl) {
    btnTerminalMarkerPrevEl.disabled = ordered.length < 2;
  }
  if (btnTerminalMarkerNextEl) {
    btnTerminalMarkerNextEl.disabled = ordered.length < 2;
  }
}

function registerTerminalMarker(type, summary, { activate = true } = {}) {
  if (!terminal.agentName) return null;
  const normalizedSummary = summarizeTerminalMarkerText(summary, getTerminalMarkerMeta(type).label);
  const lastMarker = terminal.markers.at(-1);
  if (
    lastMarker &&
    lastMarker.type === type &&
    lastMarker.summary === normalizedSummary &&
    Date.now() - lastMarker.createdAt < 800
  ) {
    if (activate) {
      terminal.activeMarkerId = lastMarker.id;
      renderTerminalMarkers();
    }
    return lastMarker;
  }

  const marker = terminal.xterm?.registerMarker?.(0) ?? null;
  let disposeListener = null;
  const entry = {
    id: ++terminal.markerSeq,
    type,
    summary: normalizedSummary,
    createdAt: Date.now(),
    marker,
    decoration: null,
    disposeListener,
    lineSnapshot: getTerminalCurrentLine(),
  };

  if (marker?.onDispose) {
    disposeListener = marker.onDispose(() => removeTerminalMarker(entry.id));
    entry.disposeListener = disposeListener;
  }

  terminal.markers.push(entry);
  if (terminal.markers.length > TERMINAL_MARKER_LIMIT) {
    const overflow = terminal.markers.splice(0, terminal.markers.length - TERMINAL_MARKER_LIMIT);
    for (const oldEntry of overflow) disposeTerminalMarker(oldEntry);
  }
  if (activate) {
    terminal.activeMarkerId = entry.id;
  }
  renderTerminalMarkers();
  return entry;
}

function beginLocalTerminalTurn(summary) {
  const normalizedSummary = summarizeTerminalMarkerText(summary);
  if (!normalizedSummary) return;
  if (terminal.localTurn?.completionTimer) {
    clearTimeout(terminal.localTurn.completionTimer);
  }
  terminal.localTurn = {
    promptSummary: normalizedSummary,
    responseBuffer: "",
    modelStarted: false,
    waitingMarked: false,
    completionTimer: null,
  };
  registerTerminalMarker("user", normalizedSummary);
}

function handleTerminalDraftData(data) {
  if (!data) return;
  let buffer = terminal.draftInputBuffer;
  let skippingEscape = false;

  for (const char of data) {
    if (skippingEscape) {
      if (/[A-Za-z~]/.test(char)) {
        skippingEscape = false;
      }
      continue;
    }
    if (char === "\x1b") {
      skippingEscape = true;
      continue;
    }
    if (char === "\u007f") {
      buffer = buffer.slice(0, -1);
      continue;
    }
    if (char === "\r") {
      beginLocalTerminalTurn(buffer);
      buffer = "";
      continue;
    }
    if (char === "\n") {
      buffer += "\n";
      continue;
    }
    if (char >= " " || char === "\t") {
      buffer += char;
    }
  }

  terminal.draftInputBuffer = buffer.slice(-4000);
}

function updateLocalTurnFromOutput(plain, fullPlain) {
  const localTurn = terminal.localTurn;
  if (!localTurn) return;
  localTurn.responseBuffer = `${localTurn.responseBuffer}${plain}`.slice(-20000);

  if (!localTurn.modelStarted && (/(?:^|\n)\s*Model:\s*/.test(plain) || /responding\b/i.test(plain))) {
    localTurn.modelStarted = true;
    registerTerminalMarker("model-start", localTurn.promptSummary, { activate: false });
  }

  const heuristics = getTerminalHeuristics();
  if (!localTurn.waitingMarked && heuristics.waitingInputRe.test(plain) && !heuristics.stillRunningRe.test(plain)) {
    localTurn.waitingMarked = true;
    registerTerminalMarker("waiting-input", summarizeTerminalMarkerText(plain, "input required"));
  }

  const readyReturned =
    matchesTerminalHeuristic(heuristics, "readyRe", plain, localTurn.promptSummary) ||
    matchesTerminalHeuristic(heuristics, "readyReturnRe", plain, localTurn.promptSummary) ||
    matchesTerminalHeuristic(heuristics, "readyRe", fullPlain, localTurn.promptSummary) ||
    matchesTerminalHeuristic(heuristics, "readyReturnRe", fullPlain, localTurn.promptSummary);
  if (!readyReturned) return;

  if (localTurn.completionTimer) {
    clearTimeout(localTurn.completionTimer);
  }
  localTurn.completionTimer = setTimeout(() => {
    const pendingTurn = terminal.localTurn;
    if (!pendingTurn || pendingTurn !== localTurn) return;
    const responseSummary =
      summarizeTerminalResponse(terminal.agentName, terminal.plainBuffer, pendingTurn.promptSummary) ||
      summarizeTerminalResponse(terminal.agentName, pendingTurn.responseBuffer, pendingTurn.promptSummary);
    if (!responseSummary) return;
    if (!pendingTurn.modelStarted) {
      registerTerminalMarker("model-start", pendingTurn.promptSummary, { activate: false });
    }
    registerTerminalMarker("model-done", responseSummary);
    if (pendingTurn.completionTimer) {
      clearTimeout(pendingTurn.completionTimer);
    }
    terminal.localTurn = null;
  }, getTerminalLocalCompletionDelay(terminal.agentName));
}

function isTerminalEventRelevant(agentName, workspaceId = state.workspaceId) {
  return terminal.agentName === agentName && terminal.workspaceId === (workspaceId ?? state.workspaceId);
}

function updateTerminalSearchCount(resultIndex = -1, resultCount = 0) {
  if (!terminalSearchCountEl) return;
  const current = resultCount > 0 && resultIndex >= 0 ? resultIndex + 1 : 0;
  terminalSearchCountEl.textContent = `${current} / ${resultCount}`;
}

function autoResizeTerminalInput() {
  if (!terminalInputEl) return;
  terminalInputEl.style.height = "0px";
  terminalInputEl.style.height = `${Math.min(terminalInputEl.scrollHeight, TERMINAL_INPUT_MAX_HEIGHT)}px`;
  scheduleTerminalFit();
}

function getTerminalBadgeState() {
  if (!terminal.agentName) return "disconnected";
  if (!terminal.hasProcess && terminal.runtimeState === "not_started") return "not_started";
  if (terminal.connectionState === "error") return "error";
  if (terminal.connectionState === "connecting") return "starting";
  if (terminal.connectionState !== "open") return "disconnected";
  const heuristics = getTerminalHeuristics();
  if (
    terminal.plainBuffer &&
    !["running", "waiting_input", "quota_wait", "error"].includes(terminal.runtimeState) &&
    (
      matchesTerminalHeuristic(heuristics, "readyRe", terminal.plainBuffer, terminal.draftInputBuffer) ||
      matchesTerminalHeuristic(heuristics, "readyReturnRe", terminal.plainBuffer, terminal.draftInputBuffer)
    )
  ) {
    return "ready";
  }
  if (terminal.runtimeState && terminal.runtimeState !== "disconnected") {
    return terminal.runtimeState;
  }
  return "ready";
}

function renderTerminalHeader() {
  const workspaceId = terminal.workspaceId ?? state.workspaceId ?? null;
  const workspace = getWorkspaceById(workspaceId);
  const badgeState = getTerminalBadgeState();
  const canInteract = terminal.connectionState === "open" && terminal.hasProcess;
  const hasSelection = terminal.xterm?.hasSelection?.() ?? false;
  const hasBuffer = Boolean(terminal.plainBuffer.trim());
  const themeAgent = terminal.agentName || state.selectedAgent || getWorkspaceParentAgentName(workspaceId);
  const layoutEnabled = terminalFeatureEnabled("layout");
  const clearEnabled = terminalFeatureEnabled("clear");
  const clipboardEnabled = terminalFeatureEnabled("clipboard");
  const searchEnabled = terminalFeatureEnabled("search");
  const markerEnabled = terminalFeatureEnabled("markers");

  applyAgentThemeToElement(terminalToolbarEl, themeAgent);
  applyAgentThemeToElement(terminalLayoutEl, themeAgent);
  applyAgentThemeToElement(terminalMarkerPaneEl, themeAgent);
  setElementHidden(btnTerminalLayoutSideEl, !layoutEnabled);
  setElementHidden(btnTerminalLayoutBottomEl, !layoutEnabled);
  setElementHidden(btnTerminalClearEl, !clearEnabled);
  setElementHidden(btnTerminalCopyEl, !clipboardEnabled);
  setElementHidden(btnTerminalPasteEl, !clipboardEnabled);
  setElementHidden(btnTerminalSearchEl, !searchEnabled);
  setElementHidden(terminalMarkerPaneEl, !markerEnabled);
  if (!searchEnabled) {
    terminal.searchVisible = false;
    terminal.searchAddon?.clearDecorations?.();
    updateTerminalSearchCount(-1, 0);
  }
  if (terminalSearchBarEl) {
    terminalSearchBarEl.hidden = !searchEnabled || !terminal.searchVisible;
  }

  terminalAgentLabel.textContent = terminal.agentName
    ? `🖥 ${terminal.agentName} — raw PTY`
    : hasWorkspaceSelection(workspaceId)
      ? "エージェントを選択してください"
      : "ワークスペースを作成してください";
  if (terminalWorkspaceLabelEl) {
    terminalWorkspaceLabelEl.textContent = terminal.agentName
      ? `workspace: ${workspace?.name ?? workspaceId}`
      : hasWorkspaceSelection(workspaceId)
        ? "workspace: -"
        : "workspace: なし";
  }
  if (terminalSharedHintEl) {
    terminalSharedHintEl.textContent = terminal.agentName
      ? (
        terminal.hasProcess
          ? `shared PTY key: ${workspaceId}:${terminal.agentName} · Chat / Discord / Schedule と同じ stdin/stdout`
          : `shared PTY key: ${workspaceId}:${terminal.agentName} · 未起動。Start ボタンか送信で起動`
      )
      : hasWorkspaceSelection(workspaceId)
        ? "Chat / Discord / Schedule と同じ PTY stdin/stdout を共有"
        : "workspace がないため terminal は未接続です";
  }
  if (terminalConfigWarningEl) {
    const warningText = terminal.warningMessage || terminal.configWarning || "";
    terminalConfigWarningEl.textContent = warningText;
    terminalConfigWarningEl.hidden = !warningText;
  }
  if (terminalApprovalBannerEl) {
    const approval = terminal.approvalRequest;
    const approvalText = approval?.summary && ["pending", "expired"].includes(approval.status)
      ? (approval.status === "expired" ? `期限切れ: ${approval.summary}` : approval.summary)
      : "";
    terminalApprovalBannerEl.hidden = !approvalText;
    if (terminalApprovalTextEl) {
      terminalApprovalTextEl.textContent = approvalText;
    }
    btnTerminalApproveEl.disabled = !terminal.agentName || approval?.status !== "pending";
    btnTerminalDenyEl.disabled = !terminal.agentName || approval?.status !== "pending";
  }
  if (terminalStatusBadgeEl) {
    terminalStatusBadgeEl.className = `terminal-status-badge ${badgeState}`;
    terminalStatusBadgeEl.textContent = TERMINAL_STATUS_TEXT[badgeState] ?? badgeState;
  }

  btnTerminalReconnectEl.disabled = !terminal.agentName || !terminal.hasProcess;
  btnTerminalKill.disabled = !terminal.agentName || !terminal.hasProcess;
  btnTerminalLayoutSideEl.disabled = !layoutEnabled || !terminal.agentName;
  btnTerminalLayoutBottomEl.disabled = !layoutEnabled || !terminal.agentName;
  btnTerminalClearEl.disabled = !clearEnabled || (!hasBuffer && !terminal.xterm);
  btnTerminalCopyEl.disabled = !clipboardEnabled || (!hasBuffer && !hasSelection);
  btnTerminalPasteEl.disabled = !clipboardEnabled || !canInteract;
  btnTerminalSearchEl.disabled = !searchEnabled || !canInteract || !terminal.searchAddon;
  btnTerminalLayoutSideEl?.classList.toggle("active", terminal.markerLayout === "side");
  btnTerminalLayoutBottomEl?.classList.toggle("active", terminal.markerLayout === "bottom");
  renderTerminalSessions();
}

function setTerminalConnectionState(nextState) {
  terminal.connectionState = nextState;
  renderTerminalHeader();
}

function setTerminalRuntimeState(nextState) {
  terminal.lastRuntimeState = terminal.runtimeState;
  terminal.runtimeState = nextState;
  if (nextState === "ready") {
    terminal.seenReadyPrompt = true;
  }
  renderTerminalHeader();
  renderSelectedAgentSummary();
}

function syncTerminalStatusFromAgent(agentName, status) {
  if (state.workspaceId && agentName) {
    const currentSnapshot = getWorkspaceTerminalStateSnapshot(state.workspaceId, agentName);
    setWorkspaceTerminalState(state.workspaceId, agentName, {
      ...currentSnapshot,
      status,
      hasProcess: status === "idle" ? currentSnapshot.hasProcess : true,
      readyForPrompt: status === "idle",
    });
  }
  if (terminal.agentName !== agentName || terminal.workspaceId !== state.workspaceId) return;
  if (status === "idle") {
    if (terminal.connectionState === "open") {
      setTerminalRuntimeState("ready");
    }
    return;
  }
  if (status === "running" || status === "waiting_input" || status === "error") {
    setTerminalRuntimeState(status);
  }
  if (status === "quota_wait") {
    setTerminalRuntimeState(status);
  }
}

function fitTerminal() {
  if (!terminal.xterm || !terminal.fitAddon) return;
  try {
    terminal.fitAddon.fit();
  } catch {}

  if (terminal.xterm.cols > 1 && terminal.xterm.rows > 1) return;

  const rect = terminalContainerEl.getBoundingClientRect();
  const fallbackCols = Math.max(80, Math.floor(rect.width / 9));
  const fallbackRows = Math.max(24, Math.floor(rect.height / 19));
  terminal.xterm.resize(fallbackCols, fallbackRows);
}

const terminalFitTimers = new Set();

function syncTerminalResizeToServer() {
  if (terminal.ws?.readyState === WebSocket.OPEN && terminal.xterm) {
    const { cols, rows } = terminal.xterm;
    terminal.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    return;
  }
  if (terminal.ws?.readyState === WebSocket.OPEN) {
    terminal.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 30 }));
  }
}

function scheduleTerminalFit() {
  for (const timerId of terminalFitTimers) {
    clearTimeout(timerId);
  }
  terminalFitTimers.clear();

  const runFit = () => {
    fitTerminal();
    syncTerminalResizeToServer();
  };

  requestAnimationFrame(() => requestAnimationFrame(runFit));
  [80, 220, 420].forEach((delayMs) => {
    let timerId = null;
    timerId = setTimeout(() => {
      terminalFitTimers.delete(timerId);
      runFit();
    }, delayMs);
    terminalFitTimers.add(timerId);
  });
}

function setTerminalInputEnabled(enabled) {
  if (terminalInputEl) terminalInputEl.disabled = !enabled;
  if (btnTerminalSendEl) btnTerminalSendEl.disabled = !enabled;
  renderTerminalHeader();
}

function resetTerminalView() {
  terminal.fallbackActive = false;
  terminal.plainBuffer = "";
  terminal.searchVisible = false;
  terminal.draftInputBuffer = "";
  terminal.localTurn = null;
  terminal.remoteTurnPromptSummary = "";
  terminal.seenReadyPrompt = false;
  terminal.configWarning = "";
  terminal.warningMessage = "";
  terminal.approvalRequest = null;
  terminal.quotaNotice = null;
  terminal.hasProcess = false;
  terminalShellEl?.classList.remove("fallback-active");
  if (terminalFallbackEl) {
    terminalFallbackEl.hidden = true;
    terminalFallbackEl.textContent = "";
  }
  if (terminalSearchBarEl) {
    terminalSearchBarEl.hidden = true;
  }
  terminal.searchAddon?.clearDecorations?.();
  updateTerminalSearchCount(-1, 0);
  clearTerminalMarkers();
  renderTerminalHeader();
}

function activateTerminalFallback() {
  if (!terminalShellEl || terminal.fallbackActive) return;
  terminal.fallbackActive = true;
  terminalShellEl.classList.add("fallback-active");
  if (terminalFallbackEl) {
    terminalFallbackEl.hidden = false;
    terminalFallbackEl.textContent = terminal.plainBuffer;
    terminalFallbackEl.scrollTop = terminalFallbackEl.scrollHeight;
  }
}

function appendTerminalPlain(rawText) {
  const plain = stripTerminalAnsi(rawText);
  if (!plain) return;
  terminal.plainBuffer += plain;
  if (terminal.plainBuffer.length > 65536) {
    terminal.plainBuffer = terminal.plainBuffer.slice(-65536);
  }
  if (terminal.fallbackActive && terminalFallbackEl) {
    terminalFallbackEl.textContent = terminal.plainBuffer;
    terminalFallbackEl.scrollTop = terminalFallbackEl.scrollHeight;
  }
  renderTerminalHeader();
}

function writeTerminalNotice(text, ansiText = text) {
  appendTerminalPlain(`${text}\n`);
  if (terminal.xterm && !terminal.fallbackActive) {
    terminal.xterm.writeln(ansiText);
  }
}

function focusTerminalPrimaryInput() {
  if (terminal.xterm && !terminal.fallbackActive && terminal.connectionState === "open") {
    terminal.xterm.focus();
    return;
  }
  terminalInputEl?.focus();
}

async function sendTerminalRaw(text) {
  if (terminal.ws?.readyState !== WebSocket.OPEN) {
    showToast("❌ terminal が未接続です", "error");
    return false;
  }
  terminal.ws.send(text);
  return true;
}

function shouldUseTerminalPromptPipeline(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized || !terminal.agentName) return false;
  const snapshot = getWorkspaceTerminalStateSnapshot(terminal.workspaceId ?? state.workspaceId, terminal.agentName);
  if (!snapshot.hasProcess) return true;
  if (terminal.draftInputBuffer.trim()) return false;
  return getTerminalBadgeState() === "ready";
}

async function sendTerminalPrompt(text) {
  const agentName = terminal.agentName;
  const workspaceId = terminal.workspaceId ?? state.workspaceId;
  if (!agentName || !workspaceId) {
    showToast("❌ terminal 対象の agent が未選択です", "error");
    return false;
  }

  try {
    const inputMode = isSlashCommandInput(text) ? "slash_command" : "prompt";
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        workspaceId,
        source: "terminal",
        includeContext: false,
        inputMode,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "送信失敗" }));
      showToast(`❌ ${err.error ?? "送信失敗"}`, "error");
      return false;
    }
    terminal.remoteTurnPromptSummary = summarizeTerminalMarkerText(text, `${agentName} prompt`);
    void loadWorkspaceTerminalStates(workspaceId, { force: true });
    setTerminalRuntimeState("running");
    return true;
  } catch (error) {
    showToast(`❌ ネットワークエラー: ${error.message}`, "error");
    return false;
  }
}

async function sendTerminalInput(text, appendEnter = true) {
  if (!(await sendTerminalRaw(text))) {
    return false;
  }
  if (appendEnter) {
    beginLocalTerminalTurn(text);
  } else {
    terminal.draftInputBuffer = `${terminal.draftInputBuffer}${text}`.slice(-4000);
  }
  if (appendEnter) {
    setTerminalRuntimeState("running");
    await delay(TERMINAL_SUBMIT_DELAY_MS);
    if (!(await sendTerminalRaw("\r"))) {
      return false;
    }
  }
  return true;
}

async function submitTerminalInput() {
  const text = terminalInputEl?.value ?? "";
  if (!text.trim()) return;
  const sent = shouldUseTerminalPromptPipeline(text)
    ? await sendTerminalPrompt(text)
    : await sendTerminalInput(text, true);
  if (sent && terminalInputEl) {
    terminalInputEl.value = "";
    autoResizeTerminalInput();
    focusTerminalPrimaryInput();
  }
}

async function copyTerminalText(text) {
  if (!text) {
    showToast("ℹ️ コピーできる内容がありません", "info", 2500);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("✅ terminal 内容をコピーしました", "success", 2500);
  } catch {
    showToast("❌ クリップボードへのコピーに失敗しました", "error");
  }
}

async function copyTerminalSelectionOrBuffer() {
  const selectedText = terminal.xterm?.hasSelection?.() ? terminal.xterm.getSelection() : "";
  const text = selectedText || terminal.plainBuffer.trimEnd();
  await copyTerminalText(text);
  terminal.xterm?.clearSelection?.();
  renderTerminalHeader();
}

async function pasteIntoTerminal() {
  if (terminal.connectionState !== "open") {
    showToast("❌ terminal が未接続です", "error");
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      showToast("ℹ️ クリップボードは空です", "info", 2500);
      return;
    }
    await sendTerminalInput(text, false);
    focusTerminalPrimaryInput();
  } catch {
    showToast("❌ クリップボードの読み取りに失敗しました", "error");
  }
}

function clearTerminalViewport() {
  terminal.xterm?.clear?.();
  terminal.xterm?.clearSelection?.();
  terminal.plainBuffer = "";
  if (terminalFallbackEl) {
    terminalFallbackEl.textContent = "";
  }
  terminal.searchAddon?.clearDecorations?.();
  updateTerminalSearchCount(-1, 0);
  clearTerminalMarkers();
  renderTerminalHeader();
  showToast("✅ terminal 表示をクリアしました", "success", 2000);
}

function getTerminalSearchOptions({ incremental = false } = {}) {
  return {
    caseSensitive: Boolean(terminalSearchCaseEl?.checked),
    wholeWord: Boolean(terminalSearchWordEl?.checked),
    regex: Boolean(terminalSearchRegexEl?.checked),
    incremental,
    decorations: {
      matchBackground: "#264f78",
      matchBorder: "#5a9cf8",
      matchOverviewRuler: "#264f78",
      activeMatchBackground: "#d7ba7d",
      activeMatchBorder: "#ffd76b",
      activeMatchColorOverviewRuler: "#ffd76b",
    },
  };
}

function runTerminalSearch(direction = "next", { incremental = false } = {}) {
  if (!terminal.searchAddon) {
    showToast("ℹ️ terminal 検索 addon が読み込まれていません", "info", 2500);
    return false;
  }
  const term = terminalSearchInputEl?.value ?? "";
  if (!term) {
    terminal.searchAddon.clearDecorations?.();
    updateTerminalSearchCount(-1, 0);
    return false;
  }
  const searchOptions = getTerminalSearchOptions({ incremental });
  return direction === "previous"
    ? terminal.searchAddon.findPrevious(term, searchOptions)
    : terminal.searchAddon.findNext(term, searchOptions);
}

function openTerminalSearch() {
  if (!terminalFeatureEnabled("search") || !terminalSearchBarEl) return;
  terminal.searchVisible = true;
  terminalSearchBarEl.hidden = false;
  const selected = terminal.xterm?.hasSelection?.() ? terminal.xterm.getSelection().trim() : "";
  if (selected && terminalSearchInputEl && !terminalSearchInputEl.value) {
    terminalSearchInputEl.value = selected;
  }
  terminalSearchInputEl?.focus();
  terminalSearchInputEl?.select();
  if (terminalSearchInputEl?.value) {
    runTerminalSearch("next", { incremental: true });
  }
}

function closeTerminalSearch() {
  terminal.searchVisible = false;
  if (terminalSearchBarEl) {
    terminalSearchBarEl.hidden = true;
  }
  terminal.searchAddon?.clearDecorations?.();
  updateTerminalSearchCount(-1, 0);
  focusTerminalPrimaryInput();
}

function toggleTerminalSearch(forceVisible = !terminal.searchVisible) {
  if (!terminalFeatureEnabled("search")) {
    closeTerminalSearch();
    return;
  }
  if (forceVisible && !terminal.searchAddon) {
    showToast("ℹ️ terminal 検索 addon が読み込まれていません", "info", 2500);
    return;
  }
  if (forceVisible) {
    openTerminalSearch();
  } else {
    closeTerminalSearch();
  }
}

async function handleTerminalFileLink(linkText) {
  const normalized = normalizeTerminalFileLink(linkText);
  if (!normalized) return;
  const suffix = normalized.line
    ? `:${normalized.line}${normalized.column ? `:${normalized.column}` : ""}`
    : "";
  await copyTerminalText(`${normalized.path}${suffix}`);
}

function buildTerminalFileLinks(bufferLineNumber) {
  if (!terminal.xterm) return undefined;
  const line = terminal.xterm.buffer.active.getLine(bufferLineNumber - 1);
  const lineText = line?.translateToString(true) ?? "";
  if (!lineText) return undefined;

  const links = [];
  const seen = new Set();
  for (const pattern of createTerminalFileLinkPatterns()) {
    for (const match of lineText.matchAll(pattern)) {
      const matchedText = match[0];
      const startIndex = match.index ?? 0;
      if (!matchedText || seen.has(`${startIndex}:${matchedText}`)) continue;
      if (!normalizeTerminalFileLink(matchedText)) continue;
      seen.add(`${startIndex}:${matchedText}`);
      links.push({
        text: matchedText,
        range: {
          start: { x: startIndex + 1, y: bufferLineNumber },
          end: { x: startIndex + matchedText.length + 1, y: bufferLineNumber },
        },
        decorations: { underline: true, pointerCursor: true },
        activate: (_event, text) => {
          void handleTerminalFileLink(text);
        },
      });
    }
  }
  return links.length > 0 ? links : undefined;
}

function createTerminalFileLinkProvider() {
  return {
    provideLinks(bufferLineNumber, callback) {
      callback(buildTerminalFileLinks(bufferLineNumber));
    },
  };
}

function updateTerminalStateFromOutput(rawText) {
  const plain = stripTerminalAnsi(rawText);
  if (!plain) return;
  const fullPlain = terminal.plainBuffer;
  const heuristics = getTerminalHeuristics();
  updateLocalTurnFromOutput(plain, fullPlain);
  const hasActiveLocalTurn = Boolean(terminal.localTurn);
  const readyDetected =
    matchesTerminalHeuristic(heuristics, "readyRe", plain, terminal.draftInputBuffer) ||
    matchesTerminalHeuristic(heuristics, "readyRe", fullPlain, terminal.draftInputBuffer) ||
    matchesTerminalHeuristic(heuristics, "readyReturnRe", plain, terminal.draftInputBuffer) ||
    matchesTerminalHeuristic(heuristics, "readyReturnRe", fullPlain, terminal.draftInputBuffer);
  if (readyDetected) {
    terminal.seenReadyPrompt = true;
    if (!hasActiveLocalTurn) {
      setTerminalRuntimeState("ready");
    }
    return;
  }
  const explicitAuthStepRe = /Sign in with Google|Use Gemini API key|Continue in your browser|Open this URL/i;
  if (
    heuristics.authRequiredRe?.test(plain) &&
    (terminal.seenReadyPrompt || explicitAuthStepRe.test(plain))
  ) {
    if (terminal.runtimeState !== "waiting_input") {
      registerTerminalMarker("waiting-input", "Authentication required", { activate: false });
    }
    setTerminalRuntimeState("waiting_input");
    return;
  }
  if (heuristics.quotaRe?.test(plain) || heuristics.quotaRe?.test(fullPlain)) {
    if (terminal.runtimeState !== "quota_wait") {
      registerTerminalMarker("notice", summarizeTerminalMarkerText(plain, "quota wait"), { activate: false });
    }
    setTerminalRuntimeState("quota_wait");
    return;
  }
  if (heuristics.waitingInputRe?.test(plain) && !heuristics.stillRunningRe?.test(plain)) {
    if (terminal.runtimeState !== "waiting_input") {
      registerTerminalMarker("waiting-input", summarizeTerminalMarkerText(plain, "input required"), { activate: false });
    }
    setTerminalRuntimeState("waiting_input");
    return;
  }
  if (plain.trim()) {
    setTerminalRuntimeState("running");
  }
}

async function refreshTerminalState() {
  if (!terminal.agentName || !terminal.workspaceId) {
    terminal.configWarning = "";
    terminal.warningMessage = "";
    terminal.approvalRequest = null;
    terminal.quotaNotice = null;
    terminal.hasProcess = false;
    setTerminalRuntimeState("disconnected");
    return;
  }
  try {
    const res = await fetch(
      `/api/agents/${encodeURIComponent(terminal.agentName)}/terminal-state?workspace=${encodeURIComponent(terminal.workspaceId)}`
    );
    if (!res.ok) return;
    const snapshot = await res.json();
    setWorkspaceTerminalState(terminal.workspaceId, terminal.agentName, snapshot);
    terminal.approvalRequest = snapshot.approvalRequest || null;
    terminal.quotaNotice = snapshot.quotaNotice || null;
    terminal.warningMessage = snapshot.warningMessage || "";
    terminal.hasProcess = Boolean(snapshot.hasProcess);
    const heuristics = getTerminalHeuristics();
    const bufferedText = terminal.plainBuffer;
    const bufferLooksReady = Boolean(
      bufferedText &&
      (
        matchesTerminalHeuristic(heuristics, "readyRe", bufferedText, terminal.draftInputBuffer) ||
        matchesTerminalHeuristic(heuristics, "readyReturnRe", bufferedText, terminal.draftInputBuffer)
      )
    );
    if (snapshot.readyForPrompt || bufferLooksReady) {
      terminal.seenReadyPrompt = true;
    }

    if (snapshot.status === "running") {
      setTerminalRuntimeState(snapshot.status);
      return;
    }
    if (snapshot.status === "waiting_input" || snapshot.status === "quota_wait" || snapshot.status === "error") {
      setTerminalRuntimeState(snapshot.status);
      return;
    }
    if (!snapshot.hasProcess) {
      terminal.configWarning = "";
      terminal.approvalRequest = null;
      setTerminalInputEnabled(false);
      setTerminalRuntimeState("not_started");
      renderSessionSidebar();
      return;
    }
    terminal.configWarning = snapshot.configStale ? (snapshot.configWarning || "") : "";
    setTerminalInputEnabled(true);
    setTerminalRuntimeState(snapshot.readyForPrompt ? "ready" : "starting");
    if (
      bufferedText &&
      snapshot.status !== "running" &&
      (
        matchesTerminalHeuristic(heuristics, "readyRe", bufferedText, terminal.draftInputBuffer) ||
        matchesTerminalHeuristic(heuristics, "readyReturnRe", bufferedText, terminal.draftInputBuffer)
      )
    ) {
      setTerminalRuntimeState("ready");
    }
    renderSessionSidebar();
  } catch {}
}

function handleTerminalKeyEvent(event) {
  if (event.type !== "keydown") return true;
  const key = event.key.toLowerCase();
  const isAccel = event.ctrlKey || event.metaKey;

  if (terminalFeatureEnabled("search") && isAccel && event.shiftKey && key === "f") {
    event.preventDefault();
    toggleTerminalSearch(true);
    return false;
  }
  if (terminalFeatureEnabled("clipboard") && isAccel && event.shiftKey && key === "c") {
    event.preventDefault();
    void copyTerminalSelectionOrBuffer();
    return false;
  }
  if (terminalFeatureEnabled("clipboard") && isAccel && event.shiftKey && key === "v") {
    event.preventDefault();
    void pasteIntoTerminal();
    return false;
  }
  if (terminalFeatureEnabled("clipboard") && event.shiftKey && event.key === "Insert") {
    event.preventDefault();
    void pasteIntoTerminal();
    return false;
  }
  if (terminalFeatureEnabled("clipboard") && isAccel && key === "c" && terminal.xterm?.hasSelection?.()) {
    event.preventDefault();
    void copyTerminalSelectionOrBuffer();
    return false;
  }
  if (terminalFeatureEnabled("clear") && isAccel && !event.shiftKey && key === "l") {
    event.preventDefault();
    clearTerminalViewport();
    return false;
  }
  if (terminalFeatureEnabled("markers") && event.altKey && event.key === "ArrowUp") {
    event.preventDefault();
    navigateTerminalMarkers(-1);
    return false;
  }
  if (terminalFeatureEnabled("markers") && event.altKey && event.key === "ArrowDown") {
    event.preventDefault();
    navigateTerminalMarkers(1);
    return false;
  }
  if (terminalFeatureEnabled("search") && terminal.searchVisible && event.key === "Escape") {
    event.preventDefault();
    closeTerminalSearch();
    return false;
  }
  return true;
}

function initXterm() {
  if (terminal.xterm) return;
  const TerminalCtor = window.Terminal?.Terminal ?? window.Terminal;
  const FitAddonCtor = window.FitAddon?.FitAddon ?? window.FitAddon;
  const SearchAddonCtor = window.SearchAddon?.SearchAddon ?? window.SearchAddon;
  const WebLinksAddonCtor = window.WebLinksAddon?.WebLinksAddon ?? window.WebLinksAddon;
  if (!TerminalCtor || !FitAddonCtor) {
    console.warn("xterm.js not loaded");
    activateTerminalFallback();
    return;
  }

  try {
    terminal.xterm = new TerminalCtor({
      allowProposedApi: true,
      theme: {
        background: "#0d0d0d",
        foreground: "#d4d4d4",
        cursor: "#7289da",
        selectionBackground: "rgba(90, 156, 248, 0.28)",
        selectionInactiveBackground: "rgba(90, 156, 248, 0.18)",
      },
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      cursorBlink: true,
      allowTransparency: true,
      rightClickSelectsWord: true,
      scrollback: 5000,
    });
    terminal.fitAddon = new FitAddonCtor();
    terminal.xterm.loadAddon(terminal.fitAddon);

    if (SearchAddonCtor) {
      terminal.searchAddon = new SearchAddonCtor({ highlightLimit: 250 });
      terminal.xterm.loadAddon(terminal.searchAddon);
      terminal.searchResultsDisposable = terminal.searchAddon.onDidChangeResults?.((event) => {
        updateTerminalSearchCount(event.resultIndex, event.resultCount);
      });
    }

    if (WebLinksAddonCtor) {
      terminal.webLinksAddon = new WebLinksAddonCtor((event, uri) => {
        event.preventDefault();
        window.open(uri, "_blank", "noopener,noreferrer");
      });
      terminal.xterm.loadAddon(terminal.webLinksAddon);
    }

    terminal.xterm.open(terminalContainerEl);
    terminal.fileLinkProviderDisposable = terminal.xterm.registerLinkProvider(createTerminalFileLinkProvider());
    terminal.xterm.attachCustomKeyEventHandler(handleTerminalKeyEvent);
    terminal.xterm.onSelectionChange(() => renderTerminalHeader());
    terminal.xterm.onData((data) => {
      handleTerminalDraftData(data);
      if (data.includes("\r") || data.includes("\n")) {
        setTerminalRuntimeState("running");
      }
      if (terminal.ws?.readyState === WebSocket.OPEN) {
        terminal.ws.send(data);
      }
    });

    terminal.resizeObserver = new ResizeObserver(() => {
      try {
        fitTerminal();
        if (terminal.ws?.readyState === WebSocket.OPEN && terminal.xterm) {
          const { cols, rows } = terminal.xterm;
          terminal.ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      } catch {}
    });
    terminal.resizeObserver.observe(terminalContainerEl);
    terminalShellEl?.addEventListener("click", focusTerminalPrimaryInput);
    fitTerminal();
    renderTerminalHeader();
  } catch (err) {
    console.error("xterm init failed:", err);
    terminal.xterm = null;
    terminal.fitAddon = null;
    terminal.searchAddon = null;
    terminal.webLinksAddon = null;
    activateTerminalFallback();
  }
}

function connectTerminal(agentName, { force = false } = {}) {
  const workspaceId = state.workspaceId;
  if (!agentName || !workspaceId || !hasWorkspaceSelection(workspaceId)) {
    if (terminal.ws) {
      terminal.suppressNextCloseNotice = true;
      const previousWs = terminal.ws;
      terminal.ws = null;
      try { previousWs.close(); } catch {}
    }
    terminal.agentName = null;
    terminal.workspaceId = null;
    resetTerminalView();
    setTerminalConnectionState("disconnected");
    setTerminalRuntimeState("disconnected");
    setTerminalInputEnabled(false);
    return;
  }
  if (
    !force &&
    terminal.agentName === agentName &&
    terminal.workspaceId === workspaceId &&
    terminal.ws?.readyState === WebSocket.OPEN
  ) {
    rememberTerminalSession(agentName, workspaceId);
    scheduleTerminalFit();
    focusTerminalPrimaryInput();
    return;
  }

  if (!force && state.workspaceTerminalStateLoaded.has(workspaceId)) {
    const snapshot = getWorkspaceTerminalStateSnapshot(workspaceId, agentName);
    if (!snapshot.hasProcess) {
      resetTerminalView();
      initXterm();
      if (terminal.xterm) {
        terminal.xterm.reset();
        terminal.xterm.clearSelection?.();
      }
      if (terminalFallbackEl) {
        terminalFallbackEl.textContent = "";
      }
      terminal.agentName = agentName;
      terminal.workspaceId = workspaceId;
      terminal.hasProcess = false;
      rememberTerminalSession(agentName, workspaceId);
      setTerminalConnectionState("disconnected");
      setTerminalRuntimeState("not_started");
      setTerminalInputEnabled(false);
      renderTerminalHeader();
      scheduleTerminalFit();
      return;
    }
  }

  if (terminal.ws) {
    terminal.suppressNextCloseNotice = true;
    const previousWs = terminal.ws;
    terminal.ws = null;
    try { previousWs.close(); } catch {}
  }

  resetTerminalView();
  initXterm();
  if (!terminal.xterm && !terminal.fallbackActive) return;

  terminal.agentName = agentName;
  terminal.workspaceId = workspaceId;
  rememberTerminalSession(agentName, workspaceId);
  setTerminalConnectionState("connecting");
  setTerminalRuntimeState("starting");
  setTerminalInputEnabled(false);

  if (terminal.xterm) {
    terminal.xterm.reset();
    terminal.xterm.clearSelection?.();
    scheduleTerminalFit();
  }
  renderTerminalHeader();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const workspace = getWorkspaceById(workspaceId);
  const agent = getSelectedAgentInfo(agentName);
  const workdir =
    workspace?.workdir ||
    agent?.settings?.workdir ||
    "";
  const ws = new WebSocket(
    `${proto}//${location.host}/api/pty?agent=${encodeURIComponent(agentName)}&workspace=${encodeURIComponent(workspaceId)}&workdir=${encodeURIComponent(workdir)}`
  );
  terminal.ws = ws;
  writeTerminalNotice(
    `[${agentName} terminal に接続中... ws=${workspaceId}]`,
    `\x1b[36m[${agentName} terminal に接続中... ws=${workspaceId}]\x1b[0m`
  );

  ws.onopen = async () => {
    if (terminal.ws !== ws) return;
    setTerminalConnectionState("open");
    if (terminal.xterm) {
      fitTerminal();
      const { cols, rows } = terminal.xterm;
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    } else {
      ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 30 }));
    }
    writeTerminalNotice(
      `[${agentName} terminal 接続済み]`,
      `\x1b[32m[${agentName} terminal 接続済み]\x1b[0m`
    );
    setTerminalInputEnabled(true);
    await refreshTerminalState();
    focusTerminalPrimaryInput();
    scheduleTerminalFit();
  };

  ws.onmessage = async (e) => {
    if (terminal.ws !== ws) return;
    const chunk =
      typeof e.data === "string"
        ? e.data
        : e.data instanceof Blob
          ? await e.data.text()
          : "";
    if (!chunk) return;
    appendTerminalPlain(chunk);
    if (!terminal.xterm || !terminalContainerEl.querySelector(".xterm")) {
      activateTerminalFallback();
    }
    if (terminal.xterm && !terminal.fallbackActive) {
      terminal.xterm.write(chunk);
    }
    updateTerminalStateFromOutput(chunk);
  };

  ws.onerror = () => {
    if (terminal.ws !== ws) return;
    registerTerminalMarker("error", "WebSocket error — 手動で再接続してください");
    setTerminalConnectionState("error");
    writeTerminalNotice(
      "[WebSocket error — 手動で再接続してください]",
      "\r\n\x1b[31m[WebSocket error — 手動で再接続してください]\x1b[0m"
    );
  };

  ws.onclose = () => {
    if (terminal.ws !== ws) {
      terminal.suppressNextCloseNotice = false;
      return;
    }
    if (!terminal.suppressNextCloseNotice) {
      registerTerminalMarker("notice", "Terminal disconnected");
      writeTerminalNotice("[接続が切れました]", "\r\n\x1b[33m[接続が切れました]\x1b[0m");
    }
    terminal.suppressNextCloseNotice = false;
    if (terminal.ws === ws) {
      terminal.ws = null;
    }
    setTerminalConnectionState("disconnected");
    setTerminalRuntimeState("disconnected");
    setTerminalInputEnabled(false);
  };
}

async function reconnectTerminal() {
  if (!terminal.agentName) return;
  connectTerminal(terminal.agentName, { force: true });
}

async function respondToTerminalApproval(decision) {
  if (!terminal.agentName || !terminal.workspaceId) return;
  const res = await fetch(`/api/agents/${encodeURIComponent(terminal.agentName)}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: terminal.workspaceId, decision }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload?.ok) {
    showToast(`❌ 承認応答に失敗: ${payload?.error || payload?.reason || res.status}`, "error");
    return;
  }
  terminal.approvalRequest = payload?.approval || null;
  renderTerminalHeader();
  showToast(
    decision === "approve" ? "✅ approve を送信しました" : "🛑 deny を送信しました",
    "success",
  );
}

btnTerminalReconnectEl?.addEventListener("click", () => void reconnectTerminal());
btnTerminalLayoutSideEl?.addEventListener("click", () => setTerminalLayoutMode("side"));
btnTerminalLayoutBottomEl?.addEventListener("click", () => setTerminalLayoutMode("bottom"));
btnTerminalClearEl?.addEventListener("click", clearTerminalViewport);
btnTerminalCopyEl?.addEventListener("click", () => void copyTerminalSelectionOrBuffer());
btnTerminalPasteEl?.addEventListener("click", () => void pasteIntoTerminal());
btnTerminalSearchEl?.addEventListener("click", () => toggleTerminalSearch(true));
btnTerminalSearchPrevEl?.addEventListener("click", () => runTerminalSearch("previous"));
btnTerminalSearchNextEl?.addEventListener("click", () => runTerminalSearch("next"));
btnTerminalSearchCloseEl?.addEventListener("click", closeTerminalSearch);
btnTerminalMarkerPrevEl?.addEventListener("click", () => navigateTerminalMarkers(-1));
btnTerminalMarkerNextEl?.addEventListener("click", () => navigateTerminalMarkers(1));
btnTerminalApproveEl?.addEventListener("click", () => void respondToTerminalApproval("approve"));
btnTerminalDenyEl?.addEventListener("click", () => void respondToTerminalApproval("deny"));
terminalSearchInputEl?.addEventListener("input", () => {
  runTerminalSearch("next", { incremental: true });
});
terminalSearchInputEl?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runTerminalSearch(event.shiftKey ? "previous" : "next");
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeTerminalSearch();
  }
});

btnTerminalKill.addEventListener("click", async () => {
  if (!terminal.agentName) return;
  if (!confirm(`${terminal.agentName} のターミナルセッションを終了しますか？`)) return;
  const res = await fetch(`/api/agents/${encodeURIComponent(terminal.agentName)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: terminal.workspaceId ?? state.workspaceId }),
  });
  if (!res.ok) {
    showToast("❌ ターミナルセッションの終了に失敗しました", "error");
    return;
  }
  writeTerminalNotice("[セッション終了を要求しました]", "\r\n\x1b[33m[セッション終了を要求しました]\x1b[0m");
});

btnTerminalSendEl?.addEventListener("click", () => void submitTerminalInput());

terminalSessionListEl?.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-session-remove]");
  if (removeButton) {
    removeTerminalSession(removeButton.getAttribute("data-session-remove") ?? "");
    return;
  }
  const targetButton = event.target.closest("[data-session-id]");
  if (!targetButton) return;
  const sessionId = targetButton.getAttribute("data-session-id");
  const session = terminal.recentSessions.find((entry) => entry.id === sessionId);
  if (!session) return;
  if (![...(workspaceSelectEl?.options ?? [])].some((option) => option.value === session.workspaceId)) {
    removeTerminalSession(session.id);
    showToast("❌ session の workspace が見つからないため一覧から外しました", "error");
    return;
  }
  void (async () => {
    const workspaceChanged = session.workspaceId !== state.workspaceId;
    const agentChanged = session.agentName !== state.selectedAgent;
    if (workspaceChanged) {
      const switched = await activateWorkspace(session.workspaceId, { preferredAgentName: session.agentName });
      if (!switched) return;
    } else if (agentChanged) {
      await selectAgentWithHistory(session.agentName);
    } else if (isTerminalTabActive()) {
      requestAnimationFrame(() => connectTerminal(session.agentName));
    }
    terminal.activeSessionId = session.id;
    persistTerminalLayoutPrefs();
    renderTerminalSessions();
  })();
});

terminalInputEl?.addEventListener("input", autoResizeTerminalInput);
terminalInputEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void submitTerminalInput();
  }
});
autoResizeTerminalInput();

document.addEventListener("keydown", (event) => {
  if (!isTerminalTabActive()) return;
  const key = event.key.toLowerCase();
  const isAccel = event.ctrlKey || event.metaKey;
  if (event.key === "F6") {
    event.preventDefault();
    cycleTerminalPaneFocus(event.shiftKey ? -1 : 1);
    return;
  }
  if (terminalFeatureEnabled("search") && isAccel && event.shiftKey && key === "f") {
    event.preventDefault();
    toggleTerminalSearch(true);
    return;
  }
  if (terminalFeatureEnabled("search") && event.key === "Escape" && terminal.searchVisible && document.activeElement !== terminalSearchInputEl) {
    event.preventDefault();
    closeTerminalSearch();
  }
});

// Connect terminal when switching to Terminal tab
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab === "terminal" && state.selectedAgent) {
      requestAnimationFrame(() => connectTerminal(state.selectedAgent));
    }
  });
});

renderTerminalHeader();
renderSelectedAgentSummary();
setTerminalLayoutMode(terminal.markerLayout, { persist: false });
renderTerminalSessions();

// ── Toast notifications ────────────────────────────────────────────────────

function showToast(text, type = "info", duration = 4000) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = text;
  toastContainerEl.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ── Settings panel ─────────────────────────────────────────────────────────

async function loadDiscordChannels() {
  try {
    const res = await fetch("/api/discord/channels");
    if (!res.ok) {
      state.discordChannels = [];
      return;
    }
    const payload = await res.json().catch(() => ({}));
    state.discordChannels = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.channels)
        ? payload.channels
        : [];
  } catch {
    state.discordChannels = [];
  }
}

function setSettingsScope(scope) {
  state.settingsScope = scope;
  renderSettingsScope();
}

async function loadSettingsWorkdir() {
  if (!settingsWorkdirEl) return;
  try {
    const res = await fetch("/api/app-settings");
    if (!res.ok) return;
    const settings = await res.json();
    settingsWorkdirEl.value = settings?.defaultWorkdir ?? "";
  } catch {}
  try {
    const res = await fetch("/api/memory/global");
    if (!res.ok) return;
    const payload = await res.json();
    if (globalMemoryInputEl) {
      globalMemoryInputEl.value = payload?.content ?? "";
    }
  } catch {}
}

async function loadSessionSettings(workspaceId) {
  const workspace = getWorkspaceById(workspaceId);
  if (!workspace) return;
  sessionSettingsTitleEl.textContent = `workspace 設定 · ${workspace.name}`;
  sessionNameInputEl.value = workspace.name ?? "";
  sessionWorkdirInputEl.value = workspace.workdir ?? "";
  sessionParentAgentEl.value = getWorkspaceParentAgentName(workspaceId) ?? "";
  if (state.discordChannels.length === 0) {
    await loadDiscordChannels();
  }
  let selectedChannelId = "";
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/discord-binding`);
    if (res.ok) {
      const bindings = await res.json();
      selectedChannelId = bindings[0]?.discordChannelId ?? "";
    }
  } catch {}
  populateDiscordChannelSelect(sessionDiscordChannelEl, selectedChannelId);
  if (sessionContextModeEl) {
    sessionContextModeEl.value = getWorkspaceContextModeValue(workspace);
  }
  setInlineHint(sessionContextHintEl, formatWorkspaceContextHint(workspace));
  try {
    const res = await fetch(`/api/memory/workspaces/${encodeURIComponent(workspaceId)}`);
    if (res.ok && sessionMemoryInputEl) {
      const payload = await res.json();
      sessionMemoryInputEl.value = payload?.content ?? "";
    }
  } catch {}
  await refreshSessionInspector(workspaceId);
}

async function loadAgentSettings(agentName) {
  if (!agentName) return;
  const [res, runtimeInfo] = await Promise.all([
    fetch(`/api/agents/${encodeURIComponent(agentName)}`),
    loadRuntimeInfo(),
  ]);
  if (!res.ok) return;
  const agent = await res.json();
  state.settingsAgentMeta = agent;
  agentSettingsTitleEl.textContent = `agent 設定 · ${agent.name}`;
  const editableFieldsText = getEditableAgentSettingsFields(agent.type);
  agentSettingsNoteEl.textContent =
    `config-based agent です。CLI 種類と agent 名は固定です。${editableFieldsText} を保存できます。稼働中の CLI session がある場合、保存後は旧設定の session に注意書きが表示されます。必要に応じて再起動してください。`;
  agentNameInputEl.value = agent.name ?? "";
  configureAgentSettingsControls(agent, runtimeInfo);
  agentWorkdirInputEl.value = agent.settings?.workdir ?? "";
  agentInstructionsInputEl.value = agent.settings?.instructions ?? "";
  try {
    const memoryRes = await fetch(`/api/memory/agents/${encodeURIComponent(agentName)}`);
    if (memoryRes.ok && agentMemoryInputEl) {
      const payload = await memoryRes.json();
      agentMemoryInputEl.value = payload?.content ?? "";
    }
  } catch {}
}

async function renderSettingsScope() {
  const scope = state.settingsScope || "global";
  sessionCreatePanelEl.hidden = scope !== "create-session";
  globalSettingsSectionEl.hidden = scope !== "global";
  sessionSettingsSectionEl.hidden = scope !== "session";
  agentSettingsSectionEl.hidden = scope !== "agent";
  if (btnSettingsGlobalEl) {
    btnSettingsGlobalEl.hidden = scope !== "global";
  }
  btnSettingsGlobalEl?.classList.toggle("active", scope === "global");
  btnSettingsSessionEl?.classList.toggle("active", scope === "session" || scope === "create-session");
  btnSettingsAgentEl?.classList.toggle("active", scope === "agent");
  if (settingsContextChipEl) {
    let label = "";
    if (scope === "create-session") {
      label = "workspace 作成";
    } else if (scope === "session") {
      const workspace = getWorkspaceById(state.settingsWorkspaceId || state.workspaceId);
      label = workspace ? `workspace 設定 · ${workspace.name}` : "workspace 設定";
    } else if (scope === "agent") {
      label = state.settingsAgentName ? `agent 設定 · ${state.settingsAgentName}` : "agent 設定";
    }
    settingsContextChipEl.hidden = !label;
    settingsContextChipEl.textContent = label;
  }

  if (scope === "global") {
    await loadSettingsWorkdir();
  }
  if (scope === "create-session") {
    populateAgentSelect(sessionCreateParentAgentEl);
  }
  if (scope === "session") {
    await loadSessionSettings(state.settingsWorkspaceId || state.workspaceId);
  }
  if (scope === "agent") {
    await loadAgentSettings(state.settingsAgentName || state.selectedAgent);
  }
  renderSelectedAgentSummary();
}

function renderAgentsScreen() {
  if (!agentsListEl) return;
  agentsListEl.innerHTML = "";
  for (const agent of state.agents) {
    const theme = getAgentTheme(agent.name);
    const card = document.createElement("div");
    card.className = "agent-card";
    card.dataset.agentTheme = theme.key;
    card.setAttribute("style", buildAgentThemeStyle(agent.name));
    card.innerHTML = `
      <div class="status-dot ${agent.status ?? "idle"}"></div>
      <div class="agent-card-main">
        <div class="agent-card-title">${escHtml(agent.name)} <span class="agent-card-chip">${escHtml(agent.type)}</span></div>
        <div class="agent-card-meta">${escHtml(agent.model || "model 未設定")} · ${escHtml(agent.source || "env")}</div>
        <div class="agent-card-settings">workdir: ${escHtml(agent.settings?.workdir || "-")}
reasoning: ${escHtml(agent.settings?.reasoningEffort || "-")}
fast: ${escHtml(getFastModeSelectValue(agent.settings?.fastMode) || "-")}
plan: ${escHtml(agent.settings?.planMode || "-")}</div>
      </div>
      <div class="agent-card-actions">
        <button type="button" class="session-action-btn" data-agent-card-settings="${agent.name}" title="agent 設定">⚙</button>
      </div>
    `;
    agentsListEl.appendChild(card);
  }
}

btnSettingsGlobalEl?.addEventListener("click", () => {
  state.settingsScope = "global";
  state.settingsWorkspaceId = null;
  state.settingsAgentName = null;
  switchTab("settings");
  void renderSettingsScope();
});

agentModelInputEl?.addEventListener("change", async () => {
  const runtimeInfo = await loadRuntimeInfo();
  refreshAgentSettingsModelControls(runtimeInfo);
});

agentsCreateTypeEl?.addEventListener("change", async () => {
  const runtimeInfo = await loadRuntimeInfo();
  if (agentsCreateModelEl) agentsCreateModelEl.value = "";
  if (agentsCreateModelDetailEl) agentsCreateModelDetailEl.value = "";
  if (agentsCreateReasoningEl) agentsCreateReasoningEl.value = "";
  if (agentsCreateFastModeEl) agentsCreateFastModeEl.value = "";
  if (agentsCreatePlanModeEl) agentsCreatePlanModeEl.value = "";
  configureAgentCreateControls(agentsCreateTypeEl.value, runtimeInfo);
});

agentsCreateModelEl?.addEventListener("change", async () => {
  const runtimeInfo = await loadRuntimeInfo();
  refreshAgentCreateModelControls(runtimeInfo);
});

agentModelDetailInputEl?.addEventListener("change", async () => {
  const runtimeInfo = await loadRuntimeInfo();
  refreshAgentSettingsModelControls(runtimeInfo);
});

agentsCreateModelDetailEl?.addEventListener("change", async () => {
  const runtimeInfo = await loadRuntimeInfo();
  refreshAgentCreateModelControls(runtimeInfo);
});

agentPlanModeInputEl?.addEventListener("change", () => {
  refreshAgentSettingsPlanControls();
});

agentsCreatePlanModeEl?.addEventListener("change", () => {
  refreshAgentCreatePlanControls();
});

btnSaveWorkdirEl?.addEventListener("click", async () => {
  const workdir = settingsWorkdirEl.value.trim();
  const res = await fetch("/api/app-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultWorkdir: workdir || "" }),
  });
  if (!res.ok) {
    showToast("❌ 保存に失敗しました", "error");
    return;
  }
  showToast("✅ default workdir を保存しました", "success");
});

btnSaveGlobalMemoryEl?.addEventListener("click", async () => {
  const res = await fetch("/api/memory/global", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: globalMemoryInputEl?.value ?? "" }),
  });
  if (!res.ok) {
    showToast("❌ global memory の保存に失敗しました", "error");
    return;
  }
  showToast("✅ global memory を保存しました", "success");
});

btnSessionCreateSaveEl?.addEventListener("click", async () => {
  const name = sessionCreateNameEl.value.trim();
  const parentAgent = sessionCreateParentAgentEl.value.trim();
  const workdir = sessionCreateWorkdirEl.value.trim();
  if (!name || !parentAgent) {
    showToast("❌ workspace 名と親 agent を入力してください", "error");
    return;
  }
  const res = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parentAgent, workdir: workdir || undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ workspace 作成に失敗: ${err.error ?? res.status}`, "error");
    return;
  }
  const workspace = await res.json();
  await loadWorkspaces();
  await loadAgents();
  await activateWorkspace(workspace.id, { preferredAgentName: parentAgent });
  state.settingsScope = "session";
  state.settingsWorkspaceId = workspace.id;
  showToast(`✅ workspace "${workspace.name}" を作成しました`, "success");
  switchTab("chat");
  renderSessionSidebar();
});

btnSessionSaveEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: sessionNameInputEl.value.trim(),
      workdir: sessionWorkdirInputEl.value.trim() || null,
      contextInjectionMode: sessionContextModeEl?.value || "default",
    }),
  });
  if (!res.ok) {
    showToast("❌ workspace 設定の保存に失敗しました", "error");
    return;
  }
  const bindingRes = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/discord-binding`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channelId: sessionDiscordChannelEl.value,
      defaultAgent: getWorkspaceParentAgentName(workspaceId) || "",
    }),
  });
  if (!bindingRes.ok) {
    const err = await bindingRes.json().catch(() => ({}));
    showToast(`❌ Discord binding 保存に失敗: ${err.error ?? bindingRes.status}`, "error");
    return;
  }
  await loadWorkspaces();
  showToast("✅ workspace 設定を保存しました", "success");
  void renderSettingsScope();
});

btnSaveSessionMemoryEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  const res = await fetch(`/api/memory/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: sessionMemoryInputEl?.value ?? "" }),
  });
  if (!res.ok) {
    showToast("❌ workspace memory の保存に失敗しました", "error");
    return;
  }
  showToast("✅ workspace memory を保存しました", "success");
});

btnSessionDurabilityRefreshEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  await refreshSessionInspector(workspaceId);
  showToast("✅ workspace inspector を更新しました", "success");
});

sessionResumeBindingsEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-session-resume-agent]")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const agentName = button.dataset.sessionResumeAgent?.trim();
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!agentName || !workspaceId) return;
  button.setAttribute("disabled", "disabled");
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`❌ resume に失敗: ${err.error ?? res.status}`, "error");
      return;
    }
    await refreshSessionInspector(workspaceId);
    showToast(`✅ ${agentName} を resume しました`, "success");
  } catch {
    showToast("❌ resume に失敗しました", "error");
  } finally {
    button.removeAttribute("disabled");
  }
});

btnSessionCheckpointCreateEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/checkpoints`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: sessionCheckpointLabelEl?.value?.trim() || "",
      requestedBy: "UI settings",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ checkpoint 作成に失敗: ${err.error ?? res.status}`, "error");
    return;
  }
  if (sessionCheckpointLabelEl) sessionCheckpointLabelEl.value = "";
  await loadSessionGitSafety(workspaceId);
  await loadSessionDurability(workspaceId);
  showToast("✅ checkpoint を作成しました", "success");
});

sessionCheckpointsEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-checkpoint-preview]")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const checkpointId = button.dataset.checkpointPreview?.trim();
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!checkpointId || !workspaceId) return;
  button.setAttribute("disabled", "disabled");
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/rollback/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkpointId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`❌ rollback preview に失敗: ${err.error ?? res.status}`, "error");
      return;
    }
    renderSessionRollbackPreview(await res.json());
    showToast("✅ rollback preview を更新しました", "success");
  } catch {
    showToast("❌ rollback preview に失敗しました", "error");
  } finally {
    button.removeAttribute("disabled");
  }
});

sessionRollbackPreviewEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("#btn-session-rollback-apply")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  const checkpointId = state.settingsRollbackPreview?.checkpoint?.id;
  if (!workspaceId || !checkpointId) return;
  if (!confirm(`checkpoint "${checkpointId}" へ rollback を適用しますか？`)) return;
  button.setAttribute("disabled", "disabled");
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/rollback/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkpointId,
        approved: true,
        requestedBy: "UI settings",
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`❌ rollback apply に失敗: ${err.error ?? res.status}`, "error");
      return;
    }
    renderSessionRollbackPreview(await res.json());
    await refreshSessionInspector(workspaceId);
    showToast("✅ rollback を適用しました", "success");
  } catch {
    showToast("❌ rollback apply に失敗しました", "error");
  } finally {
    button.removeAttribute("disabled");
  }
});

btnSessionClaimEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  const agentName = sessionClaimAgentEl?.value?.trim() || "";
  const task = sessionClaimTaskEl?.value?.trim() || "";
  if (!agentName || !task) {
    showToast("❌ claim には agent と task が必要です", "error");
    return;
  }
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentName,
      task,
      requestedBy: "UI settings",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ claim に失敗: ${err.error ?? res.status}`, "error");
    return;
  }
  if (sessionClaimTaskEl) sessionClaimTaskEl.value = "";
  await loadSessionCoordination(workspaceId);
  await loadSessionDurability(workspaceId);
  showToast(`✅ ${agentName} が claim しました`, "success");
});

btnSessionHandoffEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  const fromAgentName = sessionHandoffFromEl?.value?.trim() || "";
  const toAgentName = sessionHandoffToEl?.value?.trim() || "";
  const task = sessionHandoffTaskEl?.value?.trim() || "";
  if (!fromAgentName || !toAgentName || !task) {
    showToast("❌ handoff には from / to / task が必要です", "error");
    return;
  }
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/handoffs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromAgentName,
      toAgentName,
      task,
      requestedBy: "UI settings",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ handoff に失敗: ${err.error ?? res.status}`, "error");
    return;
  }
  if (sessionHandoffTaskEl) sessionHandoffTaskEl.value = "";
  await loadSessionCoordination(workspaceId);
  await loadSessionDurability(workspaceId);
  showToast(`✅ ${fromAgentName} → ${toAgentName} handoff を追加しました`, "success");
});

btnSessionProfileSaveEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: sessionProfileModeEl?.value || "standard",
      persona: sessionProfilePersonaEl?.value || "balanced",
      autonomy: sessionProfileAutonomyEl?.value || "guided",
      notes: sessionProfileNotesEl?.value || "",
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(`❌ workspace profile 保存に失敗: ${payload.error ?? res.status}`, "error");
    return;
  }
  applySessionProfile(payload);
  showToast("✅ workspace profile を保存しました", "success");
});

sessionClaimsPanelEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-claim-release-agent]")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const agentName = button.dataset.claimReleaseAgent?.trim();
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!agentName || !workspaceId) return;
  button.setAttribute("disabled", "disabled");
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName,
        requestedBy: "UI settings",
        reason: "manual",
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`❌ release に失敗: ${err.error ?? res.status}`, "error");
      return;
    }
    await loadSessionCoordination(workspaceId);
    await loadSessionDurability(workspaceId);
    showToast(`✅ ${agentName} を release しました`, "success");
  } catch {
    showToast("❌ release に失敗しました", "error");
  } finally {
    button.removeAttribute("disabled");
  }
});

btnSessionReviewRefreshEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  await Promise.all([
    loadSessionReview(workspaceId),
    loadSessionAutomation(workspaceId),
  ]);
  showToast("✅ review / automation を更新しました", "success");
});

btnSessionAutomationRefreshEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  await loadSessionAutomation(workspaceId);
  showToast("✅ automation を更新しました", "success");
});

sessionReviewChangesEl?.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-review-open-path]")
    : null;
  if (!(button instanceof HTMLElement)) return;
  void openChatFileViewer(button.dataset.reviewOpenPath || "");
});

sessionWorktreePanelEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("#btn-session-worktree-ensure")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  button.setAttribute("disabled", "disabled");
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/worktree`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedBy: "UI settings" }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(`❌ worktree 作成に失敗: ${payload.error ?? res.status}`, "error");
      return;
    }
    await loadWorkspaces();
    if (payload?.workspace?.workdir && sessionWorkdirInputEl) {
      sessionWorkdirInputEl.value = payload.workspace.workdir;
    }
    renderSessionWorktreePanel(payload?.status || null);
    await loadSessionReview(workspaceId);
    showToast("✅ isolated worktree へ切り替えました", "success");
  } catch {
    showToast("❌ worktree 作成に失敗しました", "error");
  } finally {
    button.removeAttribute("disabled");
  }
});

btnSessionLockClaimEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  if (!workspaceId) return;
  const agentName = sessionLockAgentEl?.value?.trim() || "";
  const filePath = sessionLockFileEl?.value?.trim() || "";
  const symbol = sessionLockSymbolEl?.value?.trim() || "";
  if (!agentName || !filePath || !symbol) {
    showToast("❌ lock には agent / file / symbol が必要です", "error");
    return;
  }
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/locks/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentName,
      filePath,
      symbol,
      requestedBy: "UI settings",
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    renderSessionLockConflict(payload);
    showToast(`❌ semantic lock に失敗: ${payload.error ?? res.status}`, res.status === 409 ? "warning" : "error");
    return;
  }
  if (sessionLockFileEl) sessionLockFileEl.value = "";
  if (sessionLockSymbolEl) sessionLockSymbolEl.value = "";
  renderSessionLockConflict(null);
  renderSessionLocksPanel(payload?.locks || []);
  setInlineHint(sessionReviewHintEl, `dirty=${state.settingsReviewSnapshot?.repository?.status?.dirtyCount ?? 0} / locks=${Array.isArray(payload?.locks) ? payload.locks.length : 0} / isolated=${state.settingsWorktreeStatus?.isIsolated ? "yes" : "no"}`);
  showToast("✅ semantic lock を追加しました", "success");
});

sessionLocksPanelEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-lock-release-id]")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  const lockId = button.dataset.lockReleaseId?.trim() || "";
  if (!workspaceId || !lockId) return;
  button.setAttribute("disabled", "disabled");
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/locks/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lockId,
        requestedBy: "UI settings",
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(`❌ semantic lock release に失敗: ${payload.error ?? res.status}`, "error");
      return;
    }
    renderSessionLocksPanel(payload?.locks || []);
    showToast("✅ semantic lock を release しました", "success");
  } catch {
    showToast("❌ semantic lock release に失敗しました", "error");
  } finally {
    button.removeAttribute("disabled");
  }
});

sessionMemoryAutomationPanelEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-memory-preview-scope]")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  const scope = button.dataset.memoryPreviewScope?.trim() || "";
  if (!workspaceId || !scope) return;
  const endpoint =
    scope === "consolidation"
      ? "consolidation"
      : scope === "diary"
        ? "diary"
        : "dreaming";
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/${endpoint}/preview`);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(`❌ ${scope} preview に失敗: ${payload.error ?? res.status}`, "error");
    return;
  }
  renderSessionMemoryAutomationPreview(payload);
  showToast(`✅ ${scope} preview を更新しました`, "success");
});

sessionMemoryAutomationPreviewEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("#btn-session-memory-automation-apply")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  const preview = state.settingsMemoryAutomationPreview;
  if (!workspaceId || !preview?.scope) return;
  if (!confirm(`${preview.scope} を apply しますか？`)) return;
  const endpoint =
    preview.scope === "workspace"
      ? "consolidation"
      : preview.scope === "diary"
        ? "diary"
        : "dreaming";
  button.setAttribute("disabled", "disabled");
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/${endpoint}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approved: true,
        requestedBy: "UI settings",
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(`❌ ${preview.scope} apply に失敗: ${payload.error ?? res.status}`, "error");
      return;
    }
    renderSessionMemoryAutomationPreview(payload);
    if (payload.scope === "workspace" || payload.scope === "dreaming") {
      await loadSessionSettings(workspaceId);
    }
    showToast(`✅ ${preview.scope} を apply しました`, "success");
  } catch {
    showToast("❌ automation apply に失敗しました", "error");
  } finally {
    button.removeAttribute("disabled");
  }
});

sessionSkillsPanelEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-skill-sync-action]")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  const action = button.dataset.skillSyncAction?.trim() || "plan";
  if (!workspaceId) return;
  button.setAttribute("disabled", "disabled");
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apply: action === "apply",
        requestedBy: "UI settings",
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(`❌ skill ${action} に失敗: ${payload.error ?? res.status}`, "error");
      return;
    }
    const registryRes = await fetch("/api/skills/registry");
    const registry = registryRes.ok ? await registryRes.json() : null;
    renderSessionSkillsPanel(registry, payload);
    showToast(`✅ skill ${action} を更新しました`, "success");
  } catch {
    showToast("❌ skill sync に失敗しました", "error");
  } finally {
    button.removeAttribute("disabled");
  }
});

sessionMcpPanelEl?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-mcp-sync-action]")
    : null;
  if (!(button instanceof HTMLElement)) return;
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  const action = button.dataset.mcpSyncAction?.trim() || "plan";
  if (!workspaceId) return;
  button.setAttribute("disabled", "disabled");
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apply: action === "apply",
        requestedBy: "UI settings",
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(`❌ MCP ${action} に失敗: ${payload.error ?? res.status}`, "error");
      return;
    }
    const registryRes = await fetch("/api/mcp/registry");
    const registry = registryRes.ok ? await registryRes.json() : null;
    renderSessionMcpPanel(registry, payload);
    showToast(`✅ MCP ${action} を更新しました`, "success");
  } catch {
    showToast("❌ MCP sync に失敗しました", "error");
  } finally {
    button.removeAttribute("disabled");
  }
});

btnSessionDeleteEl?.addEventListener("click", async () => {
  const workspaceId = state.settingsWorkspaceId || state.workspaceId;
  const workspace = getWorkspaceById(workspaceId);
  if (!workspace) {
    showToast("workspace が見つかりません", "error");
    return;
  }
  if (!confirm(`workspace "${workspace.name}" を削除しますか？`)) return;
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ 削除に失敗: ${err.error ?? res.status}`, "error");
    return;
  }
  const deletedPayload = await res.json().catch(() => ({}));
  await loadWorkspaces();
  const deletedWorkspaceId = deletedPayload?.workspace?.id || workspaceId;
  const fallbackWorkspaceId =
    state.workspaces.find((candidate) => candidate.id !== deletedWorkspaceId)?.id
    ?? state.workspaces[0]?.id;
  if (fallbackWorkspaceId) {
    await activateWorkspace(fallbackWorkspaceId);
  } else {
    state.workspaceId = null;
    state.selectedAgent = null;
    renderChatLog(null);
    updateChatComposerState();
  }
  state.settingsScope = "global";
  switchTab("chat");
  showToast("✅ workspace を削除しました", "success");
});

btnAgentSaveEl?.addEventListener("click", async () => {
  const agentName = state.settingsAgentName || state.selectedAgent;
  if (!agentName) return;
  const agentType = agentTypeDisplayEl.value.trim();
  const body = {
    name: agentNameInputEl.value.trim(),
    type: agentType || undefined,
    model: resolveConfiguredModelValue(agentType, agentModelInputEl.value, agentModelDetailInputEl?.value),
    workdir: agentWorkdirInputEl.value.trim(),
    planMode: agentPlanModeInputEl.value.trim(),
    instructions: agentInstructionsInputEl.value.trim(),
    reasoningEffort: ["claude", "copilot", "codex"].includes(agentType) ? agentReasoningInputEl.value.trim() : undefined,
    fastMode:
      agentType === "codex"
        ? (agentFastModeInputEl.value === "fast" ? true : agentFastModeInputEl.value === "flex" ? false : undefined)
        : undefined,
  };
  const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ agent 設定保存に失敗: ${err.error ?? res.status}`, "error");
    return;
  }
  const updatedAgent = await res.json().catch(() => ({}));
  await loadAgents();
  state.settingsAgentMeta = null;
  await renderSettingsScope();
  if (terminal.agentName === agentName) {
    void refreshTerminalState();
  }
  showToast("✅ agent 設定を保存しました", "success");
  if (Number(updatedAgent?.liveSessionWarningCount || 0) > 0) {
    showToast("⚠️ エージェントの設定が変更されました。必要に応じてセッションを再起動してください。", "warning", 6000);
  }
});

btnSaveAgentMemoryEl?.addEventListener("click", async () => {
  const agentName = state.settingsAgentName || state.selectedAgent;
  if (!agentName) return;
  const res = await fetch(`/api/memory/agents/${encodeURIComponent(agentName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: agentMemoryInputEl?.value ?? "" }),
  });
  if (!res.ok) {
    showToast("❌ agent memory の保存に失敗しました", "error");
    return;
  }
  showToast("✅ agent memory を保存しました", "success");
});

btnAgentDeleteEl?.addEventListener("click", async () => {
  const agentName = state.settingsAgentName || state.selectedAgent;
  if (!agentName) return;
  if (!confirm(`agent "${agentName}" を削除しますか？`)) return;
  const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ agent 削除に失敗: ${err.error ?? res.status}`, "error");
    return;
  }
  await loadAgents();
  await loadAllWorkspaceAgents();
  const validAgentNames = new Set(state.agents.map((agent) => agent.name));
  if (!state.selectedAgent || !validAgentNames.has(state.selectedAgent)) {
    const workspaceMembers = hasWorkspaceSelection()
      ? getWorkspaceAgents(state.workspaceId).filter((member) => validAgentNames.has(member.agentName))
      : [];
    state.selectedAgent =
      getWorkspaceParentAgentName(state.workspaceId) ||
      workspaceMembers[0]?.agentName ||
      state.agents[0]?.name ||
      null;
  }
  state.settingsScope = "global";
  state.settingsAgentName = null;
  state.settingsAgentMeta = null;
  renderSessionSidebar();
  renderChatRouteHint();
  renderSelectedAgentSummary();
  updateChatComposerState();
  switchTab("agents");
  showToast("✅ agent を削除しました", "success");
});

btnAgentCreateEl?.addEventListener("click", async () => {
  const body = {
    name: agentsCreateNameEl.value.trim(),
    type: agentsCreateTypeEl.value.trim(),
    model: resolveConfiguredModelValue(
      agentsCreateTypeEl.value.trim(),
      agentsCreateModelEl.value,
      agentsCreateModelDetailEl?.value,
    ),
    workdir: agentsCreateWorkdirEl.value.trim(),
    planMode: agentsCreatePlanModeEl.value.trim(),
    instructions: agentsCreateInstructionsEl.value.trim(),
    reasoningEffort:
      ["claude", "copilot", "codex"].includes(agentsCreateTypeEl.value.trim())
        ? agentsCreateReasoningEl.value.trim()
        : undefined,
    fastMode:
      agentsCreateTypeEl.value.trim() === "codex"
        ? (agentsCreateFastModeEl.value === "fast" ? true : agentsCreateFastModeEl.value === "flex" ? false : undefined)
        : undefined,
  };
  if (!body.name || !body.type) {
    showToast("❌ 名前と CLI を入力してください", "error");
    return;
  }
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(`❌ agent 作成に失敗: ${err.error ?? res.status}`, "error");
    return;
  }
  agentsCreateNameEl.value = "";
  agentsCreateWorkdirEl.value = "";
  agentsCreateModelEl.value = "";
  if (agentsCreateModelDetailEl) agentsCreateModelDetailEl.value = "";
  agentsCreateReasoningEl.value = "";
  agentsCreateFastModeEl.value = "";
  agentsCreatePlanModeEl.value = "";
  agentsCreateInstructionsEl.value = "";
  agentsCreateTypeEl.value = "gemini";
  configureAgentCreateControls("gemini", state.runtimeInfo);
  await loadAgents();
  showToast("✅ custom agent を作成しました", "success");
});

agentsListEl?.addEventListener("click", (event) => {
  const settingsButton = event.target.closest("[data-agent-card-settings]");
  if (!settingsButton) return;
  void openAgentSettings(settingsButton.getAttribute("data-agent-card-settings"), state.workspaceId);
});

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  await loadWorkspaces();
  await loadAgents();
  await loadDiscordChannels();

  const initialAgent =
    getWorkspaceParentAgentName(state.workspaceId) ||
    state.agents[0]?.name ||
    null;
  if (initialAgent) {
    selectAgent(initialAgent);
  }
  await refreshMessageHistory(state.workspaceId);
  renderChatLog(state.workspaceId);
  state.bootReady = true;
  btnSendEl.disabled = false;
  renderSessionSidebar();
  renderAgentsScreen();
  await renderSettingsScope();
  const runtimeInfo = await loadRuntimeInfo();
  configureAgentCreateControls(agentsCreateTypeEl?.value || "gemini", runtimeInfo);

  connectSSE();

  // Poll agent statuses every 5s
  setInterval(loadAgents, 5000);
  setInterval(loadWorkspaces, 15_000);
}

boot();
