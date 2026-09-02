import { describe, expect, it } from "vitest";
import { parseProjectDropData, resolveProjectDrop } from "./project-drop-resolution";

describe("parseProjectDropData", () => {
  it("parses a project-row payload", () => {
    expect(
      parseProjectDropData({ kind: "project-row", viewKey: "a", groupKey: "g", groupName: "G" }),
    ).toEqual({
      kind: "project-row",
      viewKey: "a",
      groupKey: "g",
      groupName: "G",
    });
  });

  it("parses a project-row payload with null group fields", () => {
    expect(
      parseProjectDropData({ kind: "project-row", viewKey: "a", groupKey: null, groupName: null }),
    ).toEqual({ kind: "project-row", viewKey: "a", groupKey: null, groupName: null });
  });

  it("parses a project-group-header payload", () => {
    expect(
      parseProjectDropData({
        kind: "project-group-header",
        groupKey: "g",
        groupName: "G",
        firstViewKey: "a",
      }),
    ).toEqual({ kind: "project-group-header", groupKey: "g", groupName: "G", firstViewKey: "a" });
  });

  it("parses a project-drop-zone payload", () => {
    expect(parseProjectDropData({ kind: "project-drop-zone", zone: "new-group" })).toEqual({
      kind: "project-drop-zone",
      zone: "new-group",
    });
    expect(parseProjectDropData({ kind: "project-drop-zone", zone: "ungroup" })).toEqual({
      kind: "project-drop-zone",
      zone: "ungroup",
    });
  });

  it("returns null for an unparseable kind", () => {
    expect(parseProjectDropData({ kind: "something-else" })).toBeNull();
  });

  it("returns null for non-object data", () => {
    expect(parseProjectDropData(null)).toBeNull();
    expect(parseProjectDropData(undefined)).toBeNull();
    expect(parseProjectDropData("project-row")).toBeNull();
    expect(parseProjectDropData(42)).toBeNull();
  });

  it("returns null when a required field has the wrong type", () => {
    expect(parseProjectDropData({ kind: "project-row", viewKey: 1 })).toBeNull();
    expect(parseProjectDropData({ kind: "project-row", viewKey: "a", groupKey: 1 })).toBeNull();
    expect(parseProjectDropData({ kind: "project-row", viewKey: "a", groupName: 1 })).toBeNull();
    expect(
      parseProjectDropData({ kind: "project-group-header", groupKey: "g", groupName: "G" }),
    ).toBeNull();
    expect(parseProjectDropData({ kind: "project-drop-zone", zone: "bogus" })).toBeNull();
  });
});

