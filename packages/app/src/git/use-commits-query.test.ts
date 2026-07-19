import { describe, expect, it } from "vitest";
import { resolveCheckoutCommitsQueryResult, type CheckoutCommitsData } from "./use-commits-query";

const EMPTY_COMMITS: CheckoutCommitsData = { baseRef: "main", commits: [] };

describe("resolveCheckoutCommitsQueryResult", () => {
  it("stays idle while the collapsed section has never loaded", () => {
    expect(
      resolveCheckoutCommitsQueryResult({
        enabled: false,
        capabilityPresent: true,
        canFetch: true,
        data: undefined,
        isPlaceholderData: false,
        error: null,
      }),
    ).toEqual({ status: "idle" });
  });

  it("reports loading instead of an empty result while the first request is pending", () => {
    expect(
      resolveCheckoutCommitsQueryResult({
        enabled: true,
        capabilityPresent: true,
        canFetch: true,
        data: undefined,
        isPlaceholderData: false,
        error: null,
      }),
    ).toEqual({ status: "loading" });
  });

  it("types an empty commit list as loaded data", () => {
    expect(
      resolveCheckoutCommitsQueryResult({
        enabled: true,
        capabilityPresent: true,
        canFetch: true,
        data: EMPTY_COMMITS,
        isPlaceholderData: false,
        error: null,
      }),
    ).toEqual({ status: "loaded", data: EMPTY_COMMITS });
  });

  it("surfaces a cold-load error", () => {
    const error = new Error("git log failed");
    expect(
      resolveCheckoutCommitsQueryResult({
        enabled: true,
        capabilityPresent: true,
        canFetch: true,
        data: undefined,
        isPlaceholderData: false,
        error,
      }),
    ).toEqual({ status: "error", error });
  });

  it("keeps cached data available while collapsed", () => {
    expect(
      resolveCheckoutCommitsQueryResult({
        enabled: false,
        capabilityPresent: true,
        canFetch: true,
        data: EMPTY_COMMITS,
        isPlaceholderData: false,
        error: null,
      }),
    ).toEqual({ status: "loaded", data: EMPTY_COMMITS });
  });

  it("keeps previous-checkout placeholder data in loading state", () => {
    expect(
      resolveCheckoutCommitsQueryResult({
        enabled: true,
        capabilityPresent: true,
        canFetch: true,
        data: EMPTY_COMMITS,
        isPlaceholderData: true,
        error: null,
      }),
    ).toEqual({ status: "loading" });
  });
});
