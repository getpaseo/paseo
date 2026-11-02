import type { TerminalReplayOptions } from "./terminal-replay.js";
import type { TerminalRestoreOptions } from "./terminal-restore.js";
import type { TerminalReplayMetadata } from "./terminal-replay.js";
import { describe, expect, test, vi } from "vitest";
import pino from "pino";

import type { SessionInboundMessage, SessionOutboundMessage } from "../server/messages.js";
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  type TerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { ServerMessage, TerminalSession } from "./terminal.js";
import {
  TerminalSessionController,
  type TerminalSessionControllerOptions,
} from "./terminal-session-controller.js";
import { SessionDelivery } from "../server/session/owned-subscriptions/index.js";
import type { TerminalManager, TerminalsChangedEvent } from "./terminal-manager.js";
import { isSameOrDescendantPath } from "../server/path-utils.js";
import { PluginSessionSocket } from "../server/plugins/session-socket.js";
import { TerminalWorkerIncompatibleError } from "./terminal-worker-pool.js";

interface ReplayFixture {
  data: Uint8Array;
  metadata: TerminalReplayMetadata;
}
function terminalReplay(text: string, revision: number, replayPreamble = ""): ReplayFixture {
  return {
    data: Buffer.from(text),
    metadata: { rows: 1, cols: 80, retainedHistoryLines: 0, revision, replayPreamble },
  };
}
function replayFixture(
  read: () => Promise<ReplayFixture | null>,
): TerminalManager["replayTerminal"] {
  return async (_id, _options, sink) => {
    const replay = await read();
    if (!replay) return null;
    await sink({ type: "begin", metadata: replay.metadata });
    await sink({ type: "data", data: replay.data });
    await sink({ type: "end" });
    return replay.metadata;
  };
}

function createController(
  options: TerminalSessionControllerOptions & {
    emitBinary(frame: Uint8Array): void | Promise<void>;
  },
) {
  const source = {};
  const ownership = new SessionDelivery(
    (_source, message) => options.emit(message),
    (_source, frame) => options.emitBinary(frame),
  );
  ownership.attach(source, false);
  const controller = new TerminalSessionController({
    ...options,
    emit: (message) => {
      if (!ownership.reply(message)) options.emit(message);
    },
  });
  return {
    start: () => controller.start(),
    dispatch: (message: SessionInboundMessage) =>
      ownership.request(source, message, async () => {
        await controller.dispatch(message, ownership);
      }),
    hasDirectorySubscription: (input: { cwd: string; workspaceId?: string }) =>
      controller.hasDirectorySubscription(input),
  };
}

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

function createLogger(): pino.Logger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as pino.Logger;
}

