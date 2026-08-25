import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { watchAgentFinish, type FinishNotificationDelivery } from "./finish-notifications.js";
import { AgentManager, type AgentManagerEvent, type ManagedAgent } from "./agent-manager.js";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface DeliveredNotification extends FinishNotificationDelivery {
  childAgentId: string;
  callerAgentId: string;
}

interface CoordinatorScenario {
  agentManager: AgentManager;
  deliveries: DeliveredNotification[];
  subscriptionOptions: Array<{ agentId?: string; replayState?: boolean } | undefined>;
  activeSubscriptions(): number;
  evaluationCount(): number;
  addAgent(
    agentId: string,
    lifecycle?: "idle" | "running" | "error" | "closed",
    parentAgentId?: string,
  ): void;
  removeAgent(agentId: string): void;
  setState(
    agentId: string,
    lifecycle: "idle" | "running" | "error" | "closed",
    options?: { parentAgentId?: string | null; inFlight?: boolean },
  ): void;
  requestPermission(agentId: string, requestId: string): void;
  resolvePermission(agentId: string, requestId: string): void;
  watch(childAgentId: string, callerAgentId: string, requireParentOwnership?: boolean): void;
}

function createAgent(
  agentId: string,
  lifecycle: "idle" | "running" | "error" | "closed",
  parentAgentId?: string,
): ManagedAgent {
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", agentId);
  Reflect.set(agent, "lifecycle", lifecycle);
  Reflect.set(agent, "config", { title: agentId });
  Reflect.set(agent, "labels", parentAgentId ? { "paseo.parent-agent-id": parentAgentId } : {});
  Reflect.set(agent, "pendingPermissions", new Map());
  return agent;
}

function createPermission(requestId: string): AgentPermissionRequest {
  return {
    id: requestId,
    provider: "codex",
    kind: "tool",
    name: "Run command",
    description: "Run the requested command",
    input: { command: "true" },
  };
}

function createCoordinatorScenario(options?: {
  deliver?: (delivery: DeliveredNotification, scenario: CoordinatorScenario) => Promise<void>;
}): CoordinatorScenario {
  const agents = new Map<string, ManagedAgent>();
  const inFlight = new Set<string>();
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const deliveries: DeliveredNotification[] = [];
  const subscriptionOptions: Array<{ agentId?: string; replayState?: boolean } | undefined> = [];
  let evaluationCount = 0;

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "listAgents", () => {
    evaluationCount += 1;
    return Array.from(agents.values());
  });
  Reflect.set(agentManager, "getAgent", (agentId: string) => agents.get(agentId) ?? null);
  Reflect.set(agentManager, "hasInFlightRun", (agentId: string) => inFlight.has(agentId));
  Reflect.set(
    agentManager,
    "subscribe",
    (
      callback: (event: AgentManagerEvent) => void,
      subscribeOptions?: { agentId?: string; replayState?: boolean },
    ) => {
      subscriptionOptions.push(subscribeOptions);
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  );

  function emit(event: AgentManagerEvent): void {
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }

  const scenario: CoordinatorScenario = {
    agentManager,
    deliveries,
    subscriptionOptions,
    activeSubscriptions: () => subscribers.size,
    evaluationCount: () => evaluationCount,
    addAgent(agentId, lifecycle = "idle", parentAgentId) {
      agents.set(agentId, createAgent(agentId, lifecycle, parentAgentId));
      if (lifecycle === "running") inFlight.add(agentId);
    },
    removeAgent(agentId) {
      agents.delete(agentId);
      inFlight.delete(agentId);
    },
    setState(agentId, lifecycle, stateOptions) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`Agent ${agentId} is missing`);
      Reflect.set(agent, "lifecycle", lifecycle);
      if (stateOptions?.parentAgentId === null) {
        Reflect.set(agent, "labels", {});
      } else if (stateOptions?.parentAgentId) {
        Reflect.set(agent, "labels", {
          "paseo.parent-agent-id": stateOptions.parentAgentId,
        });
      }
      if (stateOptions?.inFlight ?? lifecycle === "running") {
        inFlight.add(agentId);
      } else {
        inFlight.delete(agentId);
      }
      emit({ type: "agent_state", agent });
    },
    requestPermission(agentId, requestId) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`Agent ${agentId} is missing`);
      const request = createPermission(requestId);
      agent.pendingPermissions.set(requestId, request);
      emit({
        type: "agent_stream",
        agentId,
        event: { type: "permission_requested", provider: "codex", request },
      });
    },
    resolvePermission(agentId, requestId) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`Agent ${agentId} is missing`);
      agent.pendingPermissions.delete(requestId);
      emit({
        type: "agent_stream",
        agentId,
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    watch(childAgentId, callerAgentId, requireParentOwnership = false) {
      watchAgentFinish({
        agentManager,
        childAgentId,
        callerAgentId,
        requireParentOwnership,
        logger: createTestLogger(),
        deliver: async (delivery) => {
          const captured = { childAgentId, callerAgentId, ...delivery };
          deliveries.push(captured);
          await options?.deliver?.(captured, scenario);
        },
      });
    },
  };
  return scenario;
}

