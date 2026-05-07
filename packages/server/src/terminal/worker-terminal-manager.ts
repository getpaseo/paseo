import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { TerminalState } from "../shared/messages.js";
import type {
  ClientMessage,
  ServerMessage,
  TerminalCommandFinishedInfo,
  TerminalExitInfo,
  TerminalSession,
  TerminalStateSnapshot,
} from "./terminal.js";
import type { CaptureTerminalLinesResult } from "./terminal-capture.js";
import type {
  TerminalListItem,
  TerminalManager,
  TerminalsChangedEvent,
  TerminalsChangedListener,
} from "./terminal-manager.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerResponse,
  TerminalWorkerToParentMessage,
  WorkerCreateTerminalOptions,
  TerminalWorkerStateResult,
  WorkerTerminalInfo,
} from "./terminal-worker-protocol.js";

const REQUEST_TIMEOUT_MS = 10000;

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
  info: WorkerTerminalInfo;
  state: TerminalState;
  exitInfo: TerminalExitInfo | null;
  messageListeners: Set<(msg: ServerMessage) => void>;
  exitListeners: Set<(info: TerminalExitInfo) => void>;
  commandFinishedListeners: Set<(info: TerminalCommandFinishedInfo) => void>;
  titleChangeListeners: Set<(title?: string) => void>;
  session: TerminalSession;
}

