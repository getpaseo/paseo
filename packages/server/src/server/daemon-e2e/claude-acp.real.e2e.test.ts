import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { ClaudeACPAgentClient } from "../agent/providers/claude-acp-agent.js";
import type { SessionOutboundMessage } from "../messages.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getAskModeConfig, getFullAccessConfig, isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-claude-acp-"));
}

describe("daemon E2E (real claude-acp)", () => {
  test.runIf(isProviderAvailable("claude-acp"))(
    "smoke test in full-access mode",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestPaseoDaemon({
        agentClients: { "claude-acp": new ClaudeACPAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-acp-real-smoke" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-acp-real-smoke",
          ...getFullAccessConfig("claude-acp"),
        });

        await client.sendMessage(
          agent.id,
          "Reply with exactly: PINEAPPLE",
        );

        const finish = await client.waitForFinish(agent.id, 240_000);
        expect(finish.status).toBe("idle");
        expect(finish.final?.persistence).toBeTruthy();
        expect(finish.final?.persistence?.provider).toBe("claude-acp");
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

        expect(assistantText).toContain("PINEAPPLE");
      } finally {
        await client.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    420_000,
  );

  test.runIf(isProviderAvailable("claude-acp"))(
    "permission flow in ask mode",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestPaseoDaemon({
        agentClients: { "claude-acp": new ClaudeACPAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      const messages: SessionOutboundMessage[] = [];
      const targetFile = path.join(cwd, "permission-target.txt");

      try {
        writeFileSync(targetFile, "ACP_PERMISSION_CONTENT\n", "utf8");

        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-acp-real-permission" },
        });

        const unsubscribe = client.subscribeRawMessages((message) => {
          messages.push(message);
        });

        try {
          const agent = await client.createAgent({
            cwd,
            title: "claude-acp-real-permission",
            ...getAskModeConfig("claude-acp"),
          });

          await client.sendMessage(
            agent.id,
            [
              `Use the Bash tool to run exactly: cat ${JSON.stringify(targetFile)}.`,
              "If approval is required, wait for approval.",
              "After the command succeeds, reply with exactly: ACP_PERMISSION_DONE",
            ].join(" "),
          );

          const permissionState = await client.waitForFinish(agent.id, 30_000);
          expect(permissionState.status).toBe("permission");
          expect(permissionState.final?.pendingPermissions?.length).toBeGreaterThan(0);

          const permission = permissionState.final!.pendingPermissions[0]!;
          await client.respondToPermission(agent.id, permission.id, {
            behavior: "allow",
          });

          const finalState = await client.waitForFinish(agent.id, 60_000);
          expect(finalState.status).toBe("idle");

          const hasPermissionResolved = messages.some((message) => {
            if (message.type !== "agent_stream") {
              return false;
            }
            if (message.payload.agentId !== agent.id) {
              return false;
            }
            return (
              message.payload.event.type === "permission_resolved" &&
              message.payload.event.requestId === permission.id &&
              message.payload.event.resolution.behavior === "allow"
            );
          });
          expect(hasPermissionResolved).toBe(true);
        } finally {
          unsubscribe();
        }
      } finally {
        await client.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    420_000,
  );
});