async function expectDeliveryCount(scenario: CoordinatorScenario, count: number): Promise<void> {
  await vi.waitFor(() => expect(scenario.deliveries).toHaveLength(count));
}

test("permission stream events do not schedule graph evaluation", async () => {
  const scenario = createCoordinatorScenario();
  scenario.addAgent("caller");
  scenario.addAgent("child", "running", "caller");
  scenario.watch("child", "caller", true);
  await vi.waitFor(() => expect(scenario.evaluationCount()).toBe(1));

  scenario.requestPermission("child", "permission-1");
  await expectDeliveryCount(scenario, 1);
  expect(scenario.evaluationCount()).toBe(1);

  scenario.resolvePermission("child", "permission-1");
  await Promise.resolve();
  expect(scenario.evaluationCount()).toBe(1);
});

test("ordinary completion is delivered exactly once through one global subscription", async () => {
  const scenario = createCoordinatorScenario();
  scenario.addAgent("caller");
  scenario.addAgent("child", "idle", "caller");
  scenario.watch("child", "caller", true);

  scenario.setState("child", "running");
  scenario.setState("child", "idle");
  await expectDeliveryCount(scenario, 1);
  scenario.setState("child", "idle");

  expect(scenario.deliveries).toEqual([
    { childAgentId: "child", callerAgentId: "caller", reason: "finished" },
  ]);
  expect(scenario.subscriptionOptions).toEqual([{ replayState: false }]);
  expect(scenario.activeSubscriptions()).toBe(0);
});

test("a running label descendant blocks completion", async () => {
  const scenario = createCoordinatorScenario();
  scenario.addAgent("caller");
  scenario.addAgent("child", "idle", "caller");
  scenario.addAgent("descendant", "running", "child");
  scenario.watch("child", "caller", true);

  scenario.setState("child", "running");
  scenario.setState("child", "idle");
  await Promise.resolve();
  expect(scenario.deliveries).toEqual([]);

  scenario.setState("descendant", "idle");
  await expectDeliveryCount(scenario, 1);
});

test("a queued descendant delivery blocks until the target follow-up is finally idle", async () => {
  const releaseDelivery = createDeferred<void>();
  const deliveryStarted = createDeferred<void>();
  const scenario = createCoordinatorScenario({
    deliver: async (delivery, current) => {
      if (delivery.childAgentId !== "grandchild") return;
      deliveryStarted.resolve();
      await releaseDelivery.promise;
      current.setState("dispatcher", "running", { inFlight: true });
    },
  });
  scenario.addAgent("caller");
  scenario.addAgent("dispatcher", "running", "caller");
  scenario.addAgent("grandchild", "running", "dispatcher");
  scenario.watch("dispatcher", "caller", true);
  scenario.watch("grandchild", "dispatcher", true);

  scenario.setState("dispatcher", "idle");
  scenario.setState("grandchild", "idle");
  await deliveryStarted.promise;
  expect(scenario.deliveries.map((delivery) => delivery.childAgentId)).toEqual(["grandchild"]);

  releaseDelivery.resolve();
  await vi.waitFor(() => expect(scenario.agentManager.hasInFlightRun("dispatcher")).toBe(true));
  expect(scenario.deliveries.map((delivery) => delivery.childAgentId)).toEqual(["grandchild"]);

  scenario.setState("dispatcher", "idle", { inFlight: false });
  await expectDeliveryCount(scenario, 2);
  expect(scenario.deliveries.map((delivery) => delivery.childAgentId)).toEqual([
    "grandchild",
    "dispatcher",
  ]);
});