describe("terminal-session-controller restore", () => {
  test("delivers output produced while restore is in flight after the restore frame", async () => {
    let terminalListener: ((message: ServerMessage) => void) | null = null;
    const snapshot = deferred<ReplayFixture | null>();
    const binaryFrames: TerminalStreamFrame[] = [];
    const outboundMessages: SessionOutboundMessage[] = [];
    const terminal: TerminalSession = {
      id: "term-1",
      name: "Terminal",
      cwd: "/tmp",
      workspaceId: "ws-test",
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
      hasOutput: () => true,
      getReplayPreamble: () => "\x1b[?1h\x1b[?2004h",
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
      replayTerminal: replayFixture(() => snapshot.promise),
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
      subscribeTerminalWorkspaceContributionChanged: vi.fn(() => vi.fn()),
    };
    const controller = createController({
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
    expect(binaryFrames).toEqual([]);

    terminalListener?.({ type: "output", data: "restore-after\n", revision: 2 });
    snapshot.resolve(terminalReplay("restore-before", 1, "\x1b[?1h\x1b[?2004h"));
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
    expect(new TextDecoder().decode(binaryFrames[1]?.payload)).toBe(
      "\x1b[?1h\x1b[?2004hrestore-after\n",
    );
  });
});

function listSession(input: {
  id: string;
  name: string;
  cwd: string;
  workspaceId?: string;
}): TerminalSession {
  return {
    id: input.id,
    name: input.name,
    cwd: input.cwd,
    workspaceId: input.workspaceId ?? "ws-test",
    send: vi.fn(),
    subscribe: () => vi.fn(),
    onExit: () => vi.fn(),
    onCommandFinished: () => vi.fn(),
    onTitleChange: () => vi.fn(),
    onActivityChange: () => vi.fn(),
    getSize: () => ({ rows: 1, cols: 80 }),
    hasOutput: () => true,
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

describe("terminal-session-controller legacy terminal creation", () => {
  test("resolves a missing workspaceId from the active workspace root", async () => {
    const rootCwd = "/work/repo";
    const appCwd = "/work/repo/packages/app";
    const terminalCwd = "/work/repo/packages/app/src";
    const outboundMessages: SessionOutboundMessage[] = [];
    const createTerminal = vi.fn(
      async (options: Parameters<TerminalManager["createTerminal"]>[0]) =>
        listSession({
          id: "term-1",
          name: options.name ?? "Terminal 1",
          cwd: options.cwd,
          workspaceId: options.workspaceId,
        }),
    );
    const terminalManager: TerminalManager = {
      getTerminals: vi.fn(),
      createTerminal,
      registerCwdEnv: vi.fn(),
      validateTerminalActivityToken: vi.fn(() => "unknown"),
      getTerminal: vi.fn(),
      replayTerminal: async () => null,
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      clearTerminalAttention: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
      subscribeTerminalWorkspaceContributionChanged: vi.fn(() => vi.fn()),
    };
    const controller = createController({
      terminalManager,
      emit: (message) => outboundMessages.push(message),
      emitBinary: vi.fn(),
      hasBinaryChannel: () => true,
      isPathWithinRoot: isSameOrDescendantPath,
      sessionLogger: createLogger(),
      listTerminalWorkspaceRefs: async () => [
        { workspaceId: "ws-root", cwd: rootCwd },
        { workspaceId: "ws-app", cwd: appCwd },
      ],
    });

    await controller.dispatch({
      type: "create_terminal_request",
      cwd: terminalCwd,
      name: "App Shell",
      requestId: "req-1",
    });

    expect(createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: terminalCwd,
        workspaceId: "ws-app",
        name: "App Shell",
      }),
    );
    expect(outboundMessages).toEqual([
      {
        type: "create_terminal_response",
        payload: {
          terminal: {
            id: "term-1",
            name: "App Shell",
            cwd: terminalCwd,
            workspaceId: "ws-app",
            activity: null,
          },
          error: null,
          requestId: "req-1",
        },
      },
    ]);
  });

  test("forwards the client-provided viewport size to the terminal manager", async () => {
    const outboundMessages: SessionOutboundMessage[] = [];
    const createTerminal = vi.fn(
      async (options: Parameters<TerminalManager["createTerminal"]>[0]) =>
        listSession({
          id: "term-1",
          name: options.name ?? "Terminal 1",
          cwd: options.cwd,
          workspaceId: options.workspaceId,
        }),
    );
    const terminalManager: TerminalManager = {
      getTerminals: vi.fn(),
      createTerminal,
      registerCwdEnv: vi.fn(),
      validateTerminalActivityToken: vi.fn(() => "unknown"),
      getTerminal: vi.fn(),
      replayTerminal: async () => null,
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      clearTerminalAttention: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
      subscribeTerminalWorkspaceContributionChanged: vi.fn(() => vi.fn()),
    };
    const controller = createController({
      terminalManager,
      emit: (message) => outboundMessages.push(message),
      emitBinary: vi.fn(),
      hasBinaryChannel: () => true,
      isPathWithinRoot: isSameOrDescendantPath,
      sessionLogger: createLogger(),
      listTerminalWorkspaceRefs: async () => [{ workspaceId: "ws-1", cwd: "/work/repo" }],
    });

    await controller.dispatch({
      type: "create_terminal_request",
      cwd: "/work/repo",
      workspaceId: "ws-1",
      size: { rows: 55, cols: 136 },
      requestId: "req-size",
    });

    expect(createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/work/repo", workspaceId: "ws-1", rows: 55, cols: 136 }),
    );
  });
});

describe("terminal-session-controller with terminals held by a newer Paseo", () => {
  const incompatible = new TerminalWorkerIncompatibleError({
    paseoVersion: "9.9.9",
    protocolVersion: 7,
  });

  function incompatibleManager(): TerminalManager {
    return {
      getUnavailableError: () => incompatible,
      getTerminals: vi.fn(async () => Promise.reject(incompatible)),
      createTerminal: vi.fn(async () => Promise.reject(incompatible)),
      registerCwdEnv: vi.fn(),
      validateTerminalActivityToken: vi.fn(() => "unknown"),
      getTerminal: vi.fn(),
      replayTerminal: async () => null,
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      clearTerminalAttention: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      // The incompatible worker's terminals are not in this daemon's view.
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
      subscribeTerminalWorkspaceContributionChanged: vi.fn(() => vi.fn()),
    };
  }

  test.each([
    { type: "list_terminals_request" as const, requestId: "req-list" },
    { type: "list_terminals_request" as const, requestId: "req-list-cwd", cwd: "/work/repo" },
    {
      type: "create_terminal_request" as const,
      requestId: "req-create",
      cwd: "/work/repo",
      workspaceId: "ws-1",
    },
  ])(
    "answers $type ($requestId) with a terminal_worker_incompatible rpc_error",
    async (request) => {
      const outboundMessages: SessionOutboundMessage[] = [];
      const controller = createController({
        terminalManager: incompatibleManager(),
        emit: (message) => outboundMessages.push(message),
        emitBinary: vi.fn(),
        hasBinaryChannel: () => true,
        isPathWithinRoot: isSameOrDescendantPath,
        sessionLogger: createLogger(),
        listTerminalWorkspaceRefs: async () => [{ workspaceId: "ws-1", cwd: "/work/repo" }],
      });

      await controller.dispatch(request);

      expect(outboundMessages).toEqual([
        {
          type: "rpc_error",
          payload: {
            requestId: request.requestId,
            requestType: request.type,
            error: incompatible.message,
            code: "terminal_worker_incompatible",
          },
        },
      ]);
    },
  );
});

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// The coalescer drains on a 5ms trailing timer; wait past it (and any async
// snapshot round-trip it kicks off) before asserting on emitted frames.
async function waitForCoalescerFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

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
      replayTerminal: async () => null,
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
      subscribeTerminalWorkspaceContributionChanged: vi.fn(() => vi.fn()),
    };

    const outboundMessages: SessionOutboundMessage[] = [];
    const controller = createController({
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
      terminals: [{ id: "subdir-term", name: "Mobile", cwd: subdirCwd, workspaceId: "ws-test" }],
    });
    await flushMicrotasks();

    expect(outboundMessages).toEqual([
      {
        type: "terminals_changed",
        payload: {
          cwd: rootCwd,
          terminals: [
            { id: "root-term", name: "Terminal 1", workspaceId: "ws-test", activity: null },
            { id: "subdir-term", name: "Mobile", workspaceId: "ws-test", activity: null },
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
      replayTerminal: async () => null,
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => [rootCwd, worktreeCwd]),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
      subscribeTerminalActivity: vi.fn(() => vi.fn()),
      subscribeTerminalWorkspaceContributionChanged: vi.fn(() => vi.fn()),
    };
    const outboundMessages: SessionOutboundMessage[] = [];
    const controller = createController({
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
          terminals: [
            {
              id: "root-term",
              name: "Terminal 1",
              cwd: rootCwd,
              workspaceId: "ws-test",
              activity: null,
            },
          ],
          requestId: "req-root",
        },
      },
      {
        type: "list_terminals_response",
        payload: {
          cwd: worktreeCwd,
          terminals: [
            {
              id: "worktree-term",
              name: "Feature",
              cwd: worktreeCwd,
              workspaceId: "ws-test",
              activity: null,
            },
          ],
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
      replayTerminal: async () => null,
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
      subscribeTerminalWorkspaceContributionChanged: vi.fn(() => vi.fn()),
    };

    const outboundMessages: SessionOutboundMessage[] = [];
    const controller = createController({
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
    await expect(controller.hasDirectorySubscription({ cwd, workspaceId: "ws-a" })).resolves.toBe(
      true,
    );
    await expect(controller.hasDirectorySubscription({ cwd, workspaceId: "ws-b" })).resolves.toBe(
      true,
    );
    await flushMicrotasks();
    outboundMessages.length = 0;

    // Tearing down workspace B must not drop workspace A's live subscription.
    controller.dispatch({ type: "unsubscribe_terminals_request", cwd, workspaceId: "ws-b" });
    await expect(controller.hasDirectorySubscription({ cwd, workspaceId: "ws-a" })).resolves.toBe(
      true,
    );
    await expect(controller.hasDirectorySubscription({ cwd, workspaceId: "ws-b" })).resolves.toBe(
      false,
    );

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
  async function setup(
    getClientBufferedAmount: () => number | null,
    chunked = false,
    pace?: () => Promise<void>,
    restore?: TerminalRestoreOptions,
  ): Promise<{
    messages: SessionOutboundMessage[];
    pushOutput: (data: string) => void;
    frames: TerminalStreamFrame[];
    replayOptions: Array<TerminalReplayOptions | undefined>;
    ready: () => void;
  }> {
    let terminalListener: ((message: ServerMessage) => void) | null = null;
    const terminal: TerminalSession = {
      id: "term-1",
      name: "Terminal",
      cwd: "/tmp",
      workspaceId: "ws-test",
      send: vi.fn(),
      subscribe: (listener) => {
        terminalListener = listener;
        // Readiness starts ANSI replay; later bytes use Output frames.
        queueMicrotask(() => listener({ type: "snapshotReady", revision: 1 }));
        return vi.fn();
      },
      onExit: () => vi.fn(),
      onCommandFinished: () => vi.fn(),
      onTitleChange: () => vi.fn(),
      getSize: () => ({ rows: 1, cols: 80 }),
      hasOutput: () => true,
      getReplayPreamble: () => "",
      getTitle: () => undefined,
      setTitle: vi.fn(),
      getExitInfo: () => null,
      kill: vi.fn(),
      killAndWait: vi.fn(),
    };
    const replayOptions: Array<TerminalReplayOptions | undefined> = [];
    const terminalManager: TerminalManager = {
      getTerminals: vi.fn(),
      createTerminal: vi.fn(),
      registerCwdEnv: vi.fn(),
      getTerminal: vi.fn(() => terminal),
      replayTerminal: (id, options, sink) => {
        replayOptions.push(options);
        return replayFixture(async () => terminalReplay("live", 1))(id, options, sink);
      },
      setTerminalTitle: vi.fn(),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(),
      captureTerminal: vi.fn(),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => vi.fn()),
      validateTerminalActivityToken: () => "unknown",
      setTerminalActivity: async () => true,
      clearTerminalAttention: async () => false,
      subscribeTerminalActivity: () => () => {},
      subscribeTerminalWorkspaceContributionChanged: () => () => {},
    };

    const frames: TerminalStreamFrame[] = [];
    const messages: SessionOutboundMessage[] = [];
    const controller = createController({
      terminalManager,
      emit: (message) => {
        messages.push(message);
      },
      supportsChunkedReplay: () => chunked,
      emitBinary: (bytes) => {
        const frame = decodeTerminalStreamFrame(bytes);
        if (frame) {
          frames.push(frame);
          if (frame.opcode === TerminalStreamOpcode.ReplayBegin) return pace?.();
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
      restore,
    });
    await waitForCoalescerFlush();
    // Drop the initial subscribe snapshot frame so each test only sees frames
    // produced by the output it pushes.
    frames.length = 0;

    return {
      replayOptions,
      ready: () => terminalListener?.({ type: "snapshotReady" }),
      pushOutput: (data) => terminalListener?.({ type: "output", data, revision: 2 }),
      frames,
      messages,
    };
  }

  test.each([false, true])(
    "preserves visible history defaults and explicit requests across delivery (chunked=%s)",
    async (chunked) => {
      const replayOpcodes = chunked
        ? [
            TerminalStreamOpcode.ReplayBegin,
            TerminalStreamOpcode.ReplayData,
            TerminalStreamOpcode.ReplayEnd,
          ]
        : [TerminalStreamOpcode.Restore];
      for (const [restore, expected] of [
        [{ mode: "visible-snapshot" }, [{ scrollbackLines: 200 }]],
        [{ mode: "visible-snapshot", scrollbackLines: 0 }, [{ scrollbackLines: 0 }]],
        [{ mode: "visible-snapshot", scrollbackLines: 5 }, [{ scrollbackLines: 5 }]],
        [{ mode: "visible-snapshot", scrollbackLines: 500 }, [{ scrollbackLines: 500 }]],
        [
          { mode: "visible-snapshot", scrollbackLines: 10000 },
          [{ scrollbackLines: chunked ? 10000 : 500 }],
        ],
        [{ mode: "full-snapshot" }, [chunked ? { scrollbackLines: undefined } : undefined]],
        [{ mode: "live" }, []],
      ] as const) {
        const fixture = await setup(() => 0, chunked, undefined, restore);
        expect(fixture.replayOptions).toEqual(expected);
        fixture.ready();
        await waitForCoalescerFlush();
        expect(fixture.replayOptions).toEqual([...expected, ...expected]);
        expect(fixture.frames.map((frame) => frame.opcode)).toEqual(
          restore.mode === "live" ? [] : replayOpcodes,
        );
        fixture.pushOutput("after-restore");
        await waitForCoalescerFlush();
        expect(fixture.frames.at(-1)?.opcode).toBe(TerminalStreamOpcode.Output);
        expect(new TextDecoder().decode(fixture.frames.at(-1)!.payload)).toBe("after-restore");
      }
    },
  );

  test.each([false, true])(
    "bounds recovery without changing attach demand (chunked=%s)",
    async (chunked) => {
      for (const [restore, history] of [
        [{ mode: "visible-snapshot" }, 500],
        [{ mode: "visible-snapshot", scrollbackLines: 10000 }, 500],
        [{ mode: "full-snapshot" }, 500],
        [{ mode: "visible-snapshot", scrollbackLines: 5 }, 5],
        [{ mode: "visible-snapshot", scrollbackLines: 0 }, 0],
        [{ mode: "full-snapshot", scrollbackLines: 0 }, 0],
        [{ mode: "live", scrollbackLines: 0 }, 0],
        [{ mode: "live" }, 500],
        [undefined, 500],
      ] as const) {
        const fixture = await setup(() => 8 * 1024 * 1024, chunked, undefined, restore);
        const initial = fixture.replayOptions.slice();
        fixture.pushOutput("pressure".repeat(40000));
        await waitForCoalescerFlush();
        expect(fixture.replayOptions.at(-1)).toEqual({ scrollbackLines: history });
        expect(fixture.replayOptions).toHaveLength(initial.length + 1);
        fixture.ready(); // Worker adoption must use the original demand, even on the same stream.
        await waitForCoalescerFlush();
        expect(fixture.replayOptions.slice(initial.length + 1)).toEqual(initial);
        fixture.frames.length = 0;
        fixture.pushOutput("after-catch-up");
        await waitForCoalescerFlush();
        expect(fixture.frames.map((frame) => frame.opcode)).toEqual([TerminalStreamOpcode.Output]);
      }
    },
  );

  test("streams all output without a snapshot when the client keeps up", async () => {
    const { pushOutput, frames } = await setup(() => 0);

    const chunk = "x".repeat(300 * 1024);
    pushOutput(chunk);
    await waitForCoalescerFlush();

    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Restore)).toBe(false);
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

    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Restore)).toBe(true);

    // After the snapshot the byte counter is reset, so a small follow-up chunk
    // streams as Output rather than tripping the fallback again.
    frames.length = 0;
    pushOutput("z".repeat(1024));
    await waitForCoalescerFlush();

    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Restore)).toBe(false);
    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Output)).toBe(true);
  });

  test("uses plugin IPC queued bytes to enter the snapshot backpressure path", async () => {
    const socket = new PluginSessionSocket({
      send() {
        return true;
      },
    });
    socket.send(new Uint8Array(8 * 1024 * 1024));
    const { pushOutput, frames } = await setup(() => socket.bufferedAmount);

    pushOutput("p".repeat(300 * 1024));
    await waitForCoalescerFlush();

    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Restore)).toBe(true);
  });

  test("falls back to a snapshot at the byte threshold when no backpressure signal exists", async () => {
    // A null reading means the transport (e.g. the multiplexed relay socket) gives
    // no signal; we can't distinguish a slow client from a fast one, so we keep the
    // unconditional catch-up so a slow relay client can't fall unboundedly behind.
    const { pushOutput, frames } = await setup(() => null);

    pushOutput("r".repeat(300 * 1024));
    await waitForCoalescerFlush();

    expect(frames.some((frame) => frame.opcode === TerminalStreamOpcode.Restore)).toBe(true);
  });
  test("queues capable catch-up without waiting for the direct socket to drain", async () => {
    let buffered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { pushOutput, frames, messages } = await setup(
      () => buffered,
      true,
      () => (buffered ? gate : Promise.resolve()),
    );
    buffered = 8 * 1024 * 1024;
    pushOutput("y".repeat(300 * 1024));
    await waitForCoalescerFlush();
    expect(messages.filter((message) => message.type === "terminal_stream_exit")).toEqual([]);
    expect(frames.map((frame) => frame.opcode)).toEqual([
      TerminalStreamOpcode.ReplayBegin,
      TerminalStreamOpcode.ReplayData,
      TerminalStreamOpcode.ReplayEnd,
    ]);
    buffered = 0;
    release();
    await waitForCoalescerFlush();
    expect(frames.map((frame) => frame.opcode)).toContain(TerminalStreamOpcode.ReplayEnd);
    frames.length = 0;
    buffered = 8 * 1024 * 1024; // Small output must stay live after the replay resets its byte counter.
    pushOutput("live-after-recovery");
    await waitForCoalescerFlush();
    expect(frames.map((frame) => frame.opcode)).toEqual([TerminalStreamOpcode.Output]);
  });
});

