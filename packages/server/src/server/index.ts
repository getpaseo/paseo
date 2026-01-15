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

async function main() {
  const paseoHome = resolvePaseoHome();
  const persistedConfig = loadPersistedConfig(paseoHome);
  const logger = createRootLogger(persistedConfig);
  const config = loadConfig(paseoHome);
  const daemon = await createPaseoDaemon(config);

  await daemon.start();

  const handleShutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully...`);

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
