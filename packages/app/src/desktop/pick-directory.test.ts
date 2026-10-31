import { describe, expect, it } from "vitest";
import type { DesktopDialogBridge, DesktopDialogOpenOptions } from "./host";
import { pickDirectory } from "./pick-directory";

describe("pickDirectory", () => {
  it("opens a single-directory picker and returns the selection", async () => {
    const recordedOptions: DesktopDialogOpenOptions[] = [];
    const dialog: DesktopDialogBridge = {
      open: async (options) => {
        if (options) {
          recordedOptions.push(options);
        }
        return "/repo/project";
      },
    };

    await expect(pickDirectory({ dialog })).resolves.toBe("/repo/project");
    expect(recordedOptions).toEqual([
      {
        directory: true,
        multiple: false,
        createDirectory: true,
      },
    ]);
  });

  it("opens in the given directory", async () => {
    const recordedOptions: DesktopDialogOpenOptions[] = [];
    const dialog: DesktopDialogBridge = {
      open: async (options) => {
        if (options) {
          recordedOptions.push(options);
        }
        return null;
      },
    };

    await pickDirectory({ defaultPath: "/Users/me/Developer", dialog });

    expect(recordedOptions[0]?.defaultPath).toBe("/Users/me/Developer");
  });

  it("returns null when the picker is cancelled", async () => {
    const dialog: DesktopDialogBridge = {
      open: async () => null,
    };

    await expect(pickDirectory({ dialog })).resolves.toBeNull();
  });
});
