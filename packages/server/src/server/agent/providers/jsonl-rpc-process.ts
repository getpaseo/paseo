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
/** OMP protocol v2 transport ceiling: a single logical frame assembled by chunk decoding. */
const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** OMP physical-frame ceiling: frames at or below this size are never chunked. */
const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Per-chunk payload ceiling used by OMP's encoder; mirrored here for validator parity. */
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;
/** Hard cap on chunk-id length to bound pending-state allocations. */
const RPC_CHUNK_ID_MAX_LENGTH = 128;
/**
 * Upper bound on the encoded base64 length of one chunk payload (256 KiB of
 * raw bytes): `ceil(262144 / 3) * 4 + 4` for the maximum padding. Checking
 * the encoded length before `Buffer.from` prevents allocating an unbounded
 * buffer from a hostile or oversized `data` field.
 */
const MAX_ENCODED_CHUNK_BYTES = Math.ceil(RPC_CHUNK_PAYLOAD_BYTES / 3) * 4 + 4;
/** Canonical base64 alphabet used by OMP; equivalent to /^[A-Za-z0-9+/]*={0,2}$/ but faster. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface PendingRpcChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

/**
 * Stateless mirror of OMP's `RpcFrameDecoder` (rpc-frame.ts) implemented inline to
 * keep the OMP SDK out of `@paseo/server`. Validates metadata, canonical base64,
 * contiguous seq, declared length, the 64 MiB cap, and produces a fatal error for
 * any non-conforming line, exactly matching the OMP contract.
 */
class RpcChunkFrameDecoder {
  #pending?: PendingRpcChunks;

  /**
   *   - Returns an object when the assembled logical frame is complete.
   *   - Returns `undefined` while more chunks are still expected.
   *   - Throws on any wire-protocol violation (metadata, base64, order, length, cap,
   *     UTF-8, non-object root) or when a non-chunk line arrives while a sequence is
   *     in flight (interruption). The caller MUST treat any thrown error as a fatal
   *     transport failure.
   */
  push(value: unknown): Record<string, unknown> | undefined {
    const obj = this.#coerceObject(value);
    if (obj === null || obj.type !== "rpc_chunk") {
      return this.#handleNonChunk(obj);
    }
    const { chunkId, index, count, byteLength } = this.#validateChunkMetadata(obj);
    const bytes = decodeBase64(obj.data);
    if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new Error("rpc chunk payload exceeds the transport limit");
    }
    const pending = this.#openOrContinueSequence(index, count, byteLength, chunkId);
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;
    if (pending.receivedBytes > pending.byteLength) {
      throw new Error("rpc chunk sequence exceeds declared length");
    }
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength) {
      throw new Error("rpc chunk sequence length mismatch");
    }
    return this.#finalizePending(pending);
  }

  hasPendingSequence(): boolean {
    return this.#pending !== undefined;
  }

  #coerceObject(value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  #handleNonChunk(obj: Record<string, unknown> | null): Record<string, unknown> {
    if (this.#pending) throw new Error("rpc chunk sequence interrupted");
    if (obj === null) throw new Error("rpc frame must be an object");
    return obj;
  }

  #validateChunkMetadata(obj: Record<string, unknown>): {
    chunkId: string;
    index: number;
    count: number;
    byteLength: number;
  } {
    const { chunkId, index, count, byteLength } = obj;
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > RPC_CHUNK_ID_MAX_LENGTH ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      (index as number) < 0 ||
      (count as number) < 2 ||
      (count as number) > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
      (index as number) >= (count as number) ||
      (byteLength as number) < MAX_RPC_FRAME_BYTES ||
      (byteLength as number) > MAX_RPC_REASSEMBLED_BYTES
    ) {
      throw new Error("invalid rpc chunk metadata");
    }
    return {
      chunkId: chunkId as string,
      index: index as number,
      count: count as number,
      byteLength: byteLength as number,
    };
  }

  #openOrContinueSequence(
    index: number,
    count: number,
    byteLength: number,
    chunkId: string,
  ): PendingRpcChunks {
    let pending = this.#pending;
    if (!pending) {
      if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
      pending = {
        chunkId,
        count,
        byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
      this.#pending = pending;
    }
    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      throw new Error("rpc chunk sequence mismatch");
    }
    return pending;
  }

  #finalizePending(pending: PendingRpcChunks): Record<string, unknown> {
    this.#pending = undefined;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    const frame: unknown = JSON.parse(decoded);
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      throw new Error("rpc frame must be an object");
    }
    return frame as Record<string, unknown>;
  }
}

function decodeBase64(data: unknown): Buffer {
  if (typeof data !== "string") {
    throw new Error("invalid rpc chunk data");
  }
  if (data.length === 0) {
    throw new Error("invalid rpc chunk data");
  }
  // Bound the encoded length before any Buffer allocation. A single canonical
  // base64 string cannot represent more than `floor(length * 3 / 4)` raw
  // bytes, so an encoded length above the cap can never decode into a
  // payload at or below RPC_CHUNK_PAYLOAD_BYTES.
  if (data.length > MAX_ENCODED_CHUNK_BYTES) {
    throw new Error("rpc chunk payload exceeds the transport limit");
  }
  if (!CANONICAL_BASE64.test(data)) {
    throw new Error("invalid rpc chunk data");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new Error("invalid rpc chunk data");
  if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
    throw new Error("rpc chunk payload exceeds the transport limit");
  }
  return bytes;
}

