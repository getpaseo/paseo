import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import type { Logger } from "pino";

import type { AgentProvider, ProviderSnapshotEntry } from "./agent-sdk-types.js";
import type { ProviderDefinition } from "./provider-registry.js";

const DEFAULT_CWD_KEY = "__default__";
const DEFAULT_SNAPSHOT_TTL_MS = 300_000;

type ProviderSnapshotChangeListener = (entries: ProviderSnapshotEntry[], cwd?: string) => void;
type ProviderSnapshotManagerOptions = {
  ttlMs?: number;
  now?: () => number;
};

export class ProviderSnapshotManager {
  private readonly snapshots = new Map<string, Map<AgentProvider, ProviderSnapshotEntry>>();
  private readonly lastCheckedAts = new Map<string, number>();
  private readonly warmUps = new Map<string, Promise<void>>();
  private readonly events = new EventEmitter();
  private destroyed = false;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly providerRegistry: Record<AgentProvider, ProviderDefinition>,
    private readonly logger: Logger,
    options: ProviderSnapshotManagerOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  getSnapshot(cwd?: string): ProviderSnapshotEntry[] {
    const cwdKey = normalizeCwdKey(cwd);
    const entries = this.snapshots.get(cwdKey);
    if (!entries) {
      const loadingEntries = this.resetSnapshotToLoading(cwdKey);
      void this.warmUp(cwd);
      return entriesToArray(loadingEntries);
    }
    if (this.shouldRevalidate(cwdKey)) {
      void this.warmUp(cwd);
    }
    return entriesToArray(entries);
  }

  refresh(cwd?: string): void {
    const cwdKey = normalizeCwdKey(cwd);
    if (this.warmUps.has(cwdKey)) {
      return;
    }
    this.resetSnapshotToLoading(cwdKey);
    this.emitChange(cwdKey);
    void this.warmUp(cwd);
  }

  on(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.off(event, listener);
    return this;
  }

  destroy(): void {
    this.destroyed = true;
    this.events.removeAllListeners();
    this.snapshots.clear();
    this.lastCheckedAts.clear();
    this.warmUps.clear();
  }

  private createLoadingEntries(): Map<AgentProvider, ProviderSnapshotEntry> {
    const entries = new Map<AgentProvider, ProviderSnapshotEntry>();
    for (const provider of this.getProviderIds()) {
      const definition = this.providerRegistry[provider];
      entries.set(provider, {
        provider,
        status: "loading",
        label: definition?.label,
        description: definition?.description,
        defaultModeId: definition?.defaultModeId ?? null,
      });
    }
    return entries;
  }

  private async warmUp(cwd?: string): Promise<void> {
    const cwdKey = normalizeCwdKey(cwd);
    const inFlight = this.warmUps.get(cwdKey);
    if (inFlight) {
      return inFlight;
    }

    const warmUpPromise = Promise.allSettled(
      this.getProviderIds().map((provider) => this.refreshProvider(cwdKey, provider, cwd)),
    ).then(() => {
      this.lastCheckedAts.set(cwdKey, this.now());
    });

    this.warmUps.set(cwdKey, warmUpPromise);

    try {
      await warmUpPromise;
    } finally {
      if (this.warmUps.get(cwdKey) === warmUpPromise) {
        this.warmUps.delete(cwdKey);
      }
    }
  }

  private async refreshProvider(
    cwdKey: string,
    provider: AgentProvider,
    cwd?: string,
  ): Promise<void> {
    const definition = this.providerRegistry[provider];
    if (!definition) {
      return;
    }

    const snapshot = this.getOrCreateSnapshot(cwdKey);

    try {
      const client = definition.createClient(this.logger);
      const available = await client.isAvailable();
      if (!available) {
        snapshot.set(provider, {
          provider,
          status: "unavailable",
          label: definition.label,
          description: definition.description,
          defaultModeId: definition.defaultModeId,
        });
        this.emitChange(cwdKey);
        return;
      }

      const [models, modes] = await Promise.all([
        definition.fetchModels({ cwd }),
        definition.fetchModes({ cwd }),
      ]);

      snapshot.set(provider, {
        provider,
        status: "ready",
        models,
        modes,
        fetchedAt: new Date().toISOString(),
        label: definition.label,
        description: definition.description,
        defaultModeId: definition.defaultModeId,
      });
      this.emitChange(cwdKey);
    } catch (error) {
      snapshot.set(provider, {
        provider,
        status: "error",
        error: toErrorMessage(error),
        label: definition.label,
        description: definition.description,
        defaultModeId: definition.defaultModeId,
      });
      this.logger.warn(
        { err: error, provider, cwd: cwdKey },
        "Failed to refresh provider snapshot",
      );
      this.emitChange(cwdKey);
    }
  }

  private emitChange(cwdKey: string): void {
    if (this.destroyed) {
      return;
    }
    const snapshot = this.snapshots.get(cwdKey);
    if (!snapshot) {
      return;
    }
    this.events.emit("change", entriesToArray(snapshot), denormalizeCwdKey(cwdKey));
  }

  private shouldRevalidate(cwdKey: string): boolean {
    if (this.warmUps.has(cwdKey)) {
      return false;
    }
    const lastCheckedAt = this.lastCheckedAts.get(cwdKey);
    if (lastCheckedAt === undefined) {
      return false;
    }
    return this.now() - lastCheckedAt > this.ttlMs;
  }

  private getOrCreateSnapshot(cwdKey: string): Map<AgentProvider, ProviderSnapshotEntry> {
    const existing = this.snapshots.get(cwdKey);
    if (existing) {
      return existing;
    }

    const created = this.createLoadingEntries();
    this.snapshots.set(cwdKey, created);
    return created;
  }

  private resetSnapshotToLoading(cwdKey: string): Map<AgentProvider, ProviderSnapshotEntry> {
    const snapshot = this.getOrCreateSnapshot(cwdKey);
    snapshot.clear();
    for (const [provider, entry] of this.createLoadingEntries()) {
      snapshot.set(provider, entry);
    }
    return snapshot;
  }

  private getProviderIds(): AgentProvider[] {
    return Object.keys(this.providerRegistry) as AgentProvider[];
  }
}

function normalizeCwdKey(cwd?: string): string {
  if (!cwd) {
    return DEFAULT_CWD_KEY;
  }

  const trimmed = cwd.trim();
  if (!trimmed) {
    return DEFAULT_CWD_KEY;
  }

  return resolve(trimmed);
}

function denormalizeCwdKey(cwdKey: string): string | undefined {
  return cwdKey === DEFAULT_CWD_KEY ? undefined : cwdKey;
}

function entriesToArray(
  entries: Map<AgentProvider, ProviderSnapshotEntry>,
): ProviderSnapshotEntry[] {
  return Array.from(entries.values(), cloneEntry);
}

function cloneEntry(entry: ProviderSnapshotEntry): ProviderSnapshotEntry {
  return {
    ...entry,
    models: entry.models?.map((model) => ({ ...model })),
    modes: entry.modes?.map((mode) => ({ ...mode })),
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return "Unknown error";
}
