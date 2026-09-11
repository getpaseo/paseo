import {
  selectIsPreventingSleep,
  selectIsSleepPreventionSupported,
  selectSleepPreventionAgentCount,
} from "@/hooks/sleep-prevention-selectors";
import { useSessionStore } from "@/stores/session-store";

export function useIsPreventingSleep(): boolean {
  return useSessionStore((state) => selectIsPreventingSleep(state.sessions));
}

export function useSleepPreventionAgentCount(): number {
  return useSessionStore((state) => selectSleepPreventionAgentCount(state.sessions));
}

export function useSleepPreventionSupported(serverId: string): boolean {
  return useSessionStore((state) => selectIsSleepPreventionSupported(state.sessions[serverId]));
}

// COMPAT(sleepPrevention): added in v0.8.0, remove gate after 2027-09-11.
export function useSupportsSleepPreventionProtocol(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.sleepPrevention === true,
  );
}
