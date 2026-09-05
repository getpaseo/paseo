/**
 * Pure resolution of a sidebar project-row drag/drop interaction.
 *
 * `groupKey` is the merge key: two rows belong to the same group only when
 * their `groupKey`s are `===` equal (or both `null` for "ungrouped").
 * `groupName` is only the display casing shown in the UI — it is never
 * compared for equality and never decides where a drop lands.
 */

export interface ProjectDragData {
  kind: "project-row";
  viewKey: string;
  groupKey: string | null;
  groupName: string | null;
}

export type ProjectDropData =
  | ProjectDragData
  | { kind: "project-group-header"; groupKey: string; groupName: string; firstViewKey: string }
  | { kind: "project-drop-zone"; zone: "new-group" | "ungroup" }
  // A whole group section, the target of a group drag. A row never lands on one.
  | { kind: "project-group"; groupKey: string };

export type ProjectOrderPosition =
  | { kind: "relative"; anchorViewKey: string; placement: "before" | "after" }
  // Ahead of the group's first row, and ahead of any row still on its way into the group; the
  // caller knows about those, the resolver does not.
  | { kind: "group_start"; firstViewKey: string }
  | { kind: "keep" };

export type ProjectDropResolution =
  | { kind: "none" }
  | { kind: "reorder_within"; groupKey: string | null; overViewKey: string }
  | { kind: "move_to_group"; groupKey: string; groupName: string; position: ProjectOrderPosition }
  | { kind: "ungroup"; position: ProjectOrderPosition }
  | { kind: "new_group" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Reflect.get(record, key);
}

export function parseProjectDropData(data: unknown): ProjectDropData | null {
  if (!isRecord(data)) return null;
  const kind = field(data, "kind");

  if (kind === "project-row") {
    const viewKey = field(data, "viewKey");
    const groupKey = field(data, "groupKey");
    const groupName = field(data, "groupName");
    if (typeof viewKey !== "string") return null;
    if (groupKey !== null && typeof groupKey !== "string") return null;
    if (groupName !== null && typeof groupName !== "string") return null;
    return { kind: "project-row", viewKey, groupKey, groupName };
  }

  if (kind === "project-group-header") {
    const groupKey = field(data, "groupKey");
    const groupName = field(data, "groupName");
    const firstViewKey = field(data, "firstViewKey");
    if (
      typeof groupKey !== "string" ||
      typeof groupName !== "string" ||
      typeof firstViewKey !== "string"
    ) {
      return null;
    }
    return { kind: "project-group-header", groupKey, groupName, firstViewKey };
  }

  if (kind === "project-drop-zone") {
    const zone = field(data, "zone");
    if (zone !== "new-group" && zone !== "ungroup") return null;
    return { kind: "project-drop-zone", zone };
  }

  if (kind === "project-group") {
    const groupKey = field(data, "groupKey");
    if (typeof groupKey !== "string") return null;
    return { kind: "project-group", groupKey };
  }

  return null;
}

export function resolveProjectDrop(input: {
  activeViewKey: string;
  activeGroupKey: string | null;
  over: { id: string; data: unknown } | null;
  placement: "before" | "after";
}): ProjectDropResolution {
  const { activeViewKey, activeGroupKey, over, placement } = input;
  if (!over) return { kind: "none" };

  const dropData = parseProjectDropData(over.data);
  if (!dropData) return { kind: "none" };

  if (dropData.kind === "project-drop-zone") {
    if (dropData.zone === "new-group") return { kind: "new_group" };
    if (activeGroupKey === null) return { kind: "none" };
    return { kind: "ungroup", position: { kind: "keep" } };
  }

  if (dropData.kind === "project-group") return { kind: "none" };

  if (dropData.kind === "project-group-header") {
    if (dropData.groupKey === activeGroupKey) return { kind: "none" };
    return {
      kind: "move_to_group",
      groupKey: dropData.groupKey,
      groupName: dropData.groupName,
      position: { kind: "group_start", firstViewKey: dropData.firstViewKey },
    };
  }

  // dropData.kind === "project-row"
  if (dropData.viewKey === activeViewKey) return { kind: "none" };

  if (dropData.groupKey === activeGroupKey) {
    return { kind: "reorder_within", groupKey: dropData.groupKey, overViewKey: dropData.viewKey };
  }

  if (dropData.groupKey === null) {
    return {
      kind: "ungroup",
      position: { kind: "relative", anchorViewKey: dropData.viewKey, placement },
    };
  }

  return {
    kind: "move_to_group",
    groupKey: dropData.groupKey,
    groupName: dropData.groupName ?? dropData.groupKey,
    position: { kind: "relative", anchorViewKey: dropData.viewKey, placement },
  };
}
