import { useSyncExternalStore } from "react";
import { isNative } from "@/constants/platform";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { getOnboardingModel } from "./internal/onboarding-instance";
import { useSetupHostServerId } from "./internal/use-setup-host";

/**
 * True while this launch may still open setup: it has not been decided, and the setup host is
 * connecting, or connected and loading its workspaces. Startup keeps its loading screen up
 * meanwhile, so a new user lands on setup rather than on the empty home first. False on phones,
 * where setup never opens, when there is no setup host, and while the host is unreachable.
 */
export const useIsSetupDecisionPending: () => boolean = isNative
  ? () => false
  : useIsSetupDecisionPendingOnDesktop;

function useIsSetupDecisionPendingOnDesktop(): boolean {
  const model = getOnboardingModel();
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const serverId = useSetupHostServerId();
  const connectionStatus = useHostRuntimeConnectionStatus(serverId ?? "");
  if (state.status !== "deciding" || !serverId) return false;
  return connectionStatus !== "offline" && connectionStatus !== "error";
}
