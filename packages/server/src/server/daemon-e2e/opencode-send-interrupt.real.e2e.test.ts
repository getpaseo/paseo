import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient, type WaitForFinishResult } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { isProviderAvailable } from "./agent-configs.js";
import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";
import type { SessionOutboundMessage } from "../messages.js";

const SYSTEM_ERROR_SNIPPET = "A foreground turn is already active";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-send-interrupt-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasRunningBashToolCall(messages: SessionOutboundMessage[], agentId: string): boolean {
  return messages.some(
    (message) =>
      message.type === "agent_stream" &&
      message.payload.agentId === agentId &&
      message.payload.event.type === "timeline" &&
      message.payload.event.item.type === "tool_call" &&
      message.payload.event.item.status === "running" &&
      ["bash", "shell"].includes(message.payload.event.item.name.toLowerCase()),
  );
}

function getAssistantTexts(messages: SessionOutboundMessage[], agentId: string): string[] {
  return messages
    .filter(
      (message) =>
        message.type === "agent_stream" &&
        message.payload.agentId === agentId &&
        message.payload.event.type === "timeline" &&
        message.payload.event.item.type === "assistant_message",
    )
    .map((message) => message.payload.event.item.text);
}

function findSystemErrorText(texts: string[]): string | null {
  return texts.find((text) => text.includes("[System Error]")) ?? null;
}

function getTimelineAssistantTexts(
  timeline: Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>,
): string[] {
  return timeline.entries
    .filter((entry) => entry.item.type === "assistant_message")
    .map((entry) => entry.item.text);
}

function findSleepToolCall(
  timeline: Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>,
): { status: "running" | "completed" | "failed" | "canceled"; callId: string } | null {
  for (let idx = timeline.entries.length - 1; idx >= 0; idx -= 1) {
    const entry = timeline.entries[idx];
    if (entry?.item.type !== "tool_call") {
      continue;
    }
    if (entry.item.detail.type !== "shell") {
      continue;
    }
    if (!entry.item.detail.command.includes("sleep 60")) {
      continue;
    }
    return {
      status: entry.item.status,
      callId: entry.item.callId,
    };
  }
  return null;
}

async function allowPermission(
  client: DaemonClient,
  agentId: string,
  permission: AgentPermissionRequest,
): Promise<void> {
  if (permission.kind === "question") {
    throw new Error(
      `Unexpected question permission while waiting for tool call: ${permission.id} ${permission.title}`,
    );
  }
  await client.respondToPermission(agentId, permission.id, {
    behavior: "allow",
    message: "Approved by integration test",
  });
}

async function approvePendingPermissions(
  client: DaemonClient,
  agentId: string,
  handledPermissionIds: Set<string>,
): Promise<void> {
  const snapshot = await client.fetchAgent(agentId).catch(() => null);
  const pending = snapshot?.agent.pendingPermissions ?? [];
  const toApprove = pending.filter((permission) => !handledPermissionIds.has(permission.id));
  for (const permission of toApprove) {
    handledPermissionIds.add(permission.id);
  }
  await Promise.all(toApprove.map((permission) => allowPermission(client, agentId, permission)));
}

