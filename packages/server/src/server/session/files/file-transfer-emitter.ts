import {
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import type { FileExplorerFileBytes } from "../../file-explorer/service.js";

/**
 * A whole-file read arrives as one FileBegin, N FileChunk frames, and one
 * FileEnd. The chunking is not cosmetic: the daemon terminates any physical
 * socket whose outbound buffer passes MAX_PHYSICAL_SOCKET_BUFFERED_BYTES
 * (8 MiB), so a single-frame emit of a large file would kill the connection it
 * was trying to answer on. Chunks are paced against the client's buffered
 * amount so a slow reader throttles the daemon instead of disconnecting.
 */
export const FILE_TRANSFER_CHUNK_BYTES = 256 * 1024;
/** Mirrors the terminal's MAX_CLIENT_BUFFERED_BYTES: past this the client is not keeping up. */
export const FILE_TRANSFER_DRAIN_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const FILE_TRANSFER_DRAIN_POLL_MS = 15;
export const FILE_TRANSFER_DRAIN_TIMEOUT_MS = 30_000;

export interface FileTransferSink {
  emitBinary(frame: Uint8Array): void;
  /** Bytes queued for the client, or null when the transport reports no signal. */
  getClientBufferedAmount(): number | null;
  /** True once the session is gone; an in-flight transfer stops at the next chunk. */
  isDisposed(): boolean;
}

export type FileTransferOutcome =
  | { status: "sent"; chunks: number }
  | { status: "aborted"; reason: "disposed" | "stalled" };

export interface EmitChunkedFileTransferParams {
  sink: FileTransferSink;
  requestId: string;
  file: FileExplorerFileBytes;
  chunkBytes?: number;
  drainThresholdBytes?: number;
  drainPollMs?: number;
  drainTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function emitChunkedFileTransfer(
  params: EmitChunkedFileTransferParams,
): Promise<FileTransferOutcome> {
  const {
    sink,
    requestId,
    file,
    chunkBytes = FILE_TRANSFER_CHUNK_BYTES,
    drainThresholdBytes = FILE_TRANSFER_DRAIN_THRESHOLD_BYTES,
    drainPollMs = FILE_TRANSFER_DRAIN_POLL_MS,
    drainTimeoutMs = FILE_TRANSFER_DRAIN_TIMEOUT_MS,
    now = Date.now,
    sleep = defaultSleep,
  } = params;

  if (sink.isDisposed()) {
    return { status: "aborted", reason: "disposed" };
  }

  sink.emitBinary(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: file.mimeType,
        size: file.size,
        encoding: file.encoding,
        modifiedAt: file.modifiedAt,
        revision: file.revision,
      },
    }),
  );

  let chunks = 0;
  for (let offset = 0; offset < file.bytes.byteLength; offset += chunkBytes) {
    const drained = await waitForDrain({
      sink,
      drainThresholdBytes,
      drainPollMs,
      drainTimeoutMs,
      now,
      sleep,
    });
    if (drained.status !== "ready") {
      return { status: "aborted", reason: drained.status };
    }

    sink.emitBinary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId,
        payload: file.bytes.subarray(offset, Math.min(offset + chunkBytes, file.bytes.byteLength)),
      }),
    );
    chunks += 1;
  }

  if (sink.isDisposed()) {
    return { status: "aborted", reason: "disposed" };
  }

  sink.emitBinary(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId,
    }),
  );

  return { status: "sent", chunks };
}

interface DrainStatus {
  status: "ready" | "disposed" | "stalled";
}

async function waitForDrain(input: {
  sink: FileTransferSink;
  drainThresholdBytes: number;
  drainPollMs: number;
  drainTimeoutMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<DrainStatus> {
  const { sink, drainThresholdBytes, drainPollMs, drainTimeoutMs, now, sleep } = input;
  const deadline = now() + drainTimeoutMs;

  for (;;) {
    if (sink.isDisposed()) {
      return { status: "disposed" };
    }

    const buffered = sink.getClientBufferedAmount();
    if (buffered === null) {
      // No backpressure signal to read. Yield so the socket can flush rather
      // than pushing the whole file into the outbound buffer in one tick.
      await sleep(0);
      return { status: "ready" };
    }
    if (buffered <= drainThresholdBytes) {
      return { status: "ready" };
    }
    if (now() >= deadline) {
      return { status: "stalled" };
    }

    await sleep(drainPollMs);
  }
}
