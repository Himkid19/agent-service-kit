import { createApp } from "./app.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { createLogger } from "./logger.js";
import { authService } from "./services/auth.service.js";
import { agentService } from "./services/agent.service.js";
import { chatService } from "./services/chat.service.js";
import { healthService } from "./services/health.service.js";
import { modelService } from "./services/model.service.js";
import { workspaceManager } from "./services/workspace.service.js";

const log = createLogger("server");

async function main() {
  // Initialize all services
  await workspaceManager.init();
  await db.init(); // MySQL connection + migrations
  await authService.init();
  await agentService.init();
  await modelService.init(config.agentDir);
  await chatService.init();

  // .env provider is only a fallback: if the same provider exists in MySQL,
  // the DB config (base_url, api_key) wins and .env is not applied.
  const envFallback = await modelService.applyEnvFallback();
  const pName = config.providerName || config.defaultProvider;
  if (envFallback === "env") {
    log.info(`Provider "${pName}" registered from .env`);
  } else if (envFallback === "mysql") {
    log.info(`Provider "${pName}" found in MySQL; .env fallback not applied`);
  }

  // Seed default admin account
  await authService.seedAdmin();

  // Periodic DB heartbeat: keeps pooled connections warm (prevents the
  // idle-connection drop that caused multi-minute request hangs) and logs
  // outages as they happen instead of at the next unlucky request.
  healthService.start();

  // Start HTTP server
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    log.info(`Agent Core Service running on http://${config.host}:${config.port}`);
    log.info(`Workplaces: ${config.workplacesDir}`);
    log.info(`Database: ${config.dbHost}:${config.dbPort}/${config.dbName}`);
  });

  // LLM streaming responses can legitimately take minutes, so the request
  // timeout is the stream timeout plus a buffer. headersTimeout must stay
  // below keepAliveTimeout per Node's requirements.
  server.requestTimeout = config.streamTimeoutMs + 30_000;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.on("error", (err) => {
    log.error("http server error", err);
  });

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    healthService.stop();
    chatService.dispose();
    await db.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Fatal errors must terminate the process: after an uncaught exception or
// unhandled rejection the runtime state is undefined, and a half-dead server
// holding (potentially leaked) memory forever is worse than a clean restart.
// The container runs with --restart unless-stopped, so exiting hands the
// problem to the supervisor which restarts from a clean state.
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection (fatal, exiting)", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException (fatal, exiting)", err);
  process.exit(1);
});

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