function exitFixture(readReplay: () => Promise<ReplayFixture | null>, backedUp = false) {
  const outputs = new Set<(message: ServerMessage) => void>();
  const exits = new Set<Parameters<TerminalSession["onExit"]>[0]>();
  const terminal: TerminalSession = {
    id: "exit-terminal",
    name: "Terminal",
    cwd: "/unused",
    workspaceId: "workspace",
    send() {},
    subscribe(listener) {
      outputs.add(listener);
      return () => {
        outputs.delete(listener);
      };
    },
    onExit(listener) {
      exits.add(listener);
      return () => {
        exits.delete(listener);
      };
    },
    onCommandFinished: () => () => {},
    onTitleChange: () => () => {},
    onActivityChange: () => () => {},
    getSize: () => ({ rows: 1, cols: 80 }),
    hasOutput: () => true,
    getReplayPreamble: () => "",
    getTitle: () => undefined,
    getActivity: () => null,
    setActivity() {},
    clearActivityAttention: () => false,
    setTitle() {},
    getExitInfo: () => null,
    kill() {},
    async killAndWait() {},
  };
  const manager: TerminalManager = {
    getTerminal: () => terminal,
    replayTerminal: replayFixture(readReplay),
    getTerminals: async () => [terminal],
    createTerminal: async () => terminal,
    registerCwdEnv() {},
    validateTerminalActivityToken: () => "unknown",
    setTerminalTitle: () => true,
    setTerminalActivity: async () => true,
    clearTerminalAttention: async () => false,
    killTerminal() {},
    async killTerminalAndWait() {},
    captureTerminal: async () => ({ lines: [], totalLines: 0 }),
    listDirectories: () => [],
    killAll() {},
    subscribeTerminalsChanged: () => () => {},
    subscribeTerminalActivity: () => () => {},
    subscribeTerminalWorkspaceContributionChanged: () => () => {},
  };
  const frames: Array<{
    source: object;
    message?: SessionOutboundMessage;
    binary?: TerminalStreamFrame;
  }> = [];
  const delivery = new SessionDelivery(
    (source, message) => frames.push({ source, message }),
    (source, bytes) => {
      const binary = decodeTerminalStreamFrame(bytes);
      if (binary) frames.push({ source, binary });
    },
  );
  const controller = new TerminalSessionController({
    terminalManager: manager,
    emit: (message) => {
      delivery.reply(message);
    },
    hasBinaryChannel: () => true,
    isPathWithinRoot: () => false,
    sessionLogger: pino({ level: "silent" }),
    getClientBufferedAmount: () => (backedUp ? 8 * 1024 * 1024 : 0),
  });
  return {
    frames,
    delivery,
    controller,
    outputs,
    exits,
    subscribe: async (source: object, modern: boolean, requestId: string) => {
      delivery.attach(source, modern);
      const request = {
        type: "subscribe_terminal_request" as const,
        terminalId: terminal.id,
        requestId,
      };
      await delivery.request(source, request, async () => {
        await controller.dispatch(request, delivery);
      });
      const reply = frames.find(
        (row) =>
          row.message?.type === "subscribe_terminal_response" &&
          row.message.payload.requestId === requestId,
      )?.message;
      if (reply?.type !== "subscribe_terminal_response" || reply.payload.error !== null)
        throw new Error("Missing stream acknowledgement");
      return { source, slot: reply.payload.slot, id: reply.payload.subscriptionId };
    },
    output: (data: string, revision: number) => {
      for (const listener of outputs) listener({ type: "output", data, revision });
    },
    exit: () => {
      for (const listener of exits) listener({ exitCode: 0, signal: null, lastOutputLines: [] });
    },
  };
}

