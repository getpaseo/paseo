import { describe, expect, it } from "vitest";
import type { CheckoutPrStatusResponse } from "@getpaseo/protocol/messages";
import { normalizeCheckoutPrStatusPayload } from "./pr-status";

function payload(
  overrides: Partial<CheckoutPrStatusResponse["payload"]> = {},
): CheckoutPrStatusResponse["payload"] {
  return {
    cwd: "/repo",
    status: null,
    githubFeaturesEnabled: true,
    forge: "github",
    error: null,
    requestId: "pr-status-1",
    ...overrides,
  };
}

describe("normalizeCheckoutPrStatusPayload", () => {
  it("preserves known auth states", () => {
    expect(normalizeCheckoutPrStatusPayload(payload({ authState: "cli_missing" })).authState).toBe(
      "cli_missing",
    );
  });

  it("derives auth from the legacy feature flag when authState is absent", () => {
    expect(normalizeCheckoutPrStatusPayload(payload()).authState).toBe("authenticated");
    expect(
      normalizeCheckoutPrStatusPayload(payload({ githubFeaturesEnabled: false })).authState,
    ).toBe("unauthenticated");
  });

  it("does not expose an unknown wire auth state to feature code", () => {
    expect(
      normalizeCheckoutPrStatusPayload(
        payload({ authState: "future_auth_state", githubFeaturesEnabled: false }),
      ).authState,
    ).toBe("unauthenticated");
  });
});
