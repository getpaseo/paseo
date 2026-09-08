import type { AgentStreamEvent, AgentSessionConfig } from "./agent/agent-sdk-types.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import {
  MockLoadTestAgentClient,
  MockLoadTestAgentSession,
} from "./agent/providers/mock-load-test-agent.js";

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
  pluginTimelineItems?: boolean;
  workspaceSetupBlocked?: boolean;
}): Promise<ConnectedClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: input.clientId,
    capabilities: {
      [CLIENT_CAPS.selectiveAgentTimeline]: input.selective,
      [CLIENT_CAPS.pluginTimelineItems]: input.pluginTimelineItems ?? false,
      [CLIENT_CAPS.workspaceSetupBlocked]: input.workspaceSetupBlocked ?? false,
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

test("plugin timeline items are sent only to clients that advertise support", async () => {
  await daemon.close();
  daemon = await createTestPaseoDaemon({
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const capable = await connect({
    clientId: "plugin-shared",
    selective: false,
    pluginTimelineItems: true,
  });
  const legacy = await connect({
    clientId: "plugin-shared",
    selective: false,
    pluginTimelineItems: false,
  });
  const agent = await capable.client.createAgent({
    provider: "mock",
    cwd: "/tmp",
    title: "Plugin compatibility",
    model: "ten-second-stream",
  });
  capable.clear();
  legacy.clear();

  await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
    type: "plugin",
    id: "compat-row",
    pluginId: "timeline-items",
    kind: "notice",
    version: 1,
    data: { text: "Capable clients only" },
  });
  await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
    type: "plugin",
    id: "compat-row",
    pluginId: "timeline-items",
    kind: "notice",
    version: 1,
    data: { text: "Updated" },
  });
  await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
    type: "assistant_message",
    text: "Visible to every client",
  });
  await Promise.all([
    capable.next(isAgentStream(agent.id), "capable timeline delivery"),
    legacy.next(isAgentStream(agent.id), "legacy timeline delivery"),
  ]);
  await Promise.all([capable.barrier("plugin-capable"), legacy.barrier("plugin-legacy")]);

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
  expect(capableLiveItems.some((item) => item.type === "plugin")).toBe(true);
  expect(legacyLiveItems.some((item) => item.type === "plugin")).toBe(false);
  expect(legacyLiveItems).toContainEqual(
    expect.objectContaining({ type: "assistant_message", text: "Visible to every client" }),
  );

  for (const projection of ["canonical", "projected"] as const) {
    const [capableTimeline, legacyTimeline] = await Promise.all([
      capable.client.fetchAgentTimeline(agent.id, { direction: "tail", projection }),
      legacy.client.fetchAgentTimeline(agent.id, { direction: "tail", projection }),
    ]);
    expect(capableTimeline.entries.some((entry) => entry.item.type === "plugin")).toBe(true);
    expect(legacyTimeline.entries.some((entry) => entry.item.type === "plugin")).toBe(false);
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
    expect(legacyTimeline.entries.flatMap((entry) => entry.collapsed)).not.toContain("identity");
  }
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
  const workspaceId = await createAttentionWorkspace(legacy.client);
  const agents = await Promise.all(
    ["A", "B", "C"].map((title) =>
      legacy.client.createAgent({
        provider: "codex",
        cwd: daemon.paseoHome,
        title: `Selective ${title}`,
        workspaceId,
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

  await Promise.all([
    legacy.client.fetchAgents({ subscribe: { subscriptionId: "legacy-directory" } }),
    capable.client.fetchAgents({ subscribe: { subscriptionId: "capable-directory" } }),
  ]);
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

test("blocked setup remains readable on mixed-capability sockets sharing a session", async () => {
  await daemon.close();
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-blocked-compat-"));
  const projects = path.join(root, ".paseo", "projects");
  await mkdir(projects, { recursive: true });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "blocked-workspace",
    projectId: "project",
    cwd: root,
    kind: "directory",
    displayName: "Fork PR",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    untrustedSource: {
      kind: "change_request",
      forge: "github",
      number: 42,
      headRepository: "contributor/project",
    },
  });
  await writeFile(path.join(projects, "workspaces.json"), JSON.stringify([workspace]));
  daemon = await createTestPaseoDaemon({ paseoHomeRoot: root });
  const legacy = await connect({ clientId: "setup-shared", selective: false });
  const capable = await connect({
    clientId: "setup-shared",
    selective: false,
    workspaceSetupBlocked: true,
  });
  const oldStatus = await legacy.client.fetchWorkspaceSetupStatus(workspace.workspaceId);
  const newStatus = await capable.client.fetchWorkspaceSetupStatus(workspace.workspaceId);
  expect(oldStatus.snapshot).toMatchObject({
    status: "failed",
    error:
      "Workspace setup is blocked pending approval of code from a fork pull request. Update Paseo to review and run setup.",
  });
  expect(newStatus.snapshot).toMatchObject({
    status: "blocked",
    error: null,
    blockedSource: workspace.untrustedSource,
  });
  expect(oldStatus.snapshot?.detail).toEqual(newStatus.snapshot?.detail);
});

// A provider adapter with controllable events and durable provider history.
class CompatibilityProviderSession extends MockLoadTestAgentSession {
  private readonly observers = new Set<(event: AgentStreamEvent) => void>();
  private readonly injectedHistory: AgentStreamEvent[] = [];
  override subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    const unsubscribe = super.subscribe(callback);
    this.observers.add(callback);
    return () => {
      unsubscribe();
      this.observers.delete(callback);
    };
  }
  push(event: AgentStreamEvent): void {
    this.injectedHistory.push(event);
    for (const callback of this.observers) callback(event);
  }
  override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* this.injectedHistory;
    yield* super.streamHistory();
  }
}

