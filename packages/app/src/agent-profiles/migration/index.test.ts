import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { LegacyFavoriteProfileMigration } from ".";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.values.set(key, JSON.stringify(value));
    }
  }

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

class FakeProfileHost {
  readonly patches: AgentProfile[][] = [];
  config: { agentProfiles?: AgentProfile[] };
  shouldFailPatch = false;
  shouldFailCatalog = false;
  catalogLoadingReads = 0;

  constructor(
    profiles: AgentProfile[] = [],
    readonly supported = true,
  ) {
    this.config = { agentProfiles: profiles };
  }

  getLastServerInfoMessage() {
    return {
      features: this.supported
        ? { agentProfiles: true, agentConfigApply: true }
        : { agentProfiles: false, agentConfigApply: false },
    };
  }

  async getDaemonConfig() {
    return { requestId: "config", config: this.config };
  }

  async patchDaemonConfig(patch: { agentProfiles?: AgentProfile[] }) {
    if (this.shouldFailPatch) {
      throw new Error("host write failed");
    }
    const profiles = patch.agentProfiles ?? [];
    this.patches.push(profiles);
    this.config = { ...this.config, agentProfiles: profiles };
    return { requestId: "patch", config: this.config };
  }

  async getProvidersSnapshot() {
    if (this.shouldFailCatalog) {
      throw new Error("catalog unavailable");
    }
    if (this.catalogLoadingReads > 0) {
      this.catalogLoadingReads -= 1;
      return {
        entries: [
          {
            provider: "claude" as const,
            status: "loading" as const,
            enabled: true,
          },
        ],
        generatedAt: new Date(0).toISOString(),
        requestId: "providers-loading",
      };
    }
    return {
      entries: [
        {
          provider: "claude" as const,
          status: "ready" as const,
          enabled: true,
          label: "Claude Code",
          models: [
            { provider: "claude" as const, id: "opus", label: "Opus" },
            { provider: "claude" as const, id: "sonnet", label: "Sonnet" },
          ],
        },
      ],
      generatedAt: new Date(0).toISOString(),
      requestId: "providers",
    };
  }
}

const PREFERENCES_KEY = "@paseo:create-agent-preferences";

function migrationStorage() {
  return new MemoryStorage({
    [PREFERENCES_KEY]: {
      favoriteModels: [
        { provider: "claude", modelId: "opus" },
        { provider: "claude", modelId: "sonnet" },
        { provider: "claude", modelId: "opus" },
      ],
    },
  });
}

describe("legacy favourite profile migration", () => {
  it("appends provider-and-model-only profiles with useful catalog names", async () => {
    const existing: AgentProfile = {
      id: "hand-written",
      name: "My Opus",
      provider: "claude",
      model: "opus",
      modeId: "plan",
    };
    const host = new FakeProfileHost([existing]);
    const migration = new LegacyFavoriteProfileMigration(migrationStorage());

    await migration.migrateHost("host-a", host);

    expect(host.patches).toEqual([
      [
        existing,
        {
          id: "legacy_favorite:claude:sonnet",
          name: "Sonnet",
          provider: "claude",
          model: "sonnet",
        },
      ],
    ]);
  });

  it("runs once per host, even if the imported profiles are later deleted", async () => {
    const storage = migrationStorage();
    const migration = new LegacyFavoriteProfileMigration(storage);
    const firstHost = new FakeProfileHost();

    await migration.migrateHost("host-a", firstHost);
    firstHost.config = { agentProfiles: [] };
    await migration.migrateHost("host-a", firstHost);

    const secondHost = new FakeProfileHost();
    await migration.migrateHost("host-b", secondHost);

    expect(firstHost.patches).toHaveLength(1);
    expect(secondHost.patches).toHaveLength(1);
  });

  it("waits for profile capabilities without consuming the host migration", async () => {
    const storage = migrationStorage();
    const migration = new LegacyFavoriteProfileMigration(storage);
    const oldHost = new FakeProfileHost([], false);

    await migration.migrateHost("host-a", oldHost);

    const upgradedHost = new FakeProfileHost();
    await migration.migrateHost("host-a", upgradedHost);
    expect(oldHost.patches).toHaveLength(0);
    expect(upgradedHost.patches).toHaveLength(1);
  });

  it("retries after a failed host write", async () => {
    const host = new FakeProfileHost();
    const migration = new LegacyFavoriteProfileMigration(migrationStorage());
    host.shouldFailPatch = true;

    await expect(migration.migrateHost("host-a", host)).rejects.toThrow("host write failed");
    host.shouldFailPatch = false;
    await migration.migrateHost("host-a", host);

    expect(host.patches).toHaveLength(1);
  });

  it("retries catalog resolution instead of permanently storing raw ids", async () => {
    const host = new FakeProfileHost();
    const migration = new LegacyFavoriteProfileMigration(migrationStorage());
    host.shouldFailCatalog = true;

    await expect(migration.migrateHost("host-a", host)).rejects.toThrow("catalog unavailable");
    host.shouldFailCatalog = false;
    await migration.migrateHost("host-a", host);

    expect(host.patches[0]?.map((profile) => profile.name)).toEqual(["Opus", "Sonnet"]);
  });

  it("waits for relevant provider models to finish loading", async () => {
    const host = new FakeProfileHost();
    const migration = new LegacyFavoriteProfileMigration(migrationStorage());
    host.catalogLoadingReads = 1;

    await migration.migrateHost("host-a", host);

    expect(host.patches[0]?.map((profile) => profile.name)).toEqual(["Opus", "Sonnet"]);
  });
});
