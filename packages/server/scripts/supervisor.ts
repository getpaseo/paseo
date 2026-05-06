import { fork, spawn, type ChildProcess } from "child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createStream as createRotatingFileStream } from "rotating-file-stream";

interface SupervisorLogFileOptions {
  path: string;
  rotate: {
    maxSize: string;
    maxFiles: number;
  };
}

type WorkerLifecycleMessage =
  | {
      type: "paseo:shutdown";
    }
  | {
      type: "paseo:ready";
      listen: string;
    }
  | {
      type: "paseo:restart";
      reason?: string;
    };

interface SupervisorOptions {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  resolveWorkerSpawnSpec?: (workerEntry: string) => {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  } | null;
  onWorkerReady?: (message: { listen: string }) => Promise<void> | void;
  restartOnCrash?: boolean;
  onSupervisorExit?: () => Promise<void> | void;
  logFile?: SupervisorLogFileOptions;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "paseo:shutdown") {
    return { type: "paseo:shutdown" };
  }
  if (type === "paseo:ready") {
    const listen = (msg as { listen?: unknown }).listen;
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    return { type: "paseo:ready", listen };
  }
  if (type === "paseo:restart") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  return null;
}

function toRotatingFileStreamSize(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  if (!match) {
    return trimmed;
  }

  const value = match[1];
  const unit = (match[2] ?? "M").toUpperCase();
  return `${value}${unit}`;
}

function createSupervisorLogStream(options: SupervisorLogFileOptions | undefined) {
  if (!options) {
    return null;
  }

  mkdirSync(path.dirname(options.path), { recursive: true });
  return createRotatingFileStream(path.basename(options.path), {
    path: path.dirname(options.path),
    size: toRotatingFileStreamSize(options.rotate.maxSize),
    maxFiles: options.rotate.maxFiles,
  });
}

export function runSupervisor(options: SupervisorOptions): void {
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];
  const resolveWorkerSpawnSpec = options.resolveWorkerSpawnSpec;

  let child: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let exiting = false;
  const logStream = createSupervisorLogStream(options.logFile);

  const writeDurableChunk = (chunk: string | Buffer): void => {
    logStream?.write(chunk);
  };

  const writeLifecycleLog = (message: string, fields: Record<string, unknown> = {}): void => {
    writeDurableChunk(
      `${JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        pid: process.pid,
        name: options.name,
        msg: message,
        ...fields,
      })}\n`,
    );
  };

  const log = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    writeLifecycleLog(message);
  };

  const closeLogStream = (): Promise<void> =>
    new Promise((resolve) => {
      if (!logStream) {
        resolve();
        return;
      }
      logStream.end(resolve);
    });

  const exitSupervisor = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    Promise.resolve(options.onSupervisorExit?.())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor exit cleanup failed: ${message}`);
      })
      .then(closeLogStream)
      .finally(() => {
        process.exit(code);
      });
  };

  const spawnWorker = () => {
    let workerEntry: string;
    try {
      // Resolve at spawn time so restarts pick up current filesystem state.
      workerEntry = options.resolveWorkerEntry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Failed to resolve worker entry: ${message}`);
      exitSupervisor(1);
      return;
    }

    const spawnSpec = resolveWorkerSpawnSpec?.(workerEntry) ?? null;
    writeLifecycleLog("Spawning worker", { workerEntry });
    if (spawnSpec) {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: spawnSpec.env ?? workerEnv,
      });
    } else {
      child = fork(workerEntry, workerArgs, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: workerEnv,
        execArgv: workerExecArgv,
      });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      writeDurableChunk(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      writeDurableChunk(chunk);
    });

    child.on("message", (msg: unknown) => {
      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage) {
        return;
      }

      if (lifecycleMessage.type === "paseo:ready") {
        writeLifecycleLog("Worker ready", { listen: lifecycleMessage.listen });
        Promise.resolve(options.onWorkerReady?.({ listen: lifecycleMessage.listen })).catch(
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            log(`Worker ready callback failed: ${message}`);
          },
        );
        return;
      }

      if (lifecycleMessage.type === "paseo:shutdown") {
        writeLifecycleLog("Worker requested shutdown");
        requestShutdown("Shutdown requested by worker");
        return;
      }

      writeLifecycleLog(
        "Worker requested restart",
        lifecycleMessage.reason ? { reason: lifecycleMessage.reason } : {},
      );
      requestRestart("Restart requested by worker");
    });

    child.on("close", (code, signal) => {
      const exitDescriptor = describeExit(code, signal);
      writeLifecycleLog("Worker exited", { code, signal, exit: exitDescriptor });

      if (shuttingDown) {
        log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
        exitSupervisor(0);
        return;
      }

      const crashed =
        restartOnCrash &&
        ((code !== 0 && code !== null) || (signal !== null && signal !== "SIGTERM"));

      if (restarting || crashed) {
        restarting = false;
        log(
          crashed
            ? `Worker crashed (${exitDescriptor}). Restarting worker...`
            : `Worker exited (${exitDescriptor}). Restarting worker...`,
        );
        spawnWorker();
        return;
      }

      log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
      exitSupervisor(typeof code === "number" ? code : 1);
    });
  };

  const requestRestart = (reason: string) => {
    if (!child || restarting || shuttingDown) {
      return;
    }
    restarting = true;
    writeLifecycleLog("Restart requested", { reason });
    log(`${reason}. Stopping worker for restart...`);
    child.kill("SIGTERM");
  };

  const requestShutdown = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    restarting = false;
    writeLifecycleLog("Supervisor shutdown requested", { reason });
    log(`${reason}. Stopping worker...`);
    if (!child) {
      exitSupervisor(0);
      return;
    }
    child.kill("SIGTERM");
  };

  const forwardSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`Received ${signal}`);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  writeLifecycleLog(options.startupMessage);
  spawnWorker();
}
