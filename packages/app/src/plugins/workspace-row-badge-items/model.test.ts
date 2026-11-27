import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import {
  groupPluginWorkspaceRowBadgeItems,
  isWorkspaceRowBadgeItemVisible,
  listWorkspaceRowBadgeItems,
  pickWorkspaceRowBadgeItems,
} from "./model";

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

describe("listWorkspaceRowBadgeItems", () => {
  it("lists visible items with every host that contributes them", () => {
    const items = listWorkspaceRowBadgeItems(
      [
        installed("status", "host-a", ["state"]),
        installed("asks", "host-a", ["open"]),
        installed("status", "host-b", ["state", "deploy"]),
      ],
      { "asks/open": false },
    );
    expect(items.map(({ key, hostIds }) => ({ key, hostIds }))).toEqual([
      { key: "status/state", hostIds: ["host-a", "host-b"] },
      { key: "status/deploy", hostIds: ["host-b"] },
    ]);
  });
});

describe("pickWorkspaceRowBadgeItems", () => {
  const entries = ["status/state", "asks/open", "status/deploy"];
  const keyOf = (entry: string) => entry;

  it("keeps every entry when no keys are given", () => {
    expect(pickWorkspaceRowBadgeItems(entries, keyOf, undefined)).toEqual(entries);
  });

  it("draws the named entries in the given order and skips unknown keys", () => {
    expect(
      pickWorkspaceRowBadgeItems(entries, keyOf, ["status/deploy", "gone/item", "status/state"]),
    ).toEqual(["status/deploy", "status/state"]);
  });
});

describe("isWorkspaceRowBadgeItemVisible", () => {
  it("shows items until they are switched off", () => {
    expect(isWorkspaceRowBadgeItemVisible({}, "status/state")).toBe(true);
    expect(isWorkspaceRowBadgeItemVisible({ "status/state": true }, "status/state")).toBe(true);
    expect(isWorkspaceRowBadgeItemVisible({ "status/state": false }, "status/state")).toBe(false);
  });
});
