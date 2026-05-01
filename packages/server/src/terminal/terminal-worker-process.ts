import { createTerminalManager } from "./terminal-manager.js";
import { captureTerminalLines } from "./terminal.js";
import type { TerminalSession } from "./terminal.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerToParentMessage,
  WorkerTerminalInfo,
} from "./terminal-worker-protocol.js";

const manager = createTerminalManager();
const unsubscribeByTerminalId = new Map<string, Array<() => void>>();
const stateFlushTimeoutByTerminalId = new Map<string, ReturnType<typeof setTimeout>>();
let ipcClosing = false;

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

function clearTerminalSubscriptions(terminalId: string): void {
  const stateFlushTimeout = stateFlushTimeoutByTerminalId.get(terminalId);
  if (stateFlushTimeout) {
    clearTimeout(stateFlushTimeout);
    stateFlushTimeoutByTerminalId.delete(terminalId);
  }
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

function flushTerminalState(session: TerminalSession): void {
  const stateFlushTimeout = stateFlushTimeoutByTerminalId.get(session.id);
  if (stateFlushTimeout) {
    clearTimeout(stateFlushTimeout);
    stateFlushTimeoutByTerminalId.delete(session.id);
  }
  sendToParent({
    type: "terminalStateUpdated",
    terminalId: session.id,
    state: session.getState(),
  });
}

function scheduleTerminalStateFlush(session: TerminalSession): void {
  const existingTimeout = stateFlushTimeoutByTerminalId.get(session.id);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }
  stateFlushTimeoutByTerminalId.set(
    session.id,
    setTimeout(() => {
      stateFlushTimeoutByTerminalId.delete(session.id);
      flushTerminalState(session);
    }, 16),
  );
}

function watchTerminal(session: TerminalSession): void {
  clearTerminalSubscriptions(session.id);

  const unsubscribeMessage = session.subscribe((message) => {
    if (message.type === "output") {
      scheduleTerminalStateFlush(session);
    }
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
      const session = await manager.createTerminal(message.options);
      watchTerminal(session);
      sendToParent({
        type: "terminalCreated",
        terminal: toTerminalInfo(session),
        state: session.getState(),
      });
      sendToParent({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: {
          terminal: toTerminalInfo(session),
          state: session.getState(),
        },
      });
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
      if (session && message.message.type === "resize") {
        flushTerminalState(session);
      }
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
      error: error instanceof Error ? error.message : "Terminal worker request failed",
    });
  });
});

process.once("disconnect", () => {
  ipcClosing = true;
  manager.killAll();
});
