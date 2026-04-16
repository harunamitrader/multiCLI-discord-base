import fs from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import cron from "node-cron";

const DEFAULT_TIMEZONE = "Asia/Tokyo";
const JOB_FILE_EXTENSION = ".json";

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input || {}, key);
}

function sanitizeJobName(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("Schedule name is required.");
  }

  if (/[<>:"/\\|?*\u0000-\u001f]/.test(normalized)) {
    throw new Error("Schedule name contains unsupported filesystem characters.");
  }

  if (normalized === "." || normalized === "..") {
    throw new Error("Schedule name is invalid.");
  }

  return normalized;
}

function normalizeScheduleReference(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeTimezone(value, fallback = DEFAULT_TIMEZONE) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function isValidCronExpression(expression) {
  const normalized = String(expression || "").trim();
  const parts = normalized.split(/\s+/).filter(Boolean);
  return parts.length === 5 && cron.validate(normalized);
}

const WEEKDAY_LABELS = {
  0: "日曜",
  1: "月曜",
  2: "火曜",
  3: "水曜",
  4: "木曜",
  5: "金曜",
  6: "土曜",
  7: "日曜",
};

function parseIntegerToken(token, min, max) {
  if (!/^\d+$/.test(String(token || "").trim())) {
    return null;
  }

  const value = Number(token);
  if (!Number.isInteger(value) || value < min || value > max) {
    return null;
  }

  return value;
}

function formatTimeLabel(hour, minute) {
  const hourLabel = `${hour}時`;
  if (minute === 0) {
    return hourLabel;
  }

  return `${hourLabel}${minute}分`;
}

function parseWeekdayToken(token) {
  const normalized = String(token || "").trim();
  if (!normalized) {
    return null;
  }

  if (normalized === "1-5") {
    return "平日";
  }

  const weekday = parseIntegerToken(normalized, 0, 7);
  if (weekday != null) {
    return WEEKDAY_LABELS[weekday] || null;
  }

  const rangeMatch = normalized.match(/^([0-7])-([0-7])$/);
  if (rangeMatch) {
    const start = parseIntegerToken(rangeMatch[1], 0, 7);
    const end = parseIntegerToken(rangeMatch[2], 0, 7);
    if (start != null && end != null && start <= end) {
      return `${WEEKDAY_LABELS[start]}から${WEEKDAY_LABELS[end]}`;
    }
  }

  const listParts = normalized.split(",").map((part) => part.trim()).filter(Boolean);
  if (listParts.length > 1) {
    const labels = listParts
      .map((part) => {
        const weekdayValue = parseIntegerToken(part, 0, 7);
        return weekdayValue == null ? null : WEEKDAY_LABELS[weekdayValue];
      })
      .filter(Boolean);
    if (labels.length === listParts.length) {
      return labels.join("・");
    }
  }

  return null;
}

function describeCronExpression(expression) {
  const normalized = String(expression || "").trim();
  if (!isValidCronExpression(normalized)) {
    throw new Error("Invalid cron expression.");
  }

  const [minuteToken, hourToken, dayOfMonthToken, monthToken, dayOfWeekToken] = normalized.split(/\s+/);
  const minute = parseIntegerToken(minuteToken, 0, 59);
  const hour = parseIntegerToken(hourToken, 0, 23);
  const dayOfMonth = parseIntegerToken(dayOfMonthToken, 1, 31);
  const month = parseIntegerToken(monthToken, 1, 12);
  const weekdayLabel = parseWeekdayToken(dayOfWeekToken);

  if (
    minuteToken === "*" &&
    hourToken === "*" &&
    dayOfMonthToken === "*" &&
    monthToken === "*" &&
    dayOfWeekToken === "*"
  ) {
    return "毎分実行";
  }

  const everyMinuteMatch = minuteToken.match(/^\*\/(\d{1,2})$/);
  if (
    everyMinuteMatch &&
    hourToken === "*" &&
    dayOfMonthToken === "*" &&
    monthToken === "*" &&
    dayOfWeekToken === "*"
  ) {
    return `毎日、${Number(everyMinuteMatch[1])}分ごとに実行`;
  }

  if (
    minute != null &&
    hourToken === "*" &&
    dayOfMonthToken === "*" &&
    monthToken === "*" &&
    dayOfWeekToken === "*"
  ) {
    return `毎時${minute}分に実行`;
  }

  if (
    minute != null &&
    hour != null &&
    dayOfMonthToken === "*" &&
    monthToken === "*" &&
    dayOfWeekToken === "*"
  ) {
    return `毎日、${formatTimeLabel(hour, minute)}に実行`;
  }

  if (
    minute != null &&
    hour != null &&
    dayOfMonthToken === "*" &&
    monthToken === "*" &&
    weekdayLabel
  ) {
    if (weekdayLabel === "平日") {
      return `平日の${formatTimeLabel(hour, minute)}に実行`;
    }

    return `毎週${weekdayLabel}の${formatTimeLabel(hour, minute)}に実行`;
  }

  if (
    minute != null &&
    hour != null &&
    dayOfMonth != null &&
    monthToken === "*" &&
    dayOfWeekToken === "*"
  ) {
    return `毎月${dayOfMonth}日の${formatTimeLabel(hour, minute)}に実行`;
  }

  if (
    minute != null &&
    hour != null &&
    dayOfMonth != null &&
    month != null &&
    dayOfWeekToken === "*"
  ) {
    return `毎年${month}月${dayOfMonth}日の${formatTimeLabel(hour, minute)}に実行`;
  }

  const everyHourMatch = hourToken.match(/^\*\/(\d{1,2})$/);
  if (
    minute != null &&
    everyHourMatch &&
    dayOfMonthToken === "*" &&
    monthToken === "*" &&
    dayOfWeekToken === "*"
  ) {
    return `毎日、${Number(everyHourMatch[1])}時間ごとに${minute}分で実行`;
  }

  return `カスタム cron: ${normalized}`;
}

function formatStoredTarget(target) {
  if (!target || target.type === "spawn") {
    return {
      type: "spawn",
    };
  }

  if (target.type === "agent") {
    return {
      type: "agent",
      workspaceId: target.workspaceId,
      ...(target.agentName ? { agentName: target.agentName } : {}),
    };
  }

  return {
    type: "session",
    sessionId: target.sessionId,
    sessionTitleSnapshot: target.sessionTitleSnapshot || target.sessionId,
  };
}

function normalizeScheduleTargetObject(target) {
  if (target == null) {
    return {
      type: "spawn",
    };
  }

  const normalizedType = String(target.type || "").trim().toLowerCase();
  if (!normalizedType || normalizedType === "spawn") {
    return {
      type: "spawn",
    };
  }

  if (normalizedType === "agent") {
    const workspaceId = normalizeScheduleReference(
      target.workspaceId ?? target.workspace ?? target.workspaceReference,
    );
    const agentName = normalizeScheduleReference(
      target.agentName ?? target.agent ?? target.defaultAgent,
    );
    if (!workspaceId) {
      throw new Error("Schedule target workspaceId is required.");
    }

    return {
      type: "agent",
      workspaceId,
      ...(agentName ? { agentName } : {}),
    };
  }

  if (normalizedType !== "session") {
    throw new Error(`Unsupported schedule target type: ${normalizedType}`);
  }

  const sessionId = normalizeScheduleReference(
    target.sessionId ?? target.session ?? target.sessionReference,
  );
  if (!sessionId) {
    throw new Error("Schedule target sessionId is required.");
  }

  return {
    type: "session",
    sessionId,
    sessionTitleSnapshot:
      normalizeScheduleReference(target.sessionTitleSnapshot ?? target.sessionTitle) || sessionId,
  };
}

function normalizeScheduleTarget(input, existingJob = null) {
  if (hasOwn(input, "target")) {
    return normalizeScheduleTargetObject(input.target);
  }

  if (hasOwn(input, "session")) {
    const sessionReference = normalizeScheduleReference(input.session);
    if (!sessionReference) {
      return {
        type: "spawn",
      };
    }

    return {
      type: "session",
      sessionId: sessionReference,
      sessionTitleSnapshot: sessionReference,
    };
  }

  if (existingJob?.target) {
    return normalizeScheduleTargetObject(existingJob.target);
  }

  if (hasOwn(existingJob || {}, "session")) {
    const sessionReference = normalizeScheduleReference(existingJob.session);
    if (!sessionReference) {
      return {
        type: "spawn",
      };
    }

    return {
      type: "session",
      sessionId: sessionReference,
      sessionTitleSnapshot: sessionReference,
    };
  }

  return {
    type: "spawn",
  };
}

function formatStoredJob(job) {
  return {
    cron: job.cron,
    prompt: job.prompt,
    target: formatStoredTarget(job.target),
    timezone: job.timezone || DEFAULT_TIMEZONE,
    active: job.active !== false,
  };
}

function readJobFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizePersistedJob(name, input, existingJob = null) {
  const normalizedName = sanitizeJobName(name);
  const cronExpression = String(input?.cron ?? existingJob?.cron ?? "").trim();
  if (!isValidCronExpression(cronExpression)) {
    throw new Error(`Invalid cron expression for schedule "${normalizedName}".`);
  }

  const prompt = String(input?.prompt ?? existingJob?.prompt ?? "").trim();
  if (!prompt) {
    throw new Error(`Prompt is required for schedule "${normalizedName}".`);
  }

  const target = normalizeScheduleTarget(input, existingJob);
  const timezone = normalizeTimezone(
    input?.timezone !== undefined ? input.timezone : existingJob?.timezone,
  );
  const active =
    input?.active === undefined ? existingJob?.active !== false : Boolean(input.active);

  return {
    name: normalizedName,
    cron: cronExpression,
    prompt,
    target,
    timezone,
    active,
  };
}

function getTargetLogValue(target) {
  if (!target || target.type === "spawn") {
    return "spawn";
  }

  if (target.type === "agent") {
    return `${target.workspaceId}:${target.agentName || "(parent)"}`;
  }

  return target.sessionId;
}

export class SchedulerService {
  constructor({ config, bus }) {
    this.config = config;
    this.bus = bus;
    this.schedulesDir = config.schedulesDir;
    this.logPath = config.scheduleLogPath;
    this.jobs = new Map();
    this.runtimeState = new Map();
    this.triggerCallback = null;
    this.watcher = null;
    this.reloadTimer = null;
  }

  async init(triggerCallback) {
    this.triggerCallback = triggerCallback;
    fs.mkdirSync(this.schedulesDir, { recursive: true });
    await this.restoreJobs();
    this.startWatcher();
    return this.listJobs();
  }

  startWatcher() {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(this.schedulesDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", () => this.scheduleReload());
    this.watcher.on("change", () => this.scheduleReload());
    this.watcher.on("unlink", () => this.scheduleReload());
    this.watcher.on("error", (error) => {
      console.error("Schedule watcher error:", error);
    });
  }

  scheduleReload() {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.restoreJobs().catch((error) => {
        console.error("Failed to reload schedules:", error);
      });
    }, 150);
  }

  getJobFilePath(name) {
    return path.join(this.schedulesDir, `${sanitizeJobName(name)}${JOB_FILE_EXTENSION}`);
  }

  getTaskNextRun(task) {
    const nextRun = task?.getNextRun?.() || null;
    return nextRun instanceof Date ? nextRun.toISOString() : null;
  }

  listJobs() {
    return [...this.jobs.entries()]
      .map(([name, job]) => {
        const runtime = this.runtimeState.get(name) || {};
        return {
          name,
          cron: job.cron,
          prompt: job.prompt,
          target: formatStoredTarget(job.target),
          timezone: job.timezone,
          cronDescriptionJa: describeCronExpression(job.cron),
          active: job.active,
          nextRunAt: this.getTaskNextRun(job.task),
          lastRunAt: runtime.lastRunAt || null,
          lastStatus: runtime.lastStatus || (job.active ? "idle" : "paused"),
          lastError: runtime.lastError || null,
          lastSessionId: runtime.lastSessionId || null,
          lastSessionTitle: runtime.lastSessionTitle || null,
          filePath: this.getJobFilePath(name),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name, "ja"));
  }

  getJob(name) {
    return this.listJobs().find((job) => job.name === name) || null;
  }

  describeCron(expression) {
    return {
      cron: String(expression || "").trim(),
      descriptionJa: describeCronExpression(expression),
    };
  }

  listJobsReferencingSession(sessionId, sessionTitle = null) {
    const normalizedSessionId = normalizeScheduleReference(sessionId);
    const normalizedSessionTitle = normalizeScheduleReference(sessionTitle)?.toLowerCase() || null;

    return this.listJobs().filter((job) => {
      if (job.target?.type !== "session") {
        return false;
      }

      const targetReference = normalizeScheduleReference(job.target.sessionId);
      const targetSnapshot = normalizeScheduleReference(job.target.sessionTitleSnapshot);
      if (targetReference && normalizedSessionId && targetReference === normalizedSessionId) {
        return true;
      }

      if (!normalizedSessionTitle) {
        return false;
      }

      return (
        targetReference?.toLowerCase() === normalizedSessionTitle ||
        targetSnapshot?.toLowerCase() === normalizedSessionTitle
      );
    });
  }

  listJobsReferencingWorkspace(workspaceId) {
    const normalizedWorkspaceId = normalizeScheduleReference(workspaceId);
    if (!normalizedWorkspaceId) {
      return [];
    }

    return this.listJobs().filter((job) => {
      if (job.target?.type !== "agent") {
        return false;
      }
      return normalizeScheduleReference(job.target.workspaceId) === normalizedWorkspaceId;
    });
  }

  listJobsReferencingAgent(agentName) {
    const normalizedAgentName = normalizeScheduleReference(agentName);
    if (!normalizedAgentName) {
      return [];
    }

    return this.listJobs().filter((job) => {
      if (job.target?.type !== "agent") {
        return false;
      }
      return normalizeScheduleReference(job.target.agentName) === normalizedAgentName;
    });
  }

  async removeJobsReferencingWorkspace(workspaceId) {
    const jobs = this.listJobsReferencingWorkspace(workspaceId);
    for (const job of jobs) {
      await this.removeJob(job.name);
    }
    return jobs;
  }

  async removeJobsReferencingAgent(agentName) {
    const jobs = this.listJobsReferencingAgent(agentName);
    for (const job of jobs) {
      await this.removeJob(job.name);
    }
    return jobs;
  }

  writeJobFile(name, job) {
    const filePath = this.getJobFilePath(name);
    fs.mkdirSync(this.schedulesDir, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(formatStoredJob(job), null, 2)}\n`, "utf8");
    return filePath;
  }

  async addJob({ name, cron: cronExpression, prompt, target, timezone, active, session }) {
    const normalized = normalizePersistedJob(name, {
      cron: cronExpression,
      prompt,
      target,
      timezone,
      active,
      session,
    });
    const filePath = this.getJobFilePath(normalized.name);
    if (fs.existsSync(filePath)) {
      throw new Error(`Schedule "${normalized.name}" already exists.`);
    }

    this.writeJobFile(normalized.name, normalized);
    await this.restoreJobs();
    return this.getJob(normalized.name);
  }

  async updateJob(name, patch) {
    const filePath = this.getJobFilePath(name);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const existing = normalizePersistedJob(name, readJobFile(filePath));
    const next = normalizePersistedJob(name, patch, existing);
    this.writeJobFile(name, next);
    await this.restoreJobs();
    return this.getJob(name);
  }

  async removeJob(name) {
    const filePath = this.getJobFilePath(name);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.unlinkSync(filePath);
    this.runtimeState.delete(name);
    await this.restoreJobs();
    return true;
  }

  async restoreJobs() {
    fs.mkdirSync(this.schedulesDir, { recursive: true });
    this.stopAllTasks();

    const nextJobs = new Map();
    const fileNames = fs
      .readdirSync(this.schedulesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(JOB_FILE_EXTENSION))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "ja"));

    for (const fileName of fileNames) {
      const filePath = path.join(this.schedulesDir, fileName);
      const name = path.basename(fileName, JOB_FILE_EXTENSION);

      try {
        const job = normalizePersistedJob(name, readJobFile(filePath));
        const task =
          job.active &&
          this.triggerCallback &&
          cron.schedule(
            job.cron,
            async () => {
              await this.executeJob(job.name);
            },
            {
              timezone: job.timezone,
              noOverlap: true,
            },
          );

        nextJobs.set(job.name, {
          ...job,
          task,
        });

        const runtime = this.runtimeState.get(job.name) || {};
        this.runtimeState.set(job.name, {
          ...runtime,
          lastStatus: runtime.lastStatus || (job.active ? "idle" : "paused"),
        });
      } catch (error) {
        console.error(`Failed to load schedule file: ${filePath}`);
        console.error(error);
        this.runtimeState.set(name, {
          lastStatus: "error",
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.jobs = nextJobs;
    this.publishSchedulesChanged();
    return this.listJobs();
  }

  stopAllTasks() {
    for (const job of this.jobs.values()) {
      job.task?.stop?.();
      job.task?.destroy?.();
    }
  }

  appendLog(entry) {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.appendFileSync(
      this.logPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  }

  publishSchedulesChanged() {
    this.bus.publish("schedule.changed", {
      schedules: this.listJobs(),
    });
  }

  async executeJob(name) {
    const job = this.jobs.get(name);
    if (!job || !job.active || !this.triggerCallback) {
      return;
    }

    const startedAt = new Date().toISOString();
    const runtime = this.runtimeState.get(name) || {};
    this.runtimeState.set(name, {
      ...runtime,
      lastRunAt: startedAt,
      lastStatus: "running",
      lastError: null,
    });
    this.appendLog({
      name,
      status: "running",
      target: job.target,
      session: getTargetLogValue(job.target),
      cron: job.cron,
      prompt: job.prompt,
    });
    this.publishSchedulesChanged();

    try {
      const result = await this.triggerCallback({
        name,
        prompt: job.prompt,
        target: job.target,
        timezone: job.timezone,
      });
      const finishedAt = new Date().toISOString();
      this.runtimeState.set(name, {
        ...this.runtimeState.get(name),
        lastRunAt: finishedAt,
        lastStatus: "completed",
        lastError: null,
        lastSessionId: result?.session?.id || null,
        lastSessionTitle: result?.session?.title || null,
      });
      this.appendLog({
        name,
        status: "completed",
        target: job.target,
        session: result?.session?.id || getTargetLogValue(job.target),
        cron: job.cron,
        prompt: job.prompt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runtimeState.set(name, {
        ...this.runtimeState.get(name),
        lastRunAt: new Date().toISOString(),
        lastStatus: "error",
        lastError: message,
      });
      this.appendLog({
        name,
        status: "error",
        target: job.target,
        session: getTargetLogValue(job.target),
        cron: job.cron,
        prompt: job.prompt,
        error: message,
      });
      console.error(`Scheduled job failed: ${name}`);
      console.error(error);
    } finally {
      this.publishSchedulesChanged();
    }
  }

  async stopAll() {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.stopAllTasks();
    this.jobs.clear();
  }
}
