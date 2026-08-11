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

/**
 * Reassembly state for a protocol v2 chunked frame sequence. Some agents that
 * speak this JSONL RPC protocol (OMP) cap single-line frames at 1 MiB and emit
 * larger frames as ordered `rpc_chunk` frames; the transport reassembles them
 * into the original logical frame before routing it.
 */
interface PendingChunkSequence {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

/** Validated metadata fields of a protocol v2 `rpc_chunk` frame. */
interface RpcChunkMetadata {
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
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
  private pendingChunks: PendingChunkSequence | null = null;

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
    if (message.type === "rpc_chunk") {
      const reassembled = this.consumeRpcChunk(message);
      if (reassembled !== undefined) {
        // The reassembled frame is a complete logical frame; route it through
        // the same path as any other parsed line.
        this.handleLine(JSON.stringify(reassembled));
      }
      return;
    }
    this.dispatchFrame(message);
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

  /**
   * Reassemble a protocol v2 `rpc_chunk` frame. Returns the reconstructed
   * logical frame once the final chunk of a sequence arrives, `undefined` while
   * a sequence is still in progress, and drops (returning `undefined`) any
   * malformed or out-of-order chunk after logging it.
   */
  private consumeRpcChunk(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
    const metadata = this.parseChunkMetadata(chunk);
    if (metadata === undefined) {
      return undefined;
    }
    const bytes = this.decodeChunkPayload(metadata.data);
    if (bytes === undefined) {
      return undefined;
    }
    return this.appendChunk(metadata, bytes);
  }

  /** Validate a `rpc_chunk` frame's metadata, or reset the sequence and return undefined. */
  private parseChunkMetadata(chunk: Record<string, unknown>): RpcChunkMetadata | undefined {
    const chunkId = chunk.chunkId;
    const data = chunk.data;
    const index = chunk.index;
    const count = chunk.count;
    const byteLength = chunk.byteLength;
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      typeof data !== "string" ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      index >= count ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0
    ) {
      this.options.logger.warn(
        { chunk },
        `Ignoring malformed ${this.diagnosticName} rpc_chunk frame`,
      );
      this.pendingChunks = null;
      return undefined;
    }
    return { chunkId, index, count, byteLength, data };
  }

  /** Decode a chunk payload, or reset the sequence and return undefined on bad base64. */
  private decodeChunkPayload(data: string): Buffer | undefined {
    try {
      const bytes = Buffer.from(data, "base64");
      if (bytes.toString("base64") !== data) {
        throw new Error("invalid base64 payload");
      }
      return bytes;
    } catch {
      this.options.logger.warn({}, `Ignoring ${this.diagnosticName} rpc_chunk with invalid base64`);
      this.pendingChunks = null;
      return undefined;
    }
  }

  /** Append a chunk to the in-progress sequence, finalizing it once complete. */
  private appendChunk(
    metadata: RpcChunkMetadata,
    bytes: Buffer,
  ): Record<string, unknown> | undefined {
    let pending = this.pendingChunks;
    if (pending === null) {
      if (metadata.index !== 0) {
        this.options.logger.warn(
          {},
          `Ignoring ${this.diagnosticName} rpc_chunk sequence that did not start at index 0`,
        );
        return undefined;
      }
      pending = {
        chunkId: metadata.chunkId,
        count: metadata.count,
        byteLength: metadata.byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
      this.pendingChunks = pending;
    }

    if (
      pending.chunkId !== metadata.chunkId ||
      pending.count !== metadata.count ||
      pending.byteLength !== metadata.byteLength ||
      pending.nextIndex !== metadata.index
    ) {
      this.options.logger.warn(
        {},
        `Ignoring out-of-order ${this.diagnosticName} rpc_chunk; dropping sequence`,
      );
      this.pendingChunks = null;
      return undefined;
    }

    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;

    if (pending.receivedBytes > pending.byteLength) {
      this.options.logger.warn(
        {},
        `Ignoring ${this.diagnosticName} rpc_chunk sequence exceeding its declared length`,
      );
      this.pendingChunks = null;
      return undefined;
    }
    if (pending.nextIndex < pending.count) {
      return undefined;
    }
    if (pending.receivedBytes !== pending.byteLength) {
      this.options.logger.warn(
        {},
        `Ignoring ${this.diagnosticName} rpc_chunk sequence with a length mismatch`,
      );
      this.pendingChunks = null;
      return undefined;
    }

    this.pendingChunks = null;
    return this.finalizeChunks(pending.chunks);
  }

  /** Reassemble and parse a complete chunk sequence into its logical frame. */
  private finalizeChunks(chunks: Buffer[]): Record<string, unknown> | undefined {
    let json: string;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      this.options.logger.warn(
        {},
        `Ignoring ${this.diagnosticName} rpc_chunk sequence with invalid UTF-8`,
      );
      return undefined;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(json);
    } catch {
      this.options.logger.warn(
        {},
        `Ignoring ${this.diagnosticName} rpc_chunk sequence with invalid JSON`,
      );
      return undefined;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      return undefined;
    }
    return frame as Record<string, unknown>;
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