describe("terminal output before natural exit", () => {
  test.each([true, false])(
    "flushes each observer's final bytes before exit (modern=%s)",
    async (modern) => {
      vi.useFakeTimers();
      const f = exitFixture(async () => terminalReplay("snapshot", 0));
      try {
        const source = {};
        const owners = [
          await f.subscribe(source, modern, "first"),
          await f.subscribe(modern ? source : {}, modern, "second"),
        ];
        await vi.advanceTimersByTimeAsync(0);
        f.output("FIRST-OUTPUT", 1);
        await vi.advanceTimersByTimeAsync(5);
        f.output("FINAL-BYTES", 2);
        f.exit();
        await vi.advanceTimersByTimeAsync(0);
        for (const owner of owners) {
          const ordered = f.frames.filter(
            (row) =>
              row.source === owner.source &&
              (row.binary?.slot === owner.slot ||
                (row.message?.type === "terminal_stream_exit" &&
                  row.message.payload.subscriptionId === owner.id)),
          );
          expect(ordered.map((row) => row.binary?.opcode ?? row.message?.type)).toEqual([
            TerminalStreamOpcode.Restore,
            TerminalStreamOpcode.Output,
            TerminalStreamOpcode.Output,
            "terminal_stream_exit",
          ]);
          expect(Buffer.from(ordered[2].binary!.payload).toString()).toBe("FINAL-BYTES");
        }
        if (modern) expect(new Set(owners.map((owner) => owner.id)).size).toBe(2);
        expect(f.delivery.registrationCount).toBe(0);
        expect(f.controller.getMetrics().streamSubscriptionCount).toBe(0);
        expect(f.outputs.size + f.exits.size).toBe(0);
      } finally {
        await f.delivery.close();
        vi.useRealTimers();
      }
    },
  );

  test("waits for bootstrap snapshot and flushes buffered bytes without starting backpressure work", async () => {
    vi.useFakeTimers();
    const snapshot = deferred<ReplayFixture | null>();
    let reads = 0;
    const f = exitFixture(() => {
      reads++;
      return snapshot.promise;
    }, true);
    try {
      await f.subscribe({}, true, "bootstrap");
      f.output("x".repeat(300 * 1024), 1);
      f.output("FINAL-BYTES", 2);
      f.exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.frames.map((row) => row.message?.type)).toEqual(["subscribe_terminal_response"]);
      snapshot.resolve(terminalReplay("snapshot", 0));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.frames.slice(1).map((row) => row.binary?.opcode ?? row.message?.type)).toEqual([
        TerminalStreamOpcode.Restore,
        TerminalStreamOpcode.Output,
        "terminal_stream_exit",
      ]);
      expect(Buffer.from(f.frames[2].binary!.payload).toString()).toBe(
        "x".repeat(300 * 1024) + "FINAL-BYTES",
      );
      expect(reads).toBe(1);
      expect(f.delivery.registrationCount).toBe(0);
    } finally {
      snapshot.resolve(null);
      await f.delivery.close();
      vi.useRealTimers();
    }
  });

  test.each([true, false, "rejected"])(
    "finishes an in-flight backpressure snapshot (available=%s)",
    async (available) => {
      vi.useFakeTimers();
      const snapshot = deferred<ReplayFixture | null>();
      let reads = 0;
      const f = exitFixture(
        async () => (++reads === 1 ? terminalReplay("initial", 0) : snapshot.promise),
        true,
      );
      try {
        await f.subscribe({}, true, "pressure");
        await vi.advanceTimersByTimeAsync(0);
        f.output("x".repeat(300 * 1024), 1);
        await vi.advanceTimersByTimeAsync(5);
        expect(reads).toBe(2);
        f.output("FINAL-BYTES", 2);
        f.exit();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.frames.some((row) => row.message?.type === "terminal_stream_exit")).toBe(false);
        if (available === "rejected") snapshot.reject(new Error("Snapshot failed during exit"));
        else snapshot.resolve(available ? terminalReplay("pressure-snapshot", 1) : null);
        await vi.advanceTimersByTimeAsync(0);
        const output = f.frames
          .filter((row) => row.binary?.opcode === TerminalStreamOpcode.Output)
          .map((row) => Buffer.from(row.binary!.payload).toString())
          .join("");
        expect(output).toBe((available === true ? "" : "x".repeat(300 * 1024)) + "FINAL-BYTES");
        expect(f.frames.at(-1)?.message?.type).toBe("terminal_stream_exit");
        expect(f.delivery.registrationCount).toBe(0);
        expect(reads).toBe(2);
      } finally {
        snapshot.resolve(null);
        await f.delivery.close();
        vi.useRealTimers();
      }
    },
  );

  test("release during exit's pending snapshot suppresses late delivery", async () => {
    vi.useFakeTimers();
    const snapshot = deferred<ReplayFixture | null>();
    const f = exitFixture(() => snapshot.promise);
    const source = {};
    try {
      const owner = await f.subscribe(source, true, "pending");
      f.output("FINAL-BYTES", 1);
      f.exit();
      const request = {
        type: "subscription.release.request" as const,
        requestId: "release",
        subscriptionId: owner.id!,
      };
      const release = f.delivery.request(source, request, () => f.delivery.release(owner.id!));
      snapshot.resolve(terminalReplay("snapshot", 0));
      await release;
      await vi.advanceTimersByTimeAsync(0);
      expect(f.frames.map((row) => row.message?.type)).toEqual(["subscribe_terminal_response"]);
      expect(f.delivery.registrationCount).toBe(0);
      expect(f.outputs.size + f.exits.size).toBe(0);
    } finally {
      snapshot.resolve(null);
      await f.delivery.close();
      vi.useRealTimers();
    }
  });

  test("explicit release discards only that observer's trailing output", async () => {
    vi.useFakeTimers();
    const f = exitFixture(async () => terminalReplay("snapshot", 0));
    const source = {};
    try {
      const a = await f.subscribe(source, true, "a");
      const b = await f.subscribe(source, true, "b");
      await vi.advanceTimersByTimeAsync(0);
      f.output("FINAL-BYTES", 1);
      const request = {
        type: "subscription.release.request" as const,
        requestId: "release",
        subscriptionId: a.id!,
      };
      await f.delivery.request(source, request, () => f.delivery.release(a.id!));
      f.exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        f.frames.some(
          (row) =>
            row.binary &&
            row.binary.slot === a.slot &&
            row.binary.opcode === TerminalStreamOpcode.Output,
        ),
      ).toBe(false);
      expect(
        f.frames.some(
          (row) =>
            row.binary &&
            row.binary.slot === b.slot &&
            row.binary.opcode === TerminalStreamOpcode.Output &&
            Buffer.from(row.binary.payload).toString() === "FINAL-BYTES",
        ),
      ).toBe(true);
      expect(f.delivery.registrationCount).toBe(0);
    } finally {
      await f.delivery.close();
      vi.useRealTimers();
    }
  });
});

