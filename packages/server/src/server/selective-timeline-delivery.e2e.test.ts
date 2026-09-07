import { afterEach, beforeEach, expect, test } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { MockLoadTestAgentClient } from "./agent/providers/mock-load-test-agent.js";

interface MessageWaiter {
  predicate(message: SessionOutboundMessage): boolean;
  resolve(message: SessionOutboundMessage): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

class ConnectedClient {
  readonly messages: SessionOutboundMessage[] = [];
  private readonly waiters: MessageWaiter[] = [];
  private readonly unsubscribe: () => void;

  constructor(readonly client: DaemonClient) {
    this.unsubscribe = client.subscribeRawMessages((message) => {
      this.messages.push(message);
      for (let waiterIndex = this.waiters.length - 1; waiterIndex >= 0; waiterIndex -= 1) {
        const waiter = this.waiters[waiterIndex];
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timeout);
        this.waiters.splice(waiterIndex, 1);
        waiter.resolve(message);
      }
    });
  }

  clear(): void {
    this.messages.length = 0;
  }

  next(
    predicate: (message: SessionOutboundMessage) => boolean,
    description: string,
  ): Promise<SessionOutboundMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${description}`));
      }, 5_000);
      this.waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  hasTimeline(agentId: string): boolean {
    return this.messages.some(
      (message) => message.type === "agent_stream" && message.payload.agentId === agentId,
    );
  }

  async barrier(label: string): Promise<void> {
    await this.client.ping({ requestId: `barrier-${label}` });
  }

  close(): void {
    this.unsubscribe();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Client boundary closed"));
    }
    this.waiters.length = 0;
  }
}

function isAgentStream(agentId: string) {
  return (message: SessionOutboundMessage): boolean =>
    message.type === "agent_stream" && message.payload.agentId === agentId;
}

function isDedicatedAttention(agentId: string) {
  return (message: SessionOutboundMessage): boolean =>
    message.type === "agent_attention_required" && message.payload.agentId === agentId;
}

function isLegacyAttention(agentId: string) {
  return (message: SessionOutboundMessage): boolean =>
    message.type === "agent_stream" &&
    message.payload.agentId === agentId &&
    message.payload.event.type === "attention_required";
}

function dedicatedAttentionResult(message: SessionOutboundMessage, timelineLeaked: boolean) {
  if (message.type !== "agent_attention_required") {
    throw new Error(`Expected agent_attention_required, received ${message.type}`);
  }
  return {
    type: message.type,
    shouldNotify: message.payload.shouldNotify,
    timelineLeaked,
  };
}

function legacyAttentionResult(message: SessionOutboundMessage) {
  if (message.type !== "agent_stream" || message.payload.event.type !== "attention_required") {
    throw new Error(`Expected legacy attention_required agent_stream, received ${message.type}`);
  }
  return {
    type: message.type,
    eventType: message.payload.event.type,
    agentId: message.payload.agentId,
  };
}

let daemon: TestPaseoDaemon;
const clients: ConnectedClient[] = [];

beforeEach(async () => {
  daemon = await createTestPaseoDaemon();
});

afterEach(async () => {
  for (const connected of clients) {
    connected.close();
    await connected.client.close().catch(() => undefined);
  }
  clients.length = 0;
  await daemon.close();
}, 30_000);

async function connect(input: {
  clientId: string;
  selective: boolean;
  timelineReplacementInvalidation?: boolean;
  timelineNotifications?: boolean;
}): Promise<ConnectedClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: input.clientId,
    capabilities: {
      [CLIENT_CAPS.selectiveAgentTimeline]: input.selective,
      ...(input.timelineNotifications === undefined
        ? {}
        : { [CLIENT_CAPS.timelineNotifications]: input.timelineNotifications }),
      ...(input.timelineReplacementInvalidation
        ? { [CLIENT_CAPS.timelineReplacementInvalidation]: true }
        : {}),
    },
    reconnect: { enabled: false },
  });
  await client.connect();
  const connected = new ConnectedClient(client);
  clients.push(connected);
  return connected;
}

test("notification timeline items are sent only to clients that advertise support", async () => {
  await daemon.close();
  daemon = await createTestPaseoDaemon({
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const capable = await connect({
    clientId: "notification-capable",
    selective: false,
    timelineNotifications: true,
  });
  const legacy = await connect({
    clientId: "notification-legacy",
    selective: false,
    timelineNotifications: false,
  });
  const agent = await capable.client.createAgent({
    provider: "mock",
    cwd: "/tmp",
    title: "Notification compatibility",
    model: "ten-second-stream",
  });
  capable.clear();
  legacy.clear();

  await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
    type: "notification",
    level: "warning",
    message: "Capable clients only",
  });
  await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
    type: "assistant_message",
    text: "Visible to every client",
  });
  await Promise.all([
    capable.next(isAgentStream(agent.id), "capable timeline delivery"),
    legacy.next(isAgentStream(agent.id), "legacy timeline delivery"),
  ]);
  await Promise.all([
    capable.barrier("notification-capable"),
    legacy.barrier("notification-legacy"),
  ]);

  const capableLiveItems = capable.messages.flatMap((message) =>
    message.type === "agent_stream" && message.payload.event.type === "timeline"
      ? [message.payload.event.item]
      : [],
  );
  const legacyLiveItems = legacy.messages.flatMap((message) =>
    message.type === "agent_stream" && message.payload.event.type === "timeline"
      ? [message.payload.event.item]
      : [],
  );
  expect(capableLiveItems.some((item) => item.type === "notification")).toBe(true);
  expect(legacyLiveItems.some((item) => item.type === "notification")).toBe(false);
  expect(legacyLiveItems).toContainEqual(
    expect.objectContaining({ type: "assistant_message", text: "Visible to every client" }),
  );

  const [capableTimeline, legacyTimeline] = await Promise.all([
    capable.client.fetchAgentTimeline(agent.id, { direction: "tail", projection: "canonical" }),
    legacy.client.fetchAgentTimeline(agent.id, { direction: "tail", projection: "canonical" }),
  ]);
  expect(capableTimeline.entries.some((entry) => entry.item.type === "notification")).toBe(true);
  expect(legacyTimeline.entries.some((entry) => entry.item.type === "notification")).toBe(false);
  expect(legacyTimeline.entries).toContainEqual(
    expect.objectContaining({
      item: expect.objectContaining({
        type: "assistant_message",
        text: "Visible to every client",
      }),
    }),
  );
  expect(legacyTimeline.window).toEqual(capableTimeline.window);
  expect(legacyTimeline.endCursor).toEqual(capableTimeline.endCursor);
});

test("rewind routes replacement completion by source capability and subscription", async () => {
  await daemon.close();
  daemon = await createTestPaseoDaemon({
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const initiating = await connect({
    clientId: "rewind-initiating",
    selective: true,
    timelineReplacementInvalidation: true,
  });
  const passive = await connect({
    clientId: "rewind-passive",
    selective: true,
    timelineReplacementInvalidation: true,
  });
  const unrelated = await connect({
    clientId: "rewind-unrelated",
    selective: true,
    timelineReplacementInvalidation: true,
  });
  const legacy = await connect({ clientId: "rewind-legacy", selective: false });
  const agent = await initiating.client.createAgent({
    provider: "mock",
    cwd: "/tmp",
    title: "Rewind routing",
    model: "ten-second-stream",
  });

  await Promise.all([
    initiating.client.setAgentTimelineSubscription([agent.id]),
    passive.client.setAgentTimelineSubscription([agent.id]),
    unrelated.client.setAgentTimelineSubscription([]),
  ]);
  await initiating.client.sendMessage(agent.id, "Rewind this synthetic prompt");
  await initiating.client.cancelAgent(agent.id);
  const timeline = await initiating.client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  const target = timeline.entries.find(
    (entry) =>
      entry.item.type === "user_message" && entry.item.text === "Rewind this synthetic prompt",
  );
  if (!target || target.item.type !== "user_message" || !target.item.messageId) {
    throw new Error("Expected rewindable canonical user message");
  }

  for (const connected of [initiating, passive, unrelated, legacy]) connected.clear();
  await initiating.client.rewindAgent(agent.id, target.item.messageId, "conversation");
  await Promise.all([
    initiating.barrier("rewind-initiator"),
    passive.barrier("rewind-passive"),
    unrelated.barrier("rewind-unrelated"),
    legacy.barrier("rewind-legacy"),
  ]);

  expect(
    initiating.messages.filter((message) => message.type === "agent.rewind.response"),
  ).toHaveLength(1);
  expect(
    initiating.messages.filter((message) => message.type === "agent.timeline.replacement"),
  ).toHaveLength(0);
  expect(
    passive.messages.filter((message) => message.type === "agent.timeline.replacement"),
  ).toHaveLength(1);
  expect(passive.hasTimeline(agent.id)).toBe(false);
  expect(legacy.messages.filter(isAgentStream(agent.id)).length).toBeGreaterThan(0);
  expect(
    unrelated.messages.filter((message) => message.type === "agent.timeline.replacement"),
  ).toHaveLength(0);
  expect(unrelated.hasTimeline(agent.id)).toBe(false);
}, 30_000);

test("subscription acknowledgements stay on the requesting socket of a retained session", async () => {
  const legacy = await connect({ clientId: "shared-client", selective: false });
  const capable = await connect({ clientId: "shared-client", selective: true });
  legacy.clear();
  capable.clear();

  await capable.client.setAgentTimelineSubscription(["agent-a"]);
  await capable.barrier("targeted-subscription-ack");

  expect(
    legacy.messages.some((message) => message.type === "agent.timeline.set_subscription.response"),
  ).toBe(false);
});

test("real WebSocket sessions enforce selective delivery, retained resets, downgrade, and dedicated attention", async () => {
  const legacy = await connect({ clientId: "legacy-client", selective: false });
  let capable = await connect({ clientId: "capable-client", selective: true });
  const agents = await Promise.all(
    ["A", "B", "C"].map((title) =>
      legacy.client.createAgent({
        provider: "codex",
        cwd: "/tmp",
        title: `Selective ${title}`,
        modeId: "full-access",
      }),
    ),
  );
  const [agentA, agentB, agentC] = agents;
  legacy.clear();
  capable.clear();

  await daemon.daemon.agentManager.emitLiveTimelineItem(agentC.id, {
    type: "assistant_message",
    text: "before membership",
  });
  await legacy.next(isAgentStream(agentC.id), "legacy global delivery before membership");
  await capable.barrier("before-membership");
  expect(capable.hasTimeline(agentC.id)).toBe(false);

  await capable.client.setAgentTimelineSubscription([agentA.id, agentB.id]);
  legacy.clear();
  capable.clear();
  await daemon.daemon.agentManager.emitLiveTimelineItem(agentA.id, {
    type: "assistant_message",
    text: "viewed A",
  });
  await daemon.daemon.agentManager.emitLiveTimelineItem(agentB.id, {
    type: "assistant_message",
    text: "viewed B",
  });
  await daemon.daemon.agentManager.emitLiveTimelineItem(agentC.id, {
    type: "assistant_message",
    text: "unviewed C",
  });
  await Promise.all([
    capable.next(isAgentStream(agentA.id), "capable A delivery"),
    capable.next(isAgentStream(agentB.id), "capable B delivery"),
    legacy.next(isAgentStream(agentC.id), "legacy C delivery"),
  ]);
  await capable.barrier("unviewed-c");
  expect(capable.hasTimeline(agentC.id)).toBe(false);

  await capable.client.setAgentTimelineSubscription([agentB.id]);
  legacy.clear();
  capable.clear();
  await daemon.daemon.agentManager.emitLiveTimelineItem(agentA.id, {
    type: "assistant_message",
    text: "removed A",
  });
  await daemon.daemon.agentManager.emitLiveTimelineItem(agentB.id, {
    type: "assistant_message",
    text: "retained B",
  });
  await Promise.all([
    legacy.next(isAgentStream(agentA.id), "legacy removed A delivery"),
    capable.next(isAgentStream(agentB.id), "capable retained B delivery"),
  ]);
  await capable.barrier("removed-a");
  expect(capable.hasTimeline(agentA.id)).toBe(false);

  capable.close();
  await capable.client.close();
  clients.splice(clients.indexOf(capable), 1);
  capable = await connect({ clientId: "capable-client", selective: true });
  legacy.clear();
  capable.clear();
  await daemon.daemon.agentManager.emitLiveTimelineItem(agentB.id, {
    type: "assistant_message",
    text: "after capable resume",
  });
  await legacy.next(isAgentStream(agentB.id), "legacy delivery after capable resume");
  await capable.barrier("resumed-membership-reset");
  expect(capable.hasTimeline(agentB.id)).toBe(false);

  capable.client.sendHeartbeat({
    deviceType: "mobile",
    focusedAgentId: null,
    lastActivityAt: new Date().toISOString(),
    appVisible: true,
  });
  legacy.clear();
  capable.clear();
  const attention = capable.next(
    isDedicatedAttention(agentC.id),
    "capable dedicated attention notification",
  );
  const legacyAttention = legacy.next(
    isLegacyAttention(agentC.id),
    "legacy attention stream notification",
  );
  await legacy.client.sendMessage(agentC.id, "finish attention boundary test");
  const [attentionMessage, legacyAttentionMessage] = await Promise.all([
    attention,
    legacyAttention,
  ]);
  await capable.barrier("attention-delivery");
  expect({
    capable: dedicatedAttentionResult(attentionMessage, capable.hasTimeline(agentC.id)),
    legacy: legacyAttentionResult(legacyAttentionMessage),
  }).toEqual({
    capable: {
      type: "agent_attention_required",
      shouldNotify: true,
      timelineLeaked: false,
    },
    legacy: {
      type: "agent_stream",
      eventType: "attention_required",
      agentId: agentC.id,
    },
  });

  capable.close();
  await capable.client.close();
  clients.splice(clients.indexOf(capable), 1);
  const downgraded = await connect({ clientId: "capable-client", selective: false });
  downgraded.clear();
  await daemon.daemon.agentManager.emitLiveTimelineItem(agentA.id, {
    type: "assistant_message",
    text: "after downgrade",
  });
  const downgradedDelivery = await downgraded.next(
    isAgentStream(agentA.id),
    "legacy global delivery after capability downgrade",
  );

  expect(downgradedDelivery.type).toBe("agent_stream");
}, 30_000);
