import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);

// Opt in on Linux with passwordless sudo, unshare, ip, mount, and tc available:
// RUN_RELAY_LATENCY_E2E=1 npx vitest run src/server/relay-transport.latency.e2e.test.ts
// All networking and the hosts-file mount are private to the child namespaces.
test.runIf(process.platform === "linux" && process.env.RUN_RELAY_LATENCY_E2E === "1")(
  "connects relay control and data over a slow dual-stack route with an unreachable address",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-relay-latency-"));
    try {
      const hosts = path.join(directory, "hosts");
      await writeFile(
        hosts,
        `${await readFile("/etc/hosts", "utf8")}\n127.0.0.1 relay-latency.test\n2001:db8:1::1 relay-latency.test\n`,
      );
      const fixture = fileURLToPath(
        new URL("./test-utils/relay-latency-fixture.ts", import.meta.url),
      );
      for (const order of ["ipv4first", "ipv6first"]) {
        const { stdout } = await run(
          "sudo",
          [
            "-n",
            "unshare",
            "--mount",
            "--net",
            "sh",
            "-ec",
            `mount --make-rprivate /
mount --bind "$1" /etc/hosts
ip link set lo up
ip link add relay-test type dummy
ip addr add 192.0.2.2/32 dev relay-test
ip -6 addr add 2001:db8::2/128 dev relay-test
ip link set relay-test up
tc qdisc add dev lo root netem delay 350ms
exec "$2" --import tsx "$3" "$4"`,
            "sh",
            hosts,
            process.execPath,
            fixture,
            order,
          ],
          { timeout: 20_000 },
        );
        expect(stdout).toContain("relay data round trip passed");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);
