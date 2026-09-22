import { useSessionStore } from "@/stores/session-store";

// COMPAT(responseControl): added in v0.8.0, remove gate after 2027-09-17.
export function useResponseControlSupported(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.responseControl === true,
  );
}
