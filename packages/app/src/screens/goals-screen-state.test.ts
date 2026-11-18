import { describe, expect, it } from "vitest";
import { resolveGoalsScreenBodyState } from "./goals-screen-state";

describe("resolveGoalsScreenBodyState", () => {
  it("asks for a host update when the host lacks the goals feature", () => {
    expect(
      resolveGoalsScreenBodyState({
        hasHost: true,
        supportsGoals: false,
        loadState: { status: "loading" },
        isError: false,
      }),
    ).toEqual({ kind: "update-host" });
  });

  it("waits while the host has not reported its features", () => {
    expect(
      resolveGoalsScreenBodyState({
        hasHost: true,
        supportsGoals: null,
        loadState: { status: "connecting" },
        isError: false,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("routes a failed first load to the retry UI instead of the spinner", () => {
    expect(
      resolveGoalsScreenBodyState({
        hasHost: true,
        supportsGoals: true,
        loadState: { status: "loading" },
        isError: true,
      }),
    ).toEqual({ kind: "load-error" });
  });

  it("keeps showing loaded goals when a later poll fails", () => {
    expect(
      resolveGoalsScreenBodyState({
        hasHost: true,
        supportsGoals: true,
        loadState: { status: "loaded", data: [] },
        isError: true,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("reports no host when none is configured", () => {
    expect(
      resolveGoalsScreenBodyState({
        hasHost: false,
        supportsGoals: null,
        loadState: { status: "connecting" },
        isError: false,
      }),
    ).toEqual({ kind: "no-host" });
  });
});
