import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestJunctionDaemon } from "../test-utils/junction-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { ClaudeAgentClient } from "../agent/providers/claude-agent.js";
import { getFullAccessConfig } from "./agent-configs.js";
import { isCommandAvailable } from "../agent/provider-launch-config.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-rewind-dedupe-real-claude-"));
}

const hasClaudeCredentials =
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

describe("daemon E2E (real claude) - rewind user message dedupe", () => {
  test.runIf(isCommandAvailable("claude") && hasClaudeCredentials)(
    "emits /rewind user message once in persisted timeline",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "rewind-user-message-dedupe" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "rewind-user-message-dedupe-real-claude",
          ...getFullAccessConfig("claude"),
        });

        await client.sendMessage(agent.id, "Reply with exactly: READY");
        const initialResult = await client.waitForFinish(agent.id, 180_000);
        expect(initialResult.status).toBe("idle");

        await client.sendMessage(agent.id, "/rewind");
        const rewindResult = await client.waitForFinish(agent.id, 180_000);
        expect(rewindResult.status).not.toBe("timeout");

        const timeline = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });

        const rewindUserMessages = timeline.entries.filter(
          (entry) =>
            entry.item.type === "user_message" &&
            entry.item.text.trim() === "/rewind"
        );

        expect(rewindUserMessages).toHaveLength(1);
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    300_000
  );
});
