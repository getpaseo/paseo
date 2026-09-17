/**
 * @vitest-environment jsdom
 */
import appPackage from "../../../package.json";
import { DaemonClient, type DaemonTransport } from "@getpaseo/client/internal/daemon-client";
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostClient = vi.hoisted(() => ({ invokePluginRpc: async () => null }));
const selectedHost = vi.hoisted(() => ({ client: null as DaemonClient | null }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => selectedHost.client ?? (hostClient as unknown as DaemonClient),
  useHosts: () => [{ serverId: "host-1", label: "Local" }],
}));
vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));
vi.mock("../navigation", () => ({
  createPluginNavigation: () => ({}),
}));
vi.mock("../client-runtime", () => ({
  createPluginClientRuntime: () => ({
    paseo: {},
    dispose: () => {},
    rpc: async () => undefined,
    openSurface: () => undefined,
    openPanel: () => undefined,
    addComposerPill: () => ({ update() {}, remove() {} }),
    addHeaderButton: () => ({ update() {}, remove() {} }),
  }),
}));
vi.mock("../icons", () => ({
  Icon: () => null,
  resolvePluginIcon: () => () => null,
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

const recoveringBundle = `(function(require) {
  const React = require("react");
  return { default: function(plugin) {
    function RecoveringCard(props) {
      if (props.item.data.label === "explode") throw new Error("transient renderer failure");
      return React.createElement("span", null, props.item.data.label);
    }
    plugin.addTimelineRenderer({
      kind: "test-report",
      version: 1,
      schema: { safeParse(value) { return { success: true, data: value }; } },
      Component: RecoveringCard,
    });
    return function() {};
  } };
})`;

const timelineItem = {
  kind: "plugin" as const,
  id: "item-1",
  pluginId: "reports",
  pluginItemId: "item-1",
  itemKind: "test-report",
  version: 1,
  data: { label: "Four tests passed" },
  timestamp: new Date("2026-01-01T00:00:00.000Z"),
};
const failingTimelineItem = { ...timelineItem, data: { label: "explode" } };
const recoveredTimelineItem = { ...timelineItem, data: { label: "Recovered" } };

const roots: Array<ReturnType<typeof createRoot>> = [];
const containers: HTMLElement[] = [];
const daemonClient = {} as DaemonClient;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  pluginRegistry.removeHost("host-1");
  selectedHost.client = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PluginTimelineItemView", () => {
  it("validates and renders the matching plugin component", async () => {
    pluginRegistry.installCatalog(
      "host-1",
      [{ id: "reports", requirements: { paseo: `>=${appPackage.version}` }, clientBundle: bundle }],
      {
        client: daemonClient,
      },
    );

    const container = document.createElement("div");
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <PluginTimelineItemView serverId="host-1" agentId="agent-1" item={timelineItem} />,
      ),
    );
    expect(container.textContent).toContain("Four tests passed");
  });

  it("contains renderer crashes to one timeline item", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    pluginRegistry.installCatalog(
      "host-1",
      [
        {
          id: "reports",
          requirements: { paseo: `>=${appPackage.version}` },
          clientBundle: failingBundle,
        },
      ],
      {
        client: daemonClient,
      },
    );
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

  it("recovers when a streaming item's data changes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    pluginRegistry.installCatalog(
      "host-1",
      [
        {
          id: "reports",
          requirements: { paseo: `>=${appPackage.version}` },
          clientBundle: recoveringBundle,
        },
      ],
      {
        client: daemonClient,
      },
    );
    const container = document.createElement("div");
    containers.push(container);
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <PluginTimelineItemView serverId="host-1" agentId="agent-1" item={failingTimelineItem} />,
      );
    });
    expect(container.textContent).toBe("Plugin failed: transient renderer failure");

    await act(async () => {
      root.render(
        <PluginTimelineItemView serverId="host-1" agentId="agent-1" item={recoveredTimelineItem} />,
      );
    });
    expect(container.textContent).toBe("Recovered");
  });
});

