import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { ProviderDefinition } from "./provider-registry.js";
import { ProviderSnapshotManager, resolveSnapshotCwd } from "./provider-snapshot-manager.js";

interface ProviderCatalogListInput {
  cwd?: string | null;
  providers?: AgentProvider[];
  wait?: boolean;
}

interface ProviderCatalogProviderInput {
  cwd?: string | null;
  provider: AgentProvider;
  wait?: boolean;
}

interface ProviderCatalogCreateInput {
  cwd?: string | null;
  provider: AgentProvider;
  requestedMode: string | undefined;
  featureValues: Record<string, unknown> | undefined;
  parent: ManagedAgent | null;
}

export interface ProviderCatalogCreateResult {
  modeId: string | undefined;
  featureValues: Record<string, unknown> | undefined;
}

export class ProviderCatalog {
  constructor(
    private readonly snapshots: ProviderSnapshotManager,
    private readonly getRegistry: () => Record<AgentProvider, ProviderDefinition>,
  ) {}

  listRegisteredProviderIds(): AgentProvider[] {
    return Object.keys(this.getRegistry());
  }

  async listProviders(input: ProviderCatalogListInput = {}): Promise<ProviderSnapshotEntry[]> {
    const cwd = resolveSnapshotCwd(input.cwd);
    if (input.wait) {
      await this.snapshots.warmUpSnapshotForCwd({ cwd, providers: input.providers });
    }
    const providerFilter = input.providers ? new Set(input.providers) : null;
    const entries = this.snapshots.getSnapshot(cwd);
    return providerFilter ? entries.filter((entry) => providerFilter.has(entry.provider)) : entries;
  }

  async getProvider(input: ProviderCatalogProviderInput): Promise<ProviderSnapshotEntry> {
    const entry = (await this.listProviders({ ...input, providers: [input.provider] })).find(
      (candidate) => candidate.provider === input.provider,
    );
    if (!entry) {
      throw new Error(`Provider ${input.provider} is not configured`);
    }
    return entry;
  }

  async listModels(input: ProviderCatalogProviderInput): Promise<AgentModelDefinition[]> {
    const entry = await this.getReadyProvider(input);
    return entry.models ?? [];
  }

  async listModes(input: ProviderCatalogProviderInput): Promise<AgentMode[]> {
    const entry = await this.getReadyProvider(input);
    return entry.modes ?? [];
  }

  async resolveCreate(input: ProviderCatalogCreateInput): Promise<ProviderCatalogCreateResult> {
    const entry = await this.getReadyProvider({
      cwd: input.cwd,
      provider: input.provider,
      wait: true,
    });
    const targetProvider = this.requireProvider(input.provider);
    return targetProvider.createPolicy.resolve({
      provider: input.provider,
      requestedMode: input.requestedMode,
      featureValues: input.featureValues,
      parent: this.resolveParent(input.parent),
      availableModes: entry.modes ?? [],
    });
  }

  private resolveParent(parent: ManagedAgent | null) {
    if (!parent) {
      return null;
    }
    const provider = this.requireProvider(parent.provider);
    return {
      provider: parent.provider,
      modeId: parent.currentModeId,
      isUnattended: provider.createPolicy.isUnattended({
        modeId: parent.currentModeId,
        config: parent.config,
        features: parent.features,
        availableModes: parent.availableModes,
      }),
    };
  }

  private async getReadyProvider(
    input: ProviderCatalogProviderInput,
  ): Promise<ProviderSnapshotEntry> {
    const entry = await this.getProvider(input);
    if (!entry.enabled) {
      throw new Error(`Provider '${entry.provider}' is disabled`);
    }
    if (entry.status === "ready") {
      return entry;
    }
    if (entry.status === "error") {
      throw new Error(entry.error ?? `Failed to load provider '${entry.provider}'`);
    }
    throw new Error(`Provider '${entry.provider}' is not available`);
  }

  private requireProvider(provider: AgentProvider): ProviderDefinition {
    const definition = this.getRegistry()[provider];
    if (!definition) {
      throw new Error(`Provider ${provider} is not configured`);
    }
    return definition;
  }
}
