import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { buildModelVisibilityByProvider } from "@/provider-selection/model-visibility";
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
  return useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.modelVisibility === true &&
      // Missing permissions means an older daemon that never reported them, so
      // treat it as unknown rather than as a denial.
      (state.sessions[serverId ?? ""]?.serverInfo?.permissions?.includes("daemon.read") ?? true),
  );
}

/**
 * A config the query already delivered wins over a later fetch failure: that is
 * the acknowledged state for this session, so a dropped refresh does not throw
 * the picker back into an error.
 */
function resolveVisibilityStatus(input: {
  isSupported: boolean;
  hasConfig: boolean;
  isError: boolean;
}): ModelVisibilityStatus {
  if (!input.isSupported) return "unavailable";
  if (input.hasConfig) return "ready";
  if (input.isError) return "error";
  return "loading";
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
      // One model per patch. The daemon merges the map, so sending the whole map
      // would clobber concurrent toggles from another client.
      const patch: MutableDaemonConfigPatch = {
        providers: { [provider]: { modelVisibility: { [modelId]: visible } } },
      };
      const result = await patchConfig(patch);
      if (!result) {
        // `patchConfig` resolves undefined when the host has no client, so
        // awaiting it alone would report a disconnected save as a success.
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
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

/**
 * One Retry, two possible causes. A picker's Retry button is the only recovery
 * affordance the user has, and a visibility-fetch failure looks exactly like a
 * discovery failure from the outside. Retrying discovery alone would succeed and
 * change nothing, leaving the selector stuck.
 */
export function retryModelSelection(input: {
  status: ModelVisibilityStatus;
  retryVisibility: () => void;
  refreshDiscovery: () => void;
}): void {
  if (input.status === "error") {
    input.retryVisibility();
  }
  input.refreshDiscovery();
}
