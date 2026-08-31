import { describe, expect, it } from "vitest";
import { getWorkspaceRelativeTabId } from "./workspace-tab-navigation";

describe("getWorkspaceRelativeTabId", () => {
  it("cycles in order and wraps in both directions", () => {
    const tabIds = ["left-a", "left-b", "left-c"];

    expect(getWorkspaceRelativeTabId(tabIds, "left-a", 1)).toBe("left-b");
    expect(getWorkspaceRelativeTabId(tabIds, "left-c", 1)).toBe("left-a");
    expect(getWorkspaceRelativeTabId(tabIds, "left-a", -1)).toBe("left-c");
  });
});
