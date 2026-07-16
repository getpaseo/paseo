import { describe, expect, it } from "vitest";
import { resolveTimelineSearchScrollTarget } from "./resolve-scroll-target";

describe("resolveTimelineSearchScrollTarget", () => {
  it("resolves a live-head item to the bottom", () => {
    const target = resolveTimelineSearchScrollTarget({
      itemId: "live-1",
      isLiveHeadItem: (id) => id === "live-1",
      findGroupIdForItem: () => null,
    });
    expect(target).toEqual({ kind: "bottom" });
  });

  it("resolves an item inside a collapsed tool-call group to that group's host id", () => {
    const target = resolveTimelineSearchScrollTarget({
      itemId: "call-3",
      isLiveHeadItem: () => false,
      findGroupIdForItem: (id) => (id === "call-3" ? "call-1" : null),
    });
    expect(target).toEqual({ kind: "group", groupId: "call-1" });
  });

  it("resolves a plain item to itself when it is neither live-head nor grouped", () => {
    const target = resolveTimelineSearchScrollTarget({
      itemId: "message-1",
      isLiveHeadItem: () => false,
      findGroupIdForItem: () => null,
    });
    expect(target).toEqual({ kind: "item", itemId: "message-1" });
  });

  it("prefers the group over the live-head check when an item is both", () => {
    // A trailing tool-call group can start in retained history and still
    // contain a newer live-head call: the group must win, or the match is
    // left unreachable (bottom doesn't expand the group).
    const target = resolveTimelineSearchScrollTarget({
      itemId: "live-and-grouped",
      isLiveHeadItem: () => true,
      findGroupIdForItem: () => "some-group",
    });
    expect(target).toEqual({ kind: "group", groupId: "some-group" });
  });
});
