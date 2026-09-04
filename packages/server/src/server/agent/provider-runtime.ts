import type { Logger } from "pino";

import {
  ProviderSnapshotManager,
  type ProviderSnapshotManagerOptions,
} from "./provider-snapshot-manager.js";
import { OpenCodeBridge } from "./providers/opencode/bridge.js";
import type { PaseoToolCatalog } from "./tools/types.js";

export interface AgentProviderRuntime {
  snapshotManager: ProviderSnapshotManager;
  setPaseoToolCatalog(catalog: PaseoToolCatalog | null): void;
  shutdown(): Promise<void>;
}

interface CreateAgentProviderRuntimeOptions {
  paseoHome: string;
  logger: Logger;
  snapshotManager: Omit<ProviderSnapshotManagerOptions, "logger" | "openCodeBridge">;
}

export async function createAgentProviderRuntime(
  options: CreateAgentProviderRuntimeOptions,
): Promise<AgentProviderRuntime> {
  const bridge = new OpenCodeBridge({ paseoHome: options.paseoHome, logger: options.logger });
  try {
    await bridge.start();
    const snapshotManager = new ProviderSnapshotManager({
      ...options.snapshotManager,
      logger: options.logger.child({ module: "provider-snapshot-manager" }),
      openCodeBridge: bridge,
    });
    let shutdownPromise: Promise<void> | null = null;
    return {
      snapshotManager,
      setPaseoToolCatalog: (catalog) => bridge.setManifestCatalog(catalog),
      shutdown: () => {
        shutdownPromise ??= shutdownProviderRuntime(snapshotManager, bridge);
        return shutdownPromise;
      },
    };
  } catch (error) {
    await bridge.close().catch(() => undefined);
    throw error;
  }
}

async function shutdownProviderRuntime(
  snapshotManager: ProviderSnapshotManager,
  bridge: OpenCodeBridge,
): Promise<void> {
  try {
    await snapshotManager.shutdown();
  } finally {
    await bridge.close();
  }
}
