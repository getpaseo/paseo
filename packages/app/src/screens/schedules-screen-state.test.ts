import { describe, expect, it } from "vitest";
import { resolveSchedulesScreenBodyState } from "./schedules-screen-state";

describe("resolveSchedulesScreenBodyState", () => {
  it("routes failed loading state to the retry UI instead of the spinner", () => {
    expect(
      resolveSchedulesScreenBodyState({
        loadState: { status: "loading" },
        showLoadError: true,
      }),
    ).toEqual({ kind: "load-error" });
  });
});

  it("routes loaded empty schedules to the empty state instead of the spinner", () => {
    expect(
      resolveSchedulesScreenBodyState({
        loadState: { status: "loaded", data: [] },
        showLoadError: false,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("keeps connecting/loading on the spinner until a loaded result arrives", () => {
    expect(
      resolveSchedulesScreenBodyState({
        loadState: { status: "connecting" },
        showLoadError: false,
      }),
    ).toEqual({ kind: "loading" });
    expect(
      resolveSchedulesScreenBodyState({
        loadState: { status: "loading" },
        showLoadError: false,
      }),
    ).toEqual({ kind: "loading" });
  });
