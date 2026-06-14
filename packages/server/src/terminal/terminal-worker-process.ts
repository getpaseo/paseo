import { createTerminalManager } from "./terminal-manager.js";
import { captureTerminalLines } from "./terminal-capture.js";
import { TerminalOutputCoalescer } from "./terminal-output-coalescer.js";
import type { TerminalSession, TerminalStateSnapshotOptions } from "./terminal.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerStateResult,
  TerminalWorkerToParentMessage,
  WorkerTerminalInfo,
} from "./terminal-worker-protocol.js";

type TerminalCreateRequest = Extract<TerminalWorkerRequest, { type: "createTerminal" }>;

const manager = createTerminalManager();
const unsubscribeByTerminalId = new Map<string, Array<() => void>>();
const outputCoalescerByTerminalId = new Map<string, TerminalOutputCoalescer>();
let ipcClosing = false;

interface InFlightTerminalCreateRequest {
  requestId: string;
  errorReported: boolean;
}

let inFlightTerminalCreateRequest: InFlightTerminalCreateRequest | null = null;

// The conpty failure signal is process-scoped, not request-scoped. Serializing
// creates keeps an async spawn failure attributable to exactly one request.
let createTerminalQueue: Promise<void> = Promise.resolve();

// node-pty completes its Windows conpty spawn asynchronously on a separate
// conout worker thread. When that spawn fails (bad cwd, missing command, etc.)
// it throws an exception there that cannot be caught at the call site and would
// otherwise crash this worker process and sever every existing terminal.
process.on("uncaughtException", (error) => {
  console.error("Terminal worker uncaught exception (kept alive):", error);
  reportInFlightTerminalCreateFailure(error);
});

function sendToParent(message: TerminalWorkerToParentMessage): void {
  if (ipcClosing || !process.connected || !process.send) {
    return;
  }
  try {
    process.send(message, (error) => {
      if (error) {
        ipcClosing = true;
      }
    });
  } catch {
    ipcClosing = true;
  }
}

function buildTerminalStateResult(
  session: TerminalSession | undefined,
  options?: TerminalStateSnapshotOptions,
): TerminalWorkerStateResult {
  if (!session) {
    return null;
  }
  return { ...session.getStateSnapshot(options), replayPreamble: session.getReplayPreamble() };
}

function toTerminalInfo(session: TerminalSession): WorkerTerminalInfo {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    ...(session.getTitle() ? { title: session.getTitle() } : {}),
    activity: session.getActivity(),
  };
}

function terminalWorkerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Terminal worker request failed";
}

function reportInFlightTerminalCreateFailure(error: unknown): void {
  if (!inFlightTerminalCreateRequest || inFlightTerminalCreateRequest.errorReported) {
    return;
  }
  inFlightTerminalCreateRequest.errorReported = true;
  sendToParent({
    type: "response",
    requestId: inFlightTerminalCreateRequest.requestId,
    ok: false,
    error: terminalWorkerErrorMessage(error),
  });
}

function clearTerminalSubscriptions(terminalId: string): void {
  const subscriptions = unsubscribeByTerminalId.get(terminalId);
  if (subscriptions) {
    for (const unsubscribe of subscriptions) {
      try {
        unsubscribe();
      } catch {
        // no-op
      }
    }
  }
  unsubscribeByTerminalId.delete(terminalId);
  const coalescer = outputCoalescerByTerminalId.get(terminalId);
  if (coalescer) {
    coalescer.dispose();
    outputCoalescerByTerminalId.delete(terminalId);
  }
}

function watchTerminal(session: TerminalSession): void {
  clearTerminalSubscriptions(session.id);

  // Coalesce pty output chunks into a single IPC message per ~5ms window so a
  // burst of small chunks no longer costs one process.send each. The batch
  // carries the LAST chunk's revision (the highest) so downstream snapshot
  // replay dedup stays correct.
  let pendingOutputRevision: number | undefined;
  const outputCoalescer = new TerminalOutputCoalescer({
    timers: { setTimeout, clearTimeout },
    onFlush: ({ payload }) => {
      const revision = pendingOutputRevision;
      pendingOutputRevision = undefined;
      sendToParent({
        type: "terminalMessage",
        terminalId: session.id,
        message: { type: "output", data: payload.toString("utf8"), revision },
      });
    },
  });
  outputCoalescerByTerminalId.set(session.id, outputCoalescer);

  const unsubscribeMessage = session.subscribe((message) => {
    if (message.type === "output") {
      pendingOutputRevision = message.revision;
      outputCoalescer.handle(message.data);
      return;
    }
    // Non-output messages (snapshot/snapshotReady/titleChange) must not jump
    // ahead of buffered output: flush the coalescer first, then forward.
    outputCoalescer.flush();
    sendToParent({
      type: "terminalMessage",
      terminalId: session.id,
      message,
    });
  });
  const unsubscribeExit = session.onExit((info) => {
    outputCoalescer.flush();
    clearTerminalSubscriptions(session.id);
    sendToParent({
      type: "terminalExit",
      terminalId: session.id,
      info,
    });
  });
  const unsubscribeTitle = session.onTitleChange((title) => {
    outputCoalescer.flush();
    sendToParent({
      type: "terminalTitleChange",
      terminalId: session.id,
      title,
    });
  });
  const unsubscribeCommandFinished = session.onCommandFinished((info) => {
    outputCoalescer.flush();
    sendToParent({
      type: "terminalCommandFinished",
      terminalId: session.id,
      info,
    });
  });
  const unsubscribeActivity = session.onActivityChange((transition) => {
    sendToParent({
      type: "terminalActivityChange",
      terminalId: session.id,
      activity: transition.activity,
      previous: transition.previous,
    });
  });

  unsubscribeByTerminalId.set(session.id, [
    unsubscribeMessage,
    unsubscribeExit,
    unsubscribeTitle,
    unsubscribeCommandFinished,
    unsubscribeActivity,
  ]);
}