describe("resolveProjectDrop", () => {
  const base = {
    activeViewKey: "active",
    activeGroupKey: null as string | null,
    placement: "before" as const,
  };

  it("returns none when over is null", () => {
    expect(resolveProjectDrop({ ...base, over: null })).toEqual({ kind: "none" });
  });

  it("returns none when over.data is unparseable", () => {
    expect(resolveProjectDrop({ ...base, over: { id: "x", data: { kind: "nope" } } })).toEqual({
      kind: "none",
    });
  });

  it("resolves the new-group drop zone to new_group", () => {
    expect(
      resolveProjectDrop({
        ...base,
        over: { id: "zone", data: { kind: "project-drop-zone", zone: "new-group" } },
      }),
    ).toEqual({ kind: "new_group" });
  });

  it("resolves the ungroup drop zone to ungroup/keep when active is grouped", () => {
    expect(
      resolveProjectDrop({
        ...base,
        activeGroupKey: "g",
        over: { id: "zone", data: { kind: "project-drop-zone", zone: "ungroup" } },
      }),
    ).toEqual({ kind: "ungroup", position: { kind: "keep" } });
  });

  it("resolves the ungroup drop zone to none when active is already ungrouped", () => {
    expect(
      resolveProjectDrop({
        ...base,
        activeGroupKey: null,
        over: { id: "zone", data: { kind: "project-drop-zone", zone: "ungroup" } },
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns none over a header for the active item's own group", () => {
    expect(
      resolveProjectDrop({
        ...base,
        activeGroupKey: "g",
        over: {
          id: "header",
          data: { kind: "project-group-header", groupKey: "g", groupName: "G", firstViewKey: "a" },
        },
      }),
    ).toEqual({ kind: "none" });
  });

  it("resolves a header for a different group to move_to_group before its first item", () => {
    expect(
      resolveProjectDrop({
        ...base,
        activeGroupKey: null,
        over: {
          id: "header",
          data: {
            kind: "project-group-header",
            groupKey: "g2",
            groupName: "Group Two",
            firstViewKey: "first",
          },
        },
      }),
    ).toEqual({
      kind: "move_to_group",
      groupKey: "g2",
      groupName: "Group Two",
      position: { kind: "group_start", firstViewKey: "first" },
    });
  });

  it("returns none when the row is the active item itself", () => {
    expect(
      resolveProjectDrop({
        ...base,
        over: {
          id: "row",
          data: { kind: "project-row", viewKey: "active", groupKey: null, groupName: null },
        },
      }),
    ).toEqual({ kind: "none" });
  });

  it("resolves a row in the same group to reorder_within", () => {
    expect(
      resolveProjectDrop({
        ...base,
        activeGroupKey: "g",
        over: {
          id: "row",
          data: { kind: "project-row", viewKey: "other", groupKey: "g", groupName: "G" },
        },
      }),
    ).toEqual({ kind: "reorder_within", groupKey: "g", overViewKey: "other" });
  });

  it("resolves a row also with no group to reorder_within (not ungroup)", () => {
    // Pins branch order: `groupKey === activeGroupKey` (true when both are
    // null) must be checked before the `groupKey === null` ungroup branch,
    // or an ungrouped-to-ungrouped reorder would wrongly report "ungroup".
    expect(
      resolveProjectDrop({
        ...base,
        activeGroupKey: null,
        over: {
          id: "row",
          data: { kind: "project-row", viewKey: "other", groupKey: null, groupName: null },
        },
      }),
    ).toEqual({ kind: "reorder_within", groupKey: null, overViewKey: "other" });
  });

  it("resolves a row with no group (active grouped) to ungroup relative to the row", () => {
    expect(
      resolveProjectDrop({
        ...base,
        activeGroupKey: "g",
        placement: "after",
        over: {
          id: "row",
          data: { kind: "project-row", viewKey: "other", groupKey: null, groupName: null },
        },
      }),
    ).toEqual({
      kind: "ungroup",
      position: { kind: "relative", anchorViewKey: "other", placement: "after" },
    });
  });

  it("resolves a row in another group to move_to_group relative to the row", () => {
    expect(
      resolveProjectDrop({
        ...base,
        activeGroupKey: "g1",
        placement: "after",
        over: {
          id: "row",
          data: { kind: "project-row", viewKey: "other", groupKey: "g2", groupName: "Group Two" },
        },
      }),
    ).toEqual({
      kind: "move_to_group",
      groupKey: "g2",
      groupName: "Group Two",
      position: { kind: "relative", anchorViewKey: "other", placement: "after" },
    });
  });

  it("falls back to groupKey as groupName when a row in another group has no display name", () => {
    expect(
      resolveProjectDrop({
        ...base,
        activeGroupKey: "g1",
        placement: "before",
        over: {
          id: "row",
          data: { kind: "project-row", viewKey: "other", groupKey: "g2", groupName: null },
        },
      }),
    ).toEqual({
      kind: "move_to_group",
      groupKey: "g2",
      groupName: "g2",
      position: { kind: "relative", anchorViewKey: "other", placement: "before" },
    });
  });
});

describe("group sections", () => {
  it("parses a group section and resolves a row dropped on one to nothing", () => {
    expect(parseProjectDropData({ kind: "project-group", groupKey: "client x" })).toEqual({
      kind: "project-group",
      groupKey: "client x",
    });
    expect(parseProjectDropData({ kind: "project-group" })).toBeNull();
    expect(
      resolveProjectDrop({
        activeViewKey: "a",
        activeGroupKey: null,
        over: {
          id: "project-group-section:client x",
          data: { kind: "project-group", groupKey: "client x" },
        },
        placement: "after",
      }),
    ).toEqual({ kind: "none" });
  });
});
