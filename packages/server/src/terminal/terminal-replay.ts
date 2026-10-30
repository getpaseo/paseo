import type { FramedSocket } from "./terminal-worker-frames.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerToParentMessage,
} from "./terminal-worker-protocol.js";
import { renderTerminalSnapshotToAnsi } from "@getpaseo/protocol/terminal-snapshot";
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
  const snapshot = session.getStateSnapshot({ ...options, includeWrapFlags: true });
  const metadata = {
    rows: snapshot.state.rows,
    cols: snapshot.state.cols,
    retainedHistoryLines: session.getRetainedHistoryLines(),
    revision: snapshot.revision,
    replayPreamble: session.getReplayPreamble(),
  };
  const data = Buffer.from(renderTerminalSnapshotToAnsi(snapshot.state), "utf8");
  yield { type: "begin", metadata };
  for (let offset = 0; offset < data.length; offset += TERMINAL_REPLAY_CHUNK_BYTES) {
    yield { type: "data", data: data.subarray(offset, offset + TERMINAL_REPLAY_CHUNK_BYTES) };
  }
  yield { type: "end" };
  return metadata;
}

export function replayTerminal(
  session: LocalTerminalSession,
  options: TerminalReplayOptions | undefined,
  sink: TerminalReplaySink,
): TerminalReplayMetadata {
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

/** Owns the worker's replay/live cut, bounded live tail and controller lifetime. */
export function createTerminalReplayController(ports: TerminalReplayPorts) {
  let controller: FramedSocket | null = null;
  // Only the live tail of a replaying terminal is held. Replay chunks use the socket's
  // write completion directly; they never enter this buffer or fill the shared socket.
  interface ReplayTail {
    readers: number;
    bytes: number;
    connection: FramedSocket;
    output: TerminalWorkerToParentMessage[];
    overflow: boolean;
    failure: unknown;
    completed: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
    exit?: Extract<TerminalWorkerToParentMessage, { type: "terminalExit" }>;
  }
  const replayTails = new Map<string, ReplayTail>();
  const MAX_REPLAY_TAIL_BYTES = 4 * 1024 * 1024;

  function sendToController(message: TerminalWorkerToParentMessage): void {
    if (
      message.type === "terminalExit" ||
      (message.type === "terminalMessage" && message.message.type === "output")
    ) {
      const tail = replayTails.get(message.terminalId);
      if (tail) {
        if (message.type === "terminalExit") {
          tail.exit = message;
          return;
        }
        if (!tail.overflow && message.message.type === "output") {
          tail.bytes += Buffer.byteLength(message.message.data);
          if (tail.bytes > MAX_REPLAY_TAIL_BYTES) {
            tail.overflow = true;
            tail.output = [];
          } else tail.output.push(message);
        }
        return;
      }
    }
    // With no controller the event is dropped; the headless terminal keeps the screen, and the
    // next daemon reads it through listTerminals.
    if (controller && controller.socket.writableLength > 4 * 1024 * 1024) {
      controller.socket.destroy();
      return;
    }
    controller?.send(message);
  }

  async function deliverReplay(
    message: Extract<TerminalWorkerRequest, { type: "replayTerminal" }>,
  ): Promise<void> {
    const connection = controller;
    if (!connection) return;
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
    const existingTail = replayTails.get(session.id);
    const tail =
      existingTail?.connection === connection ? existingTail : createReplayTail(connection);
    tail.readers++;
    replayTails.set(session.id, tail);
    let released = false;
    try {
      const replay = createTerminalReplay(session, message.options);
      let next = replay.next();
      while (!next.done) {
        if (tail.overflow)
          throw new Error("Terminal output exceeded the replay buffer; attach again");
        await connection.sendAndWait({
          type: "terminalReplay",
          requestId: message.requestId,
          event: next.value,
        });
        next = replay.next();
      }
      released = true;
      await releaseReplayTail(session, tail);
      await connection.sendAndWait({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: next.value,
      });
    } catch (error) {
      tail.failure = error;
      if (!released) await releaseReplayTail(session, tail);
      throw error;
    }
  }

  function createReplayTail(connection: FramedSocket): ReplayTail {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completed = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    // A write can fail before every reader reaches the shared completion barrier.
    void completed.catch(() => {});
    return {
      connection,
      readers: 0,
      bytes: 0,
      output: [],
      overflow: false,
      failure: null,
      completed,
      resolve,
      reject,
    };
  }

  async function releaseReplayTail(session: LocalTerminalSession, tail: ReplayTail): Promise<void> {
    if (--tail.readers === 0) {
      try {
        while (!tail.failure && !tail.overflow && tail.readers === 0 && tail.output.length > 0) {
          if (controller !== tail.connection) throw new Error("Terminal worker controller changed");
          const output = tail.output.shift()!;
          if (output.type === "terminalMessage" && output.message.type === "output")
            tail.bytes -= Buffer.byteLength(output.message.data);
          await tail.connection.sendAndWait(output);
        }
      } catch (error) {
        tail.failure = error;
      } finally {
        finishReplayTail(session, tail);
      }
    }
    await tail.completed;
  }

  function finishReplayTail(session: LocalTerminalSession, tail: ReplayTail): void {
    if (tail.readers !== 0) return;
    if (replayTails.get(session.id) === tail) replayTails.delete(session.id);
    if ((tail.overflow || tail.failure) && controller === tail.connection) {
      // The live stream is shared by every viewer of this terminal. Once its tail
      // is discarded none of those viewers may continue from the old screen.
      sendToController({
        type: "terminalMessage",
        terminalId: session.id,
        message: {
          type: "streamError",
          error: "Terminal output exceeded the replay buffer; attach again",
        },
        replayPreamble: session.getReplayPreamble(),
      });
    }
    if (tail.exit && controller === tail.connection) sendToController(tail.exit);
    if (tail.failure || tail.overflow)
      tail.reject(
        tail.failure ?? new Error("Terminal output exceeded the replay buffer; attach again"),
      );
    else tail.resolve();
  }

  return {
    setConnection(connection: FramedSocket | null): void {
      const previous = controller;
      controller = connection;
      if (previous !== connection) previous?.socket.destroy();
      // Old writes settle on their original socket; new output and replay belong
      // exclusively to the replacement controller.
      replayTails.clear();
    },
    send: sendToController,
    async replay(
      request: Extract<TerminalWorkerRequest, { type: "replayTerminal" }>,
    ): Promise<void> {
      const connection = controller;
      if (!connection) return;
      try {
        await deliverReplay(request);
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
