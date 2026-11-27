import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createHostTransportFactory } from "./index.js";
import type { DaemonTransport } from "../daemon-client-transport-types.js";

const run = promisify(execFile);
const hasSsh = !spawnSync("ssh", ["-V"]).error;

test.skipIf(!hasSsh)(
  "an SSH peer abort during a pending write closes the tunnel without crashing its caller",
  async () => {
    // Isolate the caller so an unhandled stream error fails this assertion instead
    // of crashing the test worker. Both the TCP peer and OpenSSH are real.
    const { stdout } = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
        import { createServer, createConnection } from 'node:net';
        import { once } from 'node:events';
        import { createSshTunnel } from ${JSON.stringify(new URL("./ssh-tunnel.ts", import.meta.url).href)};

        const remote = createServer(socket => socket.destroy());
        remote.listen(0, '127.0.0.1');
        await once(remote, 'listening');
        const tunnel = await createSshTunnel({
          host: '127.0.0.1', sshPort: remote.address().port, daemonPort: 6767,
        });
        const [host, port] = tunnel.endpoint.split(':');
        const client = createConnection({ host, port: Number(port) });
        client.on('error', () => undefined);
        try {
          const closed = new Promise(resolve => client.once('close', resolve));
          await once(client, 'connect');
          client.write(Buffer.alloc(8 * 1024 * 1024, 65));
          await closed;
          console.log(JSON.stringify({ closed: client.destroyed, failure: tunnel.failureDetail() }));
        } finally {
          client.destroy();
          tunnel.close();
          await new Promise(resolve => remote.close(resolve));
        }
      `,
      ],
      { timeout: 10_000 },
    );
    expect(JSON.parse(stdout)).toEqual({
      closed: true,
      failure: expect.any(String),
    });
    expect(JSON.parse(stdout).failure).not.toBe("");
  },
);

const supportsEt = process.platform === "linux" || process.platform === "darwin";

function echoMessages(socket: WebSocket): void {
  socket.on("message", (data, binary) => socket.send(data, { binary }));
}

async function withEtExecutable(
  script: string | null,
  runTest: () => Promise<void>,
): Promise<void> {
  const bin = await mkdtemp(join(tmpdir(), "paseo-et-test-"));
  try {
    if (script !== null) {
      const adapter = join(bin, "adapter.mjs");
      await writeFile(
        join(bin, "et"),
        '#!/bin/sh\nexec "$PASEO_TEST_NODE" "$PASEO_TEST_ET" "$@"\n',
        { mode: 0o700 },
      );
      await writeFile(adapter, script);
      vi.stubEnv("PASEO_TEST_NODE", process.execPath);
      vi.stubEnv("PASEO_TEST_ET", adapter);
    }
    vi.stubEnv("PATH", bin);
    await runTest();
  } finally {
    vi.unstubAllEnvs();
    await rm(bin, { recursive: true, force: true });
  }
}

test.skipIf(!supportsEt)(
  "the Node connector carries binary WebSocket messages through the ET child",
  async () => {
    await withEtExecutable(
      `import { createConnection } from 'node:net';
      const args = process.argv.slice(2);
      if (args[0] === '--version') {
        console.log('et version 7.1.1');
      } else {
        const [host, port] = args[args.indexOf('-W') + 1].split(':');
        const remote = createConnection({ host, port: Number(port) });
        process.stdin.pipe(remote);
        remote.pipe(process.stdout);
      }`,
      async () => {
        const daemon = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ws" });
        let transport: DaemonTransport | undefined;
        try {
          await once(daemon, "listening");
          const address = daemon.address();
          if (typeof address === "string" || !address) throw new Error("Missing test daemon port");
          daemon.on("connection", echoMessages);
          const url = `et://test-host?daemonPort=${address.port}`;
          const webSocketAgent = vi.fn(() => {
            throw new Error("Proxied the loopback tunnel");
          });
          const connection = createHostTransportFactory(url, undefined, { webSocketAgent })({
            url,
          });
          transport = connection;
          const payload = Uint8Array.of(0, 127, 255);
          const reply = await new Promise((resolve, reject) => {
            connection.onError(reject);
            connection.onOpen(() => connection.send(payload));
            connection.onMessage((data, binary) => resolve({ data, binary }));
          });
          expect(reply).toEqual({ data: payload.buffer, binary: true });
          expect(webSocketAgent).not.toHaveBeenCalled();
        } finally {
          transport?.close();
          await new Promise<void>((resolve) => daemon.close(() => resolve()));
        }
      },
    );
  },
);

test.skipIf(!supportsEt).each([
  {
    label: "missing",
    script: null,
    detail: "Eternal Terminal is missing. Install et 7.1.1 or later on this machine.",
  },
  {
    label: "unsupported",
    script: "console.log('et version 7.1.0');",
    detail: "Unsupported Eternal Terminal version. Install et 7.1.1 or later on this machine.",
  },
  {
    label: "not forwarding the WebSocket upgrade",
    script: `if (process.argv[2] === '--version') {
      console.log('et version 7.1.1');
    } else {
      console.log('private ET stdout');
      console.error('private ET stderr');
      process.stdin.resume();
    }`,
    detail:
      "Eternal Terminal could not forward the Paseo WebSocket. Check etserver and the remote Paseo daemon port.",
  },
])("reports actionable diagnostics when ET is $label", async ({ script, detail }) => {
  await withEtExecutable(script, async () => {
    const url = "et://test-host";
    const transport = createHostTransportFactory(url)({ url });
    try {
      const failure = await new Promise((resolve) => transport.onError(resolve));
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toHaveProperty("message", detail);
    } finally {
      transport.close();
    }
  });
});
