import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess } from "@getpaseo/plugin/server";
import { signalProcess } from "./signals.js";
import { createInterface } from "node:readline";
import type { ProviderLaunch, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import {
  AntigravityError,
  decodeFrame,
  diagnostic,
  encodePrompt,
  type Frame,
  type Init,
} from "./wire.js";

interface DriverOptions {
  launch: ProviderLaunch;
  config: ProviderSessionConfig;
  conversationId: string | null;
  onFrame(frame: Frame): void;
  onExit(error: AntigravityError): void;
}

export interface Driver {
  ready: Promise<Init>;
  selection: string;
  prompt(text: string): Promise<void>;
  stop(reason: "interrupt" | "close"): Promise<void>;
}

export function selection(config: ProviderSessionConfig): string {
  return JSON.stringify([config.model, config.mode]);
}

function driverArgs(options: DriverOptions): string[] {
  const { config, conversationId } = options;
  const args = [
    ...options.launch.args,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--add-dir",
    config.cwd,
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
  ];
  if (config.model) args.push("--model", config.model);
  if (conversationId) args.push("--conversation", conversationId);
  return args;
}

export function startDriver(options: DriverOptions): Driver {
  const child = spawnProcess(options.launch.command, driverArgs(options), {
    cwd: options.config.cwd,
    env: { ...options.launch.env, ...options.config.env },
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
  const lines = createInterface({ input: child.stdout });
  let cleanup = Promise.resolve();
  let stopResult: Promise<void> | undefined;
  let stderr = "";
  let state: "starting" | "ready" | "stopping" | "exited" = "starting";
  let resolveReady: (init: Init) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<Init>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let leaderExited = false;
  const startupDeadline = setTimeout(
    () =>
      fail(
        new AntigravityError("Antigravity did not initialize within 30 seconds", "STARTUP_TIMEOUT"),
      ),
    30_000,
  );
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  child.stdin.on("error", (error: Error) =>
    fail(new AntigravityError(error.message, "STDIN_ERROR")),
  );
  child.on("error", (error: Error) => fail(new AntigravityError(error.message, "SPAWN_ERROR")));
  child.on("close", (code, signal) => {
    leaderExited = true;
    clearTimeout(startupDeadline);
    lines.close();
    const error = new AntigravityError(
      diagnostic(stderr.trim() || `Antigravity exited (${signal || code})`),
      "PROCESS_EXIT",
    );
    if (state === "starting") rejectReady(error);
    if (state === "ready") options.onExit(error);
    state = "exited";
    resolveExit();
  });
  lines.on("line", (line) => {
    if (!line.trim() || state === "exited" || state === "stopping") return;
    let decoded: Frame;
    try {
      decoded = decodeFrame(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(new AntigravityError(`Invalid Antigravity output: ${message}`, "INVALID_FRAME"));
      return;
    }
    if (state === "starting") {
      if (decoded.event === "init") {
        clearTimeout(startupDeadline);
        state = "ready";
        resolveReady(decoded);
      } else if (decoded.event === "result") {
        fail(new AntigravityError(diagnostic(decoded.result.error), "STARTUP_ERROR"));
      }
      return;
    }
    options.onFrame(decoded);
  });

  function fail(failure: AntigravityError): void {
    clearTimeout(startupDeadline);
    if (state === "starting") rejectReady(failure);
    if (state === "ready") options.onExit(failure);
    if (state === "exited" || state === "stopping") return;
    state = "stopping";
    cleanup = Promise.resolve().then(() => signalGroup(child, "SIGKILL"));
    // The stop operation awaits cleanup and owns reporting its failure.
    void cleanup.catch(() => undefined);
  }

  async function stopDriver(reason: "interrupt" | "close"): Promise<void> {
    if (state === "stopping") {
      await cleanup;
      await exited;
      return;
    }
    if (process.platform === "win32") await cleanup;
    if (state === "exited") return;
    if (state === "starting") rejectReady(new AntigravityError("Antigravity startup canceled"));
    clearTimeout(startupDeadline);
    state = "stopping";
    if (process.platform === "win32") {
      // Node signal emulation kills only the leader; taskkill must see the live tree.
      cleanup = Promise.resolve().then(() => signalGroup(child, "SIGKILL"));
      await cleanup;
      await exited;
      return;
    }
    let escalationError: unknown;
    if (reason === "close") child.stdin.end();
    else {
      try {
        signalGroup(child, "SIGINT");
      } catch (error) {
        escalationError = error;
      }
    }
    let finishKillAttempt: () => void;
    const killAttempted = new Promise<void>((resolve) => {
      finishKillAttempt = resolve;
    });
    async function escalate(signal: NodeJS.Signals): Promise<void> {
      try {
        await signalGroup(child, signal);
      } catch (error) {
        escalationError ??= error;
      } finally {
        if (signal === "SIGKILL") finishKillAttempt();
      }
    }
    const terminate = setTimeout(() => void escalate("SIGTERM"), 1000);
    const kill = setTimeout(() => void escalate("SIGKILL"), 2000);
    try {
      await Promise.race([exited, killAttempted]);
      if (escalationError && !leaderExited)
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 250);
            void exited.then(() => clearTimeout(timeout));
          }),
        ]);
      if (escalationError && !leaderExited) throw escalationError;
      if (escalationError)
        console.error("Antigravity driver signal failed after exit", escalationError);
      if (!leaderExited) await exited;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
    // A tool can keep running after its CLI leader exits.
    try {
      signalGroup(child, "SIGKILL");
    } catch (error) {
      console.error("Antigravity driver straggler cleanup failed after exit", error);
    }
  }

  return {
    ready,
    selection: selection(options.config),
    prompt(text) {
      if (state !== "ready")
        return Promise.reject(new AntigravityError("Antigravity is not ready"));
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(encodePrompt(text), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    stop(reason) {
      stopResult ??= stopDriver(reason);
      return stopResult;
    },
  };
}

function signalGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void | Promise<void> {
  if (!child.pid) return;
  return signalProcess({ platform: process.platform, pid: child.pid, signal });
}

interface ProbeOptions {
  launch: ProviderLaunch;
  args: string[];
  cwd?: string;
}
export function probe(options: ProbeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(options.launch.command, [...options.launch.args, ...options.args], {
      env: options.launch.env,
      cwd: options.cwd,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => {
      const termination = Promise.resolve().then(() => signalGroup(child, "SIGKILL"));
      void termination.then(
        () => reject(new AntigravityError("Antigravity discovery timed out", "PROBE_TIMEOUT")),
        (error) => {
          console.error("Antigravity discovery cleanup failed", error);
          reject(new AntigravityError("Antigravity discovery timed out", "PROBE_TIMEOUT"));
          return undefined;
        },
      );
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", (error: Error) => {
      clearTimeout(deadline);
      reject(new AntigravityError(error.message, "SPAWN_ERROR"));
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (code === 0) resolve(stdout);
      else
        reject(
          new AntigravityError(
            diagnostic(stderr.trim() || `agy exited with code ${code}`),
            "PROBE_ERROR",
          ),
        );
    });
  });
}
