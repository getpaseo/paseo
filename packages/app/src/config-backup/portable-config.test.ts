import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, test, vi } from "vitest";

import {
  createPaseoConfigBackup,
  parsePaseoConfigBackup,
  restorePaseoConfigBackup,
  type PortableConfigDeps,
} from "./portable-config";

class MemoryStorage {
  readonly entries = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) this.entries.set(key, value);
  }

  async getAllKeys() {
    return Array.from(this.entries.keys());
  }

  async multiGet(keys: readonly string[]) {
    return keys.map((key) => [key, this.entries.get(key) ?? null] as const);
  }

  async multiSet(entries: readonly (readonly [string, string])[]) {
    for (const [key, value] of entries) this.entries.set(key, value);
  }
}

const daemonConfig = {
  version: 1 as const,
  exportedAt: "2026-07-26T10:00:00.000Z",
  projects: [
    {
      projectId: "project-old",
      rootPath: "/Users/old/code/client/repo",
      homeRelativePath: "code/client/repo",
      kind: "git" as const,
      displayName: "client/repo",
      customName: "Billing",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      customIcon: { kind: "emoji" as const, emoji: "\u{1F4B2}" },
    },
  ],
};

function deps(storage: MemoryStorage, desktop = false): PortableConfigDeps {
  return {
    storage,
    isDesktop: () => desktop,
    loadDesktopSettings: async () => ({
      releaseChannel: "beta",
      daemon: {
        manageBuiltInDaemon: true,
        keepRunningAfterQuit: false,
      },
    }),
    updateDesktopSettings: vi.fn(),
    now: () => "2026-07-26T12:00:00.000Z",
  };
}

describe("portable Paseo configuration", () => {
  test("exports only allowlisted portable client configuration", async () => {
    const storage = new MemoryStorage({
      "@paseo:app-settings": '{"theme":"dark"}',
      "sidebar-project-workspace-order": '{"state":{"projectOrder":["project-old"]}}',
      "@paseo:changes-ship-default:/Users/old/code/client/repo": "merge",
      "@paseo:daemon-registry": '{"password":"secret"}',
      "@paseo:client-id-v1": "device-id",
      "paseo-drafts": '{"state":{"drafts":[]}}',
    });
    const client = {
      exportPortableConfig: vi.fn(async () => ({
        requestId: "export-1",
        config: daemonConfig,
      })),
    } as unknown as DaemonClient;

    const backup = await createPaseoConfigBackup({
      client,
      sourceHost: { serverId: "server-old", label: "Mac" },
      deps: deps(storage, true),
    });

    expect(backup.client.storage).toEqual({
      "@paseo:app-settings": '{"theme":"dark"}',
      "@paseo:changes-ship-default:/Users/old/code/client/repo": "merge",
      "sidebar-project-workspace-order": '{"state":{"projectOrder":["project-old"]}}',
    });
    expect(backup.desktop).toMatchObject({ releaseChannel: "beta" });
    expect(JSON.stringify(backup)).not.toContain("secret");
    expect(parsePaseoConfigBackup(JSON.stringify(backup))).toEqual(backup);
  });

  test("restores configuration with host, project, and path remapping", async () => {
    const storage = new MemoryStorage();
    const configDeps = deps(storage, true);
    const client = {
      importPortableConfig: vi.fn(async () => ({
        requestId: "import-1",
        added: 1,
        updated: 0,
        skipped: 0,
        projectIdMap: { "project-old": "project-new" },
        rootPathMap: {
          "/Users/old/code/client/repo": "/Users/new/code/client/repo",
        },
        skippedProjects: [],
        iconErrors: [],
      })),
    } as unknown as DaemonClient;
    const backup = parsePaseoConfigBackup(
      JSON.stringify({
        format: "paseo-config-backup",
        version: 1,
        exportedAt: "2026-07-26T12:00:00.000Z",
        sourceHost: { serverId: "server-old", label: "Old Mac" },
        daemon: daemonConfig,
        client: {
          storage: {
            "sidebar-project-workspace-order":
              '{"state":{"projectOrder":["project-old"]},"version":1}',
            "sidebar-view":
              '{"state":{"groupMode":"project","hostFilters":["server-old"]},"version":2}',
            "@paseo:changes-ship-default:/Users/old/code/client/repo": "merge",
            "@paseo:client-id-v1": "must-not-import",
          },
        },
        desktop: {
          releaseChannel: "stable",
          daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
        },
      }),
    );

    await restorePaseoConfigBackup({
      backup,
      client,
      targetServerId: "server-new",
      deps: configDeps,
    });

    expect(JSON.parse(storage.entries.get("sidebar-project-workspace-order") ?? "")).toEqual({
      state: { projectOrder: ["project-new"] },
      version: 1,
    });
    expect(JSON.parse(storage.entries.get("sidebar-view") ?? "")).toEqual({
      state: { groupMode: "project", hostFilters: ["server-new"] },
      version: 2,
    });
    expect(storage.entries.get("@paseo:changes-ship-default:/Users/new/code/client/repo")).toBe(
      "merge",
    );
    expect(storage.entries.has("@paseo:client-id-v1")).toBe(false);
    expect(configDeps.updateDesktopSettings).toHaveBeenCalledOnce();
  });

  test("rejects files that are not Paseo configuration backups", () => {
    expect(() => parsePaseoConfigBackup('{"version":1}')).toThrow();
  });
});
