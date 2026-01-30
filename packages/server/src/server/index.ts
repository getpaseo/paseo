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

async function main() {
  const paseoHome = resolvePaseoHome();
  const persistedConfig = loadPersistedConfig(paseoHome);
  const logger = createRootLogger(persistedConfig);
  const config = loadConfig(paseoHome);

  if (process.argv.includes("--no-relay")) {
    config.relayEnabled = false;
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
  // Logger might not be initialized yet, so we need to handle this specially
  const paseoHome = resolvePaseoHome();
  const persistedConfig = loadPersistedConfig(paseoHome);
  const logger = createRootLogger(persistedConfig);
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