interface TerminalWorkerProcess {
  connected: boolean;
  killed: boolean;
  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean;
  disconnect(): void;
  kill(): boolean;
  on(event: "message", listener: (message: TerminalWorkerToParentMessage) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface WorkerTerminalManagerOptions {
  requestTimeoutMs?: number;
  forkWorker?: () => TerminalWorkerProcess;
}

function resolveWorkerUrl(): URL {
  const currentUrl = import.meta.url;
  if (currentUrl.endsWith(".ts")) {
    return new URL("./terminal-worker-process.ts", currentUrl);
  }
  return new URL("./terminal-worker-process.js", currentUrl);
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) {
    return [];
  }
  const loaderUrl = new URL("./terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

function isResponse(message: TerminalWorkerToParentMessage): message is TerminalWorkerResponse {
  return message.type === "response";
}

function cloneTerminalInfo(info: WorkerTerminalInfo): WorkerTerminalInfo {
  return {
    id: info.id,
    name: info.name,
    cwd: info.cwd,
    ...(info.title ? { title: info.title } : {}),
  };
}

function forkTerminalWorker(): TerminalWorkerProcess {
  return fork(fileURLToPath(resolveWorkerUrl()), [], {
    execArgv: resolveWorkerExecArgv(),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  }) as TerminalWorkerProcess;
}

export function createWorkerTerminalManager(
  managerOptions: WorkerTerminalManagerOptions = {},
): TerminalManager {
  const worker = managerOptions.forkWorker ? managerOptions.forkWorker() : forkTerminalWorker();
  const requestTimeoutMs = managerOptions.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const pendingRequests = new Map<string, PendingRequest>();
  const recordsById = new Map<string, WorkerTerminalRecord>();
  const terminalIdsByCwd = new Map<string, Set<string>>();
  const terminalsChangedListeners = new Set<TerminalsChangedListener>();
  let workerExited = false;
  let workerShutdownTimer: ReturnType<typeof setTimeout> | null = null;

  function emitTerminalsChanged(event: TerminalsChangedEvent): void {
    for (const listener of Array.from(terminalsChangedListeners)) {
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
        ...(record.info.title ? { title: record.info.title } : {}),
      });
    }
    return terminals;
  }

  function registerRecord(input: {
    info: WorkerTerminalInfo;
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
      exitInfo: null,
      messageListeners: new Set(),
      exitListeners: new Set(),
      commandFinishedListeners: new Set(),
      titleChangeListeners: new Set(),
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
      subscribe(listener: (msg: ServerMessage) => void): () => void {
        record.messageListeners.add(listener);
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
      getSize(): { rows: number; cols: number } {
        return {
          rows: record.state.rows,
          cols: record.state.cols,
        };
      },
      getState(): TerminalState {
        return record.state;
      },
      getStateSnapshot(): TerminalStateSnapshot {
        return {
          state: record.state,
          revision: 0,
        };
      },
      getTitle(): string | undefined {
        return record.info.title;
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
    removeRecord(message.terminalId);
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

  function handleTerminalsChangedEvent(
    message: Extract<TerminalWorkerToParentMessage, { type: "terminalsChanged" }>,
  ): void {
    emitTerminalsChanged({
      cwd: message.cwd,
      terminals: message.terminals.map((terminal) => ({
        id: terminal.id,
        name: terminal.name,
        cwd: terminal.cwd,
        ...(terminal.title ? { title: terminal.title } : {}),
      })),
    });
  }

  function handleWorkerEvent(message: TerminalWorkerToParentMessage): void {
    switch (message.type) {
      case "terminalCreated": {
        registerRecord({ info: message.terminal, state: message.state });
        return;
      }

      case "terminalRemoved": {
        removeRecord(message.terminalId);
        emitTerminalsChanged({
          cwd: message.cwd,
          terminals: listTerminalItemsForCwd(message.cwd),
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

      case "terminalsChanged": {
        handleTerminalsChangedEvent(message);
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

  worker.on("exit", (code, signal) => {
    workerExited = true;
    if (workerShutdownTimer) {
      clearTimeout(workerShutdownTimer);
      workerShutdownTimer = null;
    }
    rejectPendingRequests(new Error(`Terminal worker exited (${signal ?? code ?? "unknown"})`));
  });

  function sendRequest(input: TerminalWorkerRequestInput): Promise<unknown> {
    if (workerExited || !worker.connected) {
      return Promise.reject(new Error("Terminal worker is not running"));
    }
    const requestId = randomUUID();
    const message = { ...input, requestId } as TerminalWorkerRequest;
    return new Promise((resolve, reject) => {
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
  }

  function sendBestEffortRequest(input: TerminalWorkerRequestInput): void {
    void sendRequest(input).catch(() => {
      // The public terminal methods that call this are intentionally synchronous.
      // Worker failures are surfaced through awaitable manager methods and worker
      // lifecycle state; do not let fire-and-forget sends crash the daemon.
    });
  }

  function toSessions(terminals: WorkerTerminalInfo[]): TerminalSession[] {
    return terminals
      .map((terminal) => recordsById.get(terminal.id)?.session)
      .filter((session): session is TerminalSession => Boolean(session));
  }

  return {
    async getTerminals(cwd: string): Promise<TerminalSession[]> {
      const result = (await sendRequest({ type: "getTerminals", cwd })) as WorkerTerminalInfo[];
      return toSessions(result);
    },

    async createTerminal(options: WorkerCreateTerminalOptions): Promise<TerminalSession> {
      const result = (await sendRequest({ type: "createTerminal", options })) as {
        terminal: WorkerTerminalInfo;
        state: TerminalState;
      };
      return registerRecord({ info: result.terminal, state: result.state });
    },

    registerCwdEnv(options: { cwd: string; env: Record<string, string> }): void {
      sendBestEffortRequest({
        type: "registerCwdEnv",
        cwd: options.cwd,
        env: options.env,
      });
    },

    getTerminal(id: string): TerminalSession | undefined {
      return recordsById.get(id)?.session;
    },

    async getTerminalState(id: string): Promise<TerminalStateSnapshot | null> {
      return (await sendRequest({
        type: "getTerminalState",
        terminalId: id,
      })) as TerminalWorkerStateResult;
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
      void sendRequest({ type: "killAll" })
        .catch(() => {
          // no-op
        })
        .finally(() => {
          if (worker.connected) {
            worker.disconnect();
          }
          if (!worker.killed && !workerShutdownTimer) {
            workerShutdownTimer = setTimeout(() => {
              worker.kill();
            }, 1000);
          }
        });
      for (const terminalId of Array.from(recordsById.keys())) {
        removeRecord(terminalId);
      }
    },

    subscribeTerminalsChanged(listener: TerminalsChangedListener): () => void {
      terminalsChangedListeners.add(listener);
      return () => {
        terminalsChangedListeners.delete(listener);
      };
    },
  };
}

export function terminateWorkerTerminalManager(manager: TerminalManager): void {
  manager.killAll();
}
