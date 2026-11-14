import { ZCODE_CAPABILITIES } from "../capabilities.js";
import type { ZCodeSessionSettings } from "./catalog.js";
import type { ZCodeProcess } from "./process.js";
import { isMethodNotFound } from "./rpc.js";
import type {
  ZCodeEvent,
  ZCodeRequestFrame,
  ZCodeTransport,
  ZCodeWorkspaceRef,
} from "./transport.js";

export const LEGACY_POLL_INTERVAL_MS = 200;

/**
 * The capabilities the connection drops when the app-server answers the
 * method behind them with "method not found".
 */
export const CAPABILITY_METHODS: Record<string, string> = {
  "prompt.command": "session/command",
  "session.subsession": "session/subagents",
  "session.can_stop_runtime": "session/read",
};

/**
 * ZCode's model picker value is "providerId/modelId", and the protocol wants
 * the two parts separately (`packages/shared/src/model-selection.ts:34-44` in
 * the ZCode repository). The catalog hands the provider the picker value as
 * the model id, so this is the inverse of what the catalog produced.
 */
function toModelSelection(value: string): { providerId: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`ZCode model id is not a provider and model pair: ${value}`);
  }
  return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

export function createLegacyTransport(process: ZCodeProcess): ZCodeTransport {
  const cursors = new Map<string, number>();
  const listeners = new Set<(event: ZCodeEvent) => void>();
  const requestUnsubscribers = new Set<() => void>();
  const unavailable = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let polling = false;

  /**
   * ZCode's protocol answers a removed method with `-32601`. That is the only
   * failure that may be downgraded: the capability goes away and the rest of
   * the provider keeps working. Any other failure propagates.
   */
  async function call(method: string, params?: unknown): Promise<unknown> {
    try {
      return await process.rpc.call(method, params);
    } catch (error) {
      if (isMethodNotFound(error)) {
        unavailable.add(method);
        return undefined;
      }
      throw error;
    }
  }

  function deliver(sessionId: string, rawEvents: readonly unknown[]): void {
    for (const raw of rawEvents) {
      const event = raw as {
        type?: string;
        sessionId?: string;
        turnId?: string;
        seq?: number;
        payload?: unknown;
      };
      if (!event.type || !event.sessionId || typeof event.seq !== "number") continue;
      cursors.set(sessionId, event.seq);
      const mapped: ZCodeEvent = {
        type: event.type,
        sessionId: event.sessionId,
        turnId: event.turnId,
        seq: event.seq,
        payload: event.payload,
      };
      for (const listener of listeners) listener(mapped);
    }
  }

  async function poll(): Promise<void> {
    // setInterval does not wait for the previous tick. A poll that outlives the
    // interval would read the same cursor twice and deliver every event twice.
    if (polling) return;
    polling = true;
    try {
      for (const [sessionId, cursor] of cursors) {
        try {
          const result = (await call("session/events", {
            sessionId,
            afterSeq: cursor,
          })) as { events?: unknown[] };
          deliver(sessionId, result?.events ?? []);
        } catch {
          // A failed poll is retried on the next tick; the session's own
          // error path reports the failure if the process is gone.
        }
      }
    } finally {
      polling = false;
    }
  }

  function startPolling(): void {
    if (timer || stopped) return;
    timer = setInterval(() => {
      void poll();
    }, LEGACY_POLL_INTERVAL_MS);
    timer.unref?.();
  }

  return {
    capabilities: ZCODE_CAPABILITIES,
    unavailableMethods: unavailable,
    async createSession(input) {
      const result = (await call("session/create", {
        workspace: {
          workspacePath: input.workspace.workspacePath,
          workspaceKey: input.workspace.workspaceKey,
        },
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.model ? { model: toModelSelection(input.model) } : {}),
        ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
      })) as { sessionId?: string };
      if (!result?.sessionId) throw new Error("ZCode did not return a session id");
      cursors.set(result.sessionId, 0);
      startPolling();
      return { sessionId: result.sessionId, workspace: input.workspace };
    },
    async resumeSession(input) {
      const workspace: ZCodeWorkspaceRef = input.workspace ?? {
        workspacePath: input.sessionId,
        workspaceKey: input.sessionId,
      };
      await call("session/resume", {
        sessionId: input.sessionId,
        workspace,
      });
      cursors.set(input.sessionId, 0);
      startPolling();
      return { sessionId: input.sessionId, workspace };
    },
    async send(input) {
      await call("session/send", {
        sessionId: input.sessionId,
        content: input.content,
        inputId: input.inputId,
      });
    },
    async stop(input) {
      await call("session/stop", { sessionId: input.sessionId });
    },
    async archive(input) {
      await call("session/close", { sessionId: input.sessionId });
    },
    async readSnapshot(input) {
      // The legacy snapshot carries the session's settings. The flat
      // configOptions array is the v4 workspace-config projection of those
      // same settings, and this path never sends it.
      const snapshot = (await call("session/read", {
        sessionId: input.sessionId,
      })) as { settings?: ZCodeSessionSettings };
      return { settings: snapshot?.settings };
    },
    async listSessions(input) {
      const result = (await call("session/list", {
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      })) as { sessions?: unknown[] };
      return result?.sessions ?? [];
    },
    async setModel(input) {
      await call("session/setModel", {
        sessionId: input.sessionId,
        model: toModelSelection(input.model),
      });
    },
    async setMode(input) {
      await call("session/setMode", {
        sessionId: input.sessionId,
        mode: input.mode,
      });
    },
    async setThoughtLevel(input) {
      await call("session/setThoughtLevel", {
        sessionId: input.sessionId,
        thoughtLevel: input.thoughtLevel,
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRequest(listener: (request: ZCodeRequestFrame) => Promise<unknown> | unknown) {
      const unsubscribe = process.rpc.onRequest(listener);
      requestUnsubscribers.add(unsubscribe);
      return () => {
        requestUnsubscribers.delete(unsubscribe);
        unsubscribe();
      };
    },
    async close() {
      stopped = true;
      if (timer) clearInterval(timer);
      for (const unsubscribe of requestUnsubscribers) unsubscribe();
      requestUnsubscribers.clear();
      cursors.clear();
      listeners.clear();
    },
  };
}
