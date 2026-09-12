import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

interface TunneledConnection {
  req: IncomingMessage;
  socket: Socket;
  tunneledRequests: string[];
}

// EnvHttpProxyAgent tunnels every proxied request through CONNECT, even a plain http://
// target, so the fake proxy must speak the CONNECT handshake and then read/answer the
// plain HTTP request written into that tunnel.
function onTunnelData({ req, socket, tunneledRequests }: TunneledConnection) {
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

function handleTunneledRequest({ req, socket, tunneledRequests }: TunneledConnection) {
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  onTunnelData({ req, socket, tunneledRequests });
}

function getListeningPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`Expected the fake proxy to listen on a TCP port, got ${String(address)}`);
  }
  return address.port;
}

interface IsolatedFetchOptions {
  proxyUrl: string;
  enabled: boolean;
}

async function runIsolatedFetch({ proxyUrl, enabled }: IsolatedFetchOptions) {
  const dispatcherModule = new URL("./global-proxy-dispatcher.ts", import.meta.url).href;
  const script = `
    const { installGlobalProxyDispatcher } = await import(${JSON.stringify(dispatcherModule)});
    installGlobalProxyDispatcher(${enabled});
    installGlobalProxyDispatcher(${enabled});
    const response = await fetch("http://example.invalid/some-path");
    process.stdout.write(await response.text());
  `;
  const env = {
    ...process.env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: "",
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    no_proxy: "",
    ALL_PROXY: "",
    all_proxy: "",
  };

  return execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), env },
  );
}

describe("installGlobalProxyDispatcher", () => {
  test("only routes daemon-issued fetch() through HTTP_PROXY once enabled", async () => {
    const tunneledRequests: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, socket) => handleTunneledRequest({ req, socket, tunneledRequests }));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const port = getListeningPort(proxy);

    try {
      const proxyUrl = `http://127.0.0.1:${port}`;

      // Disabled (e.g. globalProxyDispatcher: false): fetch reaches example.invalid directly
      // and fails DNS resolution rather than going through the configured proxy.
      await expect(runIsolatedFetch({ proxyUrl, enabled: false })).rejects.toThrow();
      expect(tunneledRequests).toEqual([]);

      // Enabled: fetch now tunnels through HTTP_PROXY. Called twice to prove the install
      // is idempotent and does not throw.
      const { stdout } = await runIsolatedFetch({ proxyUrl, enabled: true });

      expect(stdout).toBe("ok-from-proxy");
      expect(tunneledRequests).toEqual(["example.invalid:80 :: GET /some-path HTTP/1.1"]);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
