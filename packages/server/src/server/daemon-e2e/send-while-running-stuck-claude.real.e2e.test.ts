import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestJunctionDaemon } from "../test-utils/junction-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { ClaudeAgentClient } from "../agent/providers/claude-agent.js";
import { getFullAccessConfig } from "./agent-configs.js";
import { applyAgentInputProcessingTransition } from "./send-while-running-stuck-test-utils.js";
import { isCommandAvailable } from "../agent/provider-launch-config.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-stuck-claude-"));
}

describe("daemon E2E (real claude) - send while running recovery", () => {
  test.runIf(isCommandAvailable("claude"))(
    "clears input processing when the interrupt transition is missed",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });

      const primary = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      const secondary = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await primary.connect();
        await secondary.connect();
        await primary.fetchAgents({ subscribe: { subscriptionId: "primary" } });
        await secondary.fetchAgents({ subscribe: { subscriptionId: "secondary" } });

        const agent = await primary.createAgent({
          cwd,
          title: "stuck-repro-real-claude",
          ...getFullAccessConfig("claude"),
        });

        await primary.sendMessage(
          agent.id,
          "Run bash command sleep 30, wait for completion, then reply done."
        );
        await primary.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          60_000
        );

        let isProcessing = true;
        let previousIsRunning = true;
        let latestUpdatedAt = Date.now();

        await primary.close();

        await secondary.sendMessage(agent.id, "Reply with exactly: state saved");
        await secondary.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          60_000
        );

        const reconnected = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
        try {
          await reconnected.connect();
          const applySnapshot = (
            snapshot: Parameters<typeof applyAgentInputProcessingTransition>[0]["snapshot"]
          ) => {
            const next = applyAgentInputProcessingTransition({
              snapshot,
              currentIsProcessing: isProcessing,
              previousIsRunning,
              latestUpdatedAt,
            });
            isProcessing = next.isProcessing;
            previousIsRunning = next.previousIsRunning;
            latestUpdatedAt = next.latestUpdatedAt;
          };

          reconnected.on("agent_update", (message) => {
            if (message.type !== "agent_update" || message.payload.kind !== "upsert") {
              return;
            }
            if (message.payload.agent.id !== agent.id) {
              return;
            }
            applySnapshot(message.payload.agent);
          });

          const initial = await reconnected.fetchAgents({
            subscribe: { subscriptionId: "reconnected" },
          });
          const hydratedSnapshot = initial.entries.find(
            (candidate) => candidate.agent.id === agent.id
          )?.agent;
          if (hydratedSnapshot) {
            applySnapshot(hydratedSnapshot);
          }

          await secondary.waitForFinish(agent.id, 180_000);
          const finalResult = await secondary.fetchAgent(agent.id);
          if (finalResult) {
            applySnapshot(finalResult.agent);
          }

          // Sending while running should clear processing even if reconnect misses the
          // not-running -> running transition.
          expect(isProcessing).toBe(false);
        } finally {
          await reconnected.close();
        }
      } finally {
        await secondary.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    300_000
  );
});
