import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { Store } from "./store.js";
import { EventBus } from "./event-bus.js";
import { CodexAdapter } from "./codex-adapter.js";
import { AttachmentService } from "./attachment-service.js";
import { BridgeService } from "./bridge.js";
import { DiscordAdapter } from "./discord-adapter.js";
import { FileWatcherService } from "./file-watcher.js";
import { createHttpServer } from "./http-server.js";
import { SchedulerService } from "./scheduler.js";

async function main() {
  const config = loadConfig();
  const db = createDatabase(config.databasePath, config.codexDefaults);
  const store = new Store(db);
  const bus = new EventBus();
  const codex = new CodexAdapter(config);
  const attachments = new AttachmentService(config);
  const bridge = new BridgeService({ store, bus, codex, config, attachments });
  const discord = new DiscordAdapter({ bridge, bus, config, attachments });
  const fileWatcher = new FileWatcherService({ config, discord });
  const scheduler = new SchedulerService({ config, bus });
  const server = createHttpServer({
    config,
    bridge,
    bus,
    discord,
    attachments,
    scheduler,
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
    await scheduler.init(async (job) =>
      bridge.triggerScheduledJob({
        name: job.name,
        prompt: job.prompt,
        target: job.target,
      }),
    );
  } catch (error) {
    console.error("Scheduler failed to start.");
    console.error(error);
  }

  server.listen(config.port, config.host, () => {
    console.log(
      `Bridge server running at http://${config.host}:${config.port} with base workdir ${config.codexWorkdir}`,
    );
  });

  process.on("SIGINT", async () => {
    await scheduler.stopAll();
    await fileWatcher.stop();
    await discord.stop();
    bus.close();
    server.close(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