it("releases a crashed renderer's observations and recovers a fresh scope in StrictMode", async () => {
  let receive: Parameters<DaemonTransport["onMessage"]>[0] = () => {};
  let opened: () => void = () => {};
  let nextId = 0;
  const retained = new Set<string>();
  const released: string[] = [];
  const deliver = (message: unknown) =>
    receive(JSON.stringify({ type: "session", message }), false);
  const client = new DaemonClient({
    url: "ws://surface-observation.test",
    clientId: "surface-lifetime-test",
    transportFactory: () => ({
      send(data) {
        if (typeof data !== "string") throw new Error("Expected a JSON request");
        const frame = JSON.parse(data) as {
          type: string;
          message?: { type: string; requestId: string; subscriptionId: string };
        };
        if (frame.type === "hello")
          deliver({
            type: "status",
            payload: {
              status: "server_info",
              serverId: "host-1",
              hostname: null,
              version: null,
              features: { ownedSubscriptions: true },
            },
          });
        const request = frame.message;
        if (request?.type === "session.events.set_subscription.request") {
          const id = `surface-${++nextId}`;
          retained.add(id);
          deliver({
            type: "session.events.set_subscription.response",
            payload: {
              requestId: request.requestId,
              subscriptionId: id,
              events: ["project.update"],
              snapshots: [],
            },
          });
        } else if (request?.type === "subscription.release.request") {
          retained.delete(request.subscriptionId);
          released.push(request.subscriptionId);
          deliver({ type: "subscription.release.response", payload: request });
        }
      },
      close() {},
      onMessage(handler) {
        receive = handler;
        return () => {};
      },
      onOpen(handler) {
        opened = handler;
        return () => {};
      },
      onClose() {
        return () => {};
      },
      onError() {
        return () => {};
      },
    }),
  });
  const connecting = client.connect();
  opened();
  await connecting;
  selectedHost.client = client;
  const liveBundle = `(function(require) {
    const React = require("react");
    const { usePaseo } = require("@getpaseo/plugin/client");
    return { default(plugin) {
      function Card(props) {
        const paseo = usePaseo();
        const failed = React.useRef(false);
        failed.current = props.item.data.label === "explode";
        React.useEffect(() => {
          const owner = paseo.observeEvents(["project.update"]);
          return () => { if (failed.current) throw new Error("plugin cleanup failed"); void owner.release(); };
        }, [paseo]);
        if (props.item.data.label === "explode") throw new Error("owned renderer failed");
        return React.createElement("span", null, props.item.data.label);
      }
      plugin.addTimelineRenderer({ kind:"test-report", version:1, schema:{safeParse(data){return {success:true,data};}}, Component:Card });
      return () => {};
    }};
  })`;
  const survivor = client.observeEvents(["project.update"]);
  const updates: unknown[] = [];
  survivor.subscribe({ snapshot: () => {}, update: (message) => updates.push(message) });
  await survivor.ready;
  pluginRegistry.installCatalog(
    "host-1",
    [
      {
        id: "reports",
        requirements: { paseo: `>=${appPackage.version}` },
        clientBundle: liveBundle,
      },
    ],
    { client },
  );
  const container = document.createElement("div");
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (item: typeof timelineItem) =>
    act(async () =>
      root.render(
        <StrictMode>
          <PluginTimelineItemView serverId="host-1" agentId="agent-1" item={item} />
        </StrictMode>,
      ),
    );
  try {
    await render(timelineItem);
    expect(retained.size).toBe(2);
    const initialIds = new Set(retained);
    await render(failingTimelineItem);
    expect(container.textContent).toContain("Plugin failed:");
    expect([...retained]).toEqual([survivor.subscriptionId]);
    expect(released.some((id) => initialIds.has(id))).toBe(true);
    deliver({
      type: "project.update",
      payload: { subscriptionId: survivor.subscriptionId, kind: "remove", projectId: "still-live" },
    });
    expect(updates).toHaveLength(1);
    await render(recoveredTimelineItem);
    expect(container.textContent).toContain("Recovered");
    expect(retained.size).toBe(2);
    expect([...retained].filter((id) => !initialIds.has(id))).toHaveLength(1);
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect([...retained]).toEqual([survivor.subscriptionId]);
  } finally {
    await survivor.release();
    await client.close();
  }
});
