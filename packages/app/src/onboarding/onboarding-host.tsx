import { useEffect, useSyncExternalStore } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHasHydratedWorkspaces, useProjectRootPaths } from "@/stores/session-store-hooks";
import { getOnboardingModel } from "./internal/onboarding-instance";
import { OnboardingModal } from "./internal/onboarding-modal";
import { useSetupHostServerId } from "./internal/use-setup-host";

/** Mounted once by the app shell. Decides whether setup opens, then owns the modal. */
export function OnboardingHost() {
  // Native phones are set up from a desktop; setup never opens there.
  if (isNative) return null;
  return <OnboardingGate />;
}

function OnboardingGate() {
  const model = getOnboardingModel();
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const serverId = useSetupHostServerId();
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const hasHydratedWorkspaces = useHasHydratedWorkspaces(serverId);
  const projectRootPaths = useProjectRootPaths(serverId);
  const isCompact = useIsCompactFormFactor();
  const hasProjects = projectRootPaths.length > 0;

  // Without demand nothing may ask a fresh host for its workspaces, and the gate would wait forever.
  useDirectoryDemand(state.status === "hidden" ? null : serverId);

  useEffect(() => {
    model.applySetupHost(
      serverId ? { serverId, isConnected, hasHydratedWorkspaces, hasProjects } : null,
      { includePhoneStep: !isCompact },
    );
  }, [model, serverId, isConnected, hasHydratedWorkspaces, hasProjects, isCompact]);

  if (state.status !== "open") return null;
  return <OnboardingModal model={model} state={state} />;
}
