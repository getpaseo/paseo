import type { FramedSocket } from "./terminal-worker-frames.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerToParentMessage,
} from "./terminal-worker-protocol.js";
import type { LocalTerminalSession } from "./terminal.js";

export interface TerminalReplayOptions {
  scrollbackLines?: number;
}

export interface TerminalReplayMetadata {
  rows: number;
  cols: number;
  retainedHistoryLines: number;
  revision: number;
  replayPreamble: string;
}
export type TerminalReplayEvent =
  | { type: "begin"; metadata: TerminalReplayMetadata }
  | { type: "data"; data: Uint8Array }
  | { type: "end" };
export type TerminalReplaySink = (event: TerminalReplayEvent) => void;
export const TERMINAL_REPLAY_CHUNK_BYTES = 64 * 1024;

export function* createTerminalReplay(
  session: LocalTerminalSession,
  options: TerminalReplayOptions | undefined,
): Generator<TerminalReplayEvent, TerminalReplayMetadata> {
  const { metadata, data } = session.serializeReplay(options);
  yield { type: "begin", metadata };
  for (let offset = 0; offset < data.length; offset += TERMINAL_REPLAY_CHUNK_BYTES) {
    yield { type: "data", data: data.subarray(offset, offset + TERMINAL_REPLAY_CHUNK_BYTES) };
  }
  yield { type: "end" };
  return metadata;
}

export async function replayTerminal(
  session: LocalTerminalSession,
  options: TerminalReplayOptions | undefined,
  sink: TerminalReplaySink,
): Promise<TerminalReplayMetadata> {
  const replay = createTerminalReplay(session, options);
  let next = replay.next();
  while (!next.done) {
    sink(next.value);
    next = replay.next();
  }
  return next.value;
}

interface TerminalReplayPorts {
  getSession(id: string): LocalTerminalSession | undefined;
  flushOutput(id: string): void;
}

/** Worker-owned ANSI capture and paced delivery; live observations never wait for a replay. */
export function createTerminalReplayController(ports: TerminalReplayPorts) {
  let controller: FramedSocket | null = null;

  function sendToController(message: TerminalWorkerToParentMessage): void {
    // A stalled physical controller is different from a stalled viewer: all its
    // observations must reconnect to the surviving worker after this socket closes.
    if (controller && controller.socket.writableLength > 4 * 1024 * 1024) {
      controller.socket.destroy();
      return;
    }
    controller?.send(message);
  }

  async function deliverReplay(
    connection: FramedSocket,
    message: Extract<TerminalWorkerRequest, { type: "replayTerminal" }>,
  ): Promise<void> {
    ports.flushOutput(message.terminalId);
    const session = ports.getSession(message.terminalId);
    if (!session) {
      await connection.sendAndWait({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: null,
      });
      return;
    }
    // Flush and capture share one synchronous turn. Each daemon viewer buffers
    // its own live tail and discards revisions already included in this cut.
    const replay = createTerminalReplay(session, message.options);
    let next = replay.next();
    while (!next.done) {
      if (controller !== connection) throw new Error("Terminal replay controller disconnected");
      await connection.sendAndWait({
        type: "terminalReplay",
        requestId: message.requestId,
        event: next.value,
      });
      next = replay.next();
    }
    await connection.sendAndWait({
      type: "response",
      requestId: message.requestId,
      ok: true,
      result: next.value,
    });
  }

  return {
    setConnection(connection: FramedSocket | null): void {
      if (controller === connection) return;
      const previous = controller;
      controller = connection;
      previous?.socket.destroy();
    },
    send: sendToController,
    async replay(
      request: Extract<TerminalWorkerRequest, { type: "replayTerminal" }>,
    ): Promise<void> {
      const connection = controller;
      if (!connection) return;
      try {
        await deliverReplay(connection, request);
      } catch (error) {
        await connection
          .sendAndWait({
            type: "response",
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => {});
      }
    },
  };
}
