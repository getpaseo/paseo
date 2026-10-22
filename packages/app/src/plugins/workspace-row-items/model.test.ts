import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { groupPluginWorkspaceRowItems, isWorkspaceRowItemVisible } from "./model";

function Item() {
  return null;
}

function installed(id: string, serverId: string, itemIds: string[]): InstalledPlugin {
  return {
    id,
    serverId,
    locale: "en",
    i18n: { resolve: (text: string) => text },
    workspaceRowItems: itemIds.map((itemId) => ({
      id: itemId,
      title: `${id} ${itemId}`,
      icon: "Gauge",
      Component: Item,
    })),
  } as unknown as InstalledPlugin;
}

describe("groupPluginWorkspaceRowItems", () => {
  it("lists each plugin item once across hosts, in install order", () => {
    const groups = groupPluginWorkspaceRowItems([
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

describe("isWorkspaceRowItemVisible", () => {
  it("shows items until they are switched off", () => {
    expect(isWorkspaceRowItemVisible({}, "status/state")).toBe(true);
    expect(isWorkspaceRowItemVisible({ "status/state": true }, "status/state")).toBe(true);
    expect(isWorkspaceRowItemVisible({ "status/state": false }, "status/state")).toBe(false);
  });
});
