import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { Store } from "./store.js";
import { EventBus } from "./event-bus.js";
import { CodexAdapter } from "./codex-adapter.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentBridge } from "./agent-bridge.js";
import { AttachmentService } from "./attachment-service.js";
import { BridgeService } from "./bridge.js";
import { DiscordAdapter } from "./discord-adapter.js";
import { FileWatcherService } from "./file-watcher.js";
import { createHttpServer } from "./http-server.js";
import { SchedulerService } from "./scheduler.js";
import { PtyService } from "./pty-service.js";

const RESTART_EXIT_CODE = 42;

async function main() {
  const config = loadConfig();
  const db = createDatabase(config.databasePath, config.codexDefaults);
  const store = new Store(db);
  const bus = new EventBus();
  const codex = new CodexAdapter(config);
  let shutdownPromise = null;
  let restartRequested = false;
  let restartPromise = null;
  let discord = null;
  let fileWatcher = null;
  let scheduler = null;
  let server = null;
  let ptyService = null;

  const agentRegistry = new AgentRegistry(config);
  // PtyService must be created before AgentBridge so it can be injected
  ptyService = new PtyService({ agentRegistry, config, bus, store });
  scheduler = new SchedulerService({ config, bus });
  const agentBridge = new AgentBridge({ agentRegistry, store, bus, config, ptyService, scheduler });
  const attachments = new AttachmentService(config);
  const bridge = new BridgeService({ store, bus, codex, config, attachments });
  const shutdown = async () => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      ptyService?.stopAll?.();
      agentBridge?.stopAll?.();
      agentRegistry?.stopAll?.();
      await scheduler?.stopAll?.();
      await fileWatcher?.stop?.();
      await discord?.stop?.();
      bus.close();
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    })();

    return shutdownPromise;
  };
  const restartServer = async ({ requestedBy = "unknown", source = "system" } = {}) => {
    if (restartPromise) {
      return restartPromise;
    }

    restartPromise = (async () => {
      restartRequested = true;
      process.env.MULTICLI_DISCORD_BASE_LAST_RESTART_REQUESTED_BY = requestedBy;
      process.env.MULTICLI_DISCORD_BASE_LAST_RESTART_SOURCE = source;
      process.env.MULTICLI_DISCORD_BASE_LAST_RESTARTED_AT = new Date().toISOString();

      await shutdown();
      process.exit(RESTART_EXIT_CODE);
    })();

    return restartPromise;
  };
  discord = new DiscordAdapter({ bridge, agentBridge, bus, config, attachments, restartServer, agentRegistry });
  fileWatcher = new FileWatcherService({ config, discord });
  server = createHttpServer({
    config,
    bridge,
    agentBridge,
    bus,
    discord,
    attachments,
    scheduler,
    restartServer,
    ptyService,
  });

  try {
    await discord.start();
  } catch (error) {
    console.error(
      "Discord adapter failed to start. Local UI will still be available.",
    );
    console.error(error);
  }

  try {
    await fileWatcher.start();
  } catch (error) {
    console.error("File watcher failed to start.");
    console.error(error);
  }

  try {
    await scheduler.init(async (job) => {
      if (String(job.target?.type || "").trim().toLowerCase() === "agent") {
        return agentBridge.runScheduledJob({
          name: job.name,
          prompt: job.prompt,
          target: job.target,
          workdir: bridge.getScheduleDefaults().workdir,
        });
      }

      return bridge.triggerScheduledJob({
        name: job.name,
        prompt: job.prompt,
        target: job.target,
      });
    });
  } catch (error) {
    console.error("Scheduler failed to start.");
    console.error(error);
  }

  const bootstrapResumeState = () => {
    try {
      const result = ptyService?.backfillStoredSessionRefs?.() ?? null;
      if (!result) return;
      console.log(
        `[pty] session backfill scanned ${result.candidateCount} workspace-agent pairs, updated ${result.updatedCount}`,
      );
    } catch (error) {
      console.warn("[pty] session backfill failed:", error?.message || error);
    }
  };

  server.listen(config.port, config.host, () => {
    console.log(
      `Bridge server running at http://${config.host}:${config.port} with base workdir ${config.codexWorkdir}`,
    );
    queueMicrotask(bootstrapResumeState);
  });

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(restartRequested ? RESTART_EXIT_CODE : 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
