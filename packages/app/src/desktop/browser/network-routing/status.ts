import { create } from "zustand";

export type NetworkRoutingStatus = "idle" | "connecting" | "ready" | "permission_denied";
interface HostRoutingStatus {
  status: NetworkRoutingStatus;
  generation: number;
}
interface RoutingStatusState {
  hosts: Record<string, HostRoutingStatus>;
  setStatus(serverId: string, status: NetworkRoutingStatus): void;
}
export const useNetworkRoutingStatus = create<RoutingStatusState>((set) => ({
  hosts: {},
  setStatus: (serverId, status) =>
    set((state) => ({
      hosts: {
        ...state.hosts,
        [serverId]: {
          status,
          generation: (state.hosts[serverId]?.generation ?? 0) + Number(status === "ready"),
        },
      },
    })),
}));
