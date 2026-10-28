import { describe, expect, it } from "vitest";
import { compareCliVersions, isCliUpdateAvailable, parseCliVersion } from "./provider-cli-version";

describe("parseCliVersion", () => {
  it("reads the version from CLI banners", () => {
    expect(parseCliVersion("2.1.311 (Claude Code)")).toBe("2.1.311");
    expect(parseCliVersion("codex-cli 0.164.0\n")).toBe("0.164.0");
    expect(parseCliVersion("opencode 1.19.4-beta.2")).toBe("1.19.4-beta.2");
    expect(parseCliVersion("no version here")).toBeNull();
  });
});

describe("compareCliVersions", () => {
  it("orders numerically rather than lexically", () => {
    expect(compareCliVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareCliVersions("2.1.311", "2.1.311")).toBe(0);
    expect(compareCliVersions("2.2.0", "2.1.999")).toBeGreaterThan(0);
  });

  it("sorts a prerelease before its release", () => {
    expect(compareCliVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
  });
});

describe("isCliUpdateAvailable", () => {
  it("needs both versions and an older install", () => {
    expect(isCliUpdateAvailable("1.0.0", "1.0.1")).toBe(true);
    expect(isCliUpdateAvailable("1.0.1", "1.0.1")).toBe(false);
    expect(isCliUpdateAvailable("1.0.2", "1.0.1")).toBe(false);
    expect(isCliUpdateAvailable(null, "1.0.1")).toBe(false);
    expect(isCliUpdateAvailable("1.0.0", null)).toBe(false);
  });
});