describe("terminal snapshot failure", () => {
  test.each(["initial", "backpressure"])(
    "releases only the failed observer after %s rejection",
    async (phase) => {
      vi.useFakeTimers();
      let reads = 0;
      const f = exitFixture(async () => {
        if (++reads === (phase === "backpressure" ? 2 : 1))
          throw new Error("Terminal worker request timed out: replayTerminal");
        return terminalReplay("healthy", 0);
      }, phase === "backpressure");
      try {
        const source = {};
        const failed = await f.subscribe(source, true, "failed");
        await vi.advanceTimersByTimeAsync(0);
        if (phase === "backpressure") {
          f.output("x".repeat(300 * 1024), 1);
          await vi.advanceTimersByTimeAsync(5);
        }
        const healthy = await f.subscribe(source, true, "healthy");
        await vi.advanceTimersByTimeAsync(0);
        f.output("SIBLING-ALIVE", 2);
        await vi.advanceTimersByTimeAsync(5);
        expect(f.delivery.registrationCount).toBe(1);
        expect(f.controller.getMetrics().streamSubscriptionCount).toBe(1);
        expect(f.outputs.size).toBe(1);
        expect(f.exits.size).toBe(1);
        expect(
          f.frames
            .filter((row) => row.message?.type === "terminal_stream_exit")
            .map((row) => row.message),
        ).toEqual([
          {
            type: "terminal_stream_exit",
            payload: {
              terminalId: "exit-terminal",
              subscriptionId: failed.id,
              error: "Terminal worker request timed out: replayTerminal",
            },
          },
        ]);
        expect(
          f.frames.some(
            (row) =>
              row.binary?.slot === healthy.slot &&
              row.binary?.opcode === TerminalStreamOpcode.Output &&
              Buffer.from(row.binary.payload).toString() === "SIBLING-ALIVE",
          ),
        ).toBe(true);
        f.exit();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.frames.at(-1)?.message).toEqual({
          type: "terminal_stream_exit",
          payload: {
            terminalId: "exit-terminal",
            subscriptionId: healthy.id,
          },
        });
        expect(f.delivery.registrationCount).toBe(0);
        expect(f.outputs.size + f.exits.size).toBe(0);
      } finally {
        await f.delivery.close();
        vi.useRealTimers();
      }
    },
  );

  test("release during pending rejection suppresses the failure and completes cleanup", async () => {
    const snapshot = deferred<ReplayFixture | null>();
    const f = exitFixture(() => snapshot.promise);
    const source = {};
    try {
      const owner = await f.subscribe(source, true, "pending");
      f.output("BUFFERED", 1);
      const request = {
        type: "subscription.release.request" as const,
        requestId: "release",
        subscriptionId: owner.id!,
      };
      const release = f.delivery.request(source, request, () => f.delivery.release(owner.id!));
      snapshot.reject(new Error("Terminal worker request timed out: replayTerminal"));
      await release;
      expect(f.frames.map((row) => row.message?.type)).toEqual(["subscribe_terminal_response"]);
      expect(f.delivery.registrationCount).toBe(0);
      expect(f.controller.getMetrics().streamSubscriptionCount).toBe(0);
      expect(f.outputs.size + f.exits.size).toBe(0);
    } finally {
      snapshot.resolve(null);
      await f.delivery.close();
    }
  });
});

