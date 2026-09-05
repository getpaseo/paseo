import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, test } from "vitest";

import { installGlobalProxyDispatcher } from "./global-proxy-dispatcher.js";

// EnvHttpProxyAgent tunnels every proxied request through CONNECT, even a plain http://
// target, so the fake proxy must speak the CONNECT handshake and then read/answer the
// plain HTTP request written into that tunnel.
function onTunnelData(req: IncomingMessage, socket: Socket, tunneledRequests: string[]) {
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    if (!buffered.includes("\r\n\r\n")) return;
    tunneledRequests.push(`${req.url} :: ${buffered.split("\r\n")[0]}`);
    const body = "ok-from-proxy";
    socket.end(
      `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
    );
  });
}

function handleTunneledRequest(req: IncomingMessage, socket: Socket, tunneledRequests: string[]) {
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  onTunnelData(req, socket, tunneledRequests);
}

describe("installGlobalProxyDispatcher", () => {
  test("routes a daemon-issued fetch() through HTTP_PROXY", async () => {
    const tunneledRequests: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, socket) => handleTunneledRequest(req, socket, tunneledRequests));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const { port } = proxy.address() as AddressInfo;

    try {
      process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
      // Idempotent: called twice, still installs exactly one dispatcher and does not throw.
      installGlobalProxyDispatcher();
      installGlobalProxyDispatcher();

      const response = await fetch("http://example.invalid/some-path");

      expect(await response.text()).toBe("ok-from-proxy");
      expect(tunneledRequests).toEqual(["example.invalid:80 :: GET /some-path HTTP/1.1"]);
    } finally {
      delete process.env.HTTP_PROXY;
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
