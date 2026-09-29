import { describe, expect, it } from "vitest";
import { groupWorkspaceTabs, type TabGroupInput } from "./workspace-tab-groups";

const tab = (key: string, title: string, issue?: string, isActive = false): TabGroupInput => ({
  key,
  title,
  isActive,
  labels: issue ? { "paperclip.issue": issue } : null,
});

describe("groupWorkspaceTabs", () => {
  const tabs = [
    tab("browser", "Google"),
    tab("boss", "Boss · VIZ-24 Rebrand", "i24"),
    tab("dev", "Dev · VIZ-31 PandaOS", "i31"),
    tab("tester", "Tester · VIZ-24 Rebrand", "i24"),
    tab("me", "My own session"),
  ];

  it("keeps each feature's tabs together, groups first, everything else after", () => {
    const grouping = groupWorkspaceTabs({ tabs, collapsedGroups: new Set() });
    expect(grouping.visibleKeys).toEqual(["boss", "tester", "dev", "browser", "me"]);
    expect(grouping.infoByKey.get("boss")?.label).toBe("VIZ-24");
    expect(grouping.infoByKey.get("browser")).toBeUndefined();
  });

  it("shows one tab of a collapsed group, the active one, with the rest counted", () => {
    const active = [
      tabs[0]!,
      tabs[1]!,
      tabs[2]!,
      tab("tester", "Tester · VIZ-24 Rebrand", "i24", true),
      tabs[4]!,
    ];
    const grouping = groupWorkspaceTabs({
      tabs: active,
      collapsedGroups: new Set(["paperclip:i24"]),
    });
    expect(grouping.visibleKeys).toEqual(["tester", "dev", "browser", "me"]);
    expect(grouping.orderedKeys).toEqual(["boss", "tester", "dev", "browser", "me"]);
    expect(grouping.infoByKey.get("tester")?.hiddenCount).toBe(1);
  });

  it("leaves a row without Paperclip tabs exactly as it was", () => {
    const plain = [tab("a", "A"), tab("b", "B")];
    expect(groupWorkspaceTabs({ tabs: plain, collapsedGroups: new Set() }).visibleKeys).toEqual([
      "a",
      "b",
    ]);
  });
});
