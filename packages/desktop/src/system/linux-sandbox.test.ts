import { describe, expect, it } from "vitest";
import { configureLinuxSandbox } from "./linux-sandbox";

interface SandboxMetadata {
  mode: number;
  uid: number;
}

function configureWithSandbox(
  sandbox: SandboxMetadata | null,
  platform: NodeJS.Platform = "linux",
) {
  const disabledSwitches: string[] = [];

  configureLinuxSandbox({
    platform,
    resourcesPath: "/opt/Paseo/resources",
    statSandbox: () => {
      if (sandbox === null) {
        throw new Error("chrome-sandbox is unavailable");
      }
      return sandbox;
    },
    disableSandbox: () => disabledSwitches.push("no-sandbox"),
  });

  return disabledSwitches;
}

describe("configureLinuxSandbox", () => {
  it("disables the sandbox when an AppImage mount strips SUID", () => {
    expect(configureWithSandbox({ uid: 1000, mode: 0o755 })).toEqual(["no-sandbox"]);
  });

  it("keeps the sandbox for a root-owned 4755 helper", () => {
    expect(configureWithSandbox({ uid: 0, mode: 0o4755 })).toEqual([]);
  });

  it("disables the sandbox when a SUID helper is not root-owned", () => {
    expect(configureWithSandbox({ uid: 1000, mode: 0o4755 })).toEqual(["no-sandbox"]);
  });

  it("disables the sandbox when the helper cannot be inspected", () => {
    expect(configureWithSandbox(null)).toEqual(["no-sandbox"]);
  });

  it("does not inspect or configure the sandbox outside Linux", () => {
    expect(configureWithSandbox(null, "darwin")).toEqual([]);
  });
});
