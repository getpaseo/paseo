import { describe, expect, it } from "vitest";
import { configureLinuxSandbox } from "./linux-sandbox";

interface SandboxMetadata {
  mode: number;
  uid: number;
}

function configureWithSandbox(
  sandbox: SandboxMetadata | Error,
  platform: NodeJS.Platform = "linux",
) {
  const disabledSwitches: string[] = [];
  const inspectionErrors: unknown[] = [];

  configureLinuxSandbox({
    platform,
    resourcesPath: "/opt/Paseo/resources",
    statSandbox: () => {
      if (sandbox instanceof Error) {
        throw sandbox;
      }
      return sandbox;
    },
    disableSandbox: () => disabledSwitches.push("no-sandbox"),
    reportInspectionError: (error) => inspectionErrors.push(error),
  });

  return { disabledSwitches, inspectionErrors };
}

function createFileSystemError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

describe("configureLinuxSandbox", () => {
  it("disables the sandbox when an AppImage mount strips SUID", () => {
    expect(configureWithSandbox({ uid: 1000, mode: 0o755 })).toEqual({
      disabledSwitches: ["no-sandbox"],
      inspectionErrors: [],
    });
  });

  it("keeps the sandbox for a root-owned 4755 helper", () => {
    expect(configureWithSandbox({ uid: 0, mode: 0o4755 })).toEqual({
      disabledSwitches: [],
      inspectionErrors: [],
    });
  });

  it("disables the sandbox when a SUID helper is not root-owned", () => {
    expect(configureWithSandbox({ uid: 1000, mode: 0o4755 })).toEqual({
      disabledSwitches: ["no-sandbox"],
      inspectionErrors: [],
    });
  });

  it("disables the sandbox when the helper is missing", () => {
    expect(configureWithSandbox(createFileSystemError("ENOENT"))).toEqual({
      disabledSwitches: ["no-sandbox"],
      inspectionErrors: [],
    });
  });

  it("keeps the sandbox and reports unexpected inspection failures", () => {
    const permissionError = createFileSystemError("EACCES");

    expect(configureWithSandbox(permissionError)).toEqual({
      disabledSwitches: [],
      inspectionErrors: [permissionError],
    });
  });

  it("does not inspect or configure the sandbox outside Linux", () => {
    expect(configureWithSandbox(createFileSystemError("EACCES"), "darwin")).toEqual({
      disabledSwitches: [],
      inspectionErrors: [],
    });
  });
});