async function waitForRunningBashToolCall(
  client: DaemonClient,
  collector: ReturnType<typeof createMessageCollector>,
  agentId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const handledPermissionIds = new Set<string>();

  while (Date.now() < deadline) {
    await approvePendingPermissions(client, agentId, handledPermissionIds);

    const streamSystemError = findSystemErrorText(getAssistantTexts(collector.messages, agentId));
    if (streamSystemError) {
      throw new Error(`OpenCode failed before tool call started: ${streamSystemError}`);
    }

    if (hasRunningBashToolCall(collector.messages, agentId)) {
      return;
    }

    const timeline = await client.fetchAgentTimeline(agentId, { limit: 120 }).catch(() => null);
    const timelineSystemError = timeline
      ? findSystemErrorText(getTimelineAssistantTexts(timeline).slice(-8))
      : null;
    if (timelineSystemError) {
      throw new Error(`OpenCode failed before tool call started: ${timelineSystemError}`);
    }
    if (
      timeline?.entries.some(
        (entry) =>
          entry.item.type === "tool_call" &&
          entry.item.status === "running" &&
          ["bash", "shell"].includes(entry.item.name.toLowerCase()),
      )
    ) {
      return;
    }

    await sleep(500);
  }

  const timeline = await client.fetchAgentTimeline(agentId, { limit: 120 }).catch(() => null);
  const recentToolCalls =
    timeline?.entries
      .filter((entry) => entry.item.type === "tool_call")
      .slice(-10)
      .map((entry) => ({
        name: entry.item.name,
        status: entry.item.status,
        callId: entry.item.callId,
      })) ?? [];
  const recentAssistantTexts = timeline ? getTimelineAssistantTexts(timeline).slice(-6) : [];
  throw new Error(
    `Timed out waiting for running bash/shell tool call. recentToolCalls=${JSON.stringify(recentToolCalls)} recentAssistantTexts=${JSON.stringify(recentAssistantTexts)}`,
  );
}

async function waitForSleepToolCallTerminal(
  client: DaemonClient,
  agentId: string,
  timeoutMs = 30_000,
): Promise<{ status: "completed" | "failed" | "canceled"; callId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const timeline = await client.fetchAgentTimeline(agentId, { limit: 200 });
    const sleepToolCall = findSleepToolCall(timeline);
    if (sleepToolCall && sleepToolCall.status !== "running") {
      return {
        status: sleepToolCall.status,
        callId: sleepToolCall.callId,
      };
    }
    await sleep(300);
  }

  const timeline = await client.fetchAgentTimeline(agentId, { limit: 200 }).catch(() => null);
  const recentToolCalls =
    timeline?.entries
      .filter((entry) => entry.item.type === "tool_call")
      .slice(-10)
      .map((entry) => ({
        callId: entry.item.callId,
        name: entry.item.name,
        status: entry.item.status,
      })) ?? [];
  throw new Error(
    `Timed out waiting for interrupted sleep tool call to become terminal. recentToolCalls=${JSON.stringify(recentToolCalls)}`,
  );
}

async function waitForIdleResolvingPermissions(
  client: DaemonClient,
  agentId: string,
  timeoutMs: number,
): Promise<WaitForFinishResult> {
  const deadline = Date.now() + timeoutMs;
  const handledPermissionIds = new Set<string>();

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await client.waitForFinish(agentId, Math.min(remaining, 45_000));
    if (result.status !== "permission") {
      return result;
    }

    const pendingPermissions = result.final?.pendingPermissions ?? [];
    if (pendingPermissions.length === 0) {
      throw new Error("waitForFinish reported permission but no pending permissions were present");
    }

    let resolvedAny = false;
    for (const permission of pendingPermissions) {
      if (handledPermissionIds.has(permission.id)) {
        continue;
      }
      handledPermissionIds.add(permission.id);
      await allowPermission(client, agentId, permission);
      resolvedAny = true;
    }

    if (!resolvedAny) {
      throw new Error(
        "Permission wait loop made no progress; all permissions were already handled",
      );
    }
  }

  return {
    status: "timeout",
    final: null,
    error: `Timed out waiting for idle after ${timeoutMs}ms`,
    lastMessage: null,
  };
}

async function createHarness(): Promise<{
  client: DaemonClient;
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>;
}> {
  const logger = pino({ level: "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: { opencode: new OpenCodeAgentClient(logger) },
    logger,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "opencode-send-interrupt-real" } });
  return { client, daemon };
}

