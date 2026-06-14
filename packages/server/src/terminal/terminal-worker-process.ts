import { createTerminalManager } from "./terminal-manager.js";
import { captureTerminalLines } from "./terminal-capture.js";
import type { TerminalSession } from "./terminal.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerToParentMessage,
  WorkerTerminalInfo,
} from "./terminal-worker-protocol.js";

type TerminalCreateRequest = Extract<TerminalWorkerRequest, { type: "createTerminal" }>;

const manager = createTerminalManager();
const unsubscribeByTerminalId = new Map<string, Array<() => void>>();
let ipcClosing = false;

interface InFlightTerminalCreateRequest {
  requestId: string;
  errorReported: boolean;
}

let inFlightTerminalCreateRequest: InFlightTerminalCreateRequest | null = null;

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

function toTerminalInfo(session: TerminalSession): WorkerTerminalInfo {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    ...(session.getTitle() ? { title: session.getTitle() } : {}),
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
}

function watchTerminal(session: TerminalSession): void {
  clearTerminalSubscriptions(session.id);

  const unsubscribeMessage = session.subscribe((message) => {
    sendToParent({
      type: "terminalMessage",
      terminalId: session.id,
      message,
    });
  });
  const unsubscribeExit = session.onExit((info) => {
    clearTerminalSubscriptions(session.id);
    sendToParent({
      type: "terminalExit",
      terminalId: session.id,
      info,
    });
  });
  const unsubscribeTitle = session.onTitleChange((title) => {
    sendToParent({
      type: "terminalTitleChange",
      terminalId: session.id,
      title,
    });
  });
  const unsubscribeCommandFinished = session.onCommandFinished((info) => {
    sendToParent({
      type: "terminalCommandFinished",
      terminalId: session.id,
      info,
    });
  });

  unsubscribeByTerminalId.set(session.id, [
    unsubscribeMessage,
    unsubscribeExit,
    unsubscribeTitle,
    unsubscribeCommandFinished,
  ]);
}

manager.subscribeTerminalsChanged((event) => {
  sendToParent({
    type: "terminalsChanged",
    cwd: event.cwd,
    terminals: event.terminals,
  });
});

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
      await handleCreateTerminalRequest(message);
      return;
    }

    case "registerCwdEnv": {
      manager.registerCwdEnv({ cwd: message.cwd, env: message.env });
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
      const session = manager.getTerminal(message.terminalId);
      sendToParent({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: session?.getStateSnapshot(message.options) ?? null,
      });
      return;
    }

    case "listDirectories": {
      sendToParent({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: manager.listDirectories(),
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
