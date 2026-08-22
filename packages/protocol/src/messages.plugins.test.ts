import { describe, expect, it } from "vitest";
import {
  MutableDaemonConfigSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  StatusMessageSchema,
} from "./messages.js";

describe("plugin protocol compatibility", () => {
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
