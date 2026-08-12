import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";

const PREFERENCES_KEY = "@paseo:create-agent-preferences";
const COMPLETION_KEY_PREFIX = "@paseo:legacy-favorites-to-agent-profiles:v1:";
const CATALOG_LOADING_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000] as const;

const legacyPreferencesSchema = z.object({
  favoriteModels: z
    .array(
      z.object({
        provider: z.string().trim().min(1),
        modelId: z.string().trim().min(1),
      }),
    )
    .optional(),
});

type LegacyFavorite = NonNullable<
  z.infer<typeof legacyPreferencesSchema>["favoriteModels"]
>[number];

export interface LegacyFavoriteMigrationStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface LegacyFavoriteMigrationHost {
  getLastServerInfoMessage(): {
    features?: { agentProfiles?: boolean; agentConfigApply?: boolean };
  } | null;
  getDaemonConfig(): Promise<{ config: { agentProfiles?: AgentProfile[] } }>;
  patchDaemonConfig(patch: {
    agentProfiles: AgentProfile[];
  }): Promise<{ config: { agentProfiles?: AgentProfile[] } }>;
  getProvidersSnapshot(): Promise<{ entries: ProviderSnapshotEntry[] }>;
}

function supportsMigration(host: LegacyFavoriteMigrationHost): boolean {
  const features = host.getLastServerInfoMessage()?.features;
  return features?.agentProfiles === true && features.agentConfigApply === true;
}

function completionKey(serverId: string): string {
  return `${COMPLETION_KEY_PREFIX}${serverId}`;
}

function parseStoredPreferences(raw: string | null): LegacyFavorite[] {
  if (!raw) {
    return [];
  }
  try {
    const result = legacyPreferencesSchema.safeParse(JSON.parse(raw));
    return result.success ? (result.data.favoriteModels ?? []) : [];
  } catch {
    return [];
  }
}

function favoriteKey(favorite: Pick<LegacyFavorite, "provider" | "modelId">): string {
  return `${favorite.provider}\u0000${favorite.modelId}`;
}

function migratedProfileId(favorite: LegacyFavorite): string {
  return `legacy_favorite:${encodeURIComponent(favorite.provider)}:${encodeURIComponent(favorite.modelId)}`;
}

function deduplicateFavorites(favorites: readonly LegacyFavorite[]): LegacyFavorite[] {
  const seen = new Set<string>();
  return favorites.filter((favorite) => {
    const key = favoriteKey(favorite);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findCatalogLabels(
  favorite: LegacyFavorite,
  entries: readonly ProviderSnapshotEntry[],
): { model: string; provider: string } {
  const provider = entries.find((entry) => entry.provider === favorite.provider);
  const model = provider?.models?.find((entry) => entry.id === favorite.modelId);
  return {
    model: model?.label?.trim() || favorite.modelId,
    provider: provider?.label?.trim() || favorite.provider,
  };
}

function uniqueProfileName(input: {
  favorite: LegacyFavorite;
  entries: readonly ProviderSnapshotEntry[];
  usedNames: Set<string>;
}): string {
  const labels = findCatalogLabels(input.favorite, input.entries);
  const candidates = [
    labels.model,
    `${labels.provider} · ${labels.model}`,
    `${labels.provider} · ${labels.model} (${input.favorite.modelId})`,
  ];
  for (const candidate of candidates) {
    if (!input.usedNames.has(candidate)) {
      input.usedNames.add(candidate);
      return candidate;
    }
  }
  let suffix = 2;
  while (input.usedNames.has(`${candidates[2]} ${suffix}`)) {
    suffix += 1;
  }
  const name = `${candidates[2]} ${suffix}`;
  input.usedNames.add(name);
  return name;
}

function buildMigratedProfiles(input: {
  favorites: readonly LegacyFavorite[];
  existing: readonly AgentProfile[];
  entries: readonly ProviderSnapshotEntry[];
}): AgentProfile[] {
  const existingSelections = new Set(
    input.existing.map((profile) =>
      favoriteKey({ provider: profile.provider, modelId: profile.model?.trim() ?? "" }),
    ),
  );
  const existingIds = new Set(input.existing.map((profile) => profile.id));
  const usedNames = new Set(input.existing.map((profile) => profile.name));

  return deduplicateFavorites(input.favorites).flatMap((favorite) => {
    const id = migratedProfileId(favorite);
    if (existingSelections.has(favoriteKey(favorite)) || existingIds.has(id)) {
      return [];
    }
    return [
      {
        id,
        name: uniqueProfileName({ favorite, entries: input.entries, usedNames }),
        provider: favorite.provider,
        model: favorite.modelId,
      },
    ];
  });
}

function catalogIsLoading(
  entries: readonly ProviderSnapshotEntry[],
  favorites: readonly LegacyFavorite[],
): boolean {
  const providers = new Set(favorites.map((favorite) => favorite.provider));
  return entries.some((entry) => providers.has(entry.provider) && entry.status === "loading");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readProviderCatalog(
  host: LegacyFavoriteMigrationHost,
  favorites: readonly LegacyFavorite[],
): Promise<ProviderSnapshotEntry[]> {
  for (const retryDelay of CATALOG_LOADING_RETRY_DELAYS_MS) {
    const entries = (await host.getProvidersSnapshot()).entries;
    if (!catalogIsLoading(entries, favorites)) {
      return entries;
    }
    await delay(retryDelay);
  }
  const entries = (await host.getProvidersSnapshot()).entries;
  if (catalogIsLoading(entries, favorites)) {
    throw new Error("Provider catalog remained loading during legacy favourite migration");
  }
  return entries;
}

/**
 * One-time bridge from device-local model favourites to host-wide profiles.
 * The module owns every migration invariant; callers only announce a connected
 * host and may safely call again after reconnects or React remounts.
 */
export class LegacyFavoriteProfileMigration {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly storage: LegacyFavoriteMigrationStorage) {}

  migrateHost(serverId: string, host: LegacyFavoriteMigrationHost): Promise<void> {
    const active = this.inFlight.get(serverId);
    if (active) {
      return active;
    }
    const migration = this.run(serverId, host).finally(() => {
      if (this.inFlight.get(serverId) === migration) {
        this.inFlight.delete(serverId);
      }
    });
    this.inFlight.set(serverId, migration);
    return migration;
  }

  private async run(serverId: string, host: LegacyFavoriteMigrationHost): Promise<void> {
    if (!supportsMigration(host)) {
      return;
    }
    const markerKey = completionKey(serverId);
    if ((await this.storage.getItem(markerKey)) === "1") {
      return;
    }

    const favorites = parseStoredPreferences(await this.storage.getItem(PREFERENCES_KEY));
    if (favorites.length === 0) {
      await this.storage.setItem(markerKey, "1");
      return;
    }

    const [{ config }, entries] = await Promise.all([
      host.getDaemonConfig(),
      readProviderCatalog(host, favorites),
    ]);
    const existing = config.agentProfiles ?? [];
    const migrated = buildMigratedProfiles({ favorites, existing, entries });
    if (migrated.length > 0) {
      await host.patchDaemonConfig({ agentProfiles: [...existing, ...migrated] });
    }
    await this.storage.setItem(markerKey, "1");
  }
}

export const legacyFavoriteProfileMigration = new LegacyFavoriteProfileMigration(AsyncStorage);
