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
  let publishPendingProviderChange: (() => void) | null = null;

  const unsubscribeApply = options.store.onApply((config, previous, details) => {
    if (equal(config.providers, previous.providers)) return () => undefined;

    const previousAgentManagerState =
      options.providerSnapshotManager.getAgentManagerProviderState();
    const staged = options.providerSnapshotManager.stageMutableProviderConfig(config.providers, {
      removeProviders: details.removedProviders,
      replace: true,
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

  return () => {
    unsubscribeApply();
    unsubscribeChange();
  };
}
