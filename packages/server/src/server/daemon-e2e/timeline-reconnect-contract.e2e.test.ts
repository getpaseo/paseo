import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDaemonTestContext,
  type DaemonTestContext,
  DaemonClient,
} from "../test-utils/index.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import type { SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function isLiveAssistantTimeline(
  message: SessionOutboundMessage,
  agentId: string,
  epoch?: string,
  text?: string,
): boolean {
  return (
    message.type === "agent_stream" &&
    message.payload.agentId === agentId &&
    message.payload.event.type === "timeline" &&
    message.payload.event.item.type === "assistant_message" &&
    message.payload.seq === undefined &&
    typeof message.payload.epoch === "string" &&
    (epoch === undefined || message.payload.epoch === epoch) &&
    (text === undefined || message.payload.event.item.text === text)
  );
}

describe("daemon E2E - timeline reconnect contract", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("reconnect catches up committed rows without replaying a provisional seed", async () => {
    const cwd = tmpCwd();
    const primaryCollector = createMessageCollector(ctx.client);

    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Reconnect Contract Test",
        modeId: "full-access",
      });

      for (let seq = 1; seq <= 120; seq += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "assistant_message",
          text: `committed row ${seq}`,
        });
      }
      const baseline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      const epoch = baseline.epoch;
      expect(epoch).not.toBe("");
      expect(baseline.endCursor?.epoch).toBe(epoch);

      primaryCollector.clear();
      await ctx.daemon.daemon.agentManager.emitLiveTimelineItem(agent.id, {
        type: "assistant_message",
        text: "partial before disconnect",
      });
      await waitFor(() =>
        primaryCollector.messages.some((message) =>
          isLiveAssistantTimeline(message, agent.id, epoch, "partial before disconnect"),
        ),
      );

      await ctx.client.close();

      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: "finalized while disconnected",
      });

      const reconnectClient = new DaemonClient({
        url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
      });
      await reconnectClient.connect();
      const reconnectCollector = createMessageCollector(reconnectClient);

      try {
        await reconnectClient.fetchAgents({
          subscribe: { subscriptionId: "timeline-reconnect-a" },
        });

        expect(
          reconnectCollector.messages.some((message) =>
            isLiveAssistantTimeline(message, agent.id, epoch),
          ),
        ).toBe(false);

        const catchUp = await reconnectClient.fetchAgentTimeline(agent.id, {
          direction: "after",
          cursor: { epoch, seq: 120 },
          limit: 0,
          projection: "canonical",
        });

        expect(catchUp.epoch).toBe(epoch);
        expect(catchUp.reset).toBe(false);
        expect(catchUp.staleCursor).toBe(false);
        expect(catchUp.gap).toBe(false);
        expect(catchUp.entries).toHaveLength(1);
        expect(catchUp.startCursor).toEqual({ epoch, seq: 121 });
        expect(catchUp.endCursor).toEqual({ epoch, seq: 121 });
        expect(catchUp.entries[0]?.seqStart).toBe(121);
        expect(catchUp.entries[0]?.seqEnd).toBe(121);
        expect(catchUp.entries[0]?.item).toEqual({
          type: "assistant_message",
          text: "finalized while disconnected",
        });
      } finally {
        reconnectCollector.unsubscribe();
        await reconnectClient.close();
      }
    } finally {
      primaryCollector.unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("reconnect with no new committed rows resumes from future live provisional updates only", async () => {
    const cwd = tmpCwd();
    const primaryCollector = createMessageCollector(ctx.client);

    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Reconnect No Seed Test",
        modeId: "full-access",
      });

      for (let seq = 1; seq <= 120; seq += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "assistant_message",
          text: `committed row ${seq}`,
        });
      }
      const baseline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      const epoch = baseline.epoch;
      expect(epoch).not.toBe("");
      expect(baseline.endCursor?.epoch).toBe(epoch);

      primaryCollector.clear();
      await ctx.daemon.daemon.agentManager.emitLiveTimelineItem(agent.id, {
        type: "assistant_message",
        text: "partial before disconnect",
      });
      await waitFor(() =>
        primaryCollector.messages.some((message) =>
          isLiveAssistantTimeline(message, agent.id, epoch, "partial before disconnect"),
        ),
      );

      await ctx.client.close();

      const reconnectClient = new DaemonClient({
        url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
      });
      await reconnectClient.connect();
      const reconnectCollector = createMessageCollector(reconnectClient);

      try {
        await reconnectClient.fetchAgents({
          subscribe: { subscriptionId: "timeline-reconnect-b" },
        });

        expect(
          reconnectCollector.messages.some((message) =>
            isLiveAssistantTimeline(message, agent.id, epoch),
          ),
        ).toBe(false);

        const catchUp = await reconnectClient.fetchAgentTimeline(agent.id, {
          direction: "after",
          cursor: { epoch, seq: 120 },
          limit: 0,
          projection: "canonical",
        });

        expect(catchUp.epoch).toBe(epoch);
        expect(catchUp.reset).toBe(false);
        expect(catchUp.staleCursor).toBe(false);
        expect(catchUp.gap).toBe(false);
        expect(catchUp.entries).toHaveLength(0);
        expect(catchUp.startCursor).toBeNull();
        expect(catchUp.endCursor).toBeNull();

        reconnectCollector.clear();
        await ctx.daemon.daemon.agentManager.emitLiveTimelineItem(agent.id, {
          type: "assistant_message",
          text: "fresh live after reconnect",
        });
        await waitFor(() =>
          reconnectCollector.messages.some((message) =>
            isLiveAssistantTimeline(message, agent.id, epoch, "fresh live after reconnect"),
          ),
        );
      } finally {
        reconnectCollector.unsubscribe();
        await reconnectClient.close();
      }
    } finally {
      primaryCollector.unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
