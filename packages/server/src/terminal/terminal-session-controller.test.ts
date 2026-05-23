import { describe, expect, test, vi } from "vitest";
import type pino from "pino";

import type { SessionOutboundMessage } from "../server/messages.js";
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  type TerminalStreamFrame,
} from "../shared/binary-frames/index.js";
import type { TerminalCell, TerminalState } from "../shared/messages.js";
import type { ServerMessage, TerminalSession, TerminalStateSnapshot } from "./terminal.js";
import { TerminalSessionController } from "./terminal-session-controller.js";
import type { TerminalManager } from "./terminal-manager.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function terminalRow(text: string, cols = 80): TerminalCell[] {
  return Array.from({ length: cols }, (_, index) => ({
    char: text[index] ?? " ",
  }));
}

function terminalState(text: string): TerminalState {
  return {
    rows: 1,
    cols: 80,
    grid: [terminalRow(text)],
    scrollback: [],
    cursor: { row: 0, col: text.length },
  };
}

function createLogger(): pino.Logger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as pino.Logger;
}

describe("terminal-session-controller restore", () => {
  test("delivers output produced while restore is in flight after the restore frame", async () => {
    let terminalListener: ((message: ServerMessage) => void) | null = null;
    const snapshot = deferred<TerminalStateSnapshot | null>();
    const binaryFrames: TerminalStreamFrame[] = [];
    const outboundMessages: SessionOutboundMessage[] = [];
    const terminal: TerminalSession = {
      id: "term-1",
      name: "Terminal",
      cwd: "/tmp",
      send: vi.fn(),
      subscribe: (listener) => {
        terminalListener = listener;
        queueMicrotask(() => listener({ type: "snapshotReady", revision: 1 }));
        return vi.fn();
      },
      onExit: () => vi.fn(),
      onCommandFinished: () => vi.fn(),
      onTitleChange: () => vi.fn(),
      getSize: () => ({ rows: 1, cols: 80 }),
      getState: () => terminalState("restore-before"),
      getStateSnapshot: () => ({ state: terminalState("restore-before"), revision: 1 }),
      getReplayPreamble: () => "",
      getTitle: () => undefined,
      setTitle: vi.fn(),
      getExitInfo: () => null,
      kill: vi.fn(),
      killAndWait: vi.fn(),
    };
    const terminalManager: TerminalManager = {
      getTerminals: vi.fn(),
      createTerminal: vi.fn(),
      registerCwdEnv: vi.fn(),
      getTerminal: vi.fn(() => terminal),
      getTerminalState: vi.fn(() => snapshot.promise),
      setTerminalTitle: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
    };
    const controller = new TerminalSessionController({
      terminalManager,
      emit: (message) => outboundMessages.push(message),
      emitBinary: (bytes) => {
        const frame = decodeTerminalStreamFrame(bytes);
        if (frame) {
          binaryFrames.push(frame);
        }
      },
      hasBinaryChannel: () => true,
      isPathWithinRoot: () => false,
      sessionLogger: createLogger(),
    });

    await controller.dispatch({
      type: "subscribe_terminal_request",
      terminalId: "term-1",
      requestId: "req-1",
      restore: {
        mode: "visible-snapshot",
        scrollbackLines: 200,
      },
    });
    await Promise.resolve();
    expect(terminalManager.getTerminalState).toHaveBeenCalledTimes(1);

    terminalListener?.({ type: "output", data: "restore-after\n", revision: 2 });
    snapshot.resolve({ state: terminalState("restore-before"), revision: 1 });
    await snapshot.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(outboundMessages).toContainEqual({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: "term-1",
        slot: 0,
        error: null,
        requestId: "req-1",
      },
    });
    expect(binaryFrames.map((frame) => frame.opcode)).toEqual([
      TerminalStreamOpcode.Restore,
      TerminalStreamOpcode.Output,
    ]);
    expect(new TextDecoder().decode(binaryFrames[0]?.payload)).toContain("restore-before");
    expect(new TextDecoder().decode(binaryFrames[1]?.payload)).toBe("restore-after\n");
  });
});
