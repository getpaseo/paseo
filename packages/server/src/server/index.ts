import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
import { createPaseoDaemon } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { resolvePaseoHome } from "./paseo-home.js";
import { createRootLogger } from "./logger.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { PidLockError } from "./pid-lock.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

async function main() {
  let paseoHome: string;
  let logger: ReturnType<typeof createRootLogger>;
  let config: ReturnType<typeof loadConfig>;

  try {
    paseoHome = resolvePaseoHome();
    const persistedConfig = loadPersistedConfig(paseoHome);
    logger = createRootLogger(persistedConfig);
    config = loadConfig(paseoHome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }

  if (process.argv.includes("--no-relay")) {
    config.relayEnabled = false;
  }
  if (process.argv.includes("--no-mcp")) {
    config.mcpEnabled = false;
  }

  // E2E / test mode: run the daemon with deterministic fake agent clients.
  // This keeps Playwright tests stable and avoids depending on external provider auth.
  if (process.env.PASEO_USE_FAKE_AGENTS === "1") {
    config.agentClients = createTestAgentClients();
  }
  const daemon = await createPaseoDaemon(config, logger);

  try {
    await daemon.start();
  } catch (err) {
    if (err instanceof PidLockError) {
      logger.error({ pid: err.existingLock?.pid }, err.message);
      process.exit(1);
    }
    throw err;
  }

  let shuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.info("Forcing exit...");
      process.exit(1);
    }
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully... (press Ctrl+C again to force exit)`);

    const forceExit = setTimeout(() => {
      logger.warn("Forcing shutdown - HTTP server didn't close in time");
      process.exit(1);
    }, 10000);

    try {
      await daemon.stop();
      clearTimeout(forceExit);
      logger.info("Server closed");
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExit);
      logger.error({ err }, "Shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}

main().catch((err) => {
  if (process.env.PASEO_DEBUG === "1") {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
});
