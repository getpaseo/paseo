import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { PiACPAgentClient } from "../agent/providers/pi-acp-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { isProviderAvailable } from "./agent-configs.js";

process.env.PASEO_SUPERVISED = "0";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-pi-"));
}

describe("daemon E2E (real pi)", () => {
  test.runIf(isProviderAvailable("pi"))(
    "smoke test with thinking option configured separately from modes",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestPaseoDaemon({
        agentClients: { pi: new PiACPAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "pi-real-smoke" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "pi-real-smoke",
          provider: "pi",
          thinkingOptionId: "medium",
        });

        await client.sendMessage(agent.id, "Reply with exactly: PINEAPPLE");

        const finish = await client.waitForFinish(agent.id, 240_000);
        expect(finish.status).toBe("idle");
        expect(finish.final?.persistence).toBeTruthy();
        expect(finish.final?.persistence?.provider).toBe("pi");
        expect(finish.final?.persistence?.sessionId).toBeTruthy();

        const timeline = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });
        const assistantText = timeline.entries
          .filter(
            (
              entry,
            ): entry is typeof entry & {
              item: { type: "assistant_message"; text: string };
            } => entry.item.type === "assistant_message",
          )
          .map((entry) => entry.item.text)
          .join("\n");

        expect(assistantText.replace(/\s+/g, "")).toContain("PINEAPPLE");
      } finally {
        await client.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    420_000,
  );
});
