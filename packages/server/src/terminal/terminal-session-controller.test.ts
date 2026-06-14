import { describe, expect, test, vi } from "vitest";
import type pino from "pino";

import type { SessionOutboundMessage } from "../server/messages.js";
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  type TerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { TerminalCell, TerminalState } from "@getpaseo/protocol/messages";
import type { ServerMessage, TerminalSession, TerminalStateSnapshot } from "./terminal.js";
import { TerminalSessionController } from "./terminal-session-controller.js";
import type { TerminalManager, TerminalsChangedEvent } from "./terminal-manager.js";
import { isSameOrDescendantPath } from "../server/path-utils.js";

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
      onActivityChange: () => vi.fn(),
      getSize: () => ({ rows: 1, cols: 80 }),
      getState: () => terminalState("restore-before"),
      getStateSnapshot: () => ({ state: terminalState("restore-before"), revision: 1 }),
      getReplayPreamble: () => "",
      getTitle: () => undefined,
      getActivity: () => null,
      setActivity: vi.fn(),
      setTitle: vi.fn(),
      getExitInfo: () => null,
      kill: vi.fn(),
      killAndWait: vi.fn(),
    };
    const terminalManager: TerminalManager = {
      getTerminals: vi.fn(),
      createTerminal: vi.fn(),
      registerCwdEnv: vi.fn(),
      validateTerminalActivityToken: vi.fn(() => "unknown"),
      getTerminal: vi.fn(() => terminal),
      getTerminalState: vi.fn(() => snapshot.promise),
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
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

function listSession(input: { id: string; name: string; cwd: string }): TerminalSession {
  return {
    id: input.id,
    name: input.name,
    cwd: input.cwd,
    send: vi.fn(),
    subscribe: () => vi.fn(),
    onExit: () => vi.fn(),
    onCommandFinished: () => vi.fn(),
    onTitleChange: () => vi.fn(),
    onActivityChange: () => vi.fn(),
    getSize: () => ({ rows: 1, cols: 80 }),
    getState: () => terminalState(""),
    getStateSnapshot: () => ({ state: terminalState(""), revision: 0 }),
    getReplayPreamble: () => "",
    getTitle: () => undefined,
    getActivity: () => null,
    setActivity: vi.fn(),
    setTitle: vi.fn(),
    getExitInfo: () => null,
    kill: vi.fn(),
    killAndWait: vi.fn(),
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// The coalescer drains on a 5ms trailing timer; wait past it (and any async
// snapshot round-trip it kicks off) before asserting on emitted frames.
async function waitForCoalescerFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("terminal-session-controller wrap-flag gating", () => {
  function setup(clientSupportsWrapReflow?: () => boolean): {
    controller: TerminalSessionController;
    getTerminalState: ReturnType<typeof vi.fn>;
  } {
    const terminal: TerminalSession = {
      id: "term-1",
      name: "Terminal",
      cwd: "/tmp",
      send: vi.fn(),
      subscribe: (listener) => {
        queueMicrotask(() => listener({ type: "snapshotReady", revision: 1 }));
        return vi.fn();
      },
      onExit: () => vi.fn(),
      onCommandFinished: () => vi.fn(),
      onTitleChange: () => vi.fn(),
      onActivityChange: () => vi.fn(),
      getSize: () => ({ rows: 1, cols: 80 }),
      getState: () => terminalState("hello"),
      getStateSnapshot: () => ({ state: terminalState("hello"), revision: 1 }),
      getReplayPreamble: () => "",
      getTitle: () => undefined,
      getActivity: () => null,
      setActivity: vi.fn(),
      setTitle: vi.fn(),
      getExitInfo: () => null,
      kill: vi.fn(),
      killAndWait: vi.fn(),
    };
    const getTerminalState = vi.fn(() =>
      Promise.resolve<TerminalStateSnapshot>({ state: terminalState("hello"), revision: 1 }),
    );
    const terminalManager = {
      getTerminals: vi.fn(),
      createTerminal: vi.fn(),
      registerCwdEnv: vi.fn(),
      validateTerminalActivityToken: vi.fn(() => "unknown"),
      getTerminal: vi.fn(() => terminal),
      getTerminalState,
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
    } as unknown as TerminalManager;
    const controller = new TerminalSessionController({
      terminalManager,
      emit: vi.fn(),
      emitBinary: vi.fn(),
      hasBinaryChannel: () => true,
      isPathWithinRoot: () => false,
      sessionLogger: createLogger(),
      ...(clientSupportsWrapReflow ? { clientSupportsWrapReflow } : {}),
    });
    return { controller, getTerminalState };
  }

  async function subscribe(controller: TerminalSessionController): Promise<void> {
    await controller.dispatch({
      type: "subscribe_terminal_request",
      terminalId: "term-1",
      requestId: "req-1",
      restore: { mode: "visible-snapshot", scrollbackLines: 200 },
    });
    await flushMicrotasks();
  }

  test("requests wrap flags when the client supports reflowable snapshots", async () => {
    const { controller, getTerminalState } = setup(() => true);
    await subscribe(controller);
    expect(getTerminalState).toHaveBeenCalledWith(
      "term-1",
      expect.objectContaining({ includeWrapFlags: true }),
    );
  });

  test("omits wrap flags when the client does not advertise support", async () => {
    const { controller, getTerminalState } = setup();
    await subscribe(controller);
    expect(getTerminalState).toHaveBeenCalledWith(
      "term-1",
      expect.objectContaining({ includeWrapFlags: false }),
    );
  });
});

describe("terminal-session-controller subdirectory aggregation", () => {
  test("delivers a subdirectory change to a root subscriber as an aggregated, root-keyed snapshot", async () => {
    const rootCwd = "/work/repo";
    const subdirCwd = "/work/repo/apps/mobile";
    // Aggregating subdirectory buckets into the root query is the manager's
    // contract, covered by terminal-manager.test.ts. Here we only assert the
    // controller re-fetches by root and keys the snapshot by root, so the fake
    // returns a fixed aggregated list for the root and nothing otherwise.
    const aggregatedRootTerminals = [
      listSession({ id: "root-term", name: "Terminal 1", cwd: rootCwd }),
      listSession({ id: "subdir-term", name: "Mobile", cwd: subdirCwd }),
    ];

    let changedListener: ((event: TerminalsChangedEvent) => void) | null = null;
    const terminalManager: TerminalManager = {
      getTerminals: vi.fn(async (cwd: string) => (cwd === rootCwd ? aggregatedRootTerminals : [])),
      createTerminal: vi.fn(),
      registerCwdEnv: vi.fn(),
      validateTerminalActivityToken: vi.fn(() => "unknown"),
      getTerminal: vi.fn(),
      getTerminalState: vi.fn(),
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => [rootCwd, subdirCwd]),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn((listener) => {
        changedListener = listener;
        return vi.fn();
      }),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
    };

    const outboundMessages: SessionOutboundMessage[] = [];
    const controller = new TerminalSessionController({
      terminalManager,
      emit: (message) => outboundMessages.push(message),
      emitBinary: vi.fn(),
      hasBinaryChannel: () => true,
      isPathWithinRoot: isSameOrDescendantPath,
      sessionLogger: createLogger(),
    });
    controller.start();

    controller.dispatch({ type: "subscribe_terminals_request", cwd: rootCwd });
    await flushMicrotasks();
    outboundMessages.length = 0;

    changedListener?.({
      cwd: subdirCwd,
      terminals: [{ id: "subdir-term", name: "Mobile", cwd: subdirCwd }],
    });
    await flushMicrotasks();

    expect(outboundMessages).toEqual([
      {
        type: "terminals_changed",
        payload: {
          cwd: rootCwd,
          terminals: [
            { id: "root-term", name: "Terminal 1", activity: null },
            { id: "subdir-term", name: "Mobile", activity: null },
          ],
        },
      },
    ]);
  });

  test("keeps nested workspace terminals out of the parent workspace terminal list", async () => {
    const rootCwd = "/work/repo";
    const worktreeCwd = "/work/repo/.dev/paseo-home/worktrees/hash/feature-a";
    const rootTerminal = listSession({ id: "root-term", name: "Terminal 1", cwd: rootCwd });
    const worktreeTerminal = listSession({
      id: "worktree-term",
      name: "Feature",
      cwd: worktreeCwd,
    });
    const terminalManager: TerminalManager = {
      getTerminals: vi.fn(async (cwd: string) =>
        cwd === rootCwd ? [rootTerminal, worktreeTerminal] : [worktreeTerminal],
      ),
      createTerminal: vi.fn(),
      registerCwdEnv: vi.fn(),
      validateTerminalActivityToken: vi.fn(() => "unknown"),
      getTerminal: vi.fn(),
      getTerminalState: vi.fn(),
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => [rootCwd, worktreeCwd]),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
    };
    const outboundMessages: SessionOutboundMessage[] = [];
    const controller = new TerminalSessionController({
      terminalManager,
      emit: (message) => outboundMessages.push(message),
      emitBinary: vi.fn(),
      hasBinaryChannel: () => true,
      isPathWithinRoot: isSameOrDescendantPath,
      sessionLogger: createLogger(),
      listTerminalWorkspaceRoots: async () => [rootCwd, worktreeCwd],
    });

    await controller.dispatch({
      type: "list_terminals_request",
      cwd: rootCwd,
      requestId: "req-root",
    });
    await controller.dispatch({
      type: "list_terminals_request",
      cwd: worktreeCwd,
      requestId: "req-worktree",
    });

    expect(outboundMessages).toEqual([
      {
        type: "list_terminals_response",
        payload: {
          cwd: rootCwd,
          terminals: [{ id: "root-term", name: "Terminal 1", activity: null }],
          requestId: "req-root",
        },
      },
      {
        type: "list_terminals_response",
        payload: {
          cwd: worktreeCwd,
          terminals: [{ id: "worktree-term", name: "Feature", activity: null }],
          requestId: "req-worktree",
        },
      },
    ]);
  });
});

describe("terminal-session-controller workspace-scoped subscriptions", () => {
  test("two workspaces sharing a cwd subscribe and unsubscribe independently", async () => {
    const cwd = "/work/shared";
    const terminalA: TerminalSession = {
      ...listSession({ id: "a", name: "A", cwd }),
      workspaceId: "ws-a",
    };
    const terminalB: TerminalSession = {
      ...listSession({ id: "b", name: "B", cwd }),
      workspaceId: "ws-b",
    };

    let changedListener: ((event: TerminalsChangedEvent) => void) | null = null;
    const terminalManager: TerminalManager = {
      getTerminals: vi.fn(async (_cwd: string, options?: { workspaceId?: string }) =>
        options?.workspaceId === "ws-b" ? [terminalB] : [terminalA],
      ),
      createTerminal: vi.fn(),
      registerCwdEnv: vi.fn(),
      validateTerminalActivityToken: vi.fn(() => "unknown"),
      getTerminal: vi.fn(),
      getTerminalState: vi.fn(),
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => [cwd]),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn((listener) => {
        changedListener = listener;
        return vi.fn();
      }),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
    };

    const outboundMessages: SessionOutboundMessage[] = [];
    const controller = new TerminalSessionController({
      terminalManager,
      emit: (message) => outboundMessages.push(message),
      emitBinary: vi.fn(),
      hasBinaryChannel: () => true,
      isPathWithinRoot: isSameOrDescendantPath,
      sessionLogger: createLogger(),
    });
    controller.start();

    controller.dispatch({ type: "subscribe_terminals_request", cwd, workspaceId: "ws-a" });
    controller.dispatch({ type: "subscribe_terminals_request", cwd, workspaceId: "ws-b" });
    await flushMicrotasks();
    outboundMessages.length = 0;

    // Tearing down workspace B must not drop workspace A's live subscription.
    controller.dispatch({ type: "unsubscribe_terminals_request", cwd, workspaceId: "ws-b" });

    changedListener?.({ cwd, terminals: [{ id: "a", name: "A", cwd, workspaceId: "ws-a" }] });
    await flushMicrotasks();

    expect(outboundMessages).toEqual([
      {
        type: "terminals_changed",
        payload: {
          cwd,
          terminals: [{ id: "a", name: "A", workspaceId: "ws-a", activity: null }],
        },
      },
    ]);
  });
});

