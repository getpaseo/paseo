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
