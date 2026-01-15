import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
import { createPaseoDaemon } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { resolvePaseoHome } from "./paseo-home.js";

async function main() {
  const paseoHome = resolvePaseoHome();
  const config = loadConfig(paseoHome);
  const daemon = await createPaseoDaemon(config);

  await daemon.start();

  const handleShutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    const forceExit = setTimeout(() => {
      console.log("Forcing shutdown - HTTP server didn't close in time");
      process.exit(1);
    }, 10000);

    try {
      await daemon.stop();
      clearTimeout(forceExit);
      console.log("Server closed");
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExit);
      console.error("Shutdown failed:", error);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
