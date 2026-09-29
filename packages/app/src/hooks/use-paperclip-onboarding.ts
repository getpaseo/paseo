import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";

export interface OnboardingData {
  useCase: "personal" | "team" | "enterprise";
  teamShape: "solo" | "small" | "medium" | "large";
  teamName?: string;
}

export function serializeOnboardingData(data: OnboardingData): string {
  return JSON.stringify(data);
}

export function usePaperclipOnboarding() {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const defaultServerId = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () =>
      hosts.find((host) => isHostRuntimeConnected(runtime.getSnapshot(host.serverId)))?.serverId ??
      null,
    () => null,
  );
  const { config, isLoading: isConfigLoading, patchConfig } = useDaemonConfig(defaultServerId);

  const onboardingConfig = useMemo(() => config?.paperclip, [config?.paperclip]);

  const hasCompletedOnboarding = useMemo(
    () => onboardingConfig?.onboardingCompleted === true,
    [onboardingConfig?.onboardingCompleted],
  );

  const completeOnboarding = useCallback(
    async (data: OnboardingData) => {
      if (defaultServerId === null) {
        throw new Error("Host not connected");
      }
      await patchConfig({
        paperclip: {
          onboardingCompleted: true,
          ...data,
        },
      });
    },
    [defaultServerId, patchConfig],
  );

  return {
    hasCompletedOnboarding,
    completeOnboarding,
    config,
    isLoading: isConfigLoading,
    isConnected: defaultServerId !== null,
  };
}
