import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import type { SessionOutboundMessage } from "../messages.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createEvidenceRedactor } from "./hermes-acp-steering-evidence.js";

const startPrompt =
  "Use the terminal tool in the foreground to run exactly: printf 'HERMES_ACP_STEER_START\\n'; sleep 12; printf 'HERMES_ACP_STEER_END\\n'. Do not stop it.";
const correctionPrompt =
  "Keep the active tool process running. After it reaches HERMES_ACP_STEER_END, reply exactly HERMES_ACP_STEER_ACK.";
const nextPrompt = "Reply exactly HERMES_ACP_STEER_NEXT_ACK.";

function agentEvents(messages: SessionOutboundMessage[], agentId: string, type: string) {
  return messages.filter(
    (message) =>
      message.type === "agent_stream" &&
      message.payload.agentId === agentId &&
      message.payload.event.type === type,
  );
}

function targetAgentMessages(messages: SessionOutboundMessage[], agentId: string) {
  return messages.filter(
    (message) =>
      (message.type === "agent_stream" && message.payload.agentId === agentId) ||
      (message.type === "agent_update" &&
        message.payload.kind === "upsert" &&
        message.payload.agent.id === agentId),
  );
}

async function waitForToolBoundary(
  client: DaemonClient,
  messages: SessionOutboundMessage[],
  agentId: string,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const running = messages.some(
      (message) =>
        message.type === "agent_stream" &&
        message.payload.agentId === agentId &&
        message.payload.event.type === "timeline" &&
        message.payload.event.item.type === "tool_call" &&
        message.payload.event.item.status === "running",
    );
    if (running) return;
    const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 });
    if (
      timeline.entries.some(
        (entry) => entry.item.type === "tool_call" && entry.item.status === "running",
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Hermes did not expose a running tool-call boundary");
}

describe("daemon E2E (real Hermes ACP) - active turn steering", () => {
  test("keeps one Hermes ACP turn and its foreground tool alive while correcting it", async () => {
    const artifactRoot = process.env.PASEO_HERMES_STEERING_ARTIFACT_DIR
      ? path.resolve(process.env.PASEO_HERMES_STEERING_ARTIFACT_DIR)
      : await mkdtemp(path.join(tmpdir(), "paseo-hermes-acp-steering-artifact-"));
    await mkdir(artifactRoot, { recursive: true });
    const workspace = await mkdtemp(path.join(tmpdir(), "paseo-hermes-acp-workspace-"));
    let daemon: TestPaseoDaemon | null = null;
    let client: DaemonClient | null = null;
    let collector: ReturnType<typeof createMessageCollector> | null = null;
    let daemonLog: Record<string, string> = { status: "not-attempted" };
    const evidence: Record<string, unknown> = {
      expected: "same-turn-steer",
      provider: "hermes acp",
      artifactRoot,
      startedAt: new Date().toISOString(),
    };
    try {
      const version = execFileSync("hermes", ["--version"], { encoding: "utf8" })
        .trim()
        .split("\n")[0];
      evidence.hermesVersion = version;
      evidence.candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();
      daemon = await createTestPaseoDaemon({
        mcpEnabled: false,
        providerOverrides: {
          hermes: {
            extends: "acp",
            label: "Hermes",
            command: ["hermes", "acp"],
            params: { activeTurnSteering: "concurrent_prompt" },
          },
        },
      });
      evidence.paseoHome = "<temporary-paseo-home>";
      evidence.port = daemon.port;
      client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        appVersion: "0.1.70",
      });
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "hermes-steering" } });
      collector = createMessageCollector(client);
      const agent = await client.createAgent({
        provider: "hermes",
        cwd: workspace,
        title: "hermes-acp-steering",
      });
      evidence.agentId = "<agent-1>";
      await client.sendAgentMessage(agent.id, startPrompt, { messageId: "hermes-steer-start" });
      await waitForToolBoundary(client, collector.messages, agent.id);
      await client.sendAgentMessage(agent.id, correctionPrompt, {
        messageId: "hermes-steer-correction",
        activeTurnBehavior: "steer",
      });
      const finished = await client.waitForFinish(agent.id, 120_000);
      const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
      const turnsStarted = agentEvents(collector.messages, agent.id, "turn_started");
      const turnsCanceled = agentEvents(collector.messages, agent.id, "turn_canceled");
      const redact = createEvidenceRedactor(
        [workspace, daemon.paseoHome],
        new Map([
          [agent.id, "<agent-1>"],
          [turnsStarted[0]?.payload.event.turnId ?? "", "<turn-1>"],
        ]),
      );
      const assistantText = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => entry.item.text)
        .join("\n");
      evidence.actual = {
        finalStatus: finished.status,
        turnStartedCount: turnsStarted.length,
        turnCanceledCount: turnsCanceled.length,
        assistantText,
      };
      await writeFile(
        path.join(artifactRoot, "daemon-messages.json"),
        JSON.stringify(redact(targetAgentMessages(collector.messages, agent.id)), null, 2),
      );
      await writeFile(
        path.join(artifactRoot, "timeline.json"),
        JSON.stringify(redact(timeline), null, 2),
      );
      expect(finished.status).toBe("idle");
      expect(turnsStarted).toHaveLength(1);
      expect(turnsCanceled).toHaveLength(0);
      const completedTools = timeline.entries.filter(
        (entry) => entry.item.type === "tool_call" && entry.item.status === "completed",
      );
      expect(completedTools).toEqual([
        expect.objectContaining({
          turnId: turnsStarted[0]?.payload.event.turnId,
          item: expect.objectContaining({
            type: "tool_call",
            status: "completed",
            error: null,
            detail: {
              type: "shell",
              command:
                "terminal: printf 'HERMES_ACP_STEER_START\\n'; sleep 12; printf 'HERMES_ACP_STEER_END\\n'",
              output:
                "terminal result\n- **output:** HERMES_ACP_STEER_START\nHERMES_ACP_STEER_END\n- **exit_code:** 0",
            },
          }),
        }),
      ]);
      const correction = timeline.entries.find(
        (entry) =>
          entry.item.type === "user_message" && entry.item.messageId === "hermes-steer-correction",
      );
      expect(correction?.turnId).toBe(turnsStarted[0]?.payload.event.turnId);
      expect(assistantText).toContain("HERMES_ACP_STEER_ACK");
      await client.sendAgentMessage(agent.id, nextPrompt, { messageId: "hermes-steer-next" });
      const nextFinished = await client.waitForFinish(agent.id, 60_000);
      expect(nextFinished.status).toBe("idle");
      const afterNextPrompt = await client.fetchAgentTimeline(agent.id, { limit: 100 });
      const nextAcknowledged = afterNextPrompt.entries.some(
        (entry) =>
          entry.item.type === "assistant_message" &&
          entry.item.text.includes("HERMES_ACP_STEER_NEXT_ACK"),
      );
      evidence.nextPrompt = { status: nextFinished.status, acknowledged: nextAcknowledged };
      await writeFile(
        path.join(artifactRoot, "daemon-messages.json"),
        JSON.stringify(redact(targetAgentMessages(collector.messages, agent.id)), null, 2),
      );
      await writeFile(
        path.join(artifactRoot, "timeline.json"),
        JSON.stringify(redact(afterNextPrompt), null, 2),
      );
      expect(nextAcknowledged).toBe(true);
    } finally {
      collector?.unsubscribe();
      await client?.close();
      if (daemon) {
        try {
          await copyFile(
            path.join(daemon.paseoHome, "daemon.log"),
            path.join(artifactRoot, "daemon.log"),
          );
          daemonLog = { status: "captured" };
        } catch (error) {
          daemonLog = {
            status: "unavailable",
            reason: error instanceof Error ? error.name : "unknown-error",
          };
        }
      }
      await daemon?.close();
      await rm(workspace, { recursive: true, force: true });
      evidence.finishedAt = new Date().toISOString();
      evidence.daemonLog = daemonLog;
      evidence.cleanup = {
        workspaceRemoved: !existsSync(workspace),
        paseoHomeRemoved: daemon ? !existsSync(daemon.paseoHome) : null,
      };
      await writeFile(
        path.join(artifactRoot, "summary.json"),
        JSON.stringify(
          createEvidenceRedactor([workspace, daemon?.paseoHome ?? ""], new Map())(evidence),
          null,
          2,
        ),
      );
      process.stdout.write(`Hermes ACP steering evidence: ${artifactRoot}\n`);
    }
  }, 240_000);
});
