import { describe, expect, it } from "vitest";
import {
  DAEMON_PERMISSIONS,
  DaemonPermissionSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
} from "../messages.js";
import { CLIENT_CAPS } from "../client-capabilities.js";
import { NETWORK_TUNNEL_CAPABILITY } from "./rpc-schemas.js";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const limits = {
  initialWindowBytes: 262144,
  maxDataBytes: 65536,
  maxStreams: 64,
  connectTimeoutMs: 10000,
};

describe("network tunnel RPCs", () => {
  it.each([
    { type: "network.tunnel.open.request", requestId: "open" },
    { type: "network.tunnel.close.request", requestId: "close", subscriptionId },
  ])("accepts $type through the inbound envelope", (request) => {
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  });

  it.each([
    { type: "network.tunnel.open.request" },
    { type: "network.tunnel.open.request", requestId: "" },
    { type: "network.tunnel.close.request", requestId: "close" },
    { type: "network.tunnel.close.request", requestId: "close", subscriptionId: "not-a-uuid" },
  ])("rejects malformed request $type", (request) => {
    expect(SessionInboundMessageSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    {
      type: "network.tunnel.open.response",
      payload: { requestId: "open", ok: true, subscriptionId, ...limits },
    },
    {
      type: "network.tunnel.close.response",
      payload: { requestId: "close", ok: true, subscriptionId },
    },
    {
      type: "network.tunnel.open.response",
      payload: {
        requestId: "open",
        ok: false,
        error: { code: "permission_denied", message: "Permission required" },
      },
    },
    {
      type: "network.tunnel.close.response",
      payload: {
        requestId: "close",
        ok: false,
        error: { code: "not_found", message: "Unknown subscription" },
      },
    },
    {
      type: "network.tunnel.closed",
      payload: { subscriptionId, reason: "revoked" },
    },
  ])("accepts $type through the outbound envelope", (response) => {
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  it.each([
    { subscriptionId: "not-a-uuid", reason: "revoked" },
    { subscriptionId, reason: "disconnected" },
    { subscriptionId },
  ])("rejects invalid daemon closure payload %j", (payload) => {
    expect(
      SessionOutboundMessageSchema.safeParse({ type: "network.tunnel.closed", payload }).success,
    ).toBe(false);
  });

  it.each([
    { initialWindowBytes: 0 },
    { initialWindowBytes: -1 },
    { maxDataBytes: 0 },
    { maxDataBytes: 1.5 },
    { maxStreams: Infinity },
    { maxStreams: 0 },
    { maxStreams: 1.5 },
    { connectTimeoutMs: 0 },
    { connectTimeoutMs: -1 },
    { subscriptionId: "" },
    { subscriptionId: null },
  ])("rejects invalid successful response fields %j", (invalidFields) => {
    const response = {
      type: "network.tunnel.open.response",
      payload: { requestId: "open", ok: true, subscriptionId, ...limits, ...invalidFields },
    };
    expect(SessionOutboundMessageSchema.safeParse(response).success).toBe(false);
  });

  it.each([
    { requestId: "open", ok: true, subscriptionId },
    { requestId: "open", ok: false },
    { requestId: "open", ok: false, error: { code: "unknown", message: "error" } },
    { ok: true, subscriptionId, ...limits },
  ])("rejects incomplete or unknown result states %j", (payload) => {
    expect(
      SessionOutboundMessageSchema.safeParse({ type: "network.tunnel.open.response", payload })
        .success,
    ).toBe(false);
  });

  it("accepts limits above current defaults without narrowing the wire contract", () => {
    const response = {
      type: "network.tunnel.open.response",
      payload: {
        requestId: "open",
        ok: true,
        subscriptionId,
        initialWindowBytes: 524288,
        maxDataBytes: 131072,
        maxStreams: 128,
        connectTimeoutMs: 20000,
      },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  it("registers tunnel support in the daemon capability allowlist", () => {
    expect(Object.values(CLIENT_CAPS)).toContain("network_tunnel");
    expect(NETWORK_TUNNEL_CAPABILITY).toBe(CLIENT_CAPS.networkTunnel);
  });

  it("accepts negotiated lower limits", () => {
    const response = {
      type: "network.tunnel.open.response",
      payload: {
        requestId: "open",
        ok: true,
        subscriptionId,
        initialWindowBytes: 1024,
        maxDataBytes: 512,
        maxStreams: 1,
        connectTimeoutMs: 1000,
      },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  it("keeps the feature flag optional for older daemons", () => {
    const old = { status: "server_info", serverId: "host" };
    expect(ServerInfoStatusPayloadSchema.parse(old)).toEqual({
      ...old,
      hostname: null,
      version: null,
    });
    const current = { ...old, features: { networkTunnel: true }, permissions: ["network.proxy"] };
    expect(ServerInfoStatusPayloadSchema.parse(current)).toEqual({
      ...current,
      hostname: null,
      version: null,
    });
  });

  it("declares the permission without changing existing permission names", () => {
    expect(DAEMON_PERMISSIONS).toContain("network.proxy");
    expect(DaemonPermissionSchema.parse("network.proxy")).toBe("network.proxy");
    expect(DaemonPermissionSchema.parse("tunnel.manage")).toBe("tunnel.manage");
  });

  it("validates optional hello support without requiring it from old clients", () => {
    const old = { type: "hello", clientId: "client", clientType: "browser", protocolVersion: 1 };
    expect(WSHelloMessageSchema.parse(old)).toEqual(old);
    const current = { ...old, capabilities: { [NETWORK_TUNNEL_CAPABILITY]: true } };
    expect(WSHelloMessageSchema.parse(current)).toEqual(current);
    expect(
      WSHelloMessageSchema.safeParse({
        ...old,
        capabilities: { [NETWORK_TUNNEL_CAPABILITY]: "true" },
      }).success,
    ).toBe(false);
  });
});
