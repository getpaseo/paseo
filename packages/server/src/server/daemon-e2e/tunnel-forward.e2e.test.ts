import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { TunnelCloseReason, TunnelStreamOpcode } from "@getpaseo/protocol/binary-frames/index";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

/**
 * End-to-end coverage of the TCP port-forward over a real daemon WebSocket and
 * the real @getpaseo/client driver: client Open/Data → daemon dials
 * 127.0.0.1:<port> → response Data/Close streams back. This exercises everything
 * except the Electron main-process loopback listener and the React UI, which
 * need an Electron harness.
 */

// http.Server extends net.Server, so these accept either.
function listenServer(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function createEchoServer(): net.Server {
  return net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => socket.destroy());
  });
}

/** Allocate a port, then free it, so a connect to it is refused. */
function freedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface StreamResult {
  data: Uint8Array;
  reason: number;
}

/** Collect a stream's Data frames until its Close arrives. */
function collectStream(client: DaemonClient, streamId: string): Promise<StreamResult> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    const unsubscribe = client.onTunnelFrame((frame) => {
      if (frame.streamId !== streamId) {
        return;
      }
      if (frame.opcode === TunnelStreamOpcode.Data) {
        chunks.push(frame.payload);
        return;
      }
      if (frame.opcode === TunnelStreamOpcode.Close) {
        unsubscribe();
        resolve({ data: concatBytes(chunks), reason: frame.reason });
      }
    });
  });
}

describe("daemon E2E - TCP tunnel forward", () => {
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => undefined);
    }
    client = undefined;
    daemon = undefined;
  });

  async function connectClient(): Promise<DaemonClient> {
    daemon = await createTestPaseoDaemon();
    const connected = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    await connected.connect();
    await connected.fetchAgents({ subscribe: { subscriptionId: "tunnel-e2e" } });
    client = connected;
    return connected;
  }

  test("forwards an HTTP request to a loopback server and streams the full response back", async () => {
    const body = "abcdefghij".repeat(20_000); // 200 KB → many Data frames
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": String(body.length),
        Connection: "close",
      });
      res.end(body);
    });
    const port = await listenServer(server);
    cleanups.push(() => closeServer(server));

    const connected = await connectClient();
    const streamId = "http-1";
    const done = collectStream(connected, streamId);
    connected.openTunnelStream(streamId, port);
    connected.sendTunnelData(
      streamId,
      new TextEncoder().encode("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
    );

    const result = await done;
    const text = new TextDecoder().decode(result.data);
    const separator = text.indexOf("\r\n\r\n");

    expect(result.reason).toBe(TunnelCloseReason.Normal);
    expect(text.startsWith("HTTP/1.1 200")).toBe(true);
    expect(separator).toBeGreaterThan(-1);
    // The whole body survives — no truncation across frames or at close.
    expect(text.slice(separator + 4)).toBe(body);
  }, 20_000);

  test("emits a ConnectFailed close when the loopback target is not listening", async () => {
    const deadPort = await freedPort();
    const connected = await connectClient();
    const streamId = "dead-1";
    const done = collectStream(connected, streamId);
    connected.openTunnelStream(streamId, deadPort);

    const result = await done;
    expect(result.reason).toBe(TunnelCloseReason.ConnectFailed);
    expect(result.data.byteLength).toBe(0);
  });

  test("delivers a raw byte echo in both directions", async () => {
    const server = createEchoServer();
    const port = await listenServer(server);
    cleanups.push(() => closeServer(server));

    const connected = await connectClient();
    const streamId = "echo-1";
    const chunks: Uint8Array[] = [];
    const unsubscribe = connected.onTunnelFrame((frame) => {
      if (frame.streamId === streamId && frame.opcode === TunnelStreamOpcode.Data) {
        chunks.push(frame.payload);
      }
    });
    cleanups.push(async () => unsubscribe());

    connected.openTunnelStream(streamId, port);
    connected.sendTunnelData(streamId, new TextEncoder().encode("hello tunnel"));

    await expect
      .poll(() => new TextDecoder().decode(concatBytes(chunks)), { timeout: 5_000 })
      .toBe("hello tunnel");
  });
});
