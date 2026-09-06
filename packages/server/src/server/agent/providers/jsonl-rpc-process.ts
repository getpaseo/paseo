import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import { spawnProcess } from "../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import { JsonlFrameDecoder } from "./jsonl-frame-decoder.js";
export { supportsJsonlRpcProtocolV2 } from "./jsonl-frame-decoder.js";

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
  defaultRequestTimeoutMs?: number;
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
  private readonly frameDecoder: JsonlFrameDecoder;

  constructor(private readonly options: JsonlRpcProcessOptions) {
    this.diagnosticName = options.diagnosticName ?? "JSONL RPC";
    this.frameDecoder = new JsonlFrameDecoder({
      frame: (message) => this.dispatchFrame(message),
      problem: (problem, detail) => {
        this.options.logger.warn(
          { problem, detail },
          `Ignoring invalid ${this.diagnosticName} frame`,
        );
      },
    });
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
    this.child.stdin.on("error", (error) => {
      this.handleStdinError(error);
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
    timeoutMs?: number | null,
  ): { id: string; promise: Promise<unknown> } {
    if (this.disposed) {
      return {
        id: "",
        promise: Promise.reject(new Error(`${this.diagnosticName} process is closed`)),
      };
    }
    const id = `req_${this.nextRequestId}`;
    this.nextRequestId += 1;
    const requestTimeoutMs =
      timeoutMs === undefined
        ? (this.options.defaultRequestTimeoutMs ?? JSONL_RPC_DEFAULT_TIMEOUT_MS)
        : timeoutMs;
    const startedAt = Date.now();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = createRequestTimeout(requestTimeoutMs, () => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.diagnosticName} request timed out phase=${command.type} elapsedMs=${Date.now() - startedAt} timeoutMs=${requestTimeoutMs}\n${this.stderrBuffer}`.trim(),
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
    timeoutMs?: number | null,
  ): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  send(message: Record<string, unknown>): void {
    if (this.disposed) {
      return;
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.handleStdinError(new Error(`${this.diagnosticName} stdin is not writable`));
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.handleStdinError(error);
    }
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
    this.frameDecoder.write(chunk);
  }

  /** Route a complete logical frame to its consumer (response or subscriber). */
  private dispatchFrame(message: Record<string, unknown>): void {
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

  private handleStdinError(error: unknown): void {
    if (this.disposed) {
      return;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    this.options.logger.warn({ err }, `${this.diagnosticName} stdin write failed`);
    void this.close(err);
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
