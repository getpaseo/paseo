import { createPaseoDaemon } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { resolvePaseoHome } from "./paseo-home.js";
import { createRootLogger } from "./logger.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { PidLockError } from "./pid-lock.js";
import type { DaemonLifecycleIntent } from "./bootstrap.js";

type SupervisorLifecycleMessage =
  | {
      type: "paseo:shutdown";
    }
  | {
      type: "paseo:restart";
      reason?: string;
    };

async function main() {
  let paseoHome: string;
  let logger: ReturnType<typeof createRootLogger>;
  let config: ReturnType<typeof loadConfig>;
  let daemon: Awaited<ReturnType<typeof createPaseoDaemon>> | null = null;
  let shutdownPromise: Promise<number> | null = null;
  let exitHookInstalled = false;

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

  const installExitHook = () => {
    if (exitHookInstalled || !shutdownPromise) {
      return;
    }
    exitHookInstalled = true;
    void shutdownPromise.then((exitCode) => {
      process.exit(exitCode);
    });
  };

  const beginShutdown = (
    signal: string,
    options?: {
      successExitCode?: number;
    }
  ) => {
    if (!shutdownPromise) {
      logger.info(`${signal} received, shutting down gracefully...`);

      shutdownPromise = (async () => {
        const forceExit = setTimeout(() => {
          logger.warn("Forcing shutdown - HTTP server didn't close in time");
          process.exit(1);
        }, 10000);

        try {
          if (!daemon) {
            logger.error("Shutdown requested before daemon initialization completed");
            clearTimeout(forceExit);
            return 1;
          }
          await daemon.stop();
          clearTimeout(forceExit);
          logger.info("Server closed");
          return options?.successExitCode ?? 0;
        } catch (err) {
          clearTimeout(forceExit);
          logger.error({ err }, "Shutdown failed");
          return 1;
        }
      })();
    } else {
      logger.info(`${signal} received while shutdown is already in progress`);
    }

    installExitHook();
  };

  const sendSupervisorLifecycleMessage = (message: SupervisorLifecycleMessage): boolean => {
    if (typeof process.send !== "function") {
      return false;
    }
    try {
      process.send(message);
      return true;
    } catch (err) {
      logger.error({ err, message }, "Failed to send lifecycle IPC message to supervisor");
      return false;
    }
  };

  const handleLifecycleIntent = (intent: DaemonLifecycleIntent) => {
    if (intent.type === "shutdown") {
      logger.warn(
        { clientId: intent.clientId, requestId: intent.requestId },
        "Shutdown requested via websocket"
      );
      if (sendSupervisorLifecycleMessage({ type: "paseo:shutdown" })) {
        return;
      }
      beginShutdown("shutdown lifecycle intent");
      return;
    }

    logger.warn(
      { clientId: intent.clientId, requestId: intent.requestId, reason: intent.reason },
      "Restart requested via websocket"
    );
    if (
      sendSupervisorLifecycleMessage({
        type: "paseo:restart",
        ...(intent.reason ? { reason: intent.reason } : {}),
      })
    ) {
      return;
    }
    beginShutdown("restart lifecycle intent", { successExitCode: 0 });
  };

  try {
    const pidLockMode = process.env.PASEO_PID_LOCK_MODE === "external" ? "external" : "self";
    daemon = await createPaseoDaemon(
      {
        ...config,
        onLifecycleIntent: handleLifecycleIntent,
        pidLock: {
          mode: pidLockMode,
        },
      },
      logger
    );
  } catch (err) {
    if (err instanceof PidLockError) {
      logger.error({ pid: err.existingLock?.pid }, err.message);
      process.exit(1);
    }
    throw err;
  }

  try {
    await daemon.start();
  } catch (err) {
    if (err instanceof PidLockError) {
      logger.error({ pid: err.existingLock?.pid }, err.message);
      process.exit(1);
    }
    throw err;
  }

  process.on("SIGTERM", () => beginShutdown("SIGTERM"));
  process.on("SIGINT", () => beginShutdown("SIGINT"));
}

main().catch((err) => {
  if (process.env.PASEO_DEBUG === "1") {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
});
