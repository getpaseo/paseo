import { describe, expect, it } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderUsage } from "./types";
import {
  createProviderVisibilityPatch,
  filterVisibleProviders,
  getHiddenProviderIds,
} from "./visibility";

function usage(providerId: string): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    windows: [],
  };
}

describe("provider usage visibility", () => {
  it("defaults to showing every provider", () => {
    expect(getHiddenProviderIds(null)).toEqual([]);
    expect(filterVisibleProviders([usage("claude"), usage("copilot")], [])).toHaveLength(2);
  });

  it("hides only configured provider ids", () => {
    expect(
      filterVisibleProviders(
        [usage("claude"), usage("copilot"), usage("minimax")],
        ["copilot", "future-provider"],
      ).map((provider) => provider.providerId),
    ).toEqual(["claude", "minimax"]);
  });

  it("emits single-provider deltas instead of full-array snapshots", () => {
    expect(createProviderVisibilityPatch({ providerId: "copilot", visible: false })).toEqual({
      providerUsage: { hideProviders: ["copilot"] },
    });

    expect(createProviderVisibilityPatch({ providerId: "copilot", visible: true })).toEqual({
      providerUsage: { showProviders: ["copilot"] },
    });
  });

  it("deduplicates persisted ids defensively", () => {
    const config = {
      providerUsage: { hiddenProviders: ["copilot", "copilot"] },
    } as MutableDaemonConfig;

    expect(getHiddenProviderIds(config)).toEqual(["copilot"]);
  });
});
