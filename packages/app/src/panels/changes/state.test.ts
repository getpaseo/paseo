import { describe, expect, it } from "vitest";
import { changesStateSchema, defaultChangesState } from "./state";

describe("Changes presentation state", () => {
  it("drops the persisted mode without resetting the remaining presentation", () => {
    expect(
      changesStateSchema.parse({
        ...defaultChangesState,
        mode: "base",
        baseRef: "origin/main",
        layout: "split",
        wrapLines: true,
      }),
    ).toEqual({
      ...defaultChangesState,
      layout: "split",
      wrapLines: true,
    });
  });
});
