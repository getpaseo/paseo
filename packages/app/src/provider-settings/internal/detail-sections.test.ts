import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderInstallationState } from "@/components/provider-installation-section";
import { readDetailSections } from "./detail-sections";

function entry(overrides: Partial<ProviderSnapshotEntry> = {}): ProviderSnapshotEntry {
  return {
    provider: "opencode",
    label: "OpenCode",
    status: "ready",
    enabled: true,
    modes: [],
    models: [],
    ...overrides,
  };
}

const unsupported: ProviderInstallationState = { status: "unsupported" };
const notInstalled: ProviderInstallationState = {
  status: "ready",
  installation: { inspection: { status: "not_installed" }, canUpdate: false },
};

describe("provider detail sections", () => {
  it("shows models for a provider that runs", () => {
    expect(readDetailSections(entry(), unsupported)).toEqual({ error: null, models: true });
  });

  it("keeps models while the provider is probed again", () => {
    expect(readDetailSections(entry({ status: "loading" }), unsupported).models).toBe(true);
  });

  it("leads with the error and hides models when the provider fails", () => {
    expect(
      readDetailSections(
        entry({ status: "error", error: "opencode exited with code 1" }),
        unsupported,
      ),
    ).toEqual({ error: "opencode exited with code 1", models: false });
  });

  it("says nothing extra when Installation already says Not installed", () => {
    expect(readDetailSections(entry({ status: "unavailable" }), unsupported)).toEqual({
      error: null,
      models: false,
    });
    expect(
      readDetailSections(entry({ status: "error", error: "spawn ENOENT" }), notInstalled),
    ).toEqual({ error: null, models: false });
  });

  it("hides models and the error for a disabled provider", () => {
    expect(
      readDetailSections(entry({ enabled: false, status: "error", error: "boom" }), unsupported),
    ).toEqual({ error: null, models: false });
  });

  it("gives an error with no message an empty one, so the alert still shows", () => {
    expect(readDetailSections(entry({ status: "error" }), unsupported).error).toBe("");
  });
});
