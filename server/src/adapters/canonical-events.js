/**
 * Canonical Event Model
 *
 * All CLI adapters normalize their raw output to these event types.
 * The bridge/UI/Discord layer consumes only canonical events.
 *
 * @typedef {'stopped'|'idle'|'running'|'error'} AgentStatus
 *
 * @typedef {{ inputTokens: number, outputTokens: number, cachedInputTokens?: number, model?: string, durationMs?: number, costUsd?: number }} Usage
 *
 * @typedef {
 *   | { type: 'session.init';  agentName: string; sessionRef: string; model: string }
 *   | { type: 'message.user';  agentName: string; content: string; source: string }
 *   | { type: 'message.delta'; agentName: string; content: string }
 *   | { type: 'message.done';  agentName: string; content: string }
 *   | { type: 'tool.start';    agentName: string; toolName: string; toolId: string; input?: any }
 *   | { type: 'tool.done';     agentName: string; toolName: string; toolId: string; output?: string; isError?: boolean }
 *   | { type: 'run.done';      agentName: string; usage: Usage }
 *   | { type: 'run.error';     agentName: string; message: string }
 *   | { type: 'status.change'; agentName: string; status: AgentStatus }
 * } CanonicalEvent
 */

/**
 * Normalize Claude Code stream-json events → CanonicalEvent[]
 */
export function normalizeClaudeEvent(raw, agentName) {
  const events = [];

  if (raw.type === "system" && raw.subtype === "init" && raw.session_id) {
    events.push({
      type: "session.init",
      agentName,
      sessionRef: raw.session_id,
      model: raw.model ?? "",
    });
  }

  if (raw.type === "assistant" && Array.isArray(raw.message?.content)) {
    for (const block of raw.message.content) {
      if (block.type === "text" && block.text) {
        events.push({ type: "message.delta", agentName, content: block.text });
      }
      if (block.type === "tool_use") {
        events.push({
          type: "tool.start",
          agentName,
          toolName: block.name,
          toolId: block.id,
          input: block.input,
        });
      }
    }
  }

  if (raw.type === "user" && Array.isArray(raw.message?.content)) {
    for (const block of raw.message.content) {
      if (block.type === "tool_result") {
        events.push({
          type: "tool.done",
          agentName,
          toolName: "",  // Claude doesn't echo tool name in result
          toolId: block.tool_use_id,
          output: Array.isArray(block.content)
            ? block.content.map((c) => c.text ?? "").join("")
            : String(block.content ?? ""),
          isError: Boolean(block.is_error),
        });
      }
    }
  }

  if (raw.type === "result") {
    if (raw.is_error || raw.subtype === "error") {
      events.push({ type: "run.error", agentName, message: raw.result ?? "Claude error" });
    } else {
      const u = raw.usage ?? {};
      events.push({
        type: "run.done",
        agentName,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cachedInputTokens: u.cache_read_input_tokens ?? 0,
          model: raw.modelUsage ? Object.keys(raw.modelUsage)[0] : undefined,
          costUsd: raw.total_cost_usd,
        },
      });
    }
  }

  return events;
}

/**
 * Normalize Gemini CLI stream-json events → CanonicalEvent[]
 */
export function normalizeGeminiEvent(raw, agentName) {
  const events = [];

  if (raw.type === "init" && raw.session_id) {
    events.push({
      type: "session.init",
      agentName,
      sessionRef: raw.session_id,
      model: raw.model ?? "",
    });
  }

  if (raw.type === "message" && raw.role === "assistant" && raw.delta && raw.content) {
    events.push({ type: "message.delta", agentName, content: raw.content });
  }

  if (raw.type === "tool_use") {
    events.push({
      type: "tool.start",
      agentName,
      toolName: raw.name ?? "",
      toolId: raw.id ?? "",
      input: raw.input,
    });
  }

  if (raw.type === "tool_result") {
    events.push({
      type: "tool.done",
      agentName,
      toolName: "",
      toolId: raw.id ?? "",
      output: raw.output,
      isError: Boolean(raw.is_error),
    });
  }

  if (raw.type === "result") {
    if (raw.status === "error") {
      events.push({ type: "run.error", agentName, message: raw.error ?? "Gemini error" });
    } else {
      const stats = raw.stats ?? {};
      let inputTokens = 0, outputTokens = 0, cachedInputTokens = 0;
      if (stats.models) {
        for (const mu of Object.values(stats.models)) {
          inputTokens += mu.input_tokens ?? 0;
          outputTokens += mu.output_tokens ?? 0;
          cachedInputTokens += mu.cached ?? 0;
        }
      } else {
        inputTokens = stats.input_tokens ?? 0;
        outputTokens = stats.output_tokens ?? 0;
      }
      events.push({
        type: "run.done",
        agentName,
        usage: {
          inputTokens,
          outputTokens,
          cachedInputTokens,
          durationMs: stats.duration_ms,
          model: stats.models ? Object.keys(stats.models)[0] : undefined,
        },
      });
    }
  }

  return events;
}

/**
 * Normalize GitHub Copilot CLI JSON events → CanonicalEvent[]
 */
export function normalizeCopilotEvent(raw, agentName) {
  const events = [];

  if (raw.type === "assistant.message_delta" && raw.data?.deltaContent) {
    events.push({ type: "message.delta", agentName, content: String(raw.data.deltaContent) });
  }

  if (raw.type === "assistant.message" && raw.data?.content != null) {
    events.push({ type: "message.done", agentName, content: String(raw.data.content) });
  }

  if (raw.type === "result") {
    if (raw.sessionId) {
      events.push({
        type: "session.init",
        agentName,
        sessionRef: raw.sessionId,
        model: "",
      });
    }
    events.push({
      type: "run.done",
      agentName,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        durationMs: raw.usage?.totalApiDurationMs,
      },
    });
  }

  if (raw.type === "error") {
    events.push({
      type: "run.error",
      agentName,
      message: raw.message ?? raw.data?.message ?? "GitHub Copilot CLI error",
    });
  }

  return events;
}

/**
 * Normalize Codex CLI exec --json events → CanonicalEvent[]
 */
export function normalizeCodexEvent(raw, agentName) {
  const events = [];

  if (raw.type === "thread.started" && raw.thread_id) {
    events.push({
      type: "session.init",
      agentName,
      sessionRef: raw.thread_id,
      model: "",  // Codex doesn't echo model in this event
    });
  }

  if (raw.type === "item.completed" && raw.item?.type === "agent_message" && raw.item?.text) {
    events.push({ type: "message.done", agentName, content: raw.item.text });
  }

  if (raw.type === "turn.completed") {
    const u = raw.usage ?? {};
    events.push({
      type: "run.done",
      agentName,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cachedInputTokens: u.cached_input_tokens ?? 0,
      },
    });
  }

  if (raw.type === "turn.failed" || raw.type === "error") {
    events.push({
      type: "run.error",
      agentName,
      message: raw.error?.message ?? raw.message ?? "Codex error",
    });
  }

  return events;
}