export interface JsonlRpcLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface JsonlRpcResponse {
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
  /** Resolve with the full response envelope instead of only `data`. */
  fullResponse?: boolean;
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
  private readyFrame: Record<string, unknown> | null = null;
  private readyPromise: Promise<Record<string, unknown>> | null = null;
  private readyResolve: ((frame: Record<string, unknown>) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private chunkDecoderEnabled = false;
  private readonly chunkDecoder = new RpcChunkFrameDecoder();

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

  /**
   * Resolve with the first raw `{ type: "ready" }` frame once it has been
   * delivered to subscribers. The frame is also delivered through the normal
   * message path; this method does not consume or suppress it. Idempotent:
   * every call returns the same promise, and callers that await after the
   * ready frame has already arrived receive the retained frame immediately.
   * Rejects with the transport-failure error if the process fails before the
   * first ready frame.
   */
  awaitReady(): Promise<Record<string, unknown>> {
    if (this.readyFrame) {
      return Promise.resolve(this.readyFrame);
    }
    if (!this.readyPromise) {
      this.readyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }
    return this.readyPromise;
  }

  /**
   * Opt the transport into OMP-compatible chunk decoding for the lifetime of
   * the process. After this call, every parsed line is routed through an
   * `RpcChunkFrameDecoder` that mirrors the OMP `RpcFrameDecoder` contract:
   * strict metadata, canonical base64, contiguous chunk order, declared-length
   * equality, the 64 MiB reassembly cap, fatal UTF-8 decoding, and a plain
   * object root. Reconstructed frames flow through the same correlation and
   * subscriber path as ordinary lines. A `rpc_chunk` line received before this
   * call, or any decoder violation, is a fatal transport failure: all pending
   * requests reject and no further lines are accepted.
   */
  enableChunkDecoder(): void {
    this.chunkDecoderEnabled = true;
  }

  /**
   * Like `request()`, but resolves with the correlated full response envelope
   * (`{ type, id, command, success, data, error }`) instead of only `data`.
   * Rejects on `success: false` exactly like `request()`. Use this when the
   * caller must inspect the response `command` (e.g. confirming a
   * `negotiate_protocol` response) in addition to the payload.
   */
  requestResponse(
    command: { type: string; [key: string]: unknown },
    timeoutMs: number | null = JSONL_RPC_DEFAULT_TIMEOUT_MS,
  ): Promise<JsonlRpcResponse> {
    if (this.disposed) {
      return Promise.reject(new Error(`${this.diagnosticName} process is closed`));
    }
    const id = `req_${this.nextRequestId}`;
    this.nextRequestId += 1;
    const promise = new Promise<JsonlRpcResponse>((resolve, reject) => {
      const timer = createRequestTimeout(timeoutMs, () => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.diagnosticName} request timed out for ${command.type}\n${this.stderrBuffer}`.trim(),
          ),
        );
      });
      this.pending.set(id, {
        resolve: (value) => resolve(value as JsonlRpcResponse),
        reject,
        timer,
        fullResponse: true,
      });
      this.send({ ...command, id });
    });
    return promise;
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
      } else if (this.chunkDecoderEnabled && this.chunkDecoder.hasPendingSequence()) {
        this.terminate(new Error(`${this.diagnosticName} rpc chunk sequence interrupted`));
      }
    }
  }

  private handleLine(line: string): void {
    if (this.disposed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (this.chunkDecoderEnabled) {
        this.terminate(
          new Error(`${this.diagnosticName} received invalid JSON stdout frame`, { cause: error }),
        );
        return;
      }
      this.options.logger.warn(
        { error, line },
        `Ignoring non-JSON ${this.diagnosticName} stdout line`,
      );
      return;
    }
    if (this.chunkDecoderEnabled) {
      try {
        const decoded = this.chunkDecoder.push(parsed);
        if (decoded === undefined) {
          return;
        }
        parsed = decoded;
      } catch (error) {
        this.terminate(
          error instanceof Error
            ? error
            : new Error(`${this.diagnosticName} rpc chunk decoder failed: ${String(error)}`),
        );
        return;
      }
    } else if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).type === "rpc_chunk"
    ) {
      this.terminate(
        new Error(`${this.diagnosticName} received rpc_chunk before the chunk decoder was enabled`),
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
    if (message.type === "ready" && !this.readyFrame) {
      this.readyFrame = message;
      if (this.readyResolve) {
        const resolve = this.readyResolve;
        this.readyResolve = null;
        this.readyReject = null;
        resolve(message);
      }
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
    if (pending.fullResponse) {
      pending.resolve(response);
      return;
    }
    pending.resolve(response.data);
  }

  private failAll(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.readyReject) {
      const reject = this.readyReject;
      this.readyReject = null;
      this.readyResolve = null;
      reject(error);
    }
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Reject every pending request with `reason`, then terminate the child
   * process. Used for fatal wire-protocol failures where the child is still
   * alive but can no longer be trusted: the existing `child.on("exit")`
   * handler still fires the exit subscribers exactly once with the standard
   * `{ code, signal, error }` envelope, and `failAll` is a no-op once the
   * transport is disposed, so exit semantics stay coherent.
   */
  private terminate(reason: Error): void {
    if (this.disposed) {
      return;
    }
    this.failAll(reason);
    try {
      this.child.stdin.end();
    } catch {
      // Ignore stdin races.
    }
    void terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.options.logger.warn(
          { timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          `${this.diagnosticName} process did not exit after SIGTERM; sending SIGKILL`,
        );
      },
    });
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
