import { describe, expect, it } from "vitest";
import { changesStateSchema, defaultChangesState } from "./state";

describe("Changes pane state", () => {
  it("drops preferences formerly persisted per pane without resetting local document state", () => {
    expect(
      changesStateSchema.parse({
        ...defaultChangesState,
        mode: "base",
        baseRef: "origin/main",
        layout: "split",
        wrapLines: true,
        hideWhitespace: true,
      }),
    ).toEqual(defaultChangesState);
  });
});
