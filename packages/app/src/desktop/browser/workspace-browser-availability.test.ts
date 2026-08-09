import { describe, expect, it } from "vitest";
import { resolveWorkspaceBrowserAvailability } from "./workspace-browser-availability";

describe("resolveWorkspaceBrowserAvailability", () => {
  it("keeps Electron Browser available independently of the Android capability gate", () => {
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: true,
        isAndroid: false,
        hasTcpTunnel: false,
      }),
    ).toBe(true);
  });

  it("requires tcpTunnel on Android", () => {
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: false,
        isAndroid: true,
        hasTcpTunnel: true,
      }),
    ).toBe(true);
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: false,
        isAndroid: true,
        hasTcpTunnel: false,
      }),
    ).toBe(false);
  });

  it("does not expose the Browser on iOS or ordinary web", () => {
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: false,
        isAndroid: false,
        hasTcpTunnel: true,
      }),
    ).toBe(false);
  });
});