describe("daemon E2E (real opencode) - send while working and interrupt", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("send_message while sleep tool call is running starts a clean replacement turn", async () => {
    const cwd = tmpCwd();
    const { client, daemon } = await createHarness();
    const collector = createMessageCollector(client);
    const followUpToken = "OPENCODE_SEND_WHILE_WORKING_OK";

    try {
      const modelList = await client.listProviderModels("opencode");
      expect(modelList.models.length).toBeGreaterThan(0);

      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "OpenCode send while working",
        model: "opencode/big-pickle",
        modeId: "build",
      });

      await client.sendMessage(
        agent.id,
        [
          "Use the Bash tool.",
          "Run exactly: sleep 60",
          "Do not run it in the background.",
          "Do not do anything after starting the command.",
        ].join(" "),
      );

      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "running",
        90_000,
      );
      await waitForRunningBashToolCall(client, collector, agent.id);

      collector.clear();
      await client.sendMessage(agent.id, `Reply with exactly: ${followUpToken}`);

      const finish = await waitForIdleResolvingPermissions(client, agent.id, 240_000);
      expect(finish.status).toBe("idle");

      const postSendAssistantTexts = getAssistantTexts(collector.messages, agent.id);
      expect(postSendAssistantTexts.some((text) => text.includes("[System Error]"))).toBe(false);
      expect(postSendAssistantTexts.some((text) => text.includes(SYSTEM_ERROR_SNIPPET))).toBe(
        false,
      );

      const timeline = await client.fetchAgentTimeline(agent.id, { limit: 160 });
      const assistantTexts = getTimelineAssistantTexts(timeline);
      expect(assistantTexts.some((text) => text.includes(followUpToken))).toBe(true);
      expect(assistantTexts.some((text) => text.includes("[System Error]"))).toBe(false);
      expect(assistantTexts.some((text) => text.includes(SYSTEM_ERROR_SNIPPET))).toBe(false);
    } finally {
      collector.unsubscribe();
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 360_000);

  test("explicit interrupt during sleep tool call still allows the next turn to complete", async () => {
    const cwd = tmpCwd();
    const { client, daemon } = await createHarness();
    const collector = createMessageCollector(client);
    const followUpToken = "OPENCODE_INTERRUPT_FOLLOWUP_OK";

    try {
      const modelList = await client.listProviderModels("opencode");
      expect(modelList.models.length).toBeGreaterThan(0);

      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "OpenCode explicit interrupt",
        model: "opencode/big-pickle",
        modeId: "build",
      });

      await client.sendMessage(
        agent.id,
        [
          "Use the Bash tool.",
          "Run exactly: sleep 60",
          "Do not run it in the background.",
          "Do not do anything after starting the command.",
        ].join(" "),
      );

      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "running",
        90_000,
      );
      await waitForRunningBashToolCall(client, collector, agent.id);

      await client.cancelAgent(agent.id);
      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "idle" || snapshot.status === "error",
        90_000,
      );
      const interruptedToolCall = await waitForSleepToolCallTerminal(client, agent.id, 45_000);
      expect(interruptedToolCall.status).toBe("failed");

      collector.clear();
      await client.sendMessage(agent.id, `Reply with exactly: ${followUpToken}`);

      const finish = await waitForIdleResolvingPermissions(client, agent.id, 240_000);
      expect(finish.status).toBe("idle");

      const postInterruptAssistantTexts = getAssistantTexts(collector.messages, agent.id);
      expect(postInterruptAssistantTexts.some((text) => text.includes("[System Error]"))).toBe(
        false,
      );
      expect(postInterruptAssistantTexts.some((text) => text.includes(SYSTEM_ERROR_SNIPPET))).toBe(
        false,
      );

      const timeline = await client.fetchAgentTimeline(agent.id, { limit: 200 });
      const assistantTexts = getTimelineAssistantTexts(timeline);
      expect(assistantTexts.some((text) => text.includes(followUpToken))).toBe(true);
      expect(assistantTexts.some((text) => text.includes("[System Error]"))).toBe(false);
      expect(assistantTexts.some((text) => text.includes(SYSTEM_ERROR_SNIPPET))).toBe(false);
    } finally {
      collector.unsubscribe();
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 360_000);
});
