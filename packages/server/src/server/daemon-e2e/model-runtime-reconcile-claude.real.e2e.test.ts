import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestJunctionDaemon } from "../test-utils/junction-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { ClaudeAgentClient } from "../agent/providers/claude-agent.js";
import { isCommandAvailable } from "../agent/provider-launch-config.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-claude-runtime-model-reconcile-"));
}

describe("daemon E2E (real claude) - runtime model reconciliation", () => {
  test.runIf(isCommandAvailable("claude"))(
    "normalizes runtime model to a model ID exposed by the provider catalog",
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
          subscribe: { subscriptionId: "claude-runtime-model-reconcile" },
        });

        const modelsResult = await client.listProviderModels("claude", { cwd });
        expect(modelsResult.error).toBeNull();
        expect(modelsResult.models.length).toBeGreaterThan(0);
        const modelIds = new Set(modelsResult.models.map((model) => model.id));

        const agent = await client.createAgent({
          provider: "claude",
          cwd,
          title: "claude-runtime-model-reconcile",
        });

        await client.sendMessage(agent.id, "Reply with exactly: OK");
        const finish = await client.waitForFinish(agent.id, 180_000);
        expect(finish.status).toBe("idle");

        const snapshot = await client.fetchAgent(agent.id);
        expect(snapshot).not.toBeNull();
        const runtimeModelId = snapshot?.agent.runtimeInfo?.model ?? null;
        expect(typeof runtimeModelId).toBe("string");
        expect(runtimeModelId).not.toBe("");
        expect(modelIds.has(runtimeModelId as string)).toBe(true);
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    300_000
  );
});