test("transitive watcher dependencies drain from leaf to root", async () => {
  const scenario = createCoordinatorScenario();
  for (const agentId of ["root", "first", "second", "third"]) {
    scenario.addAgent(agentId);
  }
  scenario.watch("first", "root");
  scenario.watch("second", "first");
  scenario.watch("third", "second");

  for (const agentId of ["first", "second", "third"]) scenario.setState(agentId, "running");
  scenario.setState("first", "idle");
  scenario.setState("second", "idle");
  scenario.setState("third", "idle");

  await expectDeliveryCount(scenario, 3);
  expect(scenario.deliveries.map((delivery) => delivery.childAgentId)).toEqual([
    "third",
    "second",
    "first",
  ]);
});

test.each([
  { name: "self", edges: [["first", "first"]] },
  {
    name: "mutual",
    edges: [
      ["first", "second"],
      ["second", "first"],
    ],
  },
])("an entirely idle $name watcher cycle drains", async ({ edges }) => {
  const scenario = createCoordinatorScenario();
  scenario.addAgent("first");
  scenario.addAgent("second");
  for (const [childAgentId, callerAgentId] of edges) {
    scenario.watch(childAgentId, callerAgentId);
  }

  scenario.setState("first", "running");
  scenario.setState("second", "running");
  scenario.setState("first", "idle");
  scenario.setState("second", "idle");

  await expectDeliveryCount(scenario, edges.length);
});

test("detaching a child releases its former parent", async () => {
  const scenario = createCoordinatorScenario();
  scenario.addAgent("root");
  scenario.addAgent("parent", "running", "root");
  scenario.addAgent("child", "running", "parent");
  scenario.watch("parent", "root", true);
  scenario.watch("child", "parent", true);

  scenario.setState("parent", "idle");
  scenario.setState("child", "idle", { parentAgentId: null });

  await expectDeliveryCount(scenario, 1);
  expect(scenario.deliveries).toEqual([
    { childAgentId: "parent", callerAgentId: "root", reason: "finished" },
  ]);
});

test("a temporarily missing reload snapshot waits for later state", async () => {
  const scenario = createCoordinatorScenario();
  scenario.addAgent("caller");
  scenario.addAgent("child", "running", "caller");
  scenario.watch("child", "caller", true);

  scenario.removeAgent("child");
  scenario.setState("caller", "idle");
  await Promise.resolve();
  expect(scenario.deliveries).toEqual([]);

  scenario.addAgent("child", "idle", "caller");
  scenario.setState("child", "idle");
  await expectDeliveryCount(scenario, 1);
});

test.each(["skipped", "failed"])("a $s descendant delivery releases its ancestor", async (kind) => {
  const scenario = createCoordinatorScenario({
    deliver: async (delivery) => {
      if (delivery.childAgentId === "child" && kind === "failed") {
        throw new Error("delivery failed");
      }
    },
  });
  scenario.addAgent("root");
  scenario.addAgent("parent", "running");
  scenario.addAgent("child", "running");
  scenario.watch("parent", "root");
  scenario.watch("child", "parent");

  scenario.setState("parent", "idle");
  scenario.setState("child", "idle");

  await expectDeliveryCount(scenario, 2);
  expect(scenario.deliveries.map((delivery) => delivery.childAgentId)).toEqual(["child", "parent"]);
});

test("permission requests deduplicate the same ID", async () => {
  const scenario = createCoordinatorScenario();
  scenario.addAgent("caller");
  scenario.addAgent("child", "running", "caller");
  scenario.watch("child", "caller", true);

  scenario.requestPermission("child", "permission-1");
  scenario.requestPermission("child", "permission-1");
  await expectDeliveryCount(scenario, 1);
  expect(scenario.deliveries[0]?.reason).toBe("needs permission");
});

test.each([
  { lifecycle: "error" as const, reason: "errored" as const },
  { lifecycle: "closed" as const, reason: "was closed" as const },
])(
  "a watched agent that becomes $lifecycle bypasses a running descendant watcher",
  async ({ lifecycle, reason }) => {
    const scenario = createCoordinatorScenario();
    scenario.addAgent("caller");
    scenario.addAgent("child", "running", "caller");
    scenario.addAgent("descendant", "running", "child");
    scenario.watch("child", "caller", true);
    scenario.watch("descendant", "child", true);

    scenario.setState("child", lifecycle);

    await expectDeliveryCount(scenario, 1);
    scenario.setState("child", lifecycle);
    await Promise.resolve();
    expect(scenario.deliveries).toEqual([
      { childAgentId: "child", callerAgentId: "caller", reason },
    ]);
    expect(scenario.agentManager.hasInFlightRun("descendant")).toBe(true);
  },
);
