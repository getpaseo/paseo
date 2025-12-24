import "dotenv/config";
import { createPaseoDaemon } from "./bootstrap.js";
import { buildPaseoDaemonConfigFromEnv } from "./config.js";

async function main() {
  const daemonConfig = buildPaseoDaemonConfigFromEnv();
  const daemon = await createPaseoDaemon(daemonConfig);

  daemon.httpServer.listen(daemonConfig.port, () => {
    console.log(
      `\n✓ Voice Assistant server running on http://localhost:${daemonConfig.port}`
    );
  });
  const handleShutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    const forceExit = setTimeout(() => {
      console.log("Forcing shutdown - HTTP server didn't close in time");
      process.exit(1);
    }, 10000);

    try {
      await daemon.close();
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