test.each([false, true])(
  "legacy snapshot failure retries without reporting a live PTY exited (backpressure=%s)",
  async (backpressure) => {
    vi.useFakeTimers();
    let reads = 0;
    const f = exitFixture(async () => {
      if (++reads === (backpressure ? 2 : 1)) throw new Error("Snapshot unavailable");
      return terminalReplay("recovered", 0);
    }, backpressure);
    try {
      await f.subscribe({}, false, "legacy-recovery");
      await vi.advanceTimersByTimeAsync(0);
      if (backpressure) {
        f.output("x".repeat(300 * 1024), 1);
        await vi.advanceTimersByTimeAsync(5);
      }
      expect(f.frames.filter((row) => row.message?.type === "terminal_stream_exit")).toEqual([]);
      f.output("RECOVERED-OUTPUT", 2);
      for (const listener of f.outputs) listener({ type: "snapshotReady", revision: 2 });
      await vi.advanceTimersByTimeAsync(5);
      expect(reads).toBe(backpressure ? 3 : 2);
      expect(f.frames.some((row) => row.binary?.opcode === TerminalStreamOpcode.Restore)).toBe(
        true,
      );
      f.exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.frames.filter((row) => row.message?.type === "terminal_stream_exit")).toHaveLength(
        1,
      );
      expect(f.frames.at(-1)?.message).toEqual({
        type: "terminal_stream_exit",
        payload: { terminalId: "exit-terminal" },
      });
      expect(f.delivery.registrationCount).toBe(0);
      expect(f.outputs.size + f.exits.size).toBe(0);
    } finally {
      await f.delivery.close();
      vi.useRealTimers();
    }
  },
);

