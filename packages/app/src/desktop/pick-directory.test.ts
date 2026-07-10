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

    await expect(pickDirectory(dialog)).resolves.toBe("/repo/project");
    expect(recordedOptions).toEqual([
      {
        directory: true,
        multiple: false,
      },
    ]);
  });

  it("returns null when the picker is cancelled", async () => {
    const dialog: DesktopDialogBridge = {
      open: async () => null,
    };

    await expect(pickDirectory(dialog)).resolves.toBeNull();
  });
});