manager.subscribeTerminalsChanged((event) => {
  sendToParent({
    type: "terminalsChanged",
    cwd: event.cwd,
    terminals: event.terminals,
  });
});

function enqueueCreateTerminalRequest(message: TerminalCreateRequest): Promise<void> {
  const nextRequest = createTerminalQueue.then(() => handleCreateTerminalRequest(message));
  createTerminalQueue = nextRequest.catch(() => {});
  return nextRequest;
}

async function handleCreateTerminalRequest(message: TerminalCreateRequest): Promise<void> {
  const request: InFlightTerminalCreateRequest = {
    requestId: message.requestId,
    errorReported: false,
  };
  inFlightTerminalCreateRequest = request;
  try {
    const session = await manager.createTerminal(message.options);
    if (request.errorReported) {
      session.kill();
      return;
    }
    watchTerminal(session);
    const initialSnapshot = session.getStateSnapshot();
    sendToParent({
      type: "terminalCreated",
      terminal: toTerminalInfo(session),
      state: initialSnapshot.state,
    });
    sendToParent({
      type: "response",
      requestId: message.requestId,
      ok: true,
      result: {
        terminal: toTerminalInfo(session),
        state: initialSnapshot.state,
      },
    });
  } catch (error) {
    reportInFlightTerminalCreateFailure(error);
  } finally {
    if (inFlightTerminalCreateRequest === request) {
      inFlightTerminalCreateRequest = null;
    }
  }
}

async function handleRequest(message: TerminalWorkerRequest): Promise<void> {
  switch (message.type) {
    case "getTerminals": {
      const terminals = await manager.getTerminals(message.cwd);
      sendToParent({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: terminals.map(toTerminalInfo),
      });
      return;
    }

    case "createTerminal": {
      await enqueueCreateTerminalRequest(message);
      return;
    }

    case "registerCwdEnv": {
      manager.registerCwdEnv({ cwd: message.cwd, env: message.env });
      sendToParent({ type: "response", requestId: message.requestId, ok: true });
      return;
    }

    case "setActivity": {
      await manager.setTerminalActivity(message.terminalId, message.state);
      sendToParent({ type: "response", requestId: message.requestId, ok: true });
      return;
    }

    case "killTerminal": {
      const session = manager.getTerminal(message.terminalId);
      const cwd = session?.cwd;
      manager.killTerminal(message.terminalId);
      clearTerminalSubscriptions(message.terminalId);
      if (cwd) {
        sendToParent({
          type: "terminalRemoved",
          terminalId: message.terminalId,
          cwd,
        });
      }
      sendToParent({ type: "response", requestId: message.requestId, ok: true });
      return;
    }

    case "killTerminalAndWait": {
      const session = manager.getTerminal(message.terminalId);
      const cwd = session?.cwd;
      await manager.killTerminalAndWait(message.terminalId, message.options);
      clearTerminalSubscriptions(message.terminalId);
      if (cwd) {
        sendToParent({
          type: "terminalRemoved",
          terminalId: message.terminalId,
          cwd,
        });
      }
      sendToParent({ type: "response", requestId: message.requestId, ok: true });
      return;
    }

    case "getTerminalState": {
      // Flush buffered output before snapshotting: the headless state already includes it,
      // so if the coalescer emitted it afterward (in a batch carrying a revision past the
      // snapshot's) the controller's revision dedup wouldn't drop it and the client would
      // see the bytes twice. Flushing first sends them with a revision <= the snapshot's.
      outputCoalescerByTerminalId.get(message.terminalId)?.flush();
      sendToParent({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: buildTerminalStateResult(manager.getTerminal(message.terminalId), message.options),
      });
      return;
    }

    case "captureTerminal": {
      const session = manager.getTerminal(message.terminalId);
      const result = session
        ? captureTerminalLines(session, {
            start: message.start,
            end: message.end,
            stripAnsi: message.stripAnsi,
          })
        : { lines: [], totalLines: 0 };
      sendToParent({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result,
      });
      return;
    }

    case "killAll": {
      manager.killAll();
      for (const terminalId of Array.from(unsubscribeByTerminalId.keys())) {
        clearTerminalSubscriptions(terminalId);
      }
      sendToParent({ type: "response", requestId: message.requestId, ok: true });
      return;
    }

    case "send": {
      const session = manager.getTerminal(message.terminalId);
      session?.send(message.message);
      sendToParent({ type: "response", requestId: message.requestId, ok: true });
      return;
    }
  }
}

process.on("message", (message: TerminalWorkerRequest) => {
  void handleRequest(message).catch((error: unknown) => {
    sendToParent({
      type: "response",
      requestId: message.requestId,
      ok: false,
      error: terminalWorkerErrorMessage(error),
    });
  });
});

process.once("disconnect", () => {
  ipcClosing = true;
  manager.killAll();
});
