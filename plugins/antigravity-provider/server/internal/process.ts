import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess } from "@getpaseo/plugin/server";
import { signalProcess } from "./signals.js";
import { createInterface } from "node:readline";
import type { ProviderLaunch, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import {
  AntigravityError,
  decodeAcpEvent,
  decodeFrame,
  diagnostic,
  encodePrompt,
  encodeRpc,
  type AcpEvent,
  type AcpUpdate,
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
    cleanup = Promise.resolve(signalGroup(child, "SIGKILL"));
    // The stop operation awaits cleanup and owns reporting its failure.
    void cleanup.catch(() => undefined);
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
    async stop(reason) {
      if (process.platform === "win32") await cleanup;
      if (state === "exited") return;
      if (state === "starting") rejectReady(new AntigravityError("Antigravity startup canceled"));
      clearTimeout(startupDeadline);
      state = "stopping";
      if (process.platform === "win32") {
        // Node signal emulation kills only the leader; taskkill must see the live tree.
        cleanup = Promise.resolve(signalGroup(child, "SIGKILL"));
        await cleanup;
        await exited;
        return;
      }
      if (reason === "close") child.stdin.end();
      else signalGroup(child, "SIGINT");
      const terminate = setTimeout(() => signalGroup(child, "SIGTERM"), 1000);
      const kill = setTimeout(() => signalGroup(child, "SIGKILL"), 2000);
      await exited;
      clearTimeout(terminate);
      clearTimeout(kill);
      // A tool can keep running after its CLI leader exits.
      signalGroup(child, "SIGKILL");
    },
  };
}

interface ConversationOptions {
  launch: ProviderLaunch;
  config: ProviderSessionConfig;
  conversationId: string;
  timeoutMs: number;
  settleMs: number;
}

/**
 * Reads a stored conversation through `agy acp` and resolves once its process group is gone, so it
 * cannot hold the conversation when the driver resumes it.
 */
export async function readConversation(options: ConversationOptions): Promise<AcpUpdate[]> {
  const child = spawnProcess(options.launch.command, [...options.launch.args, "acp"], {
    cwd: options.config.cwd,
    env: { ...options.launch.env, ...options.config.env },
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
  const exited = new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  try {
    return await loadConversation(child, options);
  } finally {
    await endConversation(child, exited);
  }
}

function loadConversation(
  child: ChildProcessWithoutNullStreams,
  options: ConversationOptions,
): Promise<AcpUpdate[]> {
  const initializeId = 1;
  const loadId = 2;
  return new Promise((resolve, reject) => {
    const updates: AcpUpdate[] = [];
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    let loaded = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(
      () =>
        fail(
          new AntigravityError(
            "Antigravity did not load the conversation in time",
            "HISTORY_TIMEOUT",
          ),
        ),
      options.timeoutMs,
    );
    function settle(): boolean {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(quiet);
      return true;
    }
    function fail(error: AntigravityError): void {
      if (settle()) reject(error);
    }
    // agy 1.5.9 bounds its wait for the history stream and can answer session/load while the
    // stream is still sending, so the reply does not end the history. A quiet stream does.
    function finishWhenQuiet(): void {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        if (settle()) resolve(updates);
      }, options.settleMs);
    }
    function send(message: Record<string, unknown>): void {
      child.stdin.write(encodeRpc(message));
    }
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.stdin.on("error", (error: Error) =>
      fail(new AntigravityError(error.message, "STDIN_ERROR")),
    );
    child.on("error", (error: Error) => fail(new AntigravityError(error.message, "SPAWN_ERROR")));
    child.on("close", (code, signal) => {
      if (loaded) {
        if (settle()) resolve(updates);
        return;
      }
      fail(
        new AntigravityError(
          diagnostic(stderr.trim() || `Antigravity exited (${signal || code})`),
          "PROCESS_EXIT",
        ),
      );
    });
    lines.on("line", (line) => {
      if (settled || !line.trim()) return;
      let event: AcpEvent;
      try {
        event = decodeAcpEvent(line, options.conversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(new AntigravityError(`Invalid Antigravity ACP output: ${message}`, "INVALID_FRAME"));
        return;
      }
      if (event.type === "update") {
        updates.push(event.update);
        if (loaded) finishWhenQuiet();
      } else if (event.type === "request")
        send({
          id: event.id,
          error: { code: -32601, message: "Paseo only reads Antigravity history" },
        });
      else if (event.type === "error")
        fail(new AntigravityError(diagnostic(event.message), "HISTORY_ERROR"));
      else if (event.type === "result" && event.id === initializeId)
        send({
          id: loadId,
          method: "session/load",
          params: { sessionId: options.conversationId, cwd: options.config.cwd, mcpServers: [] },
        });
      else if (event.type === "result" && event.id === loadId) {
        loaded = true;
        finishWhenQuiet();
      }
    });
    send({
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    });
  });
}

async function endConversation(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<void>,
): Promise<void> {
  if (process.platform === "win32") {
    // Node signal emulation kills only the leader; taskkill must see the live tree.
    await signalGroup(child, "SIGKILL");
    await exited;
    return;
  }
  // EOF lets agy finish shutting down its backend before it exits.
  child.stdin.end();
  const terminate = setTimeout(() => signalGroup(child, "SIGTERM"), 1000);
  const kill = setTimeout(() => signalGroup(child, "SIGKILL"), 2000);
  await exited;
  clearTimeout(terminate);
  clearTimeout(kill);
  // Processes agy started can outlive it.
  signalGroup(child, "SIGKILL");
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
      const termination = Promise.resolve(signalGroup(child, "SIGKILL"));
      void termination.then(() => {
        reject(new AntigravityError("Antigravity discovery timed out", "PROBE_TIMEOUT"));
        return undefined;
      }, reject);
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
