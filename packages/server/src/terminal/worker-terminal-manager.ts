import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import { createExternalProcessEnv } from "../server/paseo-env.js";
import { assertAbsolutePath, isSameOrDescendantPath } from "../server/path-utils.js";
import { writtenDuringThisBoot } from "../server/pid-lock.js";
import type { TerminalState } from "@getpaseo/protocol/messages";
import type { TerminalActivity, TerminalActivityState } from "@getpaseo/protocol/terminal-activity";
import { deriveTerminalActivityStatusBucket } from "@getpaseo/protocol/terminal-activity";
import type {
  ClientMessage,
  ServerMessage,
  TerminalActivityTransition,
  TerminalCommandFinishedInfo,
  TerminalExitInfo,
  TerminalSession,
  TerminalStateSnapshot,
} from "./terminal.js";
import { resolvePaseoCliExecutablePath } from "./paseo-cli-path.js";
import type { CaptureTerminalLinesResult } from "./terminal-capture.js";
import { connectTerminalWorker, type TerminalWorkerConnection } from "./terminal-worker-client.js";
import { launchTerminalWorker } from "./terminal-worker-launch.js";
import { classifyTerminalWorkerProcess } from "./terminal-worker-ownership.js";
import {
  createTerminalWorkerProcessInspector,
  type TerminalWorkerProcessInspector,
} from "./terminal-worker-processes.js";
import { reapTerminalWorkers } from "./terminal-worker-reaper.js";
import {
  listTerminalWorkerRecords,
  terminalWorkerRecordPath,
  type TerminalWorkerRecord,
} from "./terminal-worker-record.js";
import {
  createTerminalWorkerPool,
  NoTerminalWorkerAvailableError,
  TerminalWorkerIncompatibleError,
  type TerminalWorkerPoolMember,
} from "./terminal-worker-pool.js";
import { pruneTerminalWorkerRuntimes } from "./terminal-worker-runtime.js";
import type {
  TerminalActivityListener,
  TerminalActivityTransitionEvent,
  TerminalListItem,
  TerminalManager,
  TerminalWorkspaceContributionChangedEvent,
  TerminalWorkspaceContributionChangedListener,
  TerminalsChangedEvent,
  TerminalsChangedListener,
} from "./terminal-manager.js";
import {
  classifyTerminalWorkerProtocol,
  type TerminalWorkerProtocolFit,
} from "./terminal-worker-protocol.js";
import type {
  TerminalWorkerListResult,
  TerminalWorkerRequest,
  TerminalWorkerResponse,
  TerminalWorkerToParentMessage,
  WorkerCreateTerminalOptions,
  TerminalWorkerStateResult,
  WorkerTerminalInfo,
} from "./terminal-worker-protocol.js";

const REQUEST_TIMEOUT_MS = 10000;

type RequiredWorkerTerminalInfo = WorkerTerminalInfo & { workspaceId: string };

function requiredWorkspaceId(workspaceId: string | undefined): string {
  if (workspaceId === undefined) {
    throw new Error("workspaceId is required");
  }
  return workspaceId;
}

function asRequiredWorkerTerminalInfo(info: WorkerTerminalInfo): RequiredWorkerTerminalInfo {
  requiredWorkspaceId(info.workspaceId);
  return info as RequiredWorkerTerminalInfo;
}

type TerminalWorkerRequestInput = TerminalWorkerRequest extends infer Request
  ? Request extends TerminalWorkerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WorkerTerminalRecord {
  info: RequiredWorkerTerminalInfo;
  state: TerminalState;
  activity: TerminalActivity | null;
  // Cached input-mode preamble from the worker (the authoritative tracker lives
  // in the worker process). Updated with streamed output and snapshot responses.
  replayPreamble: string;
  exitInfo: TerminalExitInfo | null;
  messageListeners: Set<(msg: ServerMessage) => void>;
  exitListeners: Set<(info: TerminalExitInfo) => void>;
  commandFinishedListeners: Set<(info: TerminalCommandFinishedInfo) => void>;
  titleChangeListeners: Set<(title?: string) => void>;
  activityChangeListeners: Set<(transition: TerminalActivityTransition) => void>;
  session: TerminalSession;
}

export interface TerminalCreateEnvironment {
  baseEnv: Record<string, string>;
  paseoCliPath: string | null;
}

interface WorkerTerminalManagerOptions {
  worker: TerminalWorkerConnection;
  /** Reconnects a surviving worker; null means it is confirmed gone or the owner stopped. */
  reconnect?: () => Promise<TerminalWorkerConnection | null>;
  requestTimeoutMs?: number;
  getTerminalActivityUrl?: () => string | null;
  resolveCreateEnvironment?: () => TerminalCreateEnvironment;
  // The kill path. The daemon passes the reaper, which verifies every program is gone; the
  // default asks the connected worker to shut down.
  closeTerminals?: () => Promise<void>;
}

