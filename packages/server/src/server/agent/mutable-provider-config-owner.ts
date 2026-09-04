import equal from "fast-deep-equal";
import type { ProviderRegistration } from "@getpaseo/plugin/provider";

import type { DaemonConfigStore } from "../daemon-config-store.js";
import type {
  AgentManagerProviderState,
  ProviderSnapshotManager,
} from "./provider-snapshot-manager.js";

export interface PluginProviderRegistrationSource {
  getProviderRegistrations(): readonly ProviderRegistration[];
  subscribeProviderRegistrations(listener: () => void): () => void;
}

export function attachMutableProviderConfigOwner(options: {
  store: DaemonConfigStore;
  providerSnapshotManager: ProviderSnapshotManager;
  updateProviderRegistry: (state: AgentManagerProviderState) => void;
  pluginProviders?: PluginProviderRegistrationSource;
}): () => void {
  let publishPendingProviderChange: (() => void) | null = null;

  const unsubscribeApply = options.store.onApply((config, previous, details) => {
    if (equal(config.providers, previous.providers)) return () => undefined;

    const previousAgentManagerState =
      options.providerSnapshotManager.getAgentManagerProviderState();
    const staged = options.providerSnapshotManager.stageMutableProviderConfig(config.providers, {
      removeProviders: details.removedProviders,
      replace: true,
      providerRegistrations: options.pluginProviders?.getProviderRegistrations(),
    });
    try {
      options.updateProviderRegistry(staged.agentManagerState);
    } catch (error) {
      staged.rollback();
      throw error;
    }
    publishPendingProviderChange = staged.publish;

    return () => {
      publishPendingProviderChange = null;
      staged.rollback();
      options.updateProviderRegistry(previousAgentManagerState);
    };
  });
  const unsubscribeChange = options.store.onChange(() => {
    const publish = publishPendingProviderChange;
    publishPendingProviderChange = null;
    publish?.();
  });
  const unsubscribePluginProviders = options.pluginProviders?.subscribeProviderRegistrations(() => {
    const previousAgentManagerState =
      options.providerSnapshotManager.getAgentManagerProviderState();
    const staged = options.providerSnapshotManager.stageMutableProviderConfig(
      options.store.get().providers,
      {
        replace: true,
        providerRegistrations: options.pluginProviders?.getProviderRegistrations(),
      },
    );
    try {
      options.updateProviderRegistry(staged.agentManagerState);
      staged.publish();
    } catch (error) {
      staged.rollback();
      options.updateProviderRegistry(previousAgentManagerState);
      throw error;
    }
  });

  return () => {
    unsubscribeApply();
    unsubscribeChange();
    unsubscribePluginProviders?.();
  };
}
