import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

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
