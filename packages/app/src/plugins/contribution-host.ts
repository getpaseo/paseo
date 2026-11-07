import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";
import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { persist, type StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const PreferencesSchema = z.object({ hosts: z.record(z.string(), z.string()) });
type Preferences = z.infer<typeof PreferencesSchema>;

export function createPluginHostPreferences(storage: StateStorage = AsyncStorage) {
  const store = createStore<Preferences>()(
    persist(() => ({ hosts: {} }), {
      name: "plugin-contribution-hosts",
      storage: createValidatedPersistStorage(storage, PreferencesSchema),
      // A host explicitly picked while storage loads wins over the saved choice.
      merge: (saved, current) => ({
        hosts: { ...PreferencesSchema.parse(saved ?? { hosts: {} }).hosts, ...current.hosts },
      }),
    }),
  );
  // Writes made while storage loads are suppressed; save the merged choice too.
  store.persist.onFinishHydration(({ hosts }) => store.setState({ hosts }));
  return store;
}

const preferredHosts = createPluginHostPreferences();

const getPreferredHosts = () => preferredHosts.getState().hosts;

/** Refresh only the sidebar row whose remembered host changed. */
export function usePreferredPluginContributionHost(contributionId: string): string | null {
  return useSyncExternalStoreWithSelector(
    preferredHosts.subscribe,
    getPreferredHosts,
    getPreferredHosts,
    (hosts) => hosts[contributionId] ?? null,
    Object.is,
  );
}

export function getPreferredPluginContributionHost(contributionId: string): string | null {
  return preferredHosts.getState().hosts[contributionId] ?? null;
}

export function rememberPluginContributionHost(contributionId: string, serverId: string): void {
  if (getPreferredPluginContributionHost(contributionId) === serverId) return;
  preferredHosts.setState((current) => ({
    hosts: { ...current.hosts, [contributionId]: serverId },
  }));
}

/**
 * The host a plugin's screens and sidebar items share: the host last picked on one of its screens
 * or last opened from one of its items.
 */
export function pluginScreensHostKey(pluginId: string): string {
  return `${pluginId}/screens`;
}

// COMPAT(pluginSidebarAliases): added in v0.11.0, remove after 2027-03-29
/** The host an `addSidebarItem` row last opened, which its screen's host switcher also sets. */
export function legacySidebarItemHostKey(pluginId: string, itemId: string): string {
  return `${pluginId}/sidebar/${itemId}`;
}
