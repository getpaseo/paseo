import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { getAcpProviderCatalog } from "@/hooks/use-acp-provider-catalog";
import type { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";

export type ProviderEntry = NonNullable<ReturnType<typeof useProvidersSnapshot>["entries"]>[number];

export interface ProviderConfigActions {
  /** The provider whose Enabled switch is being saved. */
  togglingProviderId: string | null;
  setEnabled: (providerId: string, enabled: boolean) => void;
  /** Config owns the provider, so Remove can delete it. */
  canRemove: (entry: ProviderEntry) => boolean;
  removingProviderId: string | null;
  /** Asks first; resolves true once the provider is gone from config. */
  remove: (providerId: string, providerLabel: string) => Promise<boolean>;
}

/** Writes a provider's Enabled flag and removes config-owned providers. */
export function useProviderConfigActions(serverId: string): ProviderConfigActions {
  const { t } = useTranslation();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const supportsProviderRemoval = useHostFeature(serverId, "providerRemoval");
  const [togglingProviderId, setTogglingProviderId] = useState<string | null>(null);
  const [removingProviderId, setRemovingProviderId] = useState<string | null>(null);
  const removingRef = useRef<string | null>(null);

  const setEnabled = useCallback(
    (providerId: string, enabled: boolean) => {
      setTogglingProviderId(providerId);
      void patchConfig({ providers: { [providerId]: { enabled } } })
        .catch((error: unknown) => {
          Alert.alert(
            t("settings.providers.updateErrorTitle"),
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          setTogglingProviderId((current) => (current === providerId ? null : current));
        });
    },
    [patchConfig, t],
  );

  // Config owns derived providers and the opt-in bundled catalog providers.
  const canRemove = useCallback(
    (entry: ProviderEntry) => {
      const providerConfig = config?.providers?.[entry.provider];
      if (!supportsProviderRemoval || entry.source !== "custom" || !providerConfig) return false;
      return Boolean(
        providerConfig.extends ||
        getAcpProviderCatalog().some(
          (catalogEntry) => catalogEntry.id === entry.provider && catalogEntry.bundledProvider,
        ),
      );
    },
    [config, supportsProviderRemoval],
  );

  const remove = useCallback(
    async (providerId: string, providerLabel: string) => {
      if (removingRef.current) return false;
      removingRef.current = providerId;
      setRemovingProviderId(providerId);
      try {
        const confirmed = await confirmDialog({
          title: t("settings.providers.remove.confirmTitle", { name: providerLabel }),
          message: t("settings.providers.remove.confirmMessage"),
          confirmLabel: t("settings.providers.remove.confirm"),
          destructive: true,
        });
        if (!confirmed) return false;
        await patchConfig({ removeProviders: [providerId] });
        return true;
      } catch (error) {
        Alert.alert(
          t("settings.providers.remove.errorTitle"),
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        if (removingRef.current === providerId) removingRef.current = null;
        setRemovingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig, t],
  );

  return { togglingProviderId, setEnabled, canRemove, removingProviderId, remove };
}
