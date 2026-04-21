function toBooleanOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return Boolean(value);
}

export function getContextLimits(agentType) {
  switch (agentType) {
    case "codex":
      return { maxMessages: 6, maxCharsPerMessage: 150, maxTotalChars: 900 };
    case "copilot":
      return { maxMessages: 8, maxCharsPerMessage: 170, maxTotalChars: 1100 };
    case "gemini":
      return { maxMessages: 8, maxCharsPerMessage: 190, maxTotalChars: 1300 };
    case "claude":
    default:
      return { maxMessages: 10, maxCharsPerMessage: 210, maxTotalChars: 1500 };
  }
}

export function sanitizeContextMessageContent(content) {
  let cleaned = String(content || "")
    .replace(/\u0007/g, "")
    .replace(/\r/g, "");
  cleaned = cleaned.replace(/\[Context from recent workspace chat\][\s\S]*?\[User prompt\]/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)⚠\s*Heads up,[^\n]*(?:\nRun \/status[^\n]*)?/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)You've hit your usage limit[^\n]*/g, "\n");
  cleaned = cleaned.replace(/(?:^|\n)Codex の応答を抽出できませんでした。[^\n]*/g, "\n");
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

export function filterContextMessages(messages) {
  const completedRunIds = new Set(
    messages
      .filter((message) => message.role === "assistant" && message.runId)
      .map((message) => message.runId),
  );
  return messages.filter((message) => {
    if (message.role !== "user") return true;
    if (!message.runId) return true;
    return completedRunIds.has(message.runId);
  });
}

export function buildContextBlock(messages, agentType = "claude") {
  if (!messages || messages.length === 0) return null;
  const limits = getContextLimits(agentType);
  const filteredMessages = filterContextMessages(messages);
  const lines = [];
  let totalChars = 0;
  let usedMessages = 0;
  for (const message of filteredMessages.slice(-limits.maxMessages)) {
    const speaker =
      message.role === "user"
        ? `You -> ${message.agentName}`
        : `${message.agentName}`;
    const body = sanitizeContextMessageContent(message.content).slice(0, limits.maxCharsPerMessage);
    if (!body) continue;
    const line = `${speaker}: ${body}`;
    if (totalChars + line.length > limits.maxTotalChars) {
      if (lines.length === 0) {
        lines.push(line.slice(0, limits.maxTotalChars));
        usedMessages += 1;
        totalChars = limits.maxTotalChars;
      }
      break;
    }
    lines.push(line);
    usedMessages += 1;
    totalChars += line.length + 1;
  }
  if (lines.length === 0) return null;
  return {
    text: lines.join("\n"),
    messageCount: usedMessages,
    totalChars,
    limits,
  };
}

export function resolveWorkspaceContextPolicy({
  workspace = null,
  workspaceAgentCount = 0,
  requestedIncludeContext = true,
} = {}) {
  const requested = requestedIncludeContext !== false;
  const configured = toBooleanOrNull(workspace?.contextInjectionEnabled);
  const defaultEnabled = Number(workspaceAgentCount || 0) > 1;
  const effective = requested && (configured == null ? defaultEnabled : configured);
  const mode =
    configured == null
      ? "default"
      : configured
        ? "on"
        : "off";
  const reason =
    configured == null
      ? defaultEnabled
        ? "複数agent workspace のため既定で ON"
        : "単一agent workspace のため既定で OFF"
      : configured
        ? "workspace 設定で ON"
        : "workspace 設定で OFF";
  return {
    requested,
    configured,
    defaultEnabled,
    effective,
    mode,
    workspaceAgentCount: Number(workspaceAgentCount || 0),
    reason,
  };
}
