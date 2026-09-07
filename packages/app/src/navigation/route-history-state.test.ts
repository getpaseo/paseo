import { describe, expect, it } from "vitest";
import {
  createRouteHistory,
  normalizeRouteHistoryHref,
  type RouteHistoryEntry,
} from "./route-history-state";

const a = { href: "/h/host/workspace/one", tabId: "agent_a" };
const b = { ...a, tabId: "terminal_b" };
const c = { href: "/h/host/workspace/two", tabId: "plugin_c" };
const settings = { href: "/settings/general", tabId: null };
const plugin = { href: "/h/host/plugin/example/main?filter=open", tabId: null };
const available = () => true;

describe("application route history", () => {
  it("ignores echoed path params while retaining plugin query state and fragments", () => {
    expect(
      normalizeRouteHistoryHref(
        "/h/host/plugin/example/sidebar/main?pluginId=example&contributionKind=sidebar&contributionId=main&filter=open&workspaceId=one#item",
        ["h", "[serverId]", "plugin", "[pluginId]", "[contributionKind]", "[contributionId]"],
      ),
    ).toBe("/h/host/plugin/example/sidebar/main?filter=open&workspaceId=one#item");
    expect(
      normalizeRouteHistoryHref("/files/a/b?path=a&path=b&view=grid", ["files", "[...path]"]),
    ).toBe("/files/a/b?view=grid");
  });
  it("replays tabs, workspaces and routes without recording replay as new visits", () => {
    const history = createRouteHistory();
    for (const entry of [a, b, c, settings, plugin]) history.record(entry);
    for (const entry of [settings, c, b, a]) {
      expect(history.move("back", available)).toEqual(entry);
      history.record(entry);
    }
    expect(history.move("back", available)).toBeNull();
    for (const entry of [b, c, settings, plugin]) {
      expect(history.move("forward", available)).toEqual(entry);
      history.record(entry);
    }
    expect(history.move("forward", available)).toBeNull();
  });

  it("deduplicates observations and discards forward visits after a new navigation", () => {
    const history = createRouteHistory();
    for (const entry of [a, a, b, b, c]) history.record(entry);
    expect(history.move("back", available)).toEqual(b);
    history.record(b);
    history.record(settings);
    expect(history.move("forward", available)).toBeNull();
    expect(history.move("back", available)).toEqual(b);
    expect(history.move("back", available)).toEqual(a);
    expect(history.move("back", available)).toBeNull();
  });

  it("skips closed tabs without reopening them or stopping at duplicate visits", () => {
    const history = createRouteHistory();
    for (const entry of [a, b, a, settings]) history.record(entry);
    const isAvailable = (entry: RouteHistoryEntry) => entry.tabId !== b.tabId;
    expect(history.move("back", isAvailable)).toEqual(a);
    history.record(a);
    expect(history.move("back", isAvailable)).toBeNull();
    expect(history.move("forward", isAvailable)).toEqual(settings);
  });

  it("coalesces intermediate route commits during rapid repeated shortcuts", () => {
    const history = createRouteHistory();
    for (const entry of [a, b, c, settings]) history.record(entry);
    expect(history.move("back", available)).toEqual(c);
    expect(history.move("back", available)).toEqual(b);
    history.record(settings);
    history.record(c);
    history.record(a);
    history.record(b);
    expect(history.move("forward", available)).toEqual(c);
    history.record(c);
    expect(history.move("forward", available)).toEqual(settings);
  });

  it("keeps a bounded session history", () => {
    const history = createRouteHistory();
    for (let index = 0; index < 110; index++) {
      history.record({ href: `/page/${index}`, tabId: null });
    }
    for (let index = 108; index >= 10; index--) {
      const entry = { href: `/page/${index}`, tabId: null };
      expect(history.move("back", available)).toEqual(entry);
      history.record(entry);
    }
    expect(history.move("back", available)).toBeNull();
  });
});
