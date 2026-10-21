import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";

let daemon: TestPaseoDaemon;
const clients: DaemonClient[] = [];
const rawMessages = new Map<DaemonClient, SessionOutboundMessage[]>();

async function connect(clientId: string): Promise<DaemonClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId,
    webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
    reconnect: { enabled: false },
  });
  await client.connect();
  rawMessages.set(client, []);
  client.subscribeRawMessages((message) => {
    rawMessages.get(client)?.push(message);
  });
  clients.push(client);
  return client;
}

async function closeClient(client: DaemonClient): Promise<void> {
  rawMessages.delete(client);
  const index = clients.indexOf(client);
  if (index >= 0) clients.splice(index, 1);
  await client.close().catch(() => undefined);
}

function hostQueue(agentId: string): { id: string; text: string }[] {
  return daemon.daemon.agentManager.getAgent(agentId)?.promptQueue ?? [];
}

function messagesContain(client: DaemonClient, needle: string): boolean {
  return (rawMessages.get(client) ?? []).some((message) =>
    JSON.stringify(message).includes(needle),
  );
}

beforeEach(async () => {
  daemon = await createTestPaseoDaemon({
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
});

afterEach(async () => {
  for (const client of clients) {
    await client.close().catch(() => undefined);
  }
  clients.length = 0;
  rawMessages.clear();
  await daemon.close();
}, 30_000);

test("queued prompts survive client disconnect and drain in order on the host", async () => {
  const writer = await connect("queue-writer");
  const observer = await connect("queue-observer");
  const agent = await writer.createAgent({
    provider: "mock",
    cwd: "/tmp",
    title: "prompt queue",
    model: "e2e-fast-stream",
  });
  await observer.fetchAgents({ subscribe: {} });
  rawMessages.get(observer)?.splice(0);

  const first = await writer.sendAgentMessage(agent.id, "first turn");
  expect(first.queued).toBe(false);

  const queued = await writer.sendAgentMessage(agent.id, "queued follow-up", {
    activeTurnBehavior: "queue",
    messageId: "msg-queued-1",
  });
  expect(queued.queued).toBe(true);
  expect(hostQueue(agent.id)).toEqual([{ id: "msg-queued-1", text: "queued follow-up" }]);

  await closeClient(writer);

  await vi.waitFor(
    () => {
      expect(messagesContain(observer, "queued follow-up")).toBe(true);
    },
    { timeout: 10_000 },
  );
  await vi.waitFor(
    () => {
      expect(hostQueue(agent.id)).toEqual([]);
    },
    { timeout: 15_000 },
  );
});

test("agent.prompt_queue.remove deletes a queued prompt before it drains", async () => {
  const client = await connect("queue-remover");
  const agent = await client.createAgent({
    provider: "mock",
    cwd: "/tmp",
    title: "prompt queue remove",
    model: "e2e-fast-stream",
  });

  await client.sendAgentMessage(agent.id, "first turn");
  const queued = await client.sendAgentMessage(agent.id, "cancel me", {
    activeTurnBehavior: "queue",
    messageId: "msg-queued-2",
  });
  expect(queued.queued).toBe(true);

  const removed = await client.removeQueuedPrompt(agent.id, "msg-queued-2");
  expect(removed).toEqual({ removed: true, text: "cancel me" });
  expect(hostQueue(agent.id)).toEqual([]);

  const missing = await client.removeQueuedPrompt(agent.id, "msg-queued-2");
  expect(missing).toEqual({ removed: false, text: null });
});
