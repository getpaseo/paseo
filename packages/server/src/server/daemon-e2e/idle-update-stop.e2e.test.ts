import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

// An embedded daemon has no lifecycle handler, so it cannot act on a shutdown.
// It must decline an idle stop instead of claiming one it will never carry out.
test("a daemon that cannot stop itself declines an idle stop and keeps accepting agent work", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();

    await expect(client.shutdownServer({ onlyIfIdle: true })).rejects.toThrow(
      "This daemon cannot stop itself",
    );

    const agent = await client.createAgent({
      provider: "claude",
      cwd: daemon.paseoHome,
      title: "Created after a declined idle stop",
    });
    expect(agent.lifecycle).not.toBe("error");
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
