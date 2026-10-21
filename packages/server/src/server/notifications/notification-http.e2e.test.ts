import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createNotificationHttp, postNotification } from "./notification-http.js";

const run = promisify(execFile);

// This TLS fixture uses the OpenSSL CLI, which is not part of the Windows runner contract.
test.skipIf(process.platform === "win32")(
  "notification HTTP honors HTTP_PROXY, HTTPS_PROXY and NO_PROXY through a real CONNECT proxy",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-notification-proxy-"));
    const key = join(home, "key.pem");
    const cert = join(home, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    let targetRequests = 0;
    const tunnels: string[] = [];
    const sockets = new Set<Socket>();
    const target = createServer((_request, response) => {
      targetRequests++;
      response.end(JSON.stringify({ ok: true }));
    });
    const tlsTarget = createTlsServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (_request, response) => {
        targetRequests++;
        response.end(JSON.stringify({ ok: true }));
      },
    );
    const proxy = createServer();
    proxy.on("connect", (request, socket, head) => {
      tunnels.push(request.url!);
      const [host, port] = request.url!.split(":");
      const upstream = connect(Number(port), host);
      sockets.add(upstream);
      sockets.add(socket);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
    });
    async function listen(server: typeof target | typeof tlsTarget): Promise<number> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener address");
      return address.port;
    }
    const transports: ReturnType<typeof createNotificationHttp>[] = [];
    try {
      const port = await listen(target);
      const tlsPort = await listen(tlsTarget);
      const proxyPort = await listen(proxy);
      const proxyUrl = `http://127.0.0.1:${proxyPort}`;
      const transport = createNotificationHttp({ HTTP_PROXY: proxyUrl, NO_PROXY: "" });
      transports.push(transport);
      expect(await postNotification(transport.request, `http://127.0.0.1:${port}`, {}, {})).toEqual(
        {
          ok: true,
        },
      );
      const direct = createNotificationHttp({
        HTTP_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "127.0.0.1",
      });
      transports.push(direct);
      expect(await postNotification(direct.request, `http://127.0.0.1:${port}`, {}, {})).toEqual({
        ok: true,
      });
      const modulePath = fileURLToPath(new URL("./notification-http.ts", import.meta.url));
      // Node reads additional CA certificates at process startup.
      const script = `import { createNotificationHttp, postNotification } from ${JSON.stringify(modulePath)};
      const transport = createNotificationHttp({ HTTPS_PROXY: ${JSON.stringify(proxyUrl)}, NO_PROXY: "" });
      try { process.stdout.write(JSON.stringify(await postNotification(transport.request, "https://127.0.0.1:${tlsPort}", {}, {}))); }
      finally { await transport.close(); }`;
      const result = await run(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
          timeout: 15_000,
        },
      );
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
      expect(tunnels).toEqual([`127.0.0.1:${port}`, `127.0.0.1:${tlsPort}`]);
      expect(targetRequests).toBe(3);
    } finally {
      await Promise.all(transports.map((transport) => transport.close()));
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [target, tlsTarget, proxy].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      rmSync(home, { recursive: true, force: true });
    }
  },
  30000,
);
