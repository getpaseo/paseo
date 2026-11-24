import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  resolveDesktopSyncCalloutDescriptor,
  type ResolveDesktopSyncCalloutInput,
} from "./resolve-desktop-sync-callout";

function buildInput(
  overrides: Partial<ResolveDesktopSyncCalloutInput> = {},
): ResolveDesktopSyncCalloutInput {
  return {
    isDesktopApp: true,
    appVersion: "0.17.3",
    daemonVersion: null,
    displacedBundle: false,
    onDiskAppVersion: null,
    keepRunningAfterQuit: false,
    isRelaunching: false,
    ...overrides,
  };
}

describe("resolveDesktopSyncCalloutDescriptor", () => {
  it("returns null outside desktop or when versions match and bundle is intact", () => {
    expect(
      resolveDesktopSyncCalloutDescriptor(
        buildInput({ isDesktopApp: false, daemonVersion: "0.17.4" }),
      ),
    ).toBeNull();
    expect(
      resolveDesktopSyncCalloutDescriptor(
        buildInput({ daemonVersion: "0.17.3", onDiskAppVersion: "0.17.3" }),
      ),
    ).toBeNull();
    expect(
      resolveDesktopSyncCalloutDescriptor(
        buildInput({ appVersion: "0.17.4", daemonVersion: "0.17.3" }),
      ),
    ).toBeNull();
  });

  it("shows a restart callout when Desktop UI lags behind the local daemon", () => {
    const descriptor = resolveDesktopSyncCalloutDescriptor(
      buildInput({ daemonVersion: "0.17.4", keepRunningAfterQuit: true }),
    );

    expect(descriptor).toEqual({
      id: "desktop-sync",
      dismissalKey: "desktop-sync:0.17.3:0.17.4",
      priority: 250,
      title: "Restart Desktop to sync UI",
      descriptionLines: [
        "Paseo Desktop v0.17.3 is behind local Daemon v0.17.4.",
        "Relaunching Desktop will not interrupt running agents.",
      ],
      actionLabel: "Restart Desktop",
      actionDisabled: false,
      testID: "desktop-sync-callout",
    });
  });

  it("shows a restart callout when on-disk bundle is newer than running Desktop", () => {
    const descriptor = resolveDesktopSyncCalloutDescriptor(
      buildInput({ onDiskAppVersion: "0.17.4" }),
    );

    expect(descriptor?.dismissalKey).toBe("desktop-sync:0.17.3:0.17.4");
    expect(descriptor?.descriptionLines).toEqual([
      "Paseo Desktop v0.17.3 is older than the v0.17.4 app bundle on disk.",
    ]);
  });

  it("shows a restart callout for a displaced bundle even without a version bump", () => {
    const descriptor = resolveDesktopSyncCalloutDescriptor(buildInput({ displacedBundle: true }));

    expect(descriptor?.dismissalKey).toBe("desktop-sync:0.17.3:displaced");
    expect(descriptor?.descriptionLines).toEqual([
      "Paseo Desktop is running from a replaced app bundle.",
    ]);
  });

  it("disables the restart button while relaunching", () => {
    const descriptor = resolveDesktopSyncCalloutDescriptor(
      buildInput({ daemonVersion: "0.17.4", isRelaunching: true }),
    );

    expect(descriptor?.actionLabel).toBe("Restarting...");
    expect(descriptor?.actionDisabled).toBe(true);
  });

  it("supports localized labels", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      const descriptor = resolveDesktopSyncCalloutDescriptor(
        buildInput({ daemonVersion: "0.17.4" }),
      );
      expect(descriptor?.title).toBe("重启 Desktop 以同步界面");
      expect(descriptor?.actionLabel).toBe("重启 Desktop");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
