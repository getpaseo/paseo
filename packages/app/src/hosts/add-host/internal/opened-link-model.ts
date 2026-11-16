import type {
  ConnectionLinkImport,
  HostRuntimeSnapshot,
  LinkPairing,
  PasswordRequiredPairing,
} from "@/runtime/host-runtime";

/**
 * Pairing links the app was opened with. A link saves its host without waiting
 * for the host to admit this client, so a password-protected host is found out
 * only when its first connection is rejected. The model watches that first
 * connection and asks for the password then, instead of leaving the host
 * rejected with nothing to act on.
 */
export type OpenedLinkState =
  | { status: "idle" }
  | { status: "passwordRequired"; passwordRequired: PasswordRequiredPairing };

export interface OpenedLinkModel {
  getState: () => OpenedLinkState;
  subscribe: (listener: () => void) => () => void;
  /** A URL the app was opened with. Anything that is not a pairing link is ignored. */
  open: (url: string | null) => void;
  /** The user closed the password prompt. The host stays saved. */
  closePassword: () => void;
  close: () => void;
}

export interface OpenedLinkDependencies {
  importConnectionLink: (link: string) => Promise<ConnectionLinkImport>;
  beginLinkPairing: () => LinkPairing;
  getSnapshot: (
    serverId: string,
  ) => Pick<HostRuntimeSnapshot, "connectionStatus" | "authFailureReason"> | null;
  subscribeToHost: (serverId: string, listener: () => void) => () => void;
  onImported: (serverId: string) => void;
}

export function openPairingLinks(deps: OpenedLinkDependencies): OpenedLinkModel {
  let state: OpenedLinkState = { status: "idle" };
  let closed = false;
  const listeners = new Set<() => void>();
  const stopWatching = new Set<() => void>();

  function publish(next: OpenedLinkState): void {
    if (closed) return;
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  /** Resolves once the host's first connection is admitted, rejected, or the host is gone. */
  function firstConnectionAsksForPassword(serverId: string): Promise<boolean> {
    return new Promise((resolve) => {
      let unsubscribe: (() => void) | null = null;
      const settle = (asksForPassword: boolean) => {
        if (unsubscribe) {
          unsubscribe();
          stopWatching.delete(unsubscribe);
        }
        resolve(asksForPassword);
      };
      const check = (): boolean => {
        const snapshot = deps.getSnapshot(serverId);
        if (!snapshot) {
          settle(false);
          return true;
        }
        if (snapshot.authFailureReason) {
          settle(true);
          return true;
        }
        if (snapshot.connectionStatus === "idle" || snapshot.connectionStatus === "connecting") {
          return false;
        }
        settle(false);
        return true;
      };
      if (check()) return;
      unsubscribe = deps.subscribeToHost(serverId, check);
      stopWatching.add(unsubscribe);
    });
  }

  async function importLink(link: string): Promise<void> {
    let outcome: ConnectionLinkImport;
    try {
      outcome = await deps.importConnectionLink(link);
    } catch (error) {
      console.warn("[OpenedPairingLinks] Pairing link failed", error);
      return;
    }
    if (closed || outcome.status !== "connected") return;
    deps.onImported(outcome.serverId);
    if (!(await firstConnectionAsksForPassword(outcome.serverId))) return;
    publish({
      status: "passwordRequired",
      passwordRequired: { link, pairing: deps.beginLinkPairing() },
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(url) {
      if (!url || !isPairingLink(url)) return;
      void importLink(url);
    },
    closePassword() {
      if (state.status !== "passwordRequired") return;
      publish({ status: "idle" });
    },
    close() {
      closed = true;
      listeners.clear();
      for (const stop of stopWatching) {
        stop();
      }
      stopWatching.clear();
    },
  };
}

function isPairingLink(url: string): boolean {
  return url.includes("#offer=") || url.includes("#connect=") || url.startsWith("relay://");
}