/** The daemon's terminal manager: its terminals live in a worker that can outlive it. */
export interface DaemonTerminalManager extends TerminalManager {
  /** Registers every terminal the connected worker already runs. Resolves with their count. */
  adoptTerminals(): Promise<number>;
  /** Kills every terminal and verifies their programs ended. */
  closeTerminals(): Promise<void>;
  /**
   * Lets go of the worker; its terminals keep running for the next daemon. With
   * `afterPendingRequests`, requests already sent get their answers first.
   */
  detach(options?: { afterPendingRequests?: boolean }): Promise<void>;
}

function createActivityToken(): string {
  return randomBytes(32).toString("base64url");
}

function resolveDaemonTerminalCreateEnvironment(): TerminalCreateEnvironment {
  return {
    baseEnv: createExternalProcessEnv(process.env),
    paseoCliPath: resolvePaseoCliExecutablePath(),
  };
}

function isResponse(message: TerminalWorkerToParentMessage): message is TerminalWorkerResponse {
  return message.type === "response";
}

function cloneTerminalInfo(info: RequiredWorkerTerminalInfo): RequiredWorkerTerminalInfo {
  return {
    id: info.id,
    name: info.name,
    cwd: info.cwd,
    workspaceId: info.workspaceId,
    ...(info.title ? { title: info.title } : {}),
    activity: info.activity,
  };
}

