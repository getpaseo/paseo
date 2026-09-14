import type { TerminalSession } from "./terminal.js";

interface TerminalSizeRequest {
  rows: number;
  cols: number;
  intent?: "claim" | "update";
}

const terminalSizeOwners = new WeakMap<TerminalSession, WeakRef<object>>();

export function applyTerminalSize(
  terminal: TerminalSession,
  owner: object,
  request: TerminalSizeRequest,
): boolean {
  const intent = resolveTerminalSizeIntent(request.intent);
  if (intent === "update" && terminalSizeOwners.get(terminal)?.deref() !== owner) {
    return false;
  }

  if (intent === "claim") {
    terminalSizeOwners.set(terminal, new WeakRef(owner));
  }

  const currentSize = terminal.getSize();
  if (currentSize.rows !== request.rows || currentSize.cols !== request.cols) {
    terminal.send({ type: "resize", rows: request.rows, cols: request.cols });
  }
  return true;
}

function resolveTerminalSizeIntent(intent: TerminalSizeRequest["intent"]): "claim" | "update" {
  if (intent) {
    return intent;
  }
  // COMPAT(terminalSizeOwnership): added in v0.2.6, remove after 2027-02-02 once the client floor sends resize intent.
  return "claim";
}
