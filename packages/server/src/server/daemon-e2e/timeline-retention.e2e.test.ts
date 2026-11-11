import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createMessageCollector, type MessageCollector } from "../test-utils/message-collector.js";

const TIMELINE_WINDOW_MAX_BYTES = String(64 * 1024);
const STRESS_UPDATES = 1000;

function todoText(item: unknown): string | null {
  const record = item as { type?: string; items?: { text?: string }[] } | null;
  return record?.type === "todo" ? (record.items?.[0]?.text ?? null) : null;
}

function itemType(item: unknown): string | null {
  return (item as { type?: string } | null)?.type ?? null;
}

describe("daemon E2E - timeline retention", () => {
  let daemon: TestPaseoDaemon;
  let client: DaemonClient;
  let collector: MessageCollector | null = null;

  beforeEach(async () => {
    process.env.PASEO_TIMELINE_WINDOW_MAX_BYTES = TIMELINE_WINDOW_MAX_BYTES;
    daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
  });

  afterEach(async () => {
    delete process.env.PASEO_TIMELINE_WINDOW_MAX_BYTES;
    collector?.unsubscribe();
    collector = null;
    await client.close();
    await daemon.close();
  }, 60_000);

  async function createStressedAgent(title: string) {
    const agent = await client.createAgent({ provider: "codex", cwd: "/tmp", title });
    await client.sendMessage(agent.id, `emit ${STRESS_UPDATES} agent stream updates`);
    await client.waitForFinish(agent.id, 120_000);
    await daemon.daemon.agentManager.flush();
    return agent;
  }

  test("bounds in-memory retention and serves evicted history from the durable store", async () => {
    const agent = await createStressedAgent("retention");

    // The in-memory window is bounded even though the full history is longer.
    const inMemory = daemon.daemon.agentManager.getTimeline(agent.id);
    expect(inMemory.length).toBeGreaterThan(0);
    expect(inMemory.length).toBeLessThan(STRESS_UPDATES);
    const durablePath = path.join(daemon.paseoHome, "timeline-rows", `${agent.id}.jsonl`);
    expect(existsSync(durablePath)).toBe(true);

    // The tail stays correct and recent.
    const tail = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 200 });
    expect(tail.error).toBeNull();
    expect(tail.entries.length).toBeGreaterThan(0);
    expect(tail.hasNewer).toBe(false);
    expect(todoText(tail.entries.at(-1)?.item)).toBe(`stress-update-${STRESS_UPDATES - 1}`);

    // The full history is served with evicted rows intact.
    const all = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    expect(all.entries).toHaveLength(STRESS_UPDATES + 1);
    expect(itemType(all.entries[0]?.item)).toBe("user_message");
    expect(todoText(all.entries.at(-1)?.item)).toBe(`stress-update-${STRESS_UPDATES - 1}`);

    // Paging across the eviction boundary returns rows evicted from memory.
    const windowProbe = daemon.daemon.agentManager.fetchTimeline(agent.id, {
      direction: "tail",
      limit: 1,
    });
    const boundarySeq = windowProbe.window.minSeq;
    const deep = await client.fetchAgentTimeline(agent.id, {
      direction: "before",
      cursor: { epoch: windowProbe.epoch, seq: boundarySeq },
      limit: 10,
    });
    expect(deep.entries).toHaveLength(10);
    expect(deep.endCursor?.seq).toBe(boundarySeq - 1);
    expect(deep.entries[0]?.seqStart).toBe(boundarySeq - 10);
    for (const entry of deep.entries) {
      expect(todoText(entry.item)).toBe(`stress-update-${entry.seqStart - 2}`);
    }
  });

  test("refresh signals a timeline replacement instead of re-broadcasting the full history", async () => {
    const agent = await createStressedAgent("refresh");
    const observation = await client.observeTimeline([agent.id]);
    collector = createMessageCollector(client);

    await client.refreshAgent(agent.id);

    const messages = collector.messages;
    collector?.unsubscribe();
    collector = null;

    const replacements = messages.filter(
      (
        message,
      ): message is Extract<SessionOutboundMessage, { type: "agent.timeline.replacement" }> =>
        message.type === "agent.timeline.replacement",
    );
    expect(replacements).toHaveLength(1);
    expect(replacements[0].payload.agentId).toBe(agent.id);

    const replayedTimeline = messages.filter(
      (message) =>
        message.type === "agent_stream" &&
        (message.payload as { event: { type: string } }).event.type === "timeline",
    );
    expect(replayedTimeline).toHaveLength(0);

    // Clients refetch their own pages after the replacement and still get the
    // complete re-hydrated timeline (the fake provider history holds no prompt row).
    const restored = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    expect(restored.entries).toHaveLength(STRESS_UPDATES);
    expect(todoText(restored.entries.at(-1)?.item)).toBe(`stress-update-${STRESS_UPDATES - 1}`);
    await observation.release();
  });

  test("restores the full timeline from the durable store after a daemon restart", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-timeline-restart-"));
    const firstDaemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      cleanup: false,
    });
    let secondDaemon: TestPaseoDaemon | null = null;
    try {
      const firstClient = new DaemonClient({ url: `ws://127.0.0.1:${firstDaemon.port}/ws` });
      await firstClient.connect();
      await firstClient.fetchAgents({ subscribe: {} });
      const agent = await firstClient.createAgent({
        provider: "codex",
        cwd: "/tmp",
        title: "restart",
      });
      await firstClient.sendMessage(agent.id, `emit ${STRESS_UPDATES} agent stream updates`);
      await firstClient.waitForFinish(agent.id, 120_000);
      await firstDaemon.daemon.agentManager.flush();
      await firstClient.close();
      await firstDaemon.close();

      secondDaemon = await createTestPaseoDaemon({
        agentClients: createTestAgentClients(),
        paseoHomeRoot,
        cleanup: false,
      });
      const secondClient = new DaemonClient({ url: `ws://127.0.0.1:${secondDaemon.port}/ws` });
      await secondClient.connect();
      const restored = await secondClient.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
      });
      expect(restored.error).toBeNull();
      expect(restored.entries).toHaveLength(STRESS_UPDATES + 1);
      expect(itemType(restored.entries[0]?.item)).toBe("user_message");
      expect(todoText(restored.entries[1]?.item)).toBe("stress-update-0");
      expect(todoText(restored.entries.at(-1)?.item)).toBe(`stress-update-${STRESS_UPDATES - 1}`);
      await secondClient.close();
    } finally {
      await secondDaemon?.close();
      await rm(paseoHomeRoot, { recursive: true, force: true });
    }
  });
});