export function createWorkerTerminalManager(
  managerOptions: WorkerTerminalManagerOptions,
): DaemonTerminalManager {
  let worker = managerOptions.worker;
  let detached = false;
  let reconnecting: Promise<void> | null = null;
  const requestTimeoutMs = managerOptions.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const resolveCreateEnvironment =
    managerOptions.resolveCreateEnvironment ?? resolveDaemonTerminalCreateEnvironment;
  const pendingRequests = new Map<string, PendingRequest>();
  const inFlight = new Set<Promise<void>>();
  const recordsById = new Map<string, WorkerTerminalRecord>();
  const terminalIdsByCwd = new Map<string, Set<string>>();
  const terminalActivityTokenById = new Map<string, string>();
  // Creation owns a reference to the session independently of the live-terminal
  // index. Only terminalCreated registers it; terminalExit removes it permanently.
  const pendingCreationsById = new Map<string, { session: TerminalSession | null }>();
  const terminalsChangedListeners = new Set<TerminalsChangedListener>();
  const terminalActivityListeners = new Set<TerminalActivityListener>();
  const terminalWorkspaceContributionChangedListeners =
    new Set<TerminalWorkspaceContributionChangedListener>();
  let workerDisconnected = false;
  let closePromise: Promise<void> | null = null;

  function emitTerminalsChanged(event: TerminalsChangedEvent): void {
    for (const listener of Array.from(terminalsChangedListeners)) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }

  function emitTerminalWorkspaceContributionChanged(
    event: TerminalWorkspaceContributionChangedEvent,
  ): void {
    for (const listener of Array.from(terminalWorkspaceContributionChangedListeners)) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }

  function emitTerminalActivityTransition(event: TerminalActivityTransitionEvent): void {
    for (const listener of Array.from(terminalActivityListeners)) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }

  function listTerminalItemsForCwd(cwd: string): TerminalListItem[] {
    const terminalIds = terminalIdsByCwd.get(cwd);
    if (!terminalIds) {
      return [];
    }
    const terminals: TerminalListItem[] = [];
    for (const terminalId of terminalIds) {
      const record = recordsById.get(terminalId);
      if (!record) {
        continue;
      }
      terminals.push({
        id: record.info.id,
        name: record.info.name,
        cwd: record.info.cwd,
        workspaceId: record.info.workspaceId,
        ...(record.info.title ? { title: record.info.title } : {}),
        activity: record.activity,
      });
    }
    return terminals;
  }

  function registerRecord(input: {
    info: RequiredWorkerTerminalInfo;
    state: TerminalState;
  }): TerminalSession {
    const existing = recordsById.get(input.info.id);
    if (existing) {
      existing.info = cloneTerminalInfo(input.info);
      existing.state = input.state;
      return existing.session;
    }

    const record: WorkerTerminalRecord = {
      info: cloneTerminalInfo(input.info),
      state: input.state,
      activity: input.info.activity,
      replayPreamble: "",
      exitInfo: null,
      messageListeners: new Set(),
      exitListeners: new Set(),
      commandFinishedListeners: new Set(),
      titleChangeListeners: new Set(),
      activityChangeListeners: new Set(),
      session: undefined as unknown as TerminalSession,
    };

    const session: TerminalSession = {
      get id() {
        return record.info.id;
      },
      get name() {
        return record.info.name;
      },
      get cwd() {
        return record.info.cwd;
      },
      get workspaceId() {
        return record.info.workspaceId;
      },
      send(message: ClientMessage): void {
        if (message.type === "resize") {
          record.state = {
            ...record.state,
            rows: message.rows,
            cols: message.cols,
          };
        }
        sendBestEffortRequest({ type: "send", terminalId: record.info.id, message });
      },
      subscribe(
        listener: (msg: ServerMessage) => void,
        options?: { initialSnapshot?: "state" | "ready" },
      ): () => void {
        record.messageListeners.add(listener);
        if (options?.initialSnapshot === "ready") {
          queueMicrotask(() => {
            if (record.messageListeners.has(listener)) {
              listener({ type: "snapshotReady", revision: 0 });
            }
          });
        }
        return () => {
          record.messageListeners.delete(listener);
        };
      },
      onExit(listener: (info: TerminalExitInfo) => void): () => void {
        if (record.exitInfo) {
          queueMicrotask(() => listener(record.exitInfo!));
          return () => {};
        }
        record.exitListeners.add(listener);
        return () => {
          record.exitListeners.delete(listener);
        };
      },
      onCommandFinished(listener: (info: TerminalCommandFinishedInfo) => void): () => void {
        record.commandFinishedListeners.add(listener);
        return () => {
          record.commandFinishedListeners.delete(listener);
        };
      },
      onTitleChange(listener: (title?: string) => void): () => void {
        record.titleChangeListeners.add(listener);
        if (record.info.title !== undefined) {
          queueMicrotask(() => {
            if (record.titleChangeListeners.has(listener)) {
              listener(record.info.title);
            }
          });
        }
        return () => {
          record.titleChangeListeners.delete(listener);
        };
      },
      onActivityChange(listener: (transition: TerminalActivityTransition) => void): () => void {
        record.activityChangeListeners.add(listener);
        return () => {
          record.activityChangeListeners.delete(listener);
        };
      },
      getActivity(): TerminalActivity | null {
        return record.activity;
      },
      setActivity(state: TerminalActivityState): void {
        record.activity = { state, changedAt: Date.now() };
        sendBestEffortRequest({ type: "setActivity", terminalId: record.info.id, state });
      },
      clearActivityAttention(): boolean {
        if (record.activity?.attentionReason == null) {
          return false;
        }
        record.activity = { state: record.activity.state, changedAt: Date.now() };
        sendBestEffortRequest({ type: "clearAttention", terminalId: record.info.id });
        return true;
      },
      getSize(): { rows: number; cols: number } {
        return {
          rows: record.state.rows,
          cols: record.state.cols,
        };
      },
      getState(): TerminalState {
        return record.state;
      },
      getStateSnapshot(options?: { scrollbackLines?: number }): TerminalStateSnapshot {
        const scrollbackLines = options?.scrollbackLines;
        const scrollback =
          typeof scrollbackLines === "number"
            ? record.state.scrollback.slice(-scrollbackLines)
            : record.state.scrollback;
        return {
          state: { ...record.state, scrollback },
          revision: 0,
        };
      },
      getReplayPreamble(): string {
        return record.replayPreamble;
      },
      getTitle(): string | undefined {
        return record.info.title;
      },
      setTitle(nextTitle: string): void {
        const manualTitle = nextTitle.trim();
        if (!manualTitle) {
          return;
        }
        record.info = { ...record.info, title: manualTitle };
        for (const listener of Array.from(record.titleChangeListeners)) {
          listener(manualTitle);
        }
      },
      getExitInfo(): TerminalExitInfo | null {
        return record.exitInfo;
      },
      kill(): void {
        sendBestEffortRequest({ type: "killTerminal", terminalId: record.info.id });
      },
      killAndWait(options?: {
        gracefulTimeoutMs?: number;
        forceTimeoutMs?: number;
      }): Promise<void> {
        return sendRequest({
          type: "killTerminalAndWait",
          terminalId: record.info.id,
          ...(options ? { options } : {}),
        }).then(() => undefined);
      },
    };

    record.session = session;
    recordsById.set(record.info.id, record);
    const terminalIds = terminalIdsByCwd.get(record.info.cwd) ?? new Set<string>();
    terminalIds.add(record.info.id);
    terminalIdsByCwd.set(record.info.cwd, terminalIds);
    return session;
  }

  function removeRecord(terminalId: string): WorkerTerminalRecord | undefined {
    const record = recordsById.get(terminalId);
    if (!record) {
      return undefined;
    }
    recordsById.delete(terminalId);
    terminalActivityTokenById.delete(terminalId);
    const terminalIds = terminalIdsByCwd.get(record.info.cwd);
    if (terminalIds) {
      terminalIds.delete(terminalId);
      if (terminalIds.size === 0) {
        terminalIdsByCwd.delete(record.info.cwd);
      }
    }
    return record;
  }

  function handleTerminalMessageEvent(
    message: Extract<TerminalWorkerToParentMessage, { type: "terminalMessage" }>,
  ): void {
    const record = recordsById.get(message.terminalId);
    if (!record) {
      return;
    }
    if (message.message.type === "snapshot") {
      record.state = message.message.state;
    }
    record.replayPreamble = message.replayPreamble;
    for (const listener of Array.from(record.messageListeners)) {
      listener(message.message);
    }
  }

  function handleTerminalExitEvent(
    message: Extract<TerminalWorkerToParentMessage, { type: "terminalExit" }>,
  ): void {
    const record = recordsById.get(message.terminalId);
    if (!record) {
      return;
    }
    record.exitInfo = message.info;
    for (const listener of Array.from(record.exitListeners)) {
      listener(message.info);
    }
    record.exitListeners.clear();
    const previousBucket = deriveTerminalActivityStatusBucket(record.activity);
    const removedRecord = removeRecord(message.terminalId);
    if (previousBucket !== null && removedRecord) {
      emitTerminalWorkspaceContributionChanged({
        terminalId: removedRecord.info.id,
        cwd: removedRecord.info.cwd,
        workspaceId: removedRecord.info.workspaceId,
      });
    }
    emitTerminalsChanged({
      cwd: record.info.cwd,
      terminals: listTerminalItemsForCwd(record.info.cwd),
    });
  }

  function handleTerminalTitleChangeEvent(
    message: Extract<TerminalWorkerToParentMessage, { type: "terminalTitleChange" }>,
  ): void {
    const record = recordsById.get(message.terminalId);
    if (!record) {
      return;
    }
    const nextState = { ...record.state };
    if (message.title) {
      nextState.title = message.title;
    } else {
      delete nextState.title;
    }
    record.info = {
      ...record.info,
      ...(message.title ? { title: message.title } : { title: undefined }),
    };
    record.state = nextState;
    for (const listener of Array.from(record.titleChangeListeners)) {
      listener(message.title);
    }
    emitTerminalsChanged({
      cwd: record.info.cwd,
      terminals: listTerminalItemsForCwd(record.info.cwd),
    });
  }

  function handleTerminalCommandFinishedEvent(
    message: Extract<TerminalWorkerToParentMessage, { type: "terminalCommandFinished" }>,
  ): void {
    const record = recordsById.get(message.terminalId);
    if (!record) {
      return;
    }
    for (const listener of Array.from(record.commandFinishedListeners)) {
      listener(message.info);
    }
  }

  function handleTerminalActivityChangeEvent(
    message: Extract<TerminalWorkerToParentMessage, { type: "terminalActivityChange" }>,
  ): void {
    const record = recordsById.get(message.terminalId);
    if (!record) {
      return;
    }
    const previousActivity = record.activity;
    record.activity = message.activity;
    const transition: TerminalActivityTransition = {
      activity: message.activity,
      previous: message.previous,
    };
    for (const listener of Array.from(record.activityChangeListeners)) {
      listener(transition);
    }
    emitTerminalActivityTransition({
      terminalId: record.info.id,
      name: record.info.name,
      cwd: record.info.cwd,
      workspaceId: record.info.workspaceId,
      activity: message.activity,
      previous: message.previous,
    });
    const previousBucket = deriveTerminalActivityStatusBucket(previousActivity);
    const nextBucket = deriveTerminalActivityStatusBucket(message.activity);
    if (previousBucket !== nextBucket) {
      emitTerminalWorkspaceContributionChanged({
        terminalId: record.info.id,
        cwd: record.info.cwd,
        workspaceId: record.info.workspaceId,
      });
    }
    emitTerminalsChanged({
      cwd: record.info.cwd,
      terminals: listTerminalItemsForCwd(record.info.cwd),
    });
  }

  function handleWorkerEvent(message: TerminalWorkerToParentMessage): void {
    switch (message.type) {
      case "terminalCreated": {
        const session = registerRecord({
          info: asRequiredWorkerTerminalInfo(message.terminal),
          state: message.state,
        });
        const pendingCreation = pendingCreationsById.get(message.terminal.id);
        if (pendingCreation) {
          pendingCreation.session = session;
        }
        emitTerminalsChanged({
          cwd: message.terminal.cwd,
          terminals: listTerminalItemsForCwd(message.terminal.cwd),
        });
        return;
      }

      case "terminalMessage": {
        handleTerminalMessageEvent(message);
        return;
      }

      case "terminalExit": {
        handleTerminalExitEvent(message);
        return;
      }

      case "terminalTitleChange": {
        handleTerminalTitleChangeEvent(message);
        return;
      }

      case "terminalCommandFinished": {
        handleTerminalCommandFinishedEvent(message);
        return;
      }

      case "terminalActivityChange": {
        handleTerminalActivityChangeEvent(message);
        return;
      }
    }
  }

  function rejectPendingRequests(error: Error): void {
    for (const [requestId, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      pendingRequests.delete(requestId);
    }
  }

  function attachWorker(): void {
    worker.on("message", (message: TerminalWorkerToParentMessage) => {
      if (isResponse(message)) {
        const pending = pendingRequests.get(message.requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        pendingRequests.delete(message.requestId);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(message.error));
        }
        return;
      }
      handleWorkerEvent(message);
    });

    worker.on("close", () => {
      workerDisconnected = true;
      rejectPendingRequests(new Error("Terminal worker connection closed"));
      const reconnect = managerOptions.reconnect;
      if (!detached && reconnect) {
        reconnecting = (async () => {
          const connection = await reconnect();
          if (!connection) {
            for (const terminalId of Array.from(recordsById.keys())) {
              handleTerminalExitEvent({
                type: "terminalExit",
                terminalId,
                info: { exitCode: null, signal: null, lastOutputLines: [] },
              });
            }
            return;
          }
          if (detached) {
            connection.disconnect();
            return;
          }
          worker = connection;
          workerDisconnected = false;
          attachWorker();
          await adoptTerminals();
          // Output emitted without a controller is retained in the worker's screen. Existing
          // streams must fetch that screen before applying further live output.
          for (const record of recordsById.values()) {
            handleTerminalMessageEvent({
              type: "terminalMessage",
              terminalId: record.info.id,
              message: { type: "snapshotReady" },
              replayPreamble: record.replayPreamble,
            });
          }
        })().finally(() => {
          reconnecting = null;
        });
        void reconnecting.catch(() => {});
      }
    });
  }
  attachWorker();

  function sendRequest(input: TerminalWorkerRequestInput): Promise<unknown> {
    if (reconnecting && workerDisconnected) return reconnecting.then(() => sendRequest(input));
    if (workerDisconnected || !worker.connected) {
      return Promise.reject(new Error("Terminal worker is not running"));
    }
    const requestId = randomUUID();
    const message = { ...input, requestId } as TerminalWorkerRequest;
    const request = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Terminal worker request timed out: ${input.type}`));
      }, requestTimeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timeout });
      worker.send(message, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        reject(error);
      });
    });
    // Tracks settlement only; the caller handles the rejection.
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    inFlight.add(settled);
    void settled.finally(() => inFlight.delete(settled));
    return request;
  }

  function sendBestEffortRequest(input: TerminalWorkerRequestInput): void {
    void sendRequest(input).catch(() => {
      // The public terminal methods that call this are intentionally synchronous.
      // Worker failures are surfaced through awaitable manager methods and worker
      // lifecycle state; do not let fire-and-forget sends crash the daemon.
    });
  }

  function clearRecords(): void {
    for (const terminalId of Array.from(recordsById.keys())) {
      removeRecord(terminalId);
    }
  }

  function disconnectWorker(): Promise<void> {
    if (workerDisconnected || !worker.connected) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      worker.on("close", () => resolve());
      worker.disconnect();
    });
  }

  function closeTerminals(): Promise<void> {
    detached = true;
    closePromise ??= (async () => {
      await reconnecting;
      if (managerOptions.closeTerminals) {
        await disconnectWorker();
        clearRecords();
        await managerOptions.closeTerminals();
        return;
      }
      // Unverified: production passes the reaper, which confirms every program ended.
      sendBestEffortRequest({ type: "shutdown" });
      await disconnectWorker();
      clearRecords();
    })();
    return closePromise;
  }

  async function adoptTerminals(): Promise<number> {
    const listed = (await sendRequest({ type: "listTerminals" })) as TerminalWorkerListResult;
    const cwds = new Set<string>();
    const liveIds = new Set(listed.map((item) => item.terminal.id));
    for (const terminalId of Array.from(recordsById.keys())) {
      if (!liveIds.has(terminalId))
        handleTerminalExitEvent({
          type: "terminalExit",
          terminalId,
          info: { exitCode: null, signal: null, lastOutputLines: [] },
        });
    }
    for (const item of listed) {
      const info = asRequiredWorkerTerminalInfo(item.terminal);
      registerRecord({ info, state: item.state });
      const record = recordsById.get(info.id);
      if (record) {
        record.replayPreamble = item.replayPreamble;
      }
      // The agent hooks inside each shell keep the token they were started with.
      if (item.activityToken) {
        terminalActivityTokenById.set(info.id, item.activityToken);
      }
      cwds.add(info.cwd);
    }
    for (const cwd of cwds) {
      emitTerminalsChanged({ cwd, terminals: listTerminalItemsForCwd(cwd) });
    }
    return listed.length;
  }

  return {
    async getTerminals(
      cwd: string,
      options?: { workspaceId?: string },
    ): Promise<TerminalSession[]> {
      assertAbsolutePath(cwd);

      // Served from the local mirror, exactly like every other parent read.
      // Terminals are bucketed by exact cwd, but an agent can open a terminal in
      // a subdirectory of the workspace. A query for the workspace root must
      // surface those too, so aggregate every bucket at or below `cwd`.
      const sessions: TerminalSession[] = [];
      for (const [bucketCwd, terminalIds] of terminalIdsByCwd) {
        if (!isSameOrDescendantPath(cwd, bucketCwd)) {
          continue;
        }
        for (const terminalId of terminalIds) {
          const session = recordsById.get(terminalId)?.session;
          if (session) {
            sessions.push(session);
          }
        }
      }

      // When the query carries a workspaceId, two workspaces sharing a cwd must
      // not see each other's terminals. A missing owner is not workspace
      // membership; unscoped callers can still list those legacy terminals.
      if (options?.workspaceId !== undefined) {
        return sessions.filter((session) => session.workspaceId === options.workspaceId);
      }
      return sessions;
    },

    async createTerminal(
      options: WorkerCreateTerminalOptions & { workspaceId: string },
    ): Promise<TerminalSession> {
      const terminalId = options.id ?? randomUUID();
      const activityToken = createActivityToken();
      const terminalActivityUrl = managerOptions.getTerminalActivityUrl?.() ?? null;
      terminalActivityTokenById.set(terminalId, activityToken);
      const creation = { session: null as TerminalSession | null };
      pendingCreationsById.set(terminalId, creation);
      try {
        const environment = resolveCreateEnvironment();
        await sendRequest({
          type: "createTerminal",
          options: {
            ...options,
            id: terminalId,
            activityToken,
            activityUrl: terminalActivityUrl,
            baseEnv: environment.baseEnv,
            paseoCliPath: environment.paseoCliPath,
          },
        });
        if (!creation.session) {
          throw new Error("Terminal worker completed creation without a terminalCreated event");
        }
        return creation.session;
      } catch (error) {
        terminalActivityTokenById.delete(terminalId);
        throw error;
      } finally {
        pendingCreationsById.delete(terminalId);
      }
    },

    registerCwdEnv(options: { cwd: string; env: Record<string, string> }): void {
      sendBestEffortRequest({
        type: "registerCwdEnv",
        cwd: options.cwd,
        env: options.env,
      });
    },

    validateTerminalActivityToken(
      terminalId: string,
      token: string,
    ): "valid" | "unknown" | "invalid" {
      const expected = terminalActivityTokenById.get(terminalId);
      if (!expected) {
        return "unknown";
      }
      return expected === token ? "valid" : "invalid";
    },

    getTerminal(id: string): TerminalSession | undefined {
      return recordsById.get(id)?.session;
    },

    async getTerminalState(
      id: string,
      options?: { scrollbackLines?: number },
    ): Promise<TerminalStateSnapshot | null> {
      const snapshot = (await sendRequest({
        type: "getTerminalState",
        terminalId: id,
        ...(options ? { options } : {}),
      })) as TerminalWorkerStateResult;
      if (snapshot && snapshot.replayPreamble !== undefined) {
        const record = recordsById.get(id);
        if (record) {
          record.replayPreamble = snapshot.replayPreamble;
        }
      }
      return snapshot;
    },

    setTerminalTitle(id: string, title: string): boolean {
      const session = recordsById.get(id)?.session;
      if (!session) {
        return false;
      }
      session.setTitle(title);
      return true;
    },

    async setTerminalActivity(id: string, state: TerminalActivityState): Promise<boolean> {
      const record = recordsById.get(id);
      if (!record) {
        return false;
      }
      await sendRequest({ type: "setActivity", terminalId: id, state });
      return true;
    },

    async clearTerminalAttention(id: string): Promise<boolean> {
      const record = recordsById.get(id);
      if (!record || record.activity?.attentionReason == null) {
        return false;
      }
      await sendRequest({ type: "clearAttention", terminalId: id });
      return true;
    },

    killTerminal(id: string): void {
      void sendRequest({ type: "killTerminal", terminalId: id }).catch(() => {
        // no-op; kill is intentionally best-effort and synchronous in the public interface.
      });
    },

    async killTerminalAndWait(
      id: string,
      options?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number },
    ): Promise<void> {
      await sendRequest({
        type: "killTerminalAndWait",
        terminalId: id,
        ...(options ? { options } : {}),
      });
    },

    async captureTerminal(
      id: string,
      options?: { start?: number; end?: number; stripAnsi?: boolean },
    ): Promise<CaptureTerminalLinesResult> {
      return (await sendRequest({
        type: "captureTerminal",
        terminalId: id,
        ...(options?.start === undefined ? {} : { start: options.start }),
        ...(options?.end === undefined ? {} : { end: options.end }),
        ...(options?.stripAnsi === undefined ? {} : { stripAnsi: options.stripAnsi }),
      })) as CaptureTerminalLinesResult;
    },

    listDirectories(): string[] {
      return Array.from(terminalIdsByCwd.keys());
    },

    killAll(): void {
      void closeTerminals().catch(() => {
        // The synchronous interface cannot report it; closeTerminals() callers see the error.
      });
    },

    closeTerminals,

    async detach(options?: { afterPendingRequests?: boolean }): Promise<void> {
      detached = true;
      await reconnecting;
      if (options?.afterPendingRequests) {
        await Promise.allSettled(Array.from(inFlight));
      }
      await disconnectWorker();
      clearRecords();
    },

    adoptTerminals,

    subscribeTerminalsChanged(listener: TerminalsChangedListener): () => void {
      terminalsChangedListeners.add(listener);
      return () => {
        terminalsChangedListeners.delete(listener);
      };
    },

    subscribeTerminalActivity(listener: TerminalActivityListener): () => void {
      terminalActivityListeners.add(listener);
      return () => {
        terminalActivityListeners.delete(listener);
      };
    },

    subscribeTerminalWorkspaceContributionChanged(
      listener: TerminalWorkspaceContributionChangedListener,
    ): () => void {
      terminalWorkspaceContributionChangedListeners.add(listener);
      return () => {
        terminalWorkspaceContributionChangedListeners.delete(listener);
      };
    },
  };
}

export interface StartWorkerTerminalManagerOptions {
  paseoHome: string;
  paseoVersion: string;
  logger: Logger;
  getTerminalActivityUrl?: () => string | null;
  requestTimeoutMs?: number;
}

// The current worker plus one draining a previous protocol. Every live worker counts,
// incompatible, unreachable, unidentified and closing ones included: the daemon never starts a
// third.
const MAX_TERMINAL_WORKERS = 2;
const DRAINED_WORKER_EXIT_TIMEOUT_MS = 10_000;

interface LiveWorkerRecord {
  path: string;
  record: TerminalWorkerRecord;
  fit: TerminalWorkerProtocolFit;
}

/**
 * Connects the daemon to its terminal workers. A worker of this daemon's protocol is adopted
 * (restart, crash, `stop --keep-terminals`); one a protocol older is adopted to drain; anything
 * older is shut down, its terminals closed; one from a newer Paseo is left running and the
 * terminal service reports it as incompatible. A worker is launched only when none is current,
 * none is incompatible and fewer than two run; when two run, the first terminal created after one
 * of them exits launches it. Records that cannot be adopted (a cleanup that
 * never finished, a dead worker whose programs survived it) go through the reaper first, so a
 * daemon never adopts terminals someone asked to close.
 */
export async function startWorkerTerminalManager(
  options: StartWorkerTerminalManagerOptions,
): Promise<DaemonTerminalManager> {
  const logger = options.logger.child({ module: "terminal-worker" });
  const inspector = createTerminalWorkerProcessInspector();
  const log = (message: string, fields?: Record<string, unknown>) => logger.info(fields, message);
  const live: LiveWorkerRecord[] = [];
  const toReap: string[] = [];
  for (const file of await listTerminalWorkerRecords(options.paseoHome)) {
    if ("error" in file) {
      logger.warn({ recordPath: file.path, err: file.error }, "Unreadable terminal worker record");
      continue;
    }
    const { record } = file;
    if (
      record.closing ||
      !writtenDuringThisBoot({ startedAt: record.createdAt, bootId: record.bootId })
    ) {
      toReap.push(file.path);
      continue;
    }
    const worker = classifyTerminalWorkerProcess(record, await inspector.inspect(record.pid));
    if (worker.status === "owned") {
      live.push({
        path: file.path,
        record,
        fit: classifyTerminalWorkerProtocol(record.protocolVersion),
      });
    } else if (worker.status === "unknown") {
      logger.warn(
        { recordPath: file.path, pid: record.pid, reason: worker.reason },
        "Cannot identify terminal worker; leaving its record",
      );
    } else {
      // Its programs lost their PTY with the worker and cannot be adopted.
      toReap.push(file.path);
    }
  }

  if (toReap.length > 0) {
    await reapTerminalWorkers({
      paseoHome: options.paseoHome,
      gracefulMs: 0,
      recordPaths: toReap,
      inspector,
      log,
    }).catch((error: unknown) => {
      logger.warn({ err: error }, "Terminal cleanup of an unadoptable worker was not confirmed");
    });
  }

  const obsolete = live.filter((entry) => entry.fit === "obsolete");
  if (obsolete.length > 0) {
    for (const entry of obsolete) {
      logger.warn(
        {
          pid: entry.record.pid,
          protocolVersion: entry.record.protocolVersion,
          paseoVersion: entry.record.paseoVersion,
          terminals: entry.record.terminals.length,
        },
        "Closing a terminal worker two or more protocol versions old; its terminals close",
      );
    }
    await reapTerminalWorkers({
      paseoHome: options.paseoHome,
      recordPaths: obsolete.map((entry) => entry.path),
      inspector,
      log,
    }).catch((error: unknown) => {
      logger.warn({ err: error }, "Closing an obsolete terminal worker was not confirmed");
    });
  }

  const closeAll = async () => {
    const result = await reapTerminalWorkers({ paseoHome: options.paseoHome, inspector, log });
    logger.info(result, "Terminals closed");
  };
  const prune = async () => {
    const result = await pruneTerminalWorkerRuntimes(options.paseoHome);
    if (result.removed.length > 0)
      log("Removed terminal worker copies", { removed: result.removed });
    for (const failure of result.failed) {
      logger.warn(failure, "Cannot remove a terminal worker copy; the next start retries");
    }
  };

  const pruneAfterExit = async (workerPid: number) => {
    if (await waitForWorkerRecordRemoval(options.paseoHome, workerPid)) {
      await prune();
      return;
    }
    logger.warn({ pid: workerPid }, "Drained terminal worker has not exited yet");
  };

  const newer = live.find((entry) => entry.fit === "newer");
  if (newer) {
    const incompatible = new TerminalWorkerIncompatibleError({
      paseoVersion: newer.record.paseoVersion,
      protocolVersion: newer.record.protocolVersion,
    });
    logger.error({ pid: newer.record.pid }, incompatible.message);
    await prune();
    return createTerminalWorkerPool({
      current: null,
      draining: [],
      incompatible,
      closeAll,
    });
  }

  const createMember = async (
    record: TerminalWorkerRecord,
    connection: TerminalWorkerConnection,
  ): Promise<TerminalWorkerPoolMember> => {
    let alive = true;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    let recovery: Promise<TerminalWorkerConnection | null> | null = null;
    const recoveryState = { stopped: false };
    const reconnect = () => {
      recovery ??= (async () => {
        while (!recoveryState.stopped) {
          const ownership = classifyTerminalWorkerProcess(
            record,
            await inspector.inspect(record.pid),
          );
          if (ownership.status === "gone" || ownership.status === "unrelated") {
            await reapTerminalWorkers({
              paseoHome: options.paseoHome,
              recordPaths: [terminalWorkerRecordPath(options.paseoHome, record.pid)],
              inspector,
              log,
              gracefulMs: 0,
            }).catch((error) =>
              logger.warn({ err: error }, "Dead terminal worker cleanup was not confirmed"),
            );
            alive = false;
            resolveExit();
            return null;
          }
          try {
            return await connectTerminalWorker({
              socketPath: record.socketPath,
              secret: record.secret,
              timeoutMs: 500,
            });
          } catch {
            await delay(100);
          }
        }
        return null;
      })().finally(() => {
        recovery = null;
      });
      return recovery;
    };
    const manager = createWorkerTerminalManager({
      worker: connection,
      reconnect,
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.getTerminalActivityUrl
        ? { getTerminalActivityUrl: options.getTerminalActivityUrl }
        : {}),
      closeTerminals: closeAll,
    });
    const count = await manager.adoptTerminals();
    if (count > 0) {
      logger.info({ pid: record.pid, terminals: count }, "Adopted terminals from a running worker");
    }
    return {
      manager,
      workerPid: record.pid,
      exited,
      ready: async () => {
        await recovery;
        return alive && !recoveryState.stopped;
      },
      stopRecovery: () => {
        recoveryState.stopped = true;
      },
    };
  };

  let current: TerminalWorkerPoolMember | null = null;
  const draining: TerminalWorkerPoolMember[] = [];
  const adoptable = [
    ...live.filter((entry) => entry.fit === "current"),
    ...live.filter((entry) => entry.fit === "previous"),
  ];
  for (const entry of adoptable) {
    let connection: TerminalWorkerConnection;
    try {
      connection = await connectTerminalWorker({
        socketPath: entry.record.socketPath,
        secret: entry.record.secret,
      });
    } catch (error) {
      logger.warn(
        { pid: entry.record.pid, err: error },
        "Cannot reach terminal worker; leaving it running",
      );
      continue;
    }
    const member = await createMember(entry.record, connection);
    if (entry.fit === "current" && !current) {
      logger.info({ pid: entry.record.pid }, "Adopting running terminal worker");
      current = member;
    } else {
      // A previous protocol, or a second worker of this one: it keeps its terminals and takes
      // no new ones.
      logger.info(
        { pid: entry.record.pid, protocolVersion: entry.record.protocolVersion },
        "Draining terminal worker; it exits after its last terminal",
      );
      draining.push(member);
    }
  }

  // Counted from the records rather than from what startup drove: a worker a cleanup could not
  // confirm gone keeps running, and a draining one exits on its own.
  const startCurrent = async (): Promise<TerminalWorkerPoolMember> => {
    const running = await countRunningTerminalWorkers(options.paseoHome, inspector);
    if (running >= MAX_TERMINAL_WORKERS) {
      throw new NoTerminalWorkerAvailableError(
        `${running} terminal workers are already running in ${options.paseoHome}; new terminals can open once one of them exits`,
      );
    }
    const launched = await launchTerminalWorker({
      paseoHome: options.paseoHome,
      paseoVersion: options.paseoVersion,
    });
    const connection = await connectTerminalWorker({
      socketPath: launched.record.socketPath,
      secret: launched.record.secret,
    });
    logger.info(
      { pid: launched.record.pid, runtime: launched.record.runtime ?? null },
      "Launched terminal worker",
    );
    return createMember(launched.record, connection);
  };

  await prune();
  if (!current) {
    try {
      current = await startCurrent();
    } catch (error) {
      if (!(error instanceof NoTerminalWorkerAvailableError)) throw error;
      logger.warn(error.message);
    }
  }

  return createTerminalWorkerPool({
    current,
    draining,
    incompatible: null,
    startCurrent,
    closeAll,
    onDrained: (member) => {
      log("Released drained terminal worker", { pid: member.workerPid });
      void pruneAfterExit(member.workerPid);
    },
  });
}

// Every worker that may still run in this home, one per record: a worker and its cleanup record
// are listed as one. Unreadable records and workers that cannot be identified count; a worker
// confirmed gone, or a pid reused by another process, does not.
async function countRunningTerminalWorkers(
  paseoHome: string,
  inspector: TerminalWorkerProcessInspector,
): Promise<number> {
  let running = 0;
  for (const file of await listTerminalWorkerRecords(paseoHome)) {
    if ("error" in file) {
      running += 1;
      continue;
    }
    const { record } = file;
    if (!writtenDuringThisBoot({ startedAt: record.createdAt, bootId: record.bootId })) continue;
    const worker = classifyTerminalWorkerProcess(record, await inspector.inspect(record.pid));
    if (worker.status === "owned" || worker.status === "unknown") running += 1;
  }
  return running;
}

// A worker deletes its own record as it exits.
async function waitForWorkerRecordRemoval(paseoHome: string, workerPid: number): Promise<boolean> {
  const recordPath = terminalWorkerRecordPath(paseoHome, workerPid);
  const deadline = Date.now() + DRAINED_WORKER_EXIT_TIMEOUT_MS;
  while (
    await access(recordPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  ) {
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
  return true;
}
