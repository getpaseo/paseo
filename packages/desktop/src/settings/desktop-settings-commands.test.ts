import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DESKTOP_SETTINGS,
  createDesktopSettingsStore,
  type DesktopSettingsStore,
} from "./desktop-settings";
import { createDesktopSettingsCommandHandlers } from "./desktop-settings-commands";

function createStoreMock(): DesktopSettingsStore {
  return {
    get: vi.fn(async () => DEFAULT_DESKTOP_SETTINGS),
    patch: vi.fn(async () => ({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
    })),
    migrateLegacyRendererSettings: vi.fn(async () => ({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: true,
      },
    })),
  };
}

describe("desktop-settings-commands", () => {
  const directories = new Set<string>();

  async function createStore(): Promise<DesktopSettingsStore> {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-commands-"));
    directories.add(userDataPath);
    return createDesktopSettingsStore({ userDataPath });
  }

  afterEach(async () => {
    await Promise.all(
      [...directories].map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
    directories.clear();
  });

  it("exposes get and patch handlers through the desktop command bus shape", async () => {
    const store = createStoreMock();
    const handlers = createDesktopSettingsCommandHandlers({ settingsStore: store });

    await expect(handlers.get_desktop_settings()).resolves.toEqual(DEFAULT_DESKTOP_SETTINGS);
    await expect(
      handlers.patch_desktop_settings({
        daemon: { keepRunningAfterQuit: false },
      }),
    ).resolves.toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
    });

    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.patch).toHaveBeenCalledWith({
      daemon: { keepRunningAfterQuit: false },
    });
  });

  it("accepts legacy renderer settings migration payloads", async () => {
    const store = createStoreMock();
    const handlers = createDesktopSettingsCommandHandlers({ settingsStore: store });

    const result = await handlers.migrate_legacy_desktop_settings({
      releaseChannel: "beta",
      manageBuiltInDaemon: false,
    });

    expect(result).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: true,
      },
    });
    expect(store.migrateLegacyRendererSettings).toHaveBeenCalledWith({
      releaseChannel: "beta",
      manageBuiltInDaemon: false,
    });
  });

  it("ignores link scheme approvals in a renderer patch but applies its other fields", async () => {
    const store = await createStore();
    await store.patch({ links: { approvedSchemes: ["obsidian"] } });
    const handlers = createDesktopSettingsCommandHandlers({ settingsStore: store });

    await handlers.patch_desktop_settings({
      releaseChannel: "beta",
      links: { approvedSchemes: ["obsidian", "javascript", "zoommtg"] },
    });
    const settings = await store.get();

    expect(settings.links.approvedSchemes).toEqual(["obsidian"]);
    expect(settings.releaseChannel).toBe("beta");
  });

  it("does not let a renderer patch approve the first scheme", async () => {
    const store = await createStore();
    const handlers = createDesktopSettingsCommandHandlers({ settingsStore: store });

    await handlers.patch_desktop_settings({ links: { approvedSchemes: ["zoommtg"] } });
    const settings = await store.get();

    expect(settings.links.approvedSchemes).toEqual([]);
  });

  it("keeps approvals written straight through the store by the opener dialog", async () => {
    const store = await createStore();

    await store.patch({ links: { approvedSchemes: ["obsidian"] } });
    const settings = await store.get();

    expect(settings.links.approvedSchemes).toEqual(["obsidian"]);
  });

  it("cannot smuggle link scheme approvals through the legacy migration payload", async () => {
    const store = await createStore();
    const handlers = createDesktopSettingsCommandHandlers({ settingsStore: store });

    await handlers.migrate_legacy_desktop_settings({
      releaseChannel: "beta",
      links: { approvedSchemes: ["zoommtg"] },
      approvedSchemes: ["zoommtg"],
    });
    const settings = await store.get();

    expect(settings.links.approvedSchemes).toEqual([]);
    expect(settings.releaseChannel).toBe("beta");
  });
});
