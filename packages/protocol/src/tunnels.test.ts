import { describe, expect, it } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("tunnel protocol schemas", () => {
  it("accepts tunnel inbound requests and outbound responses/events", () => {
    const providerListReq = SessionInboundMessageSchema.parse({
      type: "tunnel.providers.list.request",
      requestId: "req-1",
    });
    expect(providerListReq.type).toBe("tunnel.providers.list.request");

    const openReq = SessionInboundMessageSchema.parse({
      type: "tunnel.exposure.open.request",
      requestId: "req-2",
      providerId: "cloudflared",
      host: "127.0.0.1",
      port: 4321,
      label: "External MCP",
      slug: "mcp",
    });
    expect(openReq.type).toBe("tunnel.exposure.open.request");

    const closeReq = SessionInboundMessageSchema.parse({
      type: "tunnel.exposure.close.request",
      requestId: "req-3",
      exposureId: "tun_1",
    });
    expect(closeReq.type).toBe("tunnel.exposure.close.request");

    const exposure = {
      id: "tun_1",
      providerId: "cloudflared",
      target: { host: "127.0.0.1", port: 4321, label: "External MCP", slug: "mcp" },
      state: "ready" as const,
      url: "https://demo.trycloudflare.com",
      stability: "ephemeral" as const,
      detail: null,
      error: null,
      createdAt: "2026-11-27T10:00:00.000Z",
      updatedAt: "2026-11-27T10:00:01.000Z",
    };

    const listRes = SessionOutboundMessageSchema.parse({
      type: "tunnel.exposures.list.response",
      payload: {
        requestId: "req-4",
        exposures: [exposure],
        subscriptionId: "sub-1",
      },
    });
    expect(listRes.type).toBe("tunnel.exposures.list.response");

    const changed = SessionOutboundMessageSchema.parse({
      type: "tunnel.exposure.changed",
      payload: {
        subscriptionId: "sub-1",
        exposure,
      },
    });
    expect(changed.type).toBe("tunnel.exposure.changed");

    const providersRes = SessionOutboundMessageSchema.parse({
      type: "tunnel.providers.list.response",
      payload: {
        requestId: "req-1",
        providers: [
          {
            id: "cloudflared",
            pluginId: "cloudflared-tunnel",
            label: "Cloudflare Tunnel",
            availability: { status: "available", detail: "cloudflared 2026.1.0" },
          },
          {
            id: "tailscale-funnel",
            pluginId: "tailscale-funnel",
            label: "Tailscale Funnel",
            availability: {
              status: "unavailable",
              reason: "tailscale CLI is not installed",
              installUrl: "https://tailscale.com/download",
            },
          },
        ],
      },
    });
    expect(providersRes.type).toBe("tunnel.providers.list.response");
  });

  it("exposes optional server_info.features.tunnelProviders while remaining backward compatible", () => {
    const base = {
      status: "server_info" as const,
      serverId: "srv_1",
      hostname: "devbox",
      version: "0.17.6",
    };
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...base, features: { tunnelProviders: true } }).features
        ?.tunnelProviders,
    ).toBe(true);
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...base, features: {} }).features?.tunnelProviders,
    ).toBeUndefined();
  });
});
