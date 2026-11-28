import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";

export const BROWSER_FOCUS_GUARD_EVENT = "paseo:event:browser-focus-guard";
export const BROWSER_FOCUS_GUARD_READY_CHANNEL = "paseo:browser:focus-guard-ready";
const FOCUS_GUARD_READY_TIMEOUT_MS = 2_000;

export type PointerFocusGuardResult =
  | { status: "ready"; release(): void }
  | { status: "composing" }
  | { status: "unavailable" };

export interface FocusGuardHostWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
}

interface FocusGuardIpc {
  on(
    channel: string,
    listener: (event: { sender: { id: number } }, payload: unknown) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (event: { sender: { id: number } }, payload: unknown) => void,
  ): void;
}

export async function guardHostPointerFocus(input: {
  hostContents: FocusGuardHostWebContents;
  browserId: string;
  ipc?: FocusGuardIpc;
  timeoutMs?: number;
}): Promise<PointerFocusGuardResult> {
  const { hostContents, browserId, timeoutMs = FOCUS_GUARD_READY_TIMEOUT_MS } = input;
  const ipc = input.ipc ?? (ipcMain as unknown as FocusGuardIpc);
  if (hostContents.isDestroyed()) {
    return { status: "unavailable" };
  }

  const token = randomUUID();
  const hostId = hostContents.id;

  let resolveOutcome!: (value: "ready" | "composing" | "unavailable") => void;
  const promise = new Promise<"ready" | "composing" | "unavailable">((resolve) => {
    resolveOutcome = resolve;
  });
  let settled = false;
  const finish = (next: "ready" | "composing" | "unavailable"): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    ipc.removeListener(BROWSER_FOCUS_GUARD_READY_CHANNEL, onReady);
    hostContents.removeListener("destroyed", onDestroyed);
    resolveOutcome(next);
  };
  const onReady = (event: { sender: { id: number } }, reply: unknown): void => {
    if (event.sender.id !== hostId || typeof reply !== "object" || reply === null) {
      return;
    }
    const record = reply as Record<string, unknown>;
    if (record.token !== token) {
      return;
    }
    finish(record.composing === true ? "composing" : "ready");
  };
  const onDestroyed = (): void => {
    finish("unavailable");
  };
  const timer = setTimeout(() => finish("unavailable"), timeoutMs);
  ipc.on(BROWSER_FOCUS_GUARD_READY_CHANNEL, onReady);
  hostContents.once("destroyed", onDestroyed);
  hostContents.send(BROWSER_FOCUS_GUARD_EVENT, { browserId, token, active: true });
  const outcome = await promise;

  if (outcome === "composing") {
    return { status: "composing" };
  }

  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    if (!hostContents.isDestroyed()) {
      hostContents.send(BROWSER_FOCUS_GUARD_EVENT, { browserId, token, active: false });
    }
  };

  if (outcome === "unavailable") {
    release();
    return { status: "unavailable" };
  }

  return { status: "ready", release };
}
