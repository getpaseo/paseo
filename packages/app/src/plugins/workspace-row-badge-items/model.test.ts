import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { groupPluginWorkspaceRowBadgeItems, isWorkspaceRowBadgeItemVisible } from "./model";

function Item() {
  return null;
}

function installed(id: string, serverId: string, itemIds: string[]): InstalledPlugin {
  return {
    id,
    serverId,
    locale: "en",
    i18n: { resolve: (text: string) => text },
    workspaceRowBadgeItems: itemIds.map((itemId) => ({
      id: itemId,
      title: `${id} ${itemId}`,
      icon: "Gauge",
      Component: Item,
    })),
  } as unknown as InstalledPlugin;
}

describe("groupPluginWorkspaceRowBadgeItems", () => {
  it("lists each plugin item once across hosts, in install order", () => {
    const groups = groupPluginWorkspaceRowBadgeItems([
      installed("status", "host-a", ["state"]),
      installed("asks", "host-a", ["open"]),
      installed("status", "host-b", ["state"]),
    ]);
    expect(groups.map(({ key, title }) => ({ key, title }))).toEqual([
      { key: "status/state", title: "status state" },
      { key: "asks/open", title: "asks open" },
    ]);
  });
});

describe("isWorkspaceRowBadgeItemVisible", () => {
  it("shows items until they are switched off", () => {
    expect(isWorkspaceRowBadgeItemVisible({}, "status/state")).toBe(true);
    expect(isWorkspaceRowBadgeItemVisible({ "status/state": true }, "status/state")).toBe(true);
    expect(isWorkspaceRowBadgeItemVisible({ "status/state": false }, "status/state")).toBe(false);
  });
});
