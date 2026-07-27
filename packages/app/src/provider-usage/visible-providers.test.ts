import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "./types";
import { enabledProviderIdsFromSnapshot, selectVisibleProviderUsage } from "./visible-providers";

function usage(providerId: string, status: ProviderUsage["status"]): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status,
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: null,
  };
}

describe("selectVisibleProviderUsage", () => {
  it("hides unavailable providers", () => {
    expect(
      selectVisibleProviderUsage({
        providers: [usage("claude", "available"), usage("kimi", "unavailable")],
      }).map((provider) => provider.providerId),
    ).toEqual(["claude"]);
  });

  it("keeps error providers so auth failures stay visible", () => {
    expect(
      selectVisibleProviderUsage({
        providers: [usage("codex", "error")],
      }).map((provider) => provider.providerId),
    ).toEqual(["codex"]);
  });

  it("filters to enabled providers when a snapshot set is provided", () => {
    expect(
      selectVisibleProviderUsage({
        providers: [
          usage("claude", "available"),
          usage("codex", "available"),
          usage("grok", "available"),
        ],
        enabledProviderIds: new Set(["claude", "grok"]),
      }).map((provider) => provider.providerId),
    ).toEqual(["claude", "grok"]);
  });

  it("matches enabled ids case-insensitively", () => {
    expect(
      selectVisibleProviderUsage({
        providers: [usage("Claude", "available")],
        enabledProviderIds: new Set(["claude"]),
      }).map((provider) => provider.providerId),
    ).toEqual(["Claude"]);
  });
});

describe("enabledProviderIdsFromSnapshot", () => {
  it("returns null when snapshot entries are missing", () => {
    expect(enabledProviderIdsFromSnapshot(undefined)).toBeNull();
    expect(enabledProviderIdsFromSnapshot(null)).toBeNull();
  });

  it("collects only enabled provider ids", () => {
    expect(
      enabledProviderIdsFromSnapshot([
        { provider: "claude", enabled: true },
        { provider: "codex", enabled: false },
        { provider: "Grok", enabled: true },
      ]),
    ).toEqual(new Set(["claude", "grok"]));
  });
});
