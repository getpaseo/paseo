import { describe, expect, it } from "vitest";
import { findActiveProviderSessionWindow } from "./active-provider";
import type { ProviderUsage, ProviderUsageWindow } from "./types";

function providerUsage(providerId: string, windows: ProviderUsageWindow[]): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    windows,
    balances: [],
    details: [],
  };
}

describe("findActiveProviderSessionWindow", () => {
  it("selects the active provider's session limit instead of its weekly limit", () => {
    const weekly = { id: "weekly", label: "Weekly", usedPct: 18 };
    const session = { id: "session", label: "Session", usedPct: 42 };
    const providers = [
      providerUsage("claude", [weekly, { id: "five_hour", label: "Session", usedPct: 15 }]),
      providerUsage("codex", [weekly, session]),
    ];

    expect(findActiveProviderSessionWindow(providers, "CODEX")).toEqual(session);
    expect(findActiveProviderSessionWindow(providers, "claude")).toMatchObject({
      id: "five_hour",
      usedPct: 15,
    });
    expect(findActiveProviderSessionWindow(providers, "opencode")).toBeNull();
  });
});
