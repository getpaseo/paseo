import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  exportPublicKey,
  generateKeyPair,
  openDaemonSecureChannel,
  type Transport,
} from "@getpaseo/relay/e2ee";
import { leanProtocolCodec } from "../daemon-protocol-codec-lean.js";
import { strictProtocolCodec } from "../daemon-protocol-codec-strict.js";
import { createLeanHostClient } from "./lean.js";

function handleDirectServerConnection(ws: WebSocket): void {
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString("utf8")) as {
      type: string;
      message?: { type: string; requestId?: string };
    };
    if (parsed.type === "hello") {
      ws.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "srv_lean_test",
              hostname: "lean-host",
              version: "0.18.1",
              features: { ownedSubscriptions: true, connectedHosts: true },
            },
          },
        }),
      );
      return;
    }
    if (parsed.type === "session" && parsed.message?.type === "hosts.list.request") {
      ws.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "hosts.list.response",
            payload: {
              requestId: parsed.message.requestId,
              directory: { hosts: [] },
            },
          },
        }),
      );
    }
  });
}

function createRelayWireTransport(ws: WebSocket): Transport {
  const transport: Transport = {
    send: (data) => {
      ws.send(data instanceof ArrayBuffer ? Buffer.from(data) : data);
    },
    close: (code, reason) => ws.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      transport.onmessage?.({ data: data.toString("utf8"), isBinary: false });
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    transport.onmessage?.({
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      isBinary: true,
    });
  });
  ws.on("close", (code, reason) => transport.onclose?.(code, reason.toString("utf8")));
  ws.on("error", (err) => transport.onerror?.(err));
  return transport;
}

async function handleRelayServerConnection(
  ws: WebSocket,
  daemonKeys: ReturnType<typeof generateKeyPair>,
): Promise<void> {
  const transport = createRelayWireTransport(ws);
  let secureChannel: Awaited<ReturnType<typeof openDaemonSecureChannel>> | null = null;
  secureChannel = await openDaemonSecureChannel(transport, {
    daemonKeyPair: daemonKeys,
    events: {
      onopen: () => {},
      onmessage: (data) => {
        const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        const parsed = JSON.parse(text) as { type: string };
        if (parsed.type === "hello") {
          void secureChannel?.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "srv_relay_lean",
                  hostname: "relay-host",
                  version: "0.18.1",
                  features: { relayProtectedSecurity: true },
                },
              },
            }),
          );
        }
      },
      onclose: () => {},
      onerror: () => {},
    },
  });
}

describe("leanProtocolCodec", () => {
  it("matches strict parseServerInfo normalization for valid and invalid payloads", () => {
    const validCases: unknown[] = [
      {
        status: "server_info",
        serverId: "  srv_123  ",
        hostname: "  dev-box  ",
        version: " 0.18.1 ",
        protocolVersion: 2,
        desktopManaged: false,
        features: { ownedSubscriptions: true, relayProtectedSecurity: true },
        capabilities: {
          voice: {
            dictation: { enabled: true, reason: "ok" },
            voice: { enabled: false, reason: "disabled" },
          },
          extraCapability: true,
        },
        extraField: "kept",
      },
      {
        status: "server_info",
        serverId: "srv_minimal",
        hostname: "   ",
        version: null,
        capabilities: { voice: { dictation: "bad" } },
      },
    ];
    for (const payload of validCases) {
      expect(leanProtocolCodec.parseServerInfo(payload)).toEqual(
        strictProtocolCodec.parseServerInfo(payload),
      );
    }

    const invalidCases: unknown[] = [
      null,
      { status: "other", serverId: "srv_1" },
      { status: "server_info", serverId: "   " },
      { status: "server_info", serverId: "srv_1", protocolVersion: 1.5 },
    ];
    for (const payload of invalidCases) {
      expect(leanProtocolCodec.parseServerInfo(payload)).toBeNull();
      expect(strictProtocolCodec.parseServerInfo(payload)).toBeNull();
    }
  });

  it("validates outbound WS envelopes and rejects malformed frames", () => {
    expect(leanProtocolCodec.validateOutbound({ type: "pong" }).success).toBe(true);
    expect(
      leanProtocolCodec.validateOutbound({ type: "hello.rejected", reason: "password_required" })
        .success,
    ).toBe(true);
    expect(
      leanProtocolCodec.validateOutbound({
        type: "session",
        message: { type: "status", payload: { status: "server_info", serverId: "srv_1" } },
      }).success,
    ).toBe(true);
    expect(leanProtocolCodec.validateOutbound({ type: "session", message: {} }).success).toBe(
      false,
    );
    expect(
      leanProtocolCodec.validateOutbound({ type: "hello.rejected", reason: "bogus" }).success,
    ).toBe(false);
    expect(leanProtocolCodec.validateOutbound({ type: "unknown" }).success).toBe(false);
  });
});

describe("createLeanHostClient", () => {
  it("completes a direct TCP handshake and RPC without loading strict validators or relay", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    wss.on("connection", handleDirectServerConnection);

    const client = createLeanHostClient(`127.0.0.1:${address.port}`, {
      clientId: "cid_lean_test",
      clientType: "cli",
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.serverId).toBe("srv_lean_test");
      const hosts = await client.listHosts();
      expect(hosts.hosts).toEqual([]);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("loads relay E2EE lazily when connecting to a pairing offer", async () => {
    const daemonKeys = generateKeyPair();
    const daemonPublicKeyB64 = exportPublicKey(daemonKeys.publicKey);
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    wss.on("connection", (ws) => {
      void handleRelayServerConnection(ws, daemonKeys);
    });

    const offerUrl = `relay://127.0.0.1:${address.port}/srv_relay_lean?key=${encodeURIComponent(daemonPublicKeyB64)}`;
    const client = createLeanHostClient(offerUrl, {
      clientId: "cid_relay_lean_test",
      clientType: "cli",
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.serverId).toBe("srv_relay_lean");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
