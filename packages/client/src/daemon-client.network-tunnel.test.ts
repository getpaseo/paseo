import { describe, expect, test } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client.js";

function createFakeTransport(features: Record<string, boolean | undefined>): {
  transport: DaemonTransport;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const openHandlers = new Set<() => void>();
  const messageHandlers = new Set<(data: unknown, isBinary: boolean) => void | Promise<void>>();
  const closeHandlers = new Set<(event?: unknown) => void>();
  const errorHandlers = new Set<(event?: unknown) => void>();

  const emitMessage = (text: string) => {
    queueMicrotask(() => {
      for (const handler of messageHandlers) {
        void handler(text, false);
      }
    });
  };

  const transport: DaemonTransport = {
    onOpen(handler) {
      openHandlers.add(handler);
      queueMicrotask(() => handler());
      return () => openHandlers.delete(handler);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    send(data) {
      if (typeof data !== "string") return;
      const parsed = JSON.parse(data) as {
        type: string;
        message?: { type: string; requestId?: string };
      };
      sent.push(parsed);

      if (parsed.type === "hello") {
        emitMessage(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "srv_test",
                version: "0.17.6",
                features,
              },
            },
          }),
        );
        return;
      }

      if (
        parsed.type === "session" &&
        parsed.message?.type === "network.tunnel.create_ticket.request" &&
        parsed.message.requestId
      ) {
        const requestId = parsed.message.requestId;
        emitMessage(
          JSON.stringify({
            type: "session",
            message: {
              type: "network.tunnel.create_ticket.response",
              payload: {
                requestId,
                ticket: "tkt_fake_secret",
                expiresAtMs: 1_900_000_000_000,
              },
            },
          }),
        );
      }
    },
    close() {
      for (const handler of closeHandlers) {
        handler({ code: 1000, reason: "closed" });
      }
    },
  };

  return { transport, sent };
}

describe("DaemonClient.createNetworkTunnelTicket", () => {
  test("fails closed with unsupported_capability when daemon does not advertise features.networkTunnel", async () => {
    const { transport, sent } = createFakeTransport({});
    const client = new DaemonClient({
      url: "ws://127.0.0.1:6767/ws",
      clientId: "test-client",
      transportFactory: () => transport,
    });
    await client.connect();

    await expect(client.createNetworkTunnelTicket()).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    expect(
      sent.some(
        (m) =>
          (m as { message?: { type?: string } }).message?.type ===
          "network.tunnel.create_ticket.request",
      ),
    ).toBe(false);

    await client.close();
  });

  test("requests and returns a network tunnel ticket when features.networkTunnel is advertised", async () => {
    const { transport } = createFakeTransport({ networkTunnel: true });
    const client = new DaemonClient({
      url: "ws://127.0.0.1:6767/ws",
      clientId: "test-client",
      transportFactory: () => transport,
    });
    await client.connect();

    const result = await client.createNetworkTunnelTicket("req-ticket-1");
    expect(result).toEqual({
      requestId: "req-ticket-1",
      ticket: "tkt_fake_secret",
      expiresAtMs: 1_900_000_000_000,
    });

    await client.close();
  });
});
