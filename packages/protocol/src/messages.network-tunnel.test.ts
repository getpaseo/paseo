import { describe, expect, it } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  WSInboundMessageSchema,
  WSTunnelHandshakeResponseSchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

describe("network tunnel protocol messages", () => {
  it("accepts server_info with and without optional features.networkTunnel", () => {
    const base = { status: "server_info", serverId: "srv_1" };
    expect(ServerInfoStatusPayloadSchema.parse(base).features?.networkTunnel).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...base, features: { networkTunnel: true } }).features
        ?.networkTunnel,
    ).toBe(true);
  });

  it("validates network.tunnel.create_ticket.request and .response via zod-aot", () => {
    expect(
      WSInboundMessageSchema.parse({
        type: "session",
        message: {
          type: "network.tunnel.create_ticket.request",
          requestId: "req-1",
        },
      }),
    ).toEqual({
      type: "session",
      message: {
        type: "network.tunnel.create_ticket.request",
        requestId: "req-1",
      },
    });

    const response = {
      type: "session",
      message: {
        type: "network.tunnel.create_ticket.response",
        payload: {
          requestId: "req-1",
          ticket: "tkt_abc123",
          expiresAtMs: 1_800_000_000_000,
        },
      },
    };
    expect(validateWSOutboundMessage(response)).toEqual({
      success: true,
      data: response,
    });
  });

  it("validates dedicated tunnel handshake schemas", () => {
    expect(
      WSInboundMessageSchema.parse({
        type: "tunnel_hello",
        ticket: "tkt_secret",
      }),
    ).toEqual({
      type: "tunnel_hello",
      ticket: "tkt_secret",
    });

    expect(
      WSTunnelHandshakeResponseSchema.parse({
        type: "tunnel_ready",
        maxFramePayloadBytes: 65536,
        initialStreamWindowBytes: 524288,
        initialConnectionWindowBytes: 4194304,
      }),
    ).toEqual({
      type: "tunnel_ready",
      maxFramePayloadBytes: 65536,
      initialStreamWindowBytes: 524288,
      initialConnectionWindowBytes: 4194304,
    });

    expect(
      WSTunnelHandshakeResponseSchema.parse({
        type: "tunnel_error",
        code: "invalid_ticket",
        message: "Ticket expired or already used",
      }),
    ).toEqual({
      type: "tunnel_error",
      code: "invalid_ticket",
      message: "Ticket expired or already used",
    });
  });
});
