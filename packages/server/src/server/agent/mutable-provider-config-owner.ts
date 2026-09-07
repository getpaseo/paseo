import equal from "fast-deep-equal";

import type { DaemonConfigStore } from "../daemon-config-store.js";
import type {
  AgentManagerProviderState,
  ProviderSnapshotManager,
} from "./provider-snapshot-manager.js";

export function attachMutableProviderConfigOwner(options: {
  store: DaemonConfigStore;
  providerSnapshotManager: ProviderSnapshotManager;
  updateProviderRegistry: (state: AgentManagerProviderState) => void;
}): () => void {
  let commitPendingProviderChange: (() => void) | null = null;

  const unsubscribeApply = options.store.onApply((config, previous, details) => {
    if (equal(config.providers, previous.providers)) return () => undefined;

    const previousAgentManagerState =
      options.providerSnapshotManager.getAgentManagerProviderState();
    const prepared = options.providerSnapshotManager.prepareMutableProviderConfig(
      config.providers,
      {
        removeProviders: details.removedProviders,
        replace: true,
      },
    );
    try {
      options.updateProviderRegistry(prepared.agentManagerState);
    } catch (error) {
      options.updateProviderRegistry(previousAgentManagerState);
      throw error;
    }
    commitPendingProviderChange = prepared.commit;

    return () => {
      commitPendingProviderChange = null;
      options.updateProviderRegistry(previousAgentManagerState);
    };
  });
  const unsubscribeChange = options.store.onChange(() => {
    const commit = commitPendingProviderChange;
    commitPendingProviderChange = null;
    commit?.();
  });

  return () => {
    unsubscribeApply();
    unsubscribeChange();
  };
}