test("bounds a capturing viewer tail without ending a healthy viewer", async () => {
  const pending = deferred<ReplayFixture | null>();
  let reads = 0;
  const f = exitFixture(() =>
    ++reads === 2 ? pending.promise : Promise.resolve(terminalReplay("retained", 0)),
  );
  const desktop = {},
    phone = {};
  try {
    await f.subscribe(desktop, true, "desktop");
    await waitForCoalescerFlush();
    await f.subscribe(phone, true, "phone");
    f.output("x".repeat(4 * 1024 * 1024 + 1), 1);
    await waitForCoalescerFlush();
    expect(
      f.frames.filter(
        (row) => row.source === phone && row.message?.type === "terminal_stream_exit",
      ),
    ).toHaveLength(1);
    expect(
      f.frames.filter(
        (row) => row.source === desktop && row.message?.type === "terminal_stream_exit",
      ),
    ).toHaveLength(0);
    expect(
      f.frames.some(
        (row) => row.source === desktop && row.binary?.opcode === TerminalStreamOpcode.Output,
      ),
    ).toBe(true);
    pending.resolve(terminalReplay("phone", 1));
    await waitForCoalescerFlush();
    f.output("AFTER-OVERFLOW", 2);
    await waitForCoalescerFlush();
    expect(
      f.frames.some(
        (row) =>
          row.source === desktop &&
          row.binary?.opcode === TerminalStreamOpcode.Output &&
          Buffer.from(row.binary.payload).toString().includes("AFTER-OVERFLOW"),
      ),
    ).toBe(true);
    expect(f.delivery.registrationCount).toBe(1);
  } finally {
    pending.resolve(null);
    await f.delivery.close();
  }
});
