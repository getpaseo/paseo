import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

let ctx: DaemonTestContext;
let cwd: string;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60000);

describe("a message larger than the daemon accepts", () => {
  const oversizedImage = { data: "A".repeat(101 * 1024 * 1024), mimeType: "image/png" };

  test("fails the creation and keeps the connection up", async () => {
    const statuses: string[] = [];
    const unsubscribe = ctx.client.subscribeConnectionStatus((state) => {
      statuses.push(state.status);
    });

    await expect(
      ctx.client.createAgent({
        provider: "claude",
        cwd,
        title: "Oversized first message",
        initialPrompt: "Describe these screens.",
        images: [oversizedImage],
      }),
    ).rejects.toThrow(/too large/);
    unsubscribe();

    expect(statuses).toEqual(["connected"]);
    expect((await ctx.client.fetchAgents()).entries).toEqual([]);
  }, 30000);

  test("fails the send and keeps the connection up", async () => {
    const agent = await ctx.client.createAgent({ provider: "claude", cwd, title: "Agent" });
    const statuses: string[] = [];
    const unsubscribe = ctx.client.subscribeConnectionStatus((state) => {
      statuses.push(state.status);
    });

    await expect(
      ctx.client.sendMessage(agent.id, "Describe these screens.", { images: [oversizedImage] }),
    ).rejects.toThrow(/too large/);
    unsubscribe();

    expect(statuses).toEqual(["connected"]);
  }, 30000);
});

test("a direct client receives progress before its large timeline page completes", async () => {
  const agent = await ctx.client.createAgent({ provider: "claude", cwd, title: "Large timeline" });
  const text = "Timeline entry ".repeat(8 * 1024);
  for (let row = 0; row < 8; row++) {
    await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
      type: "user_message",
      text,
    });
  }

  const receivedMessageSizes: number[] = [];
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    clientId: "timeline-wire-progress",
    clientType: "browser",
    webSocketFactory: (url) => {
      const ws = new WebSocket(url);
      ws.addEventListener("message", (event) => {
        receivedMessageSizes.push(
          typeof event.data === "string" ? Buffer.byteLength(event.data) : event.data.byteLength,
        );
      });
      return ws;
    },
  });

  try {
    await client.connect();
    receivedMessageSizes.length = 0;
    const timeline = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 40,
      wholeTurns: true,
    });
    expect(timeline.entries).toHaveLength(8);
    for (const { item } of timeline.entries) {
      expect(item.type === "user_message" && item.text === text).toBe(true);
    }
    // The client can only observe liveness when a whole WebSocket message arrives.
    // A single message carrying the entire page hides progress on slow links.
    expect(Math.max(...receivedMessageSizes)).toBeLessThanOrEqual(512 * 1024);
  } finally {
    await client.close();
  }
});