class CompatibilityProvider extends MockLoadTestAgentClient {
  session!: CompatibilityProviderSession;
  override async createSession(config: AgentSessionConfig): Promise<CompatibilityProviderSession> {
    this.session = new CompatibilityProviderSession({
      config,
      sessionId: "compat-provider-session",
    });
    return this.session;
  }
}

test("plugin items are gated in provider child streams, child fetches, and rewind replay", async () => {
  await daemon.close();
  const provider = new CompatibilityProvider();
  daemon = await createTestPaseoDaemon({ isDev: true, agentClients: { mock: provider } });
  const legacy = await connect({ clientId: "provider-shared", selective: false });
  const capable = await connect({
    clientId: "provider-shared",
    selective: false,
    pluginTimelineItems: true,
  });
  const agent = await capable.client.createAgent({
    provider: "mock",
    cwd: "/tmp",
    model: "ten-second-stream",
  });
  const plugin = {
    type: "plugin" as const,
    id: "provider-row",
    pluginId: "provider",
    kind: "notice",
    version: 1,
    data: { text: "Provider notice" },
  };
  provider.session.push({ type: "timeline", provider: "mock", item: plugin });
  provider.session.push({
    type: "provider_subagent",
    provider: "mock",
    event: { type: "upsert", id: "child", title: "Child", status: "running" },
  });
  provider.session.push({
    type: "provider_subagent",
    provider: "mock",
    event: { type: "timeline", id: "child", item: plugin },
  });
  provider.session.push({
    type: "provider_subagent",
    provider: "mock",
    event: {
      type: "timeline",
      id: "child",
      item: { type: "assistant_message", text: "Child result" },
    },
  });
  function childResult(message: SessionOutboundMessage): boolean {
    return (
      message.type === "agent.provider_subagents.update" &&
      message.payload.kind === "timeline" &&
      message.payload.item.type === "assistant_message"
    );
  }
  await Promise.all([
    capable.next(childResult, "capable child result"),
    legacy.next(childResult, "legacy child result"),
  ]);
  function childItems(client: ConnectedClient) {
    return client.messages.flatMap((message) =>
      message.type === "agent.provider_subagents.update" && message.payload.kind === "timeline"
        ? [message.payload.item]
        : [],
    );
  }
  expect(childItems(capable)).toContainEqual(plugin);
  expect(childItems(legacy)).toEqual([{ type: "assistant_message", text: "Child result" }]);
  const oldChild = await legacy.client.fetchProviderSubagentTimeline(agent.id, "child");
  const newChild = await capable.client.fetchProviderSubagentTimeline(agent.id, "child");
  expect(newChild.rows.map((row) => row.item)).toContainEqual(plugin);
  expect(oldChild.rows.map((row) => row.item)).toEqual([
    { type: "assistant_message", text: "Child result" },
  ]);
  expect(oldChild.window).toEqual(newChild.window);

  await capable.client.sendMessage(agent.id, "Rewind target");
  await capable.client.cancelAgent(agent.id);
  const timeline = await capable.client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    projection: "canonical",
  });
  const targetMessageId = rewindMessageId(timeline);
  capable.clear();
  legacy.clear();
  await capable.client.rewindAgent(agent.id, targetMessageId, "conversation");
  await Promise.all([capable.barrier("provider-rewind"), legacy.barrier("provider-rewind")]);
  function replayItems(client: ConnectedClient) {
    return client.messages.flatMap((message) =>
      message.type === "agent_stream" && message.payload.event.type === "timeline"
        ? [message.payload.event.item]
        : [],
    );
  }
  expect(replayItems(capable)).toContainEqual(plugin);
  expect(replayItems(legacy).some((item) => item.type === "plugin")).toBe(false);
  expect(replayItems(legacy)).toContainEqual(expect.objectContaining({ type: "user_message" }));
});

async function createAttentionWorkspace(client: DaemonClient): Promise<string> {
  const result = await client.createWorkspace({
    source: { kind: "directory", path: daemon.paseoHome },
  });
  if (!result.workspace) throw new Error(result.error ?? "Expected workspace");
  return result.workspace.id;
}

function rewindMessageId(
  timeline: Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>,
): string {
  const target = timeline.entries.find((entry) => entry.item.type === "user_message");
  if (target?.item.type !== "user_message" || !target.item.messageId)
    throw new Error("Expected rewind target");
  return target.item.messageId;
}
