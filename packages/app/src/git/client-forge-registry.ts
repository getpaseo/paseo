import { useCallback, useSyncExternalStore } from "react";
import type {
  PluginForgeClientProviderContribution,
  PluginForgeClientView,
  PluginForgeMergeCapability,
} from "@getpaseo/plugin";
import {
  DEV_FORGE_DEFINITIONS,
  FORGE_DEFINITIONS,
  type ForgeDefinition,
} from "@getpaseo/protocol/forge-manifest";
import type {
  ClientForgeFactsEntry,
  ClientForgeLogicModule,
  ForgeSpecificEnvelope,
  ForgeUrlGrammar,
  MergeCapability,
} from "@/git/client-forge-module";
import { CLIENT_FORGE_LOGIC_MODULES } from "@/git/forges";

export interface InstalledClientForgeProvider {
  pluginId: string;
  contribution: PluginForgeClientProviderContribution;
}

export interface ClientForgeHostSnapshot {
  readonly definitionsById: ReadonlyMap<string, ForgeDefinition>;
  readonly logicById: ReadonlyMap<string, ClientForgeLogicModule>;
  readonly factsByFamily: ReadonlyMap<string, ClientForgeFactsEntry<ForgeSpecificEnvelope>>;
  /** Plugin view data stays declarative. Rendering is owned by forge-icon.tsx. */
  readonly pluginViewsById: ReadonlyMap<string, PluginForgeClientView>;
}

export interface ClientForgeRegistryConflict {
  pluginId: string;
  providerId: string;
  message: string;
}

const BUILTIN_DEFINITIONS = [...FORGE_DEFINITIONS, ...DEV_FORGE_DEFINITIONS];
const BUILTIN_IDS = new Set(BUILTIN_DEFINITIONS.map((definition) => definition.id));

function collectFactsByFamily(
  modules: Iterable<ClientForgeLogicModule>,
): Map<string, ClientForgeFactsEntry<ForgeSpecificEnvelope>> {
  const factsByFamily = new Map<string, ClientForgeFactsEntry<ForgeSpecificEnvelope>>();
  for (const module of modules) {
    if (module.facts) {
      factsByFamily.set(module.facts.family, module.facts);
    }
  }
  return factsByFamily;
}

export const BUILTIN_CLIENT_FORGE_HOST: ClientForgeHostSnapshot = {
  definitionsById: new Map(BUILTIN_DEFINITIONS.map((definition) => [definition.id, definition])),
  logicById: new Map(CLIENT_FORGE_LOGIC_MODULES.map((module) => [module.id, module])),
  factsByFamily: collectFactsByFamily(CLIENT_FORGE_LOGIC_MODULES),
  pluginViewsById: new Map(),
};

function lineAnchor(style: "github" | "gitlab", start: number, end?: number): string {
  if (style === "gitlab") {
    return end && end > start ? `#L${start}-${end}` : `#L${start}`;
  }
  return end && end > start ? `#L${start}-L${end}` : `#L${start}`;
}

function toUrlGrammar(
  contribution: PluginForgeClientProviderContribution,
): ForgeUrlGrammar | undefined {
  const grammar = contribution.urlGrammar;
  if (!grammar) {
    return undefined;
  }
  return {
    treeInfix: grammar.treeInfix,
    blobInfix: grammar.blobInfix,
    lineAnchor: (start, end) => lineAnchor(grammar.lineAnchorStyle, start, end),
    changeRequestChecksSuffix: grammar.changeRequestChecksSuffix,
    referencePaths: grammar.referencePaths?.map(({ kind, infix }) => ({ kind, infix })),
  };
}

function isMergeMethod(value: unknown): value is "merge" | "squash" | "rebase" {
  return value === "merge" || value === "squash" || value === "rebase";
}

/** Validate the output of untrusted client callbacks before core UI consumes it. */
function parseMergeCapability(value: unknown): MergeCapability | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<PluginForgeMergeCapability>;
  if (
    typeof candidate.directMergeReady !== "boolean" ||
    typeof candidate.canEnableAutoMerge !== "boolean" ||
    typeof candidate.autoMergeEnabled !== "boolean" ||
    typeof candidate.canDisableAutoMerge !== "boolean" ||
    typeof candidate.mergeBlockedByQueue !== "boolean" ||
    !Array.isArray(candidate.allowedMethods) ||
    !candidate.allowedMethods.every(isMergeMethod) ||
    !(candidate.preferredMethod === null || isMergeMethod(candidate.preferredMethod))
  ) {
    return null;
  }
  return {
    directMergeReady: candidate.directMergeReady,
    canEnableAutoMerge: candidate.canEnableAutoMerge,
    autoMergeEnabled: candidate.autoMergeEnabled,
    canDisableAutoMerge: candidate.canDisableAutoMerge,
    mergeBlockedByQueue: candidate.mergeBlockedByQueue,
    allowedMethods: [...candidate.allowedMethods],
    preferredMethod: candidate.preferredMethod,
  };
}

