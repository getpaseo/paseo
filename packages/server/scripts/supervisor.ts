import { fork, type ChildProcess } from "child_process";

type WorkerLifecycleMessage =
  | {
      type: "junction:shutdown";
    }
  | {
      type: "junction:restart";
      reason?: string;
    };

type SupervisorOptions = {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  restartOnCrash?: boolean;
  onSupervisorExit?: () => Promise<void> | void;
};

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "junction:shutdown") {
    return { type: "junction:shutdown" };
  }
  if (type === "junction:restart") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "junction:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  return null;
}

export function runSupervisor(options: SupervisorOptions): void {
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];

  let child: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let exiting = false;

  const log = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
  };

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

    child = fork(workerEntry, workerArgs, {
      stdio: "inherit",
      env: workerEnv,
      execArgv: workerExecArgv,
    });

    child.on("message", (msg: unknown) => {
      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage) {
        return;
      }

      if (lifecycleMessage.type === "junction:shutdown") {
        requestShutdown("Shutdown requested by worker");
        return;
      }

      requestRestart("Restart requested by worker");
    });

    child.on("exit", (code, signal) => {
      const exitDescriptor = describeExit(code, signal);

      if (shuttingDown) {
        log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
        exitSupervisor(0);
        return;
      }

      if (restarting || (restartOnCrash && code !== 0 && code !== null)) {
        restarting = false;
        log(`Worker exited (${exitDescriptor}). Restarting worker...`);
        spawnWorker();
        return;
      }

      log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
      exitSupervisor(typeof code === "number" ? code : 0);
    });
  };

  const requestRestart = (reason: string) => {
    if (!child || restarting || shuttingDown) {
      return;
    }
    restarting = true;
    log(`${reason}. Stopping worker for restart...`);
    child.kill("SIGTERM");
  };

  const requestShutdown = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    restarting = false;
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
  spawnWorker();
}
