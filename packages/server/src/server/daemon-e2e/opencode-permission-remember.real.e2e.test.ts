import { beforeAll, beforeEach, describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { canRunRealProvider, createRealProviderClients } from "./real-provider-test-config.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-remember-"));
}

async function createHarness(): Promise<{
  client: DaemonClient;
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>;
}> {
  const logger = pino({ level: "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: createRealProviderClients(["opencode"], logger),
    logger,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "opencode-remember" } });
  return { client, daemon };
}

// C2: a permission approved with "Allow always" persists server-side via
// OpenCode's `reply: "always"` and is NOT re-prompted for a subsequent matching
// tool call within the same session.
describe("daemon E2E (real opencode) - permission remember", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("Allow always is remembered and not re-prompted within the session", async () => {
    const cwd = tmpCwd();
    // Force bash to require approval so the first `cat` triggers a permission
    // prompt whose "always" reply should whitelist matching commands.
    writeFileSync(
      path.join(cwd, "opencode.json"),
      JSON.stringify({
        permission: { bash: "ask" },
      }),
    );
    writeFileSync(path.join(cwd, "note.txt"), "hello world", "utf8");

    const { client, daemon } = await createHarness();
    const collector = createMessageCollector(client);

    try {
      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "OpenCode permission remember",
        model: "opencode/big-pickle",
        modeId: "build",
      });

      // First turn: ask it to read the file via bash `cat`. Bash is "ask", so we
      // expect a pending permission.
      await client.sendMessage(
        agent.id,
        "Use the bash tool to run exactly `cat note.txt` and then reply DONE. Do not use the read tool.",
      );

      const firstPermission = await client.waitForFinish(agent.id, 120_000);
      expect(firstPermission.status).toBe("permission");
      const permission = firstPermission.final?.pendingPermissions?.[0];
      expect(permission).toBeTruthy();

      // Approve with "Allow always" — persists server-side via reply: "always".
      await client.respondToPermission(agent.id, permission!.id, {
        behavior: "allow",
        selectedActionId: "allow_always",
      });

      const firstDone = await client.waitForFinish(agent.id, 120_000);
      expect(firstDone.status).toBe("idle");

      // Second turn: run the same command again. Because "always" was chosen, the
      // OpenCode server should auto-approve and never surface a new permission.
      collector.clear();
      await client.sendMessage(
        agent.id,
        "Use the bash tool to run exactly `cat note.txt` again and then reply DONE. Do not use the read tool.",
      );

      const secondDone = await client.waitForFinish(agent.id, 120_000);
      expect(secondDone.status).toBe("idle");
      expect(secondDone.final?.pendingPermissions?.length ?? 0).toBe(0);

      // No permission_requested event should have been emitted for the second run.
      const rePrompted = collector.messages.some(
        (m) =>
          m.type === "agent_stream" &&
          m.payload.agentId === agent.id &&
          m.payload.event.type === "permission_requested",
      );
      expect(rePrompted).toBe(false);

      await client.deleteAgent(agent.id);
    } finally {
      collector.unsubscribe();
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
