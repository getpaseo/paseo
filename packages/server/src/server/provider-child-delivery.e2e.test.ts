import { afterEach, beforeEach, expect, test } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestAgentClients, type TestAgentSession } from "./test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

class ConnectedClient {
  readonly messages: SessionOutboundMessage[] = [];
  private readonly waiters = new Set<{
    predicate: (message: SessionOutboundMessage) => boolean;
    resolve: () => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly unsubscribe: () => void;

  constructor(readonly client: DaemonClient) {
    this.unsubscribe = client.subscribeRawMessages((message) => {
      this.messages.push(message);
      for (const waiter of this.waiters) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timeout);
        this.waiters.delete(waiter);
        waiter.resolve();
      }
    });
  }

  clear(): void {
    this.messages.length = 0;
  }

  hasProviderUpdate(parentAgentId: string, subagentId: string): boolean {
    return this.messages.some((message) => {
      if (message.type !== "agent.provider_subagents.update") return false;
      const { payload } = message;
      if (payload.kind === "upsert") {
        return (
          payload.subagent.parentAgentId === parentAgentId && payload.subagent.id === subagentId
        );
      }
      return payload.parentAgentId === parentAgentId && payload.subagentId === subagentId;
    });
  }

  hasParentTimeline(agentId: string): boolean {
    return this.messages.some(
      (message) => message.type === "agent_stream" && message.payload.agentId === agentId,
    );
  }

  async waitForProviderUpdate(parentAgentId: string, subagentId: string): Promise<void> {
    const predicate = (message: SessionOutboundMessage): boolean =>
      message.type === "agent.provider_subagents.update" &&
      (message.payload.kind === "upsert"
        ? message.payload.subagent.parentAgentId === parentAgentId &&
          message.payload.subagent.id === subagentId
        : message.payload.parentAgentId === parentAgentId &&
          message.payload.subagentId === subagentId);
    if (this.messages.some(predicate)) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for provider child ${parentAgentId}/${subagentId}`));
        }, 5_000),
      };
      this.waiters.add(waiter);
    });
  }

  async barrier(label: string): Promise<void> {
    await this.client.ping({ requestId: `barrier-${label}` });
  }

  closeBoundary(): void {
    this.unsubscribe();
    for (const waiter of this.waiters) clearTimeout(waiter.timeout);
    this.waiters.clear();
  }
}

let daemon: TestPaseoDaemon;
let providerSessions: TestAgentSession[];
const clients: ConnectedClient[] = [];

beforeEach(async () => {
  providerSessions = [];
  daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onSessionCreated: (session) => providerSessions.push(session),
    }),
  });
});

afterEach(async () => {
  for (const connected of clients) {
    connected.closeBoundary();
    await connected.client.close().catch(() => undefined);
  }
  clients.length = 0;
  await daemon.close();
}, 30_000);

async function connect(clientId: string, providerSubagents = true): Promise<ConnectedClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId,
    capabilities: { [CLIENT_CAPS.providerSubagents]: providerSubagents },
    reconnect: { enabled: false },
  });
  await client.connect();
  const connected = new ConnectedClient(client);
  clients.push(connected);
  return connected;
}

function emitProviderChild(
  session: TestAgentSession,
  input: { id: string; status?: "running" | "completed" },
): void {
  session.emit({
    type: "provider_subagent",
    provider: session.provider,
    event: {
      type: "upsert",
      id: input.id,
      status: input.status ?? "running",
      timestamp: new Date().toISOString(),
    },
  });
}

test("provider child updates stay with interested clients and reset across reconnect", async () => {
  let first = await connect("provider-child-first");
  const second = await connect("provider-child-second");
  const firstParent = await first.client.createAgent({
    provider: "codex",
    cwd: "/tmp",
    title: "First parent",
    modeId: "full-access",
  });
  const secondParent = await second.client.createAgent({
    provider: "codex",
    cwd: "/tmp",
    title: "Second parent",
    modeId: "full-access",
  });
  expect(providerSessions).toHaveLength(2);

  await Promise.all([
    first.client.listProviderSubagents(firstParent.id),
    second.client.listProviderSubagents(secondParent.id),
  ]);
  first.clear();
  second.clear();

  emitProviderChild(providerSessions[0], { id: "first-child" });
  await first.waitForProviderUpdate(firstParent.id, "first-child");
  await second.barrier("first-child-isolated");
  expect(second.hasProviderUpdate(firstParent.id, "first-child")).toBe(false);

  emitProviderChild(providerSessions[1], { id: "second-child" });
  await second.waitForProviderUpdate(secondParent.id, "second-child");
  await first.barrier("second-child-isolated");
  expect(first.hasProviderUpdate(secondParent.id, "second-child")).toBe(false);

  first.clear();
  second.clear();
  await daemon.daemon.agentManager.emitLiveTimelineItem(firstParent.id, {
    type: "assistant_message",
    text: "parent timelines remain global for non-selective clients",
  });
  await Promise.all([
    first.barrier("first-parent-timeline"),
    second.barrier("first-parent-timeline"),
  ]);
  expect(first.hasParentTimeline(firstParent.id)).toBe(true);
  expect(second.hasParentTimeline(firstParent.id)).toBe(true);

  first.closeBoundary();
  await first.client.close();
  clients.splice(clients.indexOf(first), 1);
  first = await connect("provider-child-first");
  first.clear();
  second.clear();

  emitProviderChild(providerSessions[0], { id: "before-resubscribe" });
  await first.barrier("reconnect-clears-interest");
  await second.barrier("reconnect-does-not-leak");
  expect(first.hasProviderUpdate(firstParent.id, "before-resubscribe")).toBe(false);
  expect(second.hasProviderUpdate(firstParent.id, "before-resubscribe")).toBe(false);

  await first.client.listProviderSubagents(firstParent.id);
  first.clear();
  emitProviderChild(providerSessions[0], { id: "after-resubscribe" });
  await first.waitForProviderUpdate(firstParent.id, "after-resubscribe");
  expect(first.hasProviderUpdate(firstParent.id, "after-resubscribe")).toBe(true);
}, 30_000);

test("provider child interest and list responses stay on the requesting socket", async () => {
  const interested = await connect("shared-provider-child-client");
  const otherSocket = await connect("shared-provider-child-client");
  const parent = await interested.client.createAgent({
    provider: "codex",
    cwd: "/tmp",
    title: "Shared session parent",
    modeId: "full-access",
  });
  expect(providerSessions).toHaveLength(1);
  interested.clear();
  otherSocket.clear();

  await interested.client.listProviderSubagents(parent.id, {
    requestId: "source-scoped-provider-child-list",
  });
  await otherSocket.barrier("source-scoped-provider-child-list");
  expect(
    otherSocket.messages.some(
      (message) =>
        message.type === "agent.provider_subagents.list.response" &&
        message.payload.requestId === "source-scoped-provider-child-list",
    ),
  ).toBe(false);

  interested.clear();
  otherSocket.clear();
  emitProviderChild(providerSessions[0], { id: "source-scoped-child" });
  await interested.waitForProviderUpdate(parent.id, "source-scoped-child");
  await otherSocket.barrier("source-scoped-provider-child-update");
  expect(otherSocket.hasProviderUpdate(parent.id, "source-scoped-child")).toBe(false);
}, 30_000);

test("provider child updates exclude interested sockets without the capability", async () => {
  const capable = await connect("capable-provider-child-client");
  const incapable = await connect("incapable-provider-child-client", false);
  const parent = await capable.client.createAgent({
    provider: "codex",
    cwd: "/tmp",
    title: "Capability-filtered parent",
    modeId: "full-access",
  });
  expect(providerSessions).toHaveLength(1);

  await Promise.all([
    capable.client.listProviderSubagents(parent.id),
    incapable.client.listProviderSubagents(parent.id),
  ]);
  capable.clear();
  incapable.clear();

  emitProviderChild(providerSessions[0], { id: "capability-filtered-child" });
  await capable.waitForProviderUpdate(parent.id, "capability-filtered-child");
  await incapable.barrier("capability-filtered-child");
  expect(incapable.hasProviderUpdate(parent.id, "capability-filtered-child")).toBe(false);
}, 30_000);

test("timeline requests register interest and responses stay on the requesting socket", async () => {
  const interested = await connect("shared-provider-timeline-client");
  const otherSocket = await connect("shared-provider-timeline-client");
  const parent = await interested.client.createAgent({
    provider: "codex",
    cwd: "/tmp",
    title: "Timeline-scoped parent",
    modeId: "full-access",
  });
  expect(providerSessions).toHaveLength(1);
  emitProviderChild(providerSessions[0], { id: "timeline-scoped-child" });
  await expect
    .poll(() => daemon.daemon.agentManager.listProviderSubagents(parent.id))
    .toHaveLength(1);
  interested.clear();
  otherSocket.clear();

  await interested.client.fetchProviderSubagentTimeline(parent.id, "timeline-scoped-child", {
    requestId: "source-scoped-provider-child-timeline",
  });
  await otherSocket.barrier("source-scoped-provider-child-timeline");
  expect(
    interested.messages.some(
      (message) =>
        message.type === "agent.provider_subagents.timeline.get.response" &&
        message.payload.requestId === "source-scoped-provider-child-timeline",
    ),
  ).toBe(true);
  expect(
    otherSocket.messages.some(
      (message) =>
        message.type === "agent.provider_subagents.timeline.get.response" &&
        message.payload.requestId === "source-scoped-provider-child-timeline",
    ),
  ).toBe(false);

  interested.clear();
  otherSocket.clear();
  emitProviderChild(providerSessions[0], {
    id: "timeline-scoped-child",
    status: "completed",
  });
  await interested.waitForProviderUpdate(parent.id, "timeline-scoped-child");
  await otherSocket.barrier("timeline-request-registers-interest");
  expect(otherSocket.hasProviderUpdate(parent.id, "timeline-scoped-child")).toBe(false);
}, 30_000);
