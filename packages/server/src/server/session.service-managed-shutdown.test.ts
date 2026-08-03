import { describe, expect, test } from "vitest";

import type { DaemonLifecycleIntent } from "./bootstrap.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

/**
 * The lifecycle intent is the only channel from a session to the daemon worker,
 * and from there to the fork supervisor. An intent that is never emitted is a
 * worker that is never asked to stop, which is the invariant these tests hold:
 * a launchd/systemd/Docker-owned daemon cannot be taken down by a routine client.
 */
async function withDaemon(
  options: { serviceManaged?: boolean },
  run: (context: { client: DaemonClient; intents: DaemonLifecycleIntent[] }) => Promise<void>,
): Promise<void> {
  const intents: DaemonLifecycleIntent[] = [];
  const daemon = await createTestPaseoDaemon({
    serviceManaged: options.serviceManaged,
    onLifecycleIntent: (intent) => {
      intents.push(intent);
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await run({ client, intents });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}

describe("service-managed daemon shutdown fence", () => {
  test("refuses an ordinary client shutdown and leaves the worker running", async () => {
    await withDaemon({ serviceManaged: true }, async ({ client, intents }) => {
      await expect(client.shutdownServer({ timeout: 5_000 })).rejects.toMatchObject({
        name: "DaemonShutdownRejectedError",
        reason: "service_managed",
      });

      expect(intents).toEqual([]);

      // The daemon is still serving: the fence refused the request, it did not
      // half-stop the process.
      const agents = await client.fetchAgents();
      expect(Array.isArray(agents.entries)).toBe(true);
    });
  }, 30_000);

  test("honors an explicit service maintenance shutdown", async () => {
    await withDaemon({ serviceManaged: true }, async ({ client, intents }) => {
      const payload = await client.shutdownServer({
        timeout: 5_000,
        serviceMaintenance: true,
      });

      expect(payload.status).toBe("shutdown_requested");
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ type: "shutdown", reason: "client_shutdown_rpc" });
    });
  }, 30_000);

  test("an unmanaged daemon still shuts down on an ordinary client shutdown", async () => {
    await withDaemon({}, async ({ client, intents }) => {
      const payload = await client.shutdownServer({ timeout: 5_000 });

      expect(payload.status).toBe("shutdown_requested");
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ type: "shutdown", reason: "client_shutdown_rpc" });
    });
  }, 30_000);
});