describe("terminal-session-controller backpressure snapshot fallback", () => {
  async function setup(getClientBufferedAmount: () => number | null): Promise<{
    pushOutput: (data: string) => void;
    frames: TerminalStreamFrame[];
  }> {
    let terminalListener: ((message: ServerMessage) => void) | null = null;
    const terminal: TerminalSession = {
      id: "term-1",
      name: "Terminal",
      cwd: "/tmp",
      send: vi.fn(),
      subscribe: (listener) => {
        terminalListener = listener;
        // Legacy stream: a snapshot arrives on subscribe (one Snapshot frame),
        // after which output streams through the coalescer as Output frames.
        queueMicrotask(() =>
          listener({ type: "snapshot", state: terminalState("live"), revision: 1 }),
        );
        return vi.fn();
      },
      onExit: () => vi.fn(),
      onCommandFinished: () => vi.fn(),
      onTitleChange: () => vi.fn(),
      getSize: () => ({ rows: 1, cols: 80 }),
      getState: () => terminalState("live"),
      getStateSnapshot: () => ({ state: terminalState("live"), revision: 1 }),
      getReplayPreamble: () => "",
      getTitle: () => undefined,
      setTitle: vi.fn(),
      getExitInfo: () => null,
      kill: vi.fn(),
      killAndWait: vi.fn(),
    };
    const terminalManager = {
      getTerminals: vi.fn(),
      createTerminal: vi.fn(),
      registerCwdEnv: vi.fn(),
      getTerminal: vi.fn(() => terminal),
      getTerminalState: vi.fn(() =>
        Promise.resolve<TerminalStateSnapshot>({ state: terminalState("live"), revision: 1 }),
      ),
      setTerminalTitle: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
    } as unknown as TerminalManager;

    const frames: TerminalStreamFrame[] = [];
    const controller = new TerminalSessionController({
      terminalManager,
      emit: vi.fn(),
      emitBinary: (bytes) => {
        const frame = decodeTerminalStreamFrame(bytes);
        if (frame) {
          frames.push(frame);
        }
      },
      hasBinaryChannel: () => true,
      isPathWithinRoot: () => false,
      sessionLogger: createLogger(),
      getClientBufferedAmount,
    });

    await controller.dispatch({
      type: "subscribe_terminal_request",
      terminalId: "term-1",
      requestId: "req-1",
    });
    await waitForCoalescerFlush();
    // Drop the initial subscribe snapshot frame so each test only sees frames
    // produced by the output it pushes.
    frames.length = 0;

    return {
      pushOutput: (data) => terminalListener?.({ type: "output", data, revision: 2 }),
      frames,
    };
  }

  test("streams all output without a snapshot when the client keeps up", async () => {
    const { pushOutput, frames } = await setup(() => 0);

    const chunk = "x".repeat(300 * 1024);
    pushOutput(chunk);
    await waitForCoalescerFlush();

    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Snapshot)).toBe(false);
    const outputFrames = frames.filter((frame) => frame.opcode === TerminalStreamOpcode.Output);
    expect(outputFrames.length).toBeGreaterThan(0);
    const receivedBytes = outputFrames.reduce(
      (total, frame) => total + frame.payload.byteLength,
      0,
    );
    expect(receivedBytes).toBe(Buffer.byteLength(chunk, "utf8"));
  });

  test("falls back to a snapshot and resets the byte counter when the client is backed up", async () => {
    const { pushOutput, frames } = await setup(() => 8 * 1024 * 1024);

    pushOutput("y".repeat(300 * 1024));
    await waitForCoalescerFlush();

    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Snapshot)).toBe(true);

    // After the snapshot the byte counter is reset, so a small follow-up chunk
    // streams as Output rather than tripping the fallback again.
    frames.length = 0;
    pushOutput("z".repeat(1024));
    await waitForCoalescerFlush();

    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Snapshot)).toBe(false);
    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Output)).toBe(true);
  });

  test("falls back to a snapshot at the byte threshold when no backpressure signal exists", async () => {
    // A null reading means the transport (e.g. the multiplexed relay socket) gives
    // no signal; we can't distinguish a slow client from a fast one, so we keep the
    // unconditional catch-up so a slow relay client can't fall unboundedly behind.
    const { pushOutput, frames } = await setup(() => null);

    pushOutput("r".repeat(300 * 1024));
    await waitForCoalescerFlush();

    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Snapshot)).toBe(true);
  });
});
