/**
 * @vitest-environment jsdom
 */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ invokePluginRpc: async () => null }) as unknown as DaemonClient,
  useHosts: () => [{ serverId: "host-1", label: "Local" }],
}));

import { pluginRegistry } from "../registry";
import { PluginTimelineItemView } from "./view";

const bundle = `(function(require) {
  const React = require("react");
  return { default: function(plugin) {
    function Card(props) {
      return React.createElement("span", null, props.item.data.label);
    }
    plugin.addTimelineRenderer({
      kind: "test-report",
      version: 1,
      schema: { safeParse(value) { return { success: true, data: value }; } },
      Component: Card,
    });
    return function() {};
  } };
})`;

const failingBundle = `(function() {
  return { default: function(plugin) {
    function BrokenCard() { throw new Error("timeline renderer exploded"); }
    plugin.addTimelineRenderer({
      kind: "test-report",
      version: 1,
      schema: { safeParse(value) { return { success: true, data: value }; } },
      Component: BrokenCard,
    });
    return function() {};
  } };
})`;

const timelineItem = {
  kind: "plugin" as const,
  id: "item-1",
  pluginId: "reports",
  itemKind: "test-report",
  version: 1,
  data: { label: "Four tests passed" },
  timestamp: new Date("2026-01-01T00:00:00.000Z"),
};

const roots: Array<ReturnType<typeof createRoot>> = [];
const containers: HTMLElement[] = [];

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  pluginRegistry.removeHost("host-1");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PluginTimelineItemView", () => {
  it("validates and renders the matching plugin component", () => {
    pluginRegistry.installCatalog("host-1", [{ id: "reports", clientBundle: bundle }]);

    const markup = renderToStaticMarkup(
      <PluginTimelineItemView serverId="host-1" agentId="agent-1" item={timelineItem} />,
    );

    expect(markup).toContain("Four tests passed");
  });

  it("contains renderer crashes to one timeline item", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    pluginRegistry.installCatalog("host-1", [{ id: "reports", clientBundle: failingBundle }]);
    const container = document.createElement("div");
    containers.push(container);
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <div>
          <span>Message before</span>
          <PluginTimelineItemView serverId="host-1" agentId="agent-1" item={timelineItem} />
          <span>Message after</span>
        </div>,
      );
    });

    expect(container.textContent).toContain("Message before");
    expect(container.textContent).toContain("Plugin failed: timeline renderer exploded");
    expect(container.textContent).toContain("Message after");
  });
});
