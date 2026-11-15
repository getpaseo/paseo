import { describe, expect, it } from "vitest";
import { dragStateInitial, dragStateReducer } from "./drag-reducer";

describe("dragStateReducer", () => {
  it("starts tracking the active item with a snapshot of the data", () => {
    const next = dragStateReducer(dragStateInitial<string>(), {
      type: "start",
      id: "alpha",
      data: ["alpha", "beta"],
    });

    expect(next).toEqual({ activeId: "alpha", dragItems: ["alpha", "beta"], replaces: null });
  });

  it("clears the active item and the snapshot", () => {
    const next = dragStateReducer(
      { activeId: "alpha", dragItems: ["alpha", "beta"], replaces: null },
      { type: "clear" },
    );

    expect(next).toEqual({ activeId: null, dragItems: null, replaces: null });
  });

  it("holds the dropped order in place of the data it replaces", () => {
    const next = dragStateReducer(
      { activeId: "alpha", dragItems: ["alpha", "beta"], replaces: null },
      { type: "drop", items: ["beta", "alpha"], replaces: ["alpha", "beta"] },
    );

    expect(next).toEqual({
      activeId: null,
      dragItems: ["beta", "alpha"],
      replaces: ["alpha", "beta"],
    });
  });

  it("replaces an in-flight drag when a new one starts", () => {
    const next = dragStateReducer(
      { activeId: "alpha", dragItems: ["alpha", "beta"], replaces: null },
      { type: "start", id: "beta", data: ["beta", "gamma"] },
    );

    expect(next).toEqual({ activeId: "beta", dragItems: ["beta", "gamma"], replaces: null });
  });
});
