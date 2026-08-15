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
