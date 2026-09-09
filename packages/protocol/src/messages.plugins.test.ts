import { describe, expect, it } from "vitest";
import {
  MutableDaemonConfigSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  StatusMessageSchema,
} from "./messages.js";

describe("plugin protocol compatibility", () => {
  it.each([undefined, { paseo: ">=0.8.0" }])(
    "parses plugin catalogs with requirements %j",
    (requirements) => {
      const message = {
        type: "plugin.catalog.get.response",
        payload: {
          requestId: "catalog",
          plugins: [
            { id: "example", clientBundle: "bundle", ...(requirements ? { requirements } : {}) },
          ],
        },
      };
      expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    },
  );
  it("parses plugin timeline append messages and advertises the capability", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.timeline.append.request",
        requestId: "request-append",
        agentId: "agent-1",
        item: {
          type: "plugin",
          id: "review-1",
          kind: "review",
          version: 1,
          data: { status: "running" },
        },
      }),
    ).toMatchObject({ type: "agent.timeline.append.request" });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.timeline.append.response",
        payload: { requestId: "request-append", seq: 7, epoch: "epoch-1" },
      }),
    ).toMatchObject({ type: "agent.timeline.append.response" });
    expect(
      StatusMessageSchema.parse({
        type: "status",
        payload: {
          status: "server_info",
          serverId: "server-1",
          features: { pluginTimelineItems: true },
        },
      }).payload,
    ).toMatchObject({ features: { pluginTimelineItems: true } });
  });

  it.each([0, -1, 1.5])("rejects plugin timeline version %s", (version) => {
    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "agent.timeline.append.request",
        requestId: "append-1",
        agentId: "agent-1",
        item: { type: "plugin", id: "row-1", kind: "review", version, data: {} },
      }),
    ).toThrow();
  });

  it("keeps old directory plugin config valid when enabled is absent", () => {
    const config = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: true },
      plugins: { example: { source: "directory", path: "/plugins/example" } },
    });

    expect(config.plugins?.example?.enabled).toBeUndefined();
  });

  it("uses namespaced management request and response pairs", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "plugin.directory.install.request",
        requestId: "request-1",
        path: "/plugins/example",
        id: "example-work",
      }).type,
    ).toBe("plugin.directory.install.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "plugin.directory.inspect.request",
        requestId: "request-0",
        path: "/plugins/example",
      }).type,
    ).toBe("plugin.directory.inspect.request");
    expect(
      SessionOutboundMessageSchema.parse({
        type: "plugin.directory.install.response",
        payload: {
          requestId: "request-1",
          plugin: {
            id: "example-work",
            path: "/plugins/example",
            enabled: true,
            status: "running",
          },
        },
      }).type,
    ).toBe("plugin.directory.install.response");
  });

  it("uses capability-gated source management RPCs", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "plugin.source.install.request",
        requestId: "request-install",
        source: "owner/repository:plugins/review",
        ref: "main",
      }).type,
    ).toBe("plugin.source.install.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "plugin.source.install.request",
        requestId: "request-install-old-client",
        source: "owner/repository",
        pluginPath: "plugins/review",
      }).type,
    ).toBe("plugin.source.install.request");
    expect(
      SessionOutboundMessageSchema.parse({
        type: "plugin.source.status.response",
        payload: {
          requestId: "request-status",
          plugins: [
            {
              id: "review",
              source: "git",
              path: "/plugins/review",
              currentCommit: "a".repeat(40),
              latestCommit: "b".repeat(40),
              commitsBehind: 2,
              updateAvailable: true,
            },
          ],
        },
      }).type,
    ).toBe("plugin.source.status.response");

    const older = StatusMessageSchema.parse({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "older-host",
        features: { pluginManagement: true },
      },
    });
    expect(older.payload.features?.pluginGitManagement).toBeUndefined();
  });

  it("uses a namespaced snapshot RPC for structured plugin logs", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "plugin.logs.get.request",
        requestId: "request-logs",
        pluginId: "example",
      }),
    ).toEqual({
      type: "plugin.logs.get.request",
      requestId: "request-logs",
      pluginId: "example",
    });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "plugin.logs.get.response",
        payload: {
          requestId: "request-logs",
          pluginId: "example",
          entries: [
            {
              sequence: 7,
              timestamp: "2026-08-16T12:00:00.000Z",
              stream: "stderr",
              message: "failed to connect",
            },
          ],
        },
      }),
    ).toEqual({
      type: "plugin.logs.get.response",
      payload: {
        requestId: "request-logs",
        pluginId: "example",
        entries: [
          {
            sequence: 7,
            timestamp: "2026-08-16T12:00:00.000Z",
            stream: "stderr",
            message: "failed to connect",
          },
        ],
      },
    });
  });

  it("keeps the plugin logs capability optional for older server info", () => {
    const older = StatusMessageSchema.parse({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "older-host",
        features: { pluginManagement: true },
      },
    });
    const current = StatusMessageSchema.parse({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "current-host",
        features: { pluginManagement: true, pluginLogs: true },
      },
    });

    expect(older.payload.features?.pluginLogs).toBeUndefined();
    expect(current.payload.features?.pluginLogs).toBe(true);
  });

  it("keeps the plugin themes capability optional for older server info", () => {
    const older = StatusMessageSchema.parse({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "older-host",
        features: { plugins: true },
      },
    });
    const current = StatusMessageSchema.parse({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "current-host",
        features: { plugins: true, pluginThemes: true },
      },
    });

    expect(older.payload.features?.pluginThemes).toBeUndefined();
    expect(current.payload.features?.pluginThemes).toBe(true);
  });

  it("keeps the catalog change notification safe for older clients", () => {
    expect(
      StatusMessageSchema.parse({
        type: "status",
        payload: { status: "plugin_catalog_changed", pluginId: "example" },
      }),
    ).toEqual({
      type: "status",
      payload: { status: "plugin_catalog_changed", pluginId: "example" },
    });
  });

  it("requires plugin action payloads and keeps remove empty", () => {
    expect(() =>
      SessionOutboundMessageSchema.parse({
        type: "plugin.reload.response",
        payload: { requestId: "request-1" },
      }),
    ).toThrow();
    expect(
      SessionOutboundMessageSchema.parse({
        type: "plugin.remove.response",
        payload: { requestId: "request-2" },
      }),
    ).toEqual({ type: "plugin.remove.response", payload: { requestId: "request-2" } });
    expect(() =>
      SessionOutboundMessageSchema.parse({
        type: "plugin.remove.response",
        payload: { requestId: "request-2", plugin: { id: "extra" } },
      }),
    ).toThrow();
  });
});
