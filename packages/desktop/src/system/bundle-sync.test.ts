import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => "/Applications/Paseo.app/Contents/Resources/app.asar",
  },
}));

import {
  extractPlistBundleShortVersion,
  inspectDesktopBundleSync,
  isDisplacedMacBundlePath,
  resolveCanonicalMacAppBundlePath,
} from "./bundle-sync";

const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>0.17.4</string>
</dict>
</plist>`;

describe("bundle-sync", () => {
  it("extracts CFBundleShortVersionString from Info.plist XML", () => {
    expect(extractPlistBundleShortVersion(SAMPLE_PLIST)).toBe("0.17.4");
    expect(extractPlistBundleShortVersion("<plist></plist>")).toBeNull();
  });

  it("detects displaced .app.outgoing and .app.incoming bundle paths", () => {
    expect(
      isDisplacedMacBundlePath(
        "/Applications/.Paseo.app.outgoing-12345-1795473800/Contents/MacOS/Paseo",
      ),
    ).toBe(true);
    expect(isDisplacedMacBundlePath("/Applications/Paseo.app/Contents/MacOS/Paseo")).toBe(false);
  });

  it("resolves canonical .app path from displaced bundle paths", () => {
    expect(
      resolveCanonicalMacAppBundlePath({
        execPath: "/Applications/.Paseo.app.outgoing-123-456/Contents/MacOS/Paseo",
        appPath: "/Applications/.Paseo.app.outgoing-123-456/Contents/Resources/app.asar",
      }),
    ).toBe("/Applications/Paseo.app");
  });

  it("returns inactive defaults outside packaged macOS builds", () => {
    expect(
      inspectDesktopBundleSync({
        platform: "linux",
        isPackaged: true,
        execPath: "/opt/Paseo/paseo",
        appPath: "/opt/Paseo/resources/app.asar",
      }),
    ).toEqual({
      displacedBundle: false,
      onDiskAppVersion: null,
      relaunchExecPath: null,
    });

    expect(
      inspectDesktopBundleSync({
        platform: "darwin",
        isPackaged: false,
        execPath: "/Applications/.Paseo.app.outgoing-1/Contents/MacOS/Paseo",
        appPath: "/repo/packages/desktop",
      }),
    ).toEqual({
      displacedBundle: false,
      onDiskAppVersion: null,
      relaunchExecPath: null,
    });
  });

  it("detects displaced .app.outgoing bundle and reads the replacement on-disk version", () => {
    const execPath = "/Applications/.Paseo.app.outgoing-84165-1795473764/Contents/MacOS/Paseo";
    const info = inspectDesktopBundleSync({
      platform: "darwin",
      isPackaged: true,
      execPath,
      appPath: "/Applications/.Paseo.app.outgoing-84165-1795473764/Contents/Resources/app.asar",
      existsSyncImpl: (target) =>
        target === "/Applications/Paseo.app/Contents/Info.plist" ||
        target === "/Applications/Paseo.app/Contents/MacOS/Paseo",
      readFileSyncImpl: (() => SAMPLE_PLIST) as never,
    });

    expect(info).toEqual({
      displacedBundle: true,
      onDiskAppVersion: "0.17.4",
      relaunchExecPath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
    });
  });

  it("detects unlinked executable even when execPath still holds the pre-swap path", () => {
    const execPath = "/Applications/Paseo.app/Contents/MacOS/Paseo";
    const info = inspectDesktopBundleSync({
      platform: "darwin",
      isPackaged: true,
      execPath,
      appPath: "/Applications/Paseo.app/Contents/Resources/app.asar",
      existsSyncImpl: (target) => target === "/Applications/Paseo.app/Contents/Info.plist",
      readFileSyncImpl: (() => SAMPLE_PLIST) as never,
    });

    expect(info).toEqual({
      displacedBundle: true,
      onDiskAppVersion: "0.17.4",
      relaunchExecPath: null,
    });
  });
});
