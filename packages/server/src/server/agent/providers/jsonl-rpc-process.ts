import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import { spawnProcess } from "../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";

/** Default wall-clock timeout for control-plane / short RPC calls. */
export const JSONL_RPC_DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Pass as `timeoutMs` to wait only for a response, process death, or `close()`.
 * Use for long-running blocking RPCs (e.g. LLM-backed compact).
 */
export const JSONL_RPC_NO_TIMEOUT = null;

const STDERR_BUFFER_LIMIT = 8192;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface JsonlRpcLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

interface JsonlRpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface JsonlRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error;
}

export interface JsonlRpcProcessOptions {
  launch: JsonlRpcLaunch;
  logger: Logger;
  diagnosticName?: string;
  spawn?: (launch: JsonlRpcLaunch) => ChildProcessWithoutNullStreams;
}

function assertChildWithPipes(
  child: ChildProcess,
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("JSONL RPC process was spawned without stdio streams");
  }
}

function spawnJsonlRpcProcess(launch: JsonlRpcLaunch): ChildProcessWithoutNullStreams {
  const child = spawnProcess(launch.command, launch.args, {
    cwd: launch.cwd,
    envOverlay: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertChildWithPipes(child);
  return child;
}

export class JsonlRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly diagnosticName: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageSubscribers = new Set<(message: Record<string, unknown>) => void>();
  private readonly exitSubscribers = new Set<(exit: JsonlRpcExit) => void>();
  private stderrBuffer = "";
  private nextRequestId = 1;
  private disposed = false;
  private stdoutBuffer = "";

  constructor(private readonly options: JsonlRpcProcessOptions) {
    this.diagnosticName = options.diagnosticName ?? "JSONL RPC";
    this.child = (options.spawn ?? spawnJsonlRpcProcess)(options.launch);
    this.child.stdout.on("data", (chunk) => {
      this.handleStdoutChunk(chunk.toString());
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });
    this.child.on("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `${this.diagnosticName} process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderrBuffer}`.trim(),
      );
      const exit = { code, signal, error };
      for (const subscriber of this.exitSubscribers) {
        subscriber(exit);
      }
      this.failAll(error);
    });
  }

  onMessage(callback: (message: Record<string, unknown>) => void): () => void {
    this.messageSubscribers.add(callback);
    return () => {
      this.messageSubscribers.delete(callback);
    };
  }

  onExit(callback: (exit: JsonlRpcExit) => void): () => void {
    this.exitSubscribers.add(callback);
    return () => {
      this.exitSubscribers.delete(callback);
    };
  }

  startRequest(
    command: { type: string; [key: string]: unknown },
    timeoutMs: number | null = JSONL_RPC_DEFAULT_TIMEOUT_MS,
  ): { id: string; promise: Promise<unknown> } {
    if (this.disposed) {
      return {
        id: "",
        promise: Promise.reject(new Error(`${this.diagnosticName} process is closed`)),
      };
    }
    const id = `req_${this.nextRequestId}`;
    this.nextRequestId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = createRequestTimeout(timeoutMs, () => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.diagnosticName} request timed out for ${command.type}\n${this.stderrBuffer}`.trim(),
          ),
        );
      });
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...command, id });
    });
    return { id, promise };
  }

  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs: number | null = JSONL_RPC_DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  send(message: Record<string, unknown>): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(error = new Error(`${this.diagnosticName} process is closed`)): Promise<void> {
    if (this.disposed) return;
    this.failAll(error);
    try {
      this.child.stdin.end();
    } catch {
      // Ignore cleanup races.
    }
    const result = await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.options.logger.warn(
          { timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          `${this.diagnosticName} process did not exit after SIGTERM; sending SIGKILL`,
        );
      },
    });
    if (result === "kill-timeout") {
      this.options.logger.warn(
        { timeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS },
        `${this.diagnosticName} process did not report exit after SIGKILL`,
      );
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.options.logger.warn(
        { error, line },
        `Ignoring non-JSON ${this.diagnosticName} stdout line`,
      );
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (message.type === "response") {
      this.handleResponse(message as unknown as JsonlRpcResponse);
      return;
    }
    for (const subscriber of this.messageSubscribers) {
      subscriber(message);
    }
  }

  private handleResponse(response: JsonlRpcResponse): void {
    if (!response.id) {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(response.id);
    if (!response.success) {
      pending.reject(
        new Error(
          response.error ?? `${this.diagnosticName} ${response.command ?? "request"} failed`,
        ),
      );
      return;
    }
    pending.resolve(response.data);
  }

  private failAll(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Schedule a request timeout, or return null when the call should wait
 * indefinitely for a response, process exit, or close().
 */
function createRequestTimeout(
  timeoutMs: number | null,
  onTimeout: () => void,
): NodeJS.Timeout | null {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return setTimeout(onTimeout, timeoutMs);
}
