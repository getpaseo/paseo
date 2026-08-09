import { create } from "zustand";
import type { MobileBrowserProxySession } from "@/native/mobile-browser-proxy";

export type MobileBrowserTunnelStatus = "idle" | "starting" | "ready" | "unsupported" | "error";

interface MobileBrowserTunnelState {
  activeServerId: string | null;
  status: MobileBrowserTunnelStatus;
  session: MobileBrowserProxySession | null;
  error: string | null;
  reloadGeneration: number;
}

const INITIAL_STATE: MobileBrowserTunnelState = {
  activeServerId: null,
  status: "idle",
  session: null,
  error: null,
  reloadGeneration: 0,
};

export const useMobileBrowserTunnelStore = create<MobileBrowserTunnelState>(() => INITIAL_STATE);

interface HostClaim {
  serverId: string;
  sequence: number;
}

const hostClaims = new Map<string, HostClaim>();
let nextClaimSequence = 1;

function refreshActiveServerFromClaims(): void {
  let latest: HostClaim | null = null;
  for (const claim of hostClaims.values()) {
    if (!latest || claim.sequence > latest.sequence) {
      latest = claim;
    }
  }
  const activeServerId = latest?.serverId ?? null;
  useMobileBrowserTunnelStore.setState((state) => {
    if (state.activeServerId === activeServerId) {
      return state;
    }
    return {
      ...state,
      activeServerId,
      status: activeServerId ? "starting" : "idle",
      session: null,
      error: null,
    };
  });
}

export function claimMobileBrowserHost(claimId: string, serverId: string): () => void {
  hostClaims.set(claimId, { serverId, sequence: nextClaimSequence });
  nextClaimSequence += 1;
  refreshActiveServerFromClaims();
  return () => {
    hostClaims.delete(claimId);
    refreshActiveServerFromClaims();
  };
}

export function setMobileBrowserTunnelStarting(serverId: string): void {
  useMobileBrowserTunnelStore.setState((state) =>
    state.activeServerId === serverId
      ? { ...state, status: "starting", session: null, error: null }
      : state,
  );
}

export function setMobileBrowserTunnelReady(
  serverId: string,
  session: MobileBrowserProxySession,
): void {
  useMobileBrowserTunnelStore.setState((state) =>
    state.activeServerId === serverId ? { ...state, status: "ready", session, error: null } : state,
  );
}

export function setMobileBrowserTunnelFailure(
  serverId: string,
  status: Extract<MobileBrowserTunnelStatus, "unsupported" | "error">,
  error: string,
): void {
  useMobileBrowserTunnelStore.setState((state) =>
    state.activeServerId === serverId ? { ...state, status, session: null, error } : state,
  );
}

export function setMobileBrowserTunnelIdle(serverId: string): void {
  useMobileBrowserTunnelStore.setState((state) =>
    state.activeServerId === serverId
      ? { ...state, status: "idle", session: null, error: null }
      : state,
  );
}

export function requestMobileBrowserReload(): void {
  useMobileBrowserTunnelStore.setState((state) => ({
    ...state,
    reloadGeneration: state.reloadGeneration + 1,
  }));
}

export function setMobileBrowserTunnelNotice(serverId: string, message: string | null): void {
  useMobileBrowserTunnelStore.setState((state) =>
    state.activeServerId === serverId && state.status === "ready"
      ? { ...state, error: message }
      : state,
  );
}
