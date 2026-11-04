import { describe, expect, it } from "vitest";
import { createToolCallExpansion } from "./expansion";

function observe(expansion: ReturnType<typeof createToolCallExpansion>) {
  const notified: string[] = [];
  expansion.subscribeCall("first", () => notified.push("first"));
  expansion.subscribeCall("second", () => notified.push("second"));
  expansion.subscribeGroups(() => notified.push("timeline"));
  return notified;
}

describe("tool call expansion", () => {
  it("opens a lone call and its future group without notifying the timeline", () => {
    const expansion = createToolCallExpansion();
    const notified = observe(expansion);
    const groupsBefore = expansion.getExpandedGroups();

    expansion.setCallExpanded({ callId: "first", expanded: true, standalone: true });

    expect(notified).toEqual(["first"]);
    expect(expansion.getExpandedGroups()).toBe(groupsBefore);
    expect(expansion.isCallExpanded("first", false)).toBe(true);
    expect(expansion.getExpandedGroups().has("first")).toBe(true);
  });

  it("closes the lone call and its future group together", () => {
    const expansion = createToolCallExpansion();
    const notified = observe(expansion);
    const groupsBefore = expansion.getExpandedGroups();

    expansion.setCallExpanded({ callId: "first", expanded: true, standalone: true });
    expansion.setCallExpanded({ callId: "first", expanded: false, standalone: true });

    expect(notified).toEqual(["first", "first"]);
    expect(expansion.getExpandedGroups()).toBe(groupsBefore);
    expect(expansion.isCallExpanded("first", false)).toBe(false);
    expect(expansion.getExpandedGroups().has("first")).toBe(false);
  });

  it("keeps a call open when its group closes and reopens", () => {
    const expansion = createToolCallExpansion();
    const notified = observe(expansion);
    expansion.setCallExpanded({ callId: "first", expanded: true, standalone: true });
    const groupsWhenFormed = expansion.getExpandedGroups();

    expansion.setGroupExpanded("first", false);
    const closedGroups = expansion.getExpandedGroups();
    expect(closedGroups).not.toBe(groupsWhenFormed);
    expect(closedGroups.has("first")).toBe(false);
    expect(expansion.isCallExpanded("first", false)).toBe(true);

    expansion.setGroupExpanded("first", true);
    expect(expansion.getExpandedGroups()).not.toBe(closedGroups);
    expect(expansion.getExpandedGroups().has("first")).toBe(true);
    expect(expansion.isCallExpanded("first", false)).toBe(true);
    expect(notified).toEqual(["first", "timeline", "timeline"]);
  });

  it("toggles a call inside a group without touching the group", () => {
    const expansion = createToolCallExpansion();
    const notified = observe(expansion);
    expansion.setGroupExpanded("first", true);
    const groups = expansion.getExpandedGroups();

    expansion.setCallExpanded({ callId: "first", expanded: true, standalone: false });
    expansion.setCallExpanded({ callId: "first", expanded: false, standalone: false });

    expect(notified).toEqual(["timeline", "first", "first"]);
    expect(expansion.getExpandedGroups()).toBe(groups);
    expect(groups.has("first")).toBe(true);
  });

  it("uses the call's default until the user toggles it", () => {
    const expansion = createToolCallExpansion();
    expect(expansion.isCallExpanded("first", true)).toBe(true);
    expansion.setCallExpanded({ callId: "first", expanded: false, standalone: true });
    expect(expansion.isCallExpanded("first", true)).toBe(false);
  });
});
