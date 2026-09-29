import { describe, expect, it } from "vitest";
import { agentTabGroup, groupWorkspaceTabs, type TabGroupInput } from "./workspace-tab-groups";

const tab = (
  key: string,
  groupKey: string | null,
  extra: Partial<TabGroupInput> = {},
): TabGroupInput => ({ key, isActive: false, groupKey, ...extra });

describe("groupWorkspaceTabs", () => {
  const tabs = [
    tab("terminal", null),
    tab("dev", "agent:dev", { groupLabel: "Dev" }),
    tab("boss", "agent:boss", { groupLabel: "Boss" }),
    tab("preview", "agent:dev"),
    tab("me", null),
  ];

  it("keeps an agent with the tabs it opened, and leaves a lone agent ungrouped", () => {
    const grouping = groupWorkspaceTabs({ tabs, collapsedGroups: new Set() });
    expect(grouping.visibleKeys).toEqual(["dev", "preview", "terminal", "boss", "me"]);
    expect(grouping.infoByKey.get("dev")?.label).toBe("Dev");
    expect(grouping.infoByKey.get("boss")).toBeUndefined();
  });

  it("shows one tab of a collapsed group, the active one, with the rest counted", () => {
    const active = [
      tabs[0]!,
      tabs[1]!,
      tabs[2]!,
      tab("preview", "agent:dev", { isActive: true }),
      tabs[4]!,
    ];
    const grouping = groupWorkspaceTabs({
      tabs: active,
      collapsedGroups: new Set(["agent:dev"]),
    });
    expect(grouping.visibleKeys).toEqual(["preview", "terminal", "boss", "me"]);
    expect(grouping.orderedKeys).toEqual(["dev", "preview", "terminal", "boss", "me"]);
    expect(grouping.infoByKey.get("preview")?.hiddenCount).toBe(1);
  });

  it("leaves a row without groups exactly as it was", () => {
    const plain = [tab("a", null), tab("b", null)];
    expect(groupWorkspaceTabs({ tabs: plain, collapsedGroups: new Set() }).visibleKeys).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("agentTabGroup", () => {
  it("puts every agent of a Paperclip feature in one group named after the feature", () => {
    const labels = { "paperclip.feature": "f35", "paperclip.feature.key": "VIZ-35" };
    const boss = agentTabGroup("boss", labels, "Boss");
    const dev = agentTabGroup("dev", labels, "Dev");
    expect(boss.key).toBe(dev.key);
    expect(boss.label).toBe("VIZ-35");
  });

  it("keeps any other agent in a group of its own", () => {
    expect(agentTabGroup("a1", null, "My session")).toEqual({
      key: "agent:a1",
      label: "My session",
    });
  });
});
