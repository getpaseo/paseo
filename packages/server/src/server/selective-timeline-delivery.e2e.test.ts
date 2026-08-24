import { afterEach, beforeEach, expect, test } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

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

async function connect(input: { clientId: string; selective: boolean }): Promise<ConnectedClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: input.clientId,
    capabilities: { [CLIENT_CAPS.selectiveAgentTimeline]: input.selective },
    reconnect: { enabled: false },
  });
  await client.connect();
  const connected = new ConnectedClient(client);
  clients.push(connected);
  return connected;
}

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
