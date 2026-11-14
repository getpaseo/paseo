import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { useToast } from "@/contexts/toast-api-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  buildAcpProviderConfigPatch,
  getAcpProviderCatalog,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { selectHostFeature, useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";

export type ProviderEntry = NonNullable<ReturnType<typeof useProvidersSnapshot>["entries"]>[number];

export interface ProviderConfigActions {
  /** The provider whose Enabled switch is being saved. */
  togglingProviderId: string | null;
  setEnabled: (providerId: string, enabled: boolean) => void;
  /** Config owns the provider, so Remove can delete it. */
  canRemove: (entry: ProviderEntry) => boolean;
  /**
   * The provider being removed, as it was when the user confirmed. It stays set once the removal
   * succeeds, because whatever shows the provider closes next and keeps showing it until then, and
   * ends when the host lists the provider again, as when the user adds it back.
   */
  removing: ProviderEntry | null;
  /** Asks first; resolves true once the provider is gone from config. */
  remove: (entry: ProviderEntry, providerLabel: string) => Promise<boolean>;
  /** The catalog provider being written to config. */
  addingProviderId: string | null;
  /** Writes a catalog provider to config and probes it; resolves true once it is listed. */
  add: (entry: AcpProviderCatalogItem) => Promise<boolean>;
}

/** Writes a provider's Enabled flag, adds catalog providers and removes config-owned ones. */
export function useProviderConfigActions(serverId: string): ProviderConfigActions {
  const { t } = useTranslation();
  const toast = useToast();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const { entries, refresh } = useProvidersSnapshot(serverId);
  const supportsProviderRemoval = useHostFeature(serverId, "providerRemoval");
  const [togglingProviderId, setTogglingProviderId] = useState<string | null>(null);
  const [removal, setRemoval] = useState<{ entry: ProviderEntry; done: boolean } | null>(null);
  const removingRef = useRef<string | null>(null);
  const [addingProviderId, setAddingProviderId] = useState<string | null>(null);
  const addingRef = useRef<string | null>(null);

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
    async (entry: ProviderEntry, providerLabel: string) => {
      if (removingRef.current) return false;
      removingRef.current = entry.provider;
      try {
        const confirmed = await confirmDialog({
          title: t("settings.providers.remove.confirmTitle", { name: providerLabel }),
          message: t("settings.providers.remove.confirmMessage"),
          confirmLabel: t("settings.providers.remove.confirm"),
          destructive: true,
        });
        if (!confirmed) return false;
        setRemoval({ entry, done: false });
        await patchConfig({ removeProviders: [entry.provider] });
        setRemoval({ entry, done: true });
        return true;
      } catch (error) {
        setRemoval(null);
        Alert.alert(
          t("settings.providers.remove.errorTitle"),
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        removingRef.current = null;
      }
    },
    [patchConfig, t],
  );

  // A sheet outlives each opening, so a finished removal ends here rather than with the sheet.
  if (removal?.done && entries?.some((entry) => entry.provider === removal.entry.provider)) {
    setRemoval(null);
  }

  const add = useCallback(
    async (entry: AcpProviderCatalogItem) => {
      if (addingRef.current) return false;
      addingRef.current = entry.id;
      setAddingProviderId(entry.id);
      try {
        await patchConfig(
          buildAcpProviderConfigPatch(entry, (feature) =>
            selectHostFeature(useSessionStore.getState(), serverId, feature),
          ),
        );
        await refresh([entry.id]);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        if (addingRef.current === entry.id) addingRef.current = null;
        setAddingProviderId((current) => (current === entry.id ? null : current));
      }
    },
    [patchConfig, refresh, serverId, toast],
  );

  return {
    togglingProviderId,
    setEnabled,
    canRemove,
    removing: removal?.entry ?? null,
    remove,
    addingProviderId,
    add,
  };
}
