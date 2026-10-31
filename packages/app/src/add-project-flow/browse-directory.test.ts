import { describe, expect, it } from "vitest";
import type { DesktopDialogBridge, DesktopDialogOpenOptions } from "@/desktop/host";
import type { DesktopSettings, DesktopSettingsPatch } from "@/desktop/settings/desktop-settings";
import { browseForProjectDirectory, resolveBrowseStartDirectory } from "./browse-directory";

function createDialog(selection: string | null): {
  dialog: DesktopDialogBridge;
  opened: DesktopDialogOpenOptions[];
} {
  const opened: DesktopDialogOpenOptions[] = [];
  return {
    opened,
    dialog: {
      open: async (options) => {
        if (options) opened.push(options);
        return selection;
      },
    },
  };
}

function createSettingsRecorder(): {
  updates: DesktopSettingsPatch[];
  updateSettings: (updates: DesktopSettingsPatch) => Promise<void>;
} {
  const updates: DesktopSettingsPatch[] = [];
  return {
    updates,
    updateSettings: async (patch) => {
      updates.push(patch);
    },
  };
}

const NO_DIRECTORIES: DesktopSettings["projects"] = {
  defaultBrowseDirectory: null,
  lastBrowseDirectory: null,
};

describe("resolveBrowseStartDirectory", () => {
  it("prefers the default folder over the last browsed folder", () => {
    expect(
      resolveBrowseStartDirectory({
        defaultBrowseDirectory: "/Users/me/Developer",
        lastBrowseDirectory: "/Users/me/src",
      }),
    ).toBe("/Users/me/Developer");
  });

  it("falls back to the last browsed folder", () => {
    expect(
      resolveBrowseStartDirectory({ defaultBrowseDirectory: null, lastBrowseDirectory: "/tmp" }),
    ).toBe("/tmp");
  });

  it("leaves the start folder to the OS when neither is set", () => {
    expect(resolveBrowseStartDirectory(NO_DIRECTORIES)).toBeNull();
  });
});

describe("browseForProjectDirectory", () => {
  it("opens in the start folder and remembers the parent of the pick", async () => {
    const { dialog, opened } = createDialog("/Users/me/Developer/app");
    const { updates, updateSettings } = createSettingsRecorder();

    const path = await browseForProjectDirectory({
      projects: { defaultBrowseDirectory: null, lastBrowseDirectory: "/Users/me/src" },
      updateSettings,
      dialog,
    });

    expect(path).toBe("/Users/me/Developer/app");
    expect(opened[0]?.defaultPath).toBe("/Users/me/src");
    expect(updates).toEqual([{ projects: { lastBrowseDirectory: "/Users/me/Developer" } }]);
  });

  it("does not rewrite the last folder when it has not changed", async () => {
    const { dialog } = createDialog("/Users/me/Developer/app");
    const { updates, updateSettings } = createSettingsRecorder();

    await browseForProjectDirectory({
      projects: { defaultBrowseDirectory: null, lastBrowseDirectory: "/Users/me/Developer" },
      updateSettings,
      dialog,
    });

    expect(updates).toEqual([]);
  });

  it("remembers nothing when the picker is cancelled", async () => {
    const { dialog } = createDialog(null);
    const { updates, updateSettings } = createSettingsRecorder();

    const path = await browseForProjectDirectory({
      projects: NO_DIRECTORIES,
      updateSettings,
      dialog,
    });

    expect(path).toBeNull();
    expect(updates).toEqual([]);
  });
});
