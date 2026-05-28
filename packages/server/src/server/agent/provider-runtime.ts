import type { Logger } from "pino";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./provider-launch-config.js";
import {
  buildProviderRegistry,
  createClientsFromRegistry,
  type ProviderDefinition,
} from "./provider-registry.js";
import type { AgentProvider } from "./agent-sdk-types.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { ProviderCatalog } from "./provider-catalog.js";

interface ProviderRuntimeOptions {
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  isDev?: boolean;
}

export class ProviderRuntime {
  private registry: Record<AgentProvider, ProviderDefinition>;
  readonly snapshots: ProviderSnapshotManager;
  readonly catalog: ProviderCatalog;

  constructor(
    private readonly logger: Logger,
    options: ProviderRuntimeOptions,
  ) {
    this.registry = buildProviderRegistry(logger, options);
    this.snapshots = new ProviderSnapshotManager(this.registry, logger);
    this.catalog = new ProviderCatalog(this.snapshots, () => this.registry);
  }

  getRegistry(): Record<AgentProvider, ProviderDefinition> {
    return this.registry;
  }

  createClients(logger: Logger) {
    return createClientsFromRegistry(this.registry, logger);
  }

  replace(options: ProviderRuntimeOptions): void {
    this.registry = buildProviderRegistry(this.logger, options);
    this.snapshots.replaceRegistry(this.registry);
  }

  destroy(): void {
    this.snapshots.destroy();
  }
}
