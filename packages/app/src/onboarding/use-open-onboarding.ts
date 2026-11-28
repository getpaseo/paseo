import { useCallback } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getOnboardingModel } from "./internal/onboarding-instance";
import { useSetupHostServerId } from "./internal/use-setup-host";

/** Reopens setup on its first step. Null when there is no host to set up. */
export function useOpenOnboarding(): (() => void) | null {
  const serverId = useSetupHostServerId();
  const isCompact = useIsCompactFormFactor();
  const open = useCallback(() => {
    if (!serverId) return;
    getOnboardingModel().reopen(serverId, { includePhoneStep: !isCompact });
  }, [isCompact, serverId]);
  return serverId ? open : null;
}
