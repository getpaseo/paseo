import { useCallback, useMemo } from "react";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHosts, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface OnboardingData {
  useCase: "personal" | "team" | "enterprise";
  teamShape: "solo" | "small" | "medium" | "large";
  teamName?: string;
}

export function serializeOnboardingData(data: OnboardingData): string {
  return JSON.stringify(data);
}

export function usePaperclipOnboarding() {
  const defaultServerId = useHosts()[0]?.serverId ?? null;
  const isConnected = useHostRuntimeIsConnected(defaultServerId ?? "");
  const { config, patchConfig } = useDaemonConfig(defaultServerId);

  const onboardingConfig = useMemo(() => config?.paperclip, [config?.paperclip]);

  const hasCompletedOnboarding = useMemo(
    () => onboardingConfig?.onboardingCompleted === true,
    [onboardingConfig?.onboardingCompleted],
  );

  const completeOnboarding = useCallback(
    async (data: OnboardingData) => {
      if (!isConnected) {
        throw new Error("Host not connected");
      }
      await patchConfig({
        paperclip: {
          onboardingCompleted: true,
          ...data,
        },
      });
    },
    [isConnected, patchConfig],
  );

  return {
    hasCompletedOnboarding,
    completeOnboarding,
    isLoading: false,
    isConnected,
  };
}
