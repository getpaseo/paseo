import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PLUGIN_SIDEBAR_BADGE_DEFAULT_INTERVAL_MS,
  PLUGIN_SIDEBAR_BADGE_MIN_INTERVAL_MS,
  PluginSidebarBadgeSchema,
  resolvePluginSidebarBadgeInterval,
} from "./badges.js";
import { readPluginSidebarBadge } from "./host.js";
import { defineRpc } from "./rpc.js";

const badgeRpc = defineRpc({
  name: "reviews.badge",
  input: z.object({}),
  output: PluginSidebarBadgeSchema,
});

const item = { id: "inbox", title: "Reviews", icon: "Inbox", surface: "inbox" };

describe("resolvePluginSidebarBadgeInterval", () => {
  it("defaults when the plugin says nothing", () => {
    expect(resolvePluginSidebarBadgeInterval(undefined)).toBe(
      PLUGIN_SIDEBAR_BADGE_DEFAULT_INTERVAL_MS,
    );
  });

  it("floors an interval that would hammer the plugin", () => {
    expect(resolvePluginSidebarBadgeInterval(1)).toBe(PLUGIN_SIDEBAR_BADGE_MIN_INTERVAL_MS);
  });

  it("keeps a slower interval the plugin asked for", () => {
    expect(resolvePluginSidebarBadgeInterval(300_000)).toBe(300_000);
  });

  it("ignores a non-finite interval", () => {
    expect(resolvePluginSidebarBadgeInterval(Number.NaN)).toBe(
      PLUGIN_SIDEBAR_BADGE_DEFAULT_INTERVAL_MS,
    );
  });
});

describe("readPluginSidebarBadge", () => {
  it("returns null for a sidebar item with no badge", async () => {
    await expect(readPluginSidebarBadge(item, async () => ({ count: 3 }))).resolves.toBeNull();
  });

  it("calls the badge RPC with an empty input and parses the count", async () => {
    const calls: { method: string; input: unknown }[] = [];
    const badge = await readPluginSidebarBadge(
      { ...item, badge: { rpc: badgeRpc } },
      async (method, input) => {
        calls.push({ method, input });
        return { count: 7 };
      },
    );

    expect(calls).toEqual([{ method: "reviews.badge", input: {} }]);
    expect(badge).toEqual({ count: 7 });
  });

  it("rejects a count the schema does not allow", async () => {
    await expect(
      readPluginSidebarBadge({ ...item, badge: { rpc: badgeRpc } }, async () => ({ count: -1 })),
    ).rejects.toThrow();
  });
});