function createFactsEntry(
  contribution: PluginForgeClientProviderContribution,
): ClientForgeFactsEntry<ForgeSpecificEnvelope> | undefined {
  const facts = contribution.facts;
  if (!facts) {
    return undefined;
  }
  const parse = (value: unknown): ForgeSpecificEnvelope | null => {
    try {
      const result = facts.schema.safeParse(value);
      return result.success ? (result.data as ForgeSpecificEnvelope) : null;
    } catch (error) {
      console.warn(`[Plugins] Forge facts parser failed for ${facts.family}`, error);
      return null;
    }
  };
  return {
    family: facts.family,
    parse,
    deriveMergeCapability(value: unknown) {
      const parsed = parse(value);
      if (!parsed || !facts.deriveMergeCapability) {
        return null;
      }
      try {
        return parseMergeCapability(facts.deriveMergeCapability(parsed));
      } catch (error) {
        console.warn(`[Plugins] Forge merge capability failed for ${facts.family}`, error);
        return null;
      }
    },
    nativeFallbackChecks: [],
  };
}

function toDefinition(contribution: PluginForgeClientProviderContribution): ForgeDefinition {
  const definition = contribution.definition;
  return {
    ...definition,
    cloudHosts: definition.cloudHosts ? [...definition.cloudHosts] : undefined,
    iconKind: definition.id,
  };
}

function createHostSnapshot(providers: readonly InstalledClientForgeProvider[]): {
  snapshot: ClientForgeHostSnapshot;
  conflicts: ClientForgeRegistryConflict[];
} {
  const definitionsById = new Map(BUILTIN_CLIENT_FORGE_HOST.definitionsById);
  const logicById = new Map(BUILTIN_CLIENT_FORGE_HOST.logicById);
  const factsByFamily = new Map(BUILTIN_CLIENT_FORGE_HOST.factsByFamily);
  const pluginViewsById = new Map<string, PluginForgeClientView>();
  const conflicts: ClientForgeRegistryConflict[] = [];

  for (const { pluginId, contribution } of providers) {
    const providerId = contribution.definition.id;
    if (definitionsById.has(providerId)) {
      conflicts.push({
        pluginId,
        providerId,
        message: BUILTIN_IDS.has(providerId)
          ? `Forge provider ${providerId} conflicts with a built-in provider`
          : `Forge provider ${providerId} is already registered on this host`,
      });
      continue;
    }
    const facts = createFactsEntry(contribution);
    if (facts && factsByFamily.has(facts.family)) {
      conflicts.push({
        pluginId,
        providerId,
        message: `Forge facts family ${facts.family} is already registered on this host`,
      });
      continue;
    }

    definitionsById.set(providerId, toDefinition(contribution));
    logicById.set(providerId, {
      id: providerId,
      urlGrammar: toUrlGrammar(contribution),
      facts,
    });
    if (facts) {
      factsByFamily.set(facts.family, facts);
    }
    if (contribution.view) {
      pluginViewsById.set(providerId, contribution.view);
    }
  }

  return {
    snapshot: { definitionsById, logicById, factsByFamily, pluginViewsById },
    conflicts,
  };
}

export class ClientForgeRegistry {
  private readonly byHost = new Map<string, ClientForgeHostSnapshot>();
  private readonly listenersByHost = new Map<string, Set<() => void>>();

  getHostSnapshot = (serverId: string): ClientForgeHostSnapshot =>
    this.byHost.get(serverId) ?? BUILTIN_CLIENT_FORGE_HOST;

  subscribeHost(serverId: string, listener: () => void): () => void {
    const listeners = this.listenersByHost.get(serverId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listenersByHost.set(serverId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listenersByHost.delete(serverId);
      }
    };
  }

  replaceHost(
    serverId: string,
    providers: readonly InstalledClientForgeProvider[],
  ): ClientForgeRegistryConflict[] {
    const { snapshot, conflicts } = createHostSnapshot(providers);
    if (providers.length === 0) {
      this.byHost.delete(serverId);
    } else {
      this.byHost.set(serverId, snapshot);
    }
    this.publish(serverId);
    return conflicts;
  }

  removeHost(serverId: string): void {
    if (!this.byHost.delete(serverId)) {
      return;
    }
    this.publish(serverId);
  }

  private publish(serverId: string): void {
    for (const listener of this.listenersByHost.get(serverId) ?? []) {
      listener();
    }
  }
}

export const clientForgeRegistry = new ClientForgeRegistry();

export function useClientForgeHost(serverId: string): ClientForgeHostSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => clientForgeRegistry.subscribeHost(serverId, listener),
    [serverId],
  );
  const getSnapshot = useCallback(() => clientForgeRegistry.getHostSnapshot(serverId), [serverId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getClientForgeDefinition(
  host: ClientForgeHostSnapshot,
  id: string,
): ForgeDefinition | null {
  return host.definitionsById.get(id) ?? null;
}

export function getClientForgeLogic(
  host: ClientForgeHostSnapshot,
  id: string,
): ClientForgeLogicModule | null {
  return host.logicById.get(id) ?? null;
}

export function parseHostForgeFacts(
  host: ClientForgeHostSnapshot,
  value: unknown,
): ForgeSpecificEnvelope | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const family = Reflect.get(value, "forge");
  if (typeof family !== "string") {
    return null;
  }
  return host.factsByFamily.get(family)?.parse(value) ?? null;
}

export function deriveHostMergeCapability(
  host: ClientForgeHostSnapshot,
  value: unknown,
): MergeCapability | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const family = Reflect.get(value, "forge");
  if (typeof family !== "string") {
    return null;
  }
  return host.factsByFamily.get(family)?.deriveMergeCapability(value) ?? null;
}
