import { describe, expect, test } from "vitest";

import {
  TerminalStreamOpcode,
  encodeTerminalResizePayload,
  type TerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { SessionOutboundMessage, TerminalState } from "@getpaseo/protocol/messages";
import type pino from "pino";

import { TerminalSessionController } from "./terminal-session-controller.js";
import type { TerminalManager } from "./terminal-manager.js";
import type { TerminalSession } from "./terminal.js";

function createFixture(): {
  terminal: TerminalSession;
  terminalManager: TerminalManager;
  appliedSizes: string[];
} {
  const appliedSizes: string[] = [];
  let size = { rows: 24, cols: 80 };
  const state = (): TerminalState => ({
    rows: size.rows,
    cols: size.cols,
    grid: [],
    scrollback: [],
    cursor: { row: 0, col: 0 },
  });
  const terminal = {
    id: "terminal-1",
    name: "Terminal",
    cwd: "/tmp",
    workspaceId: "workspace-1",
    getSize: () => size,
    send: (message: { type: string; rows?: number; cols?: number }) => {
      if (message.type !== "resize" || message.rows === undefined || message.cols === undefined) {
        return;
      }
      size = { rows: message.rows, cols: message.cols };
      appliedSizes.push(`${message.cols}x${message.rows}`);
    },
    subscribe: () => () => {},
    onExit: () => () => {},
  } as unknown as TerminalSession;
  const terminalManager = {
    getTerminal: () => terminal,
    getTerminalState: async () => ({ state: state(), revision: 0 }),
  } as unknown as TerminalManager;
  return { terminal, terminalManager, appliedSizes };
}

function createController(
  terminalManager: TerminalManager,
  outbound: SessionOutboundMessage[] = [],
): TerminalSessionController {
  return new TerminalSessionController({
    terminalManager,
    emit: (message) => outbound.push(message),
    emitBinary: () => {},
    hasBinaryChannel: () => true,
    isPathWithinRoot: () => false,
    sessionLogger: { warn: () => {}, error: () => {} } as unknown as pino.Logger,
  });
}

function resizeFrame(input: {
  rows: number;
  cols: number;
  intent?: "claim" | "update";
}): TerminalStreamFrame {
  return {
    opcode: TerminalStreamOpcode.Resize,
    slot: 0,
    payload: encodeTerminalResizePayload(input),
  };
}

describe("terminal session controller size ownership", () => {
  test("routes JSON, binary, and attach sizes through one connection-owned arbiter", async () => {
    const { terminalManager, appliedSizes } = createFixture();
    const controllerA = createController(terminalManager);
    const controllerB = createController(terminalManager);

    controllerA.dispatch({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: { type: "resize", rows: 30, cols: 100, intent: "claim" },
    });
    controllerA.dispatch({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: { type: "resize", rows: 31, cols: 101, intent: "update" },
    });
    controllerB.dispatch({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: { type: "resize", rows: 32, cols: 102, intent: "update" },
    });

    await controllerB.dispatch({
      type: "subscribe_terminal_request",
      terminalId: "terminal-1",
      requestId: "subscribe-b",
      restore: { mode: "live" },
    });
    controllerB.handleBinaryFrame(resizeFrame({ rows: 33, cols: 103, intent: "claim" }));
    controllerA.dispatch({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: { type: "resize", rows: 34, cols: 104, intent: "update" },
    });

    await controllerA.dispatch({
      type: "subscribe_terminal_request",
      terminalId: "terminal-1",
      requestId: "subscribe-a",
      restore: { mode: "live", size: { rows: 35, cols: 105 } },
    });
    controllerB.handleBinaryFrame(resizeFrame({ rows: 36, cols: 106, intent: "update" }));

    expect(appliedSizes).toEqual(["100x30", "101x31", "103x33", "105x35"]);
  });
});
