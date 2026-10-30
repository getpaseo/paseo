import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import {
  clampWidgetPosition,
  floatingWidgetBounds,
  groupFloatingWidgets,
  initialWidgetPosition,
  selectFloatingWidgetTarget,
  type EvaluatedFloatingWidget,
} from "./model";

function installation(serverId: string, id = "pet"): InstalledPlugin {
  const widget: EvaluatedFloatingWidget = {
    contribution: { id: "companion", title: "Companion", Component: () => null },
    visible: true,
    revealRevision: 0,
    show() {},
    hide() {},
  };
  return { id, serverId, floatingWidgets: [widget] } as InstalledPlugin;
}

describe("floating widget ownership", () => {
  it("deduplicates by plugin and widget, with deterministic host choice and explicit overrides", () => {
    const a = installation("a");
    const b = installation("b");
    const other = installation("a", "clock");
    const groups = groupFloatingWidgets([b, other, a]);
    expect(groups.map((group) => group.key)).toEqual(["clock/companion", "pet/companion"]);
    const pet = groups[1]!;
    expect(pet.targets.map((target) => target.plugin.serverId)).toEqual(["a", "b"]);
    expect(selectFloatingWidgetTarget(pet, null).plugin).toBe(a);
    expect(selectFloatingWidgetTarget(pet, "b").plugin).toBe(b);
    expect(selectFloatingWidgetTarget(pet, "removed-host").plugin).toBe(a);
    expect(groupFloatingWidgets([])).toEqual([]);
  });

  it("selects the latest explicit show request, including when the previous source was hidden", () => {
    const a = installation("a");
    const b = installation("b");
    const group = groupFloatingWidgets([a, b])[0]!;
    a.floatingWidgets[0]!.revealRevision = 1;
    a.floatingWidgets[0]!.visible = false;
    b.floatingWidgets[0]!.revealRevision = 2;
    expect(selectFloatingWidgetTarget(group, "a").plugin).toBe(b);
    b.floatingWidgets[0]!.visible = false;
    expect(selectFloatingWidgetTarget(group, "a").widget.visible).toBe(false);
    a.floatingWidgets[0]!.revealRevision = 3;
    a.floatingWidgets[0]!.visible = true;
    expect(selectFloatingWidgetTarget(group, "b").plugin).toBe(a);
    const removed = groupFloatingWidgets([b])[0]!;
    expect(selectFloatingWidgetTarget(removed, "a").plugin).toBe(b);
  });
});

describe("floating widget viewport geometry", () => {
  const insets = { top: 44, left: 0, right: 0, bottom: 34 };
  const size = { width: 208, height: 200 };

  it("keeps every corner within the safe area", () => {
    const bounds = floatingWidgetBounds({ width: 390, height: 844 }, insets, 0);
    expect(bounds).toEqual({ x: 8, y: 52, width: 374, height: 750 });
    expect(initialWidgetPosition("top-left", size, bounds)).toEqual({ x: 8, y: 52 });
    expect(initialWidgetPosition("top-right", size, bounds)).toEqual({ x: 174, y: 52 });
    expect(initialWidgetPosition("bottom-left", size, bounds)).toEqual({ x: 8, y: 602 });
    expect(initialWidgetPosition("bottom-right", size, bounds)).toEqual({ x: 174, y: 602 });
  });

  it("reclamps a dragged widget after keyboard opening or viewport shrink", () => {
    const position = { x: 800, y: 700 };
    const bounds = floatingWidgetBounds({ width: 320, height: 640 }, insets, 266);
    expect(bounds).toEqual({ x: 8, y: 52, width: 304, height: 280 });
    expect(clampWidgetPosition(position, size, bounds)).toEqual({ x: 104, y: 132 });
    expect(clampWidgetPosition({ x: -100, y: -100 }, size, bounds)).toEqual({ x: 8, y: 52 });
  });

  it("handles a viewport smaller than the requested content without negative coordinates", () => {
    const bounds = floatingWidgetBounds({ width: 100, height: 80 }, insets, 300);
    expect(bounds).toEqual({ x: 8, y: 52, width: 84, height: 0 });
    expect(initialWidgetPosition("bottom-right", size, bounds)).toEqual({ x: 8, y: 52 });
  });
});
