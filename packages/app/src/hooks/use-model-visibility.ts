import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import {
  buildModelVisibilityByProvider,
  isModelVisibilitySupported,
  resolveVisibilityStatus,
  setModelVisible as saveModelVisible,
} from "@/provider-selection/model-visibility";
import type { ModelVisibilitySelection } from "@/provider-selection/provider-selection";
import { useDaemonConfig } from "./use-daemon-config";

export type ModelVisibilityStatus = ModelVisibilitySelection["status"];

export interface ModelVisibilityState extends ModelVisibilitySelection {
  isSupported: boolean;
  retry: () => void;
  setModelVisible: (provider: string, modelId: string, visible: boolean) => Promise<void>;
}

// COMPAT(modelVisibility): added in v0.7.3, remove gate after 2027-09-07.
export function useModelVisibilitySupported(serverId: string | null): boolean {
  return useSessionStore((state) =>
    isModelVisibilitySupported(state.sessions[serverId ?? ""]?.serverInfo),
  );
}

export function useModelVisibility(serverId: string | null): ModelVisibilityState {
  const { t } = useTranslation();
  const isSupported = useModelVisibilitySupported(serverId);
  const { config, isError, refetch, patchConfig } = useDaemonConfig(serverId);

  const visibilityByProvider = useMemo(
    () => (config ? buildModelVisibilityByProvider(config.providers) : undefined),
    [config],
  );

  const setModelVisible = useCallback(
    async (provider: string, modelId: string, visible: boolean) => {
      await saveModelVisible({
        provider,
        modelId,
        visible,
        patchConfig,
        disconnectedMessage: t("workspace.terminal.hostDisconnected"),
      });
    },
    [patchConfig, t],
  );

  const status = resolveVisibilityStatus({
    isSupported,
    hasConfig: visibilityByProvider !== undefined,
    isError,
  });

  // Memoized because selector producers key `useMemo` on this object; a fresh
  // one each render would rebuild every model list on every render.
  return useMemo(
    () => ({
      status,
      visibilityByProvider: status === "ready" ? visibilityByProvider : undefined,
      isSupported,
      retry: refetch,
      setModelVisible,
    }),
    [status, visibilityByProvider, isSupported, refetch, setModelVisible],
  );
}
