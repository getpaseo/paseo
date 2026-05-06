import { describe, expect, it, vi } from "vitest";
import { detectRunningUnderARM64Translation } from "./arm64-translation";

describe("detectRunningUnderARM64Translation", () => {
  it("returns false outside macOS without probing sysctl", () => {
    const execFileSyncImpl = vi.fn();

    expect(
      detectRunningUnderARM64Translation({
        platform: "linux",
        electronReportedTranslation: true,
        execFileSyncImpl,
      }),
    ).toBe(false);
    expect(execFileSyncImpl).not.toHaveBeenCalled();
  });

  it("trusts Electron when it reports ARM64 translation", () => {
    const execFileSyncImpl = vi.fn();

    expect(
      detectRunningUnderARM64Translation({
        platform: "darwin",
        electronReportedTranslation: true,
        execFileSyncImpl,
      }),
    ).toBe(true);
    expect(execFileSyncImpl).not.toHaveBeenCalled();
  });

  it("falls back to sysctl when Electron does not report translation", () => {
    const execFileSyncImpl = vi.fn(() => "1\n");

    expect(
      detectRunningUnderARM64Translation({
        platform: "darwin",
        electronReportedTranslation: false,
        execFileSyncImpl,
      }),
    ).toBe(true);
    expect(execFileSyncImpl).toHaveBeenCalledWith("sysctl", ["-in", "sysctl.proc_translated"], {
      encoding: "utf-8",
      timeout: 1000,
    });
  });

  it("treats missing sysctl support as not translated", () => {
    const execFileSyncImpl = vi.fn(() => {
      throw new Error("unknown oid");
    });

    expect(
      detectRunningUnderARM64Translation({
        platform: "darwin",
        execFileSyncImpl,
      }),
    ).toBe(false);
  });
});
