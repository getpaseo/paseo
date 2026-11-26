import { describe, expect, it } from "vitest";

import { isNewerVersion, isNextPatchRelease } from "./app-update-version";

describe("isNewerVersion", () => {
  it("orders releases by major, minor, then patch", () => {
    expect(isNewerVersion("0.17.5", "0.17.4")).toBe(true);
    expect(isNewerVersion("0.18.0", "0.17.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.17.10", "0.17.9")).toBe(true);
  });

  it("does not call the same or an older version newer", () => {
    expect(isNewerVersion("0.17.4", "0.17.4")).toBe(false);
    expect(isNewerVersion("0.17.3", "0.17.4")).toBe(false);
    expect(isNewerVersion("0.16.9", "0.17.0")).toBe(false);
  });

  it("orders a release after its own prereleases", () => {
    expect(isNewerVersion("0.17.0", "0.17.0-beta.2")).toBe(true);
    expect(isNewerVersion("0.17.0-beta.2", "0.17.0")).toBe(false);
    expect(isNewerVersion("0.17.0-beta.2", "0.16.4")).toBe(true);
  });

  it("orders prereleases numerically, not as text", () => {
    expect(isNewerVersion("0.17.0-beta.10", "0.17.0-beta.9")).toBe(true);
    expect(isNewerVersion("0.17.0-beta.2", "0.17.0-beta.2")).toBe(false);
    expect(isNewerVersion("0.17.0-beta.1", "0.17.0-alpha.5")).toBe(true);
    expect(isNewerVersion("0.17.0-beta.1.1", "0.17.0-beta.1")).toBe(true);
  });

  it("ignores a leading v and build metadata", () => {
    expect(isNewerVersion("v0.17.5", "0.17.4")).toBe(true);
    expect(isNewerVersion("0.17.5+build.7", "0.17.5")).toBe(false);
  });

  it("never calls a version newer when either side is not a version", () => {
    expect(isNewerVersion("0.17.5", "")).toBe(false);
    expect(isNewerVersion("0.17.5", "latest")).toBe(false);
    expect(isNewerVersion("nightly", "0.17.4")).toBe(false);
    expect(isNewerVersion("0.17", "0.16.0")).toBe(false);
    expect(isNewerVersion("0.17.5.1", "0.17.4")).toBe(false);
  });
});

describe("isNextPatchRelease", () => {
  it("accepts only the patch release that directly follows", () => {
    expect(isNextPatchRelease("0.17.4", "0.17.5")).toBe(true);
    expect(isNextPatchRelease("0.17.9", "0.17.10")).toBe(true);
  });

  it("rejects a skipped release, the same release, and an older release", () => {
    expect(isNextPatchRelease("0.17.4", "0.17.6")).toBe(false);
    expect(isNextPatchRelease("0.17.4", "0.17.4")).toBe(false);
    expect(isNextPatchRelease("0.17.4", "0.17.3")).toBe(false);
  });

  it("rejects a minor or major bump", () => {
    expect(isNextPatchRelease("0.17.4", "0.18.0")).toBe(false);
    expect(isNextPatchRelease("0.17.4", "1.17.5")).toBe(false);
  });

  it("rejects prereleases and anything that is not a version", () => {
    expect(isNextPatchRelease("0.17.4", "0.17.5-beta.1")).toBe(false);
    expect(isNextPatchRelease("0.17.4-beta.1", "0.17.5")).toBe(false);
    expect(isNextPatchRelease("0.17.4", "next")).toBe(false);
    expect(isNextPatchRelease("", "0.17.5")).toBe(false);
  });
});
