import { createHubcodeDaemon } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { resolveHubcodeHome } from "./hubcode-home.js";
import { createRootLogger } from "./logger.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { acquirePidLock, PidLockError, releasePidLock, updatePidLock } from "./pid-lock.js";
import type { DaemonLifecycleIntent } from "./bootstrap.js";

type SupervisorLifecycleMessage =
  | {
      type: "hubcode:shutdown";
    }
  | {
      type: "hubcode:restart";
      reason?: string;
    };

async function main() {
  let hubcodeHome: string;
  let logger: ReturnType<typeof createRootLogger>;
  let config: ReturnType<typeof loadConfig>;
  let daemon: Awaited<ReturnType<typeof createHubcodeDaemon>> | null = null;
  let shutdownPromise: Promise<number> | null = null;
  let exitHookInstalled = false;
  const supervised = process.env.HUBCODE_SUPERVISED === "1" && typeof process.send === "function";
  let pidLockAcquired = false;

  try {
    hubcodeHome = resolveHubcodeHome();
    const persistedConfig = loadPersistedConfig(hubcodeHome);
    logger = createRootLogger(persistedConfig, { hubcodeHome });
    config = loadConfig(hubcodeHome);
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
  if (process.argv.includes("--no-inject-mcp")) {
    config.mcpInjectIntoAgents = false;
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
    },
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
          if (pidLockAcquired) {
            await releasePidLock(hubcodeHome);
            pidLockAcquired = false;
          }
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
        "Shutdown requested via websocket",
      );
      if (sendSupervisorLifecycleMessage({ type: "hubcode:shutdown" })) {
        return;
      }
      beginShutdown("shutdown lifecycle intent");
      return;
    }

    logger.warn(
      { clientId: intent.clientId, requestId: intent.requestId, reason: intent.reason },
      "Restart requested via websocket",
    );
    if (
      sendSupervisorLifecycleMessage({
        type: "hubcode:restart",
        ...(intent.reason ? { reason: intent.reason } : {}),
      })
    ) {
      return;
    }
    beginShutdown("restart lifecycle intent", { successExitCode: 0 });
  };

  try {
    if (!supervised) {
      await acquirePidLock(hubcodeHome, null);
      pidLockAcquired = true;
    }

    daemon = await createHubcodeDaemon(
      {
        ...config,
        onLifecycleIntent: handleLifecycleIntent,
      },
      logger,
    );
  } catch (err) {
    if (pidLockAcquired) {
      await releasePidLock(hubcodeHome);
      pidLockAcquired = false;
    }
    if (err instanceof PidLockError) {
      logger.error({ pid: err.existingLock?.pid }, err.message);
      process.exit(1);
    }
    logger.fatal({ err }, "Daemon bootstrap failed");
    throw err;
  }

  try {
    await daemon.start();
    if (!supervised) {
      const listenTarget = daemon.getListenTarget();
      const listen =
        listenTarget?.type === "tcp"
          ? `${listenTarget.host}:${listenTarget.port}`
          : listenTarget?.path;
      if (!listen) {
        throw new Error("Daemon did not expose a listen target after startup");
      }
      await updatePidLock(hubcodeHome, { listen });
    }
  } catch (err) {
    if (pidLockAcquired) {
      await releasePidLock(hubcodeHome);
      pidLockAcquired = false;
    }
    if (err instanceof PidLockError) {
      logger.error({ pid: err.existingLock?.pid }, err.message);
      process.exit(1);
    }
    logger.fatal({ err }, "Daemon failed to start listening");
    throw err;
  }

  process.on("SIGTERM", () => beginShutdown("SIGTERM"));
  process.on("SIGINT", () => beginShutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — daemon crashing");
    exitAfterPinoFlush();
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection — daemon crashing");
    exitAfterPinoFlush();
  });
}

// Give pino async streams a moment to flush the fatal log entry to daemon.log
// before the process exits. Without this, the last few entries that explain
// why the daemon crashed can be lost.
function exitAfterPinoFlush(): void {
  setTimeout(() => process.exit(1), 200);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  exitAfterPinoFlush();
});
