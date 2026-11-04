import type { ConnectionLinkImport, PasswordRequiredPairing } from "@/runtime/host-runtime";

/**
 * One visit to the QR scan screen. The camera reports every frame that shows
 * a code, so an attempt that ends (Cancel on the host confirmation, a closed
 * password prompt, or an error) stops scanning until the user taps scan again.
 * Without that, the code still in front of the camera starts a new attempt on
 * the next frame.
 */
export type PairScanState =
  | { status: "scanning" }
  | { status: "pairing" }
  | { status: "passwordRequired"; passwordRequired: PasswordRequiredPairing }
  | { status: "stopped"; error: string | null }
  | { status: "connected" };

export interface PairScanModel {
  getState: () => PairScanState;
  subscribe: (listener: () => void) => () => void;
  /** Data from a QR code the camera saw. Only a scanning session starts an attempt. */
  scan: (data: string) => void;
  /** The user asked to scan again after an attempt ended. */
  scanAgain: () => void;
  /** The user closed the password prompt, which ends the attempt. */
  closePassword: () => void;
  close: () => void;
}

export interface PairScanDependencies {
  importConnectionLink: (link: string) => Promise<ConnectionLinkImport>;
  onConnected: (serverId: string) => void;
}

export function openPairScan(deps: PairScanDependencies): PairScanModel {
  let state: PairScanState = { status: "scanning" };
  let closed = false;
  const listeners = new Set<() => void>();

  function publish(next: PairScanState): void {
    if (closed) return;
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  async function pair(link: string): Promise<void> {
    publish({ status: "pairing" });
    try {
      const outcome = await deps.importConnectionLink(link);
      if (closed) return;
      if (outcome.status === "connected") {
        publish({ status: "connected" });
        deps.onConnected(outcome.serverId);
        return;
      }
      if (outcome.status === "password_required") {
        const { link: passwordLink, pairing } = outcome;
        publish({ status: "passwordRequired", passwordRequired: { link: passwordLink, pairing } });
        return;
      }
      publish({ status: "stopped", error: null });
    } catch (error) {
      publish({ status: "stopped", error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    scan(data) {
      if (state.status !== "scanning") return;
      const link = pairingLinkFromScan(data);
      if (!link) return;
      void pair(link);
    },
    scanAgain() {
      if (state.status !== "stopped") return;
      publish({ status: "scanning" });
    },
    closePassword() {
      if (state.status !== "passwordRequired") return;
      publish({ status: "stopped", error: null });
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}

function pairingLinkFromScan(data: string): string | null {
  const raw = data.trim();
  if (raw.includes("#offer=") || raw.includes("#connect=") || raw.startsWith("relay://")) {
    return raw;
  }
  return null;
}
