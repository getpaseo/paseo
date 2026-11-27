import { createIdleRuntimeCleanup } from "../idle-runtime-cleanup/index.js";
import { HostObservationError } from "../host-operations/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { formatAgentMessage, parseAgentMessage } from "../agent-messages/envelope.js";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { buildStoredAgentPayload } from "../agent-projections.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  createFinishSubscriptions,
  createJsonFinishSubscriptionStore,
  type FinishObservation,
  type FinishSubscription,
  type FinishSubscriptions,
  type PendingWork,
} from "./index.js";
import type { FinishObservationResult } from "./internal/observation-buffer.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Observation implements FinishObservation {
  waits: Array<{
    signal: AbortSignal;
    childAgentId: string;
    result: ReturnType<typeof deferred<FinishObservationResult>>;
  }> = [];
  permission = deferred<void>();
  opening: Promise<void> = Promise.resolve();
  openedSignals: AbortSignal[] = [];
  /** Work that will start each child's next turn by itself, as the local host reports it. */
  work = new Map<string, PendingWork[]>();
  async open(record: FinishSubscription, signal: AbortSignal) {
    this.openedSignals.push(signal);
    await this.opening;
    return { next: () => this.wait(record.childAgentId, signal), close: async () => {} };
  }
  pendingWork(record: FinishSubscription): PendingWork[] {
    return this.work.get(record.childAgentId) ?? [];
  }
  waitsFor(childAgentId: string) {
    return this.waits.filter((entry) => entry.childAgentId === childAgentId);
  }
  async wait(childAgentId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const result = deferred<FinishObservationResult>();
    signal.addEventListener("abort", () => result.reject(new Error("Stopped")), { once: true });
    this.waits.push({ signal, childAgentId, result });
    return result.promise;
  }
  afterPermission() {
    return this.permission.promise;
  }
}
class Delivery implements AgentMessageDelivery {
  prompts: string[] = [];
  /** Prompts as the recipient's provider receives them, inside their envelope. */
  enqueued: string[] = [];
  acknowledgments: Array<ReturnType<typeof deferred<"steered">>> = [];
  enqueue(message: Parameters<AgentMessageDelivery["enqueue"]>[0]) {
    this.prompts.push(String(message.prompt));
    this.enqueued.push(
      formatAgentMessage({
        id: "notification",
        source: message.source ?? null,
        text: String(message.prompt),
      }),
    );
    const acknowledgment = deferred<"steered">();
    this.acknowledgments.push(acknowledgment);
    return {
      status: "queued" as const,
      messageId: "notification",
      dispatched: acknowledgment.promise,
    };
  }
  async close() {}
  async waitForDispatch() {}
}
const homes: string[] = [];
const services: FinishSubscriptions[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function scenario(
  directory?: string,
  removalFailures = 0,
  retryDelayMs = 1,
  followLimitMs?: number,
) {
  const home = directory ?? (await mkdtemp(join(tmpdir(), "finish-recovery-")));
  if (!directory) homes.push(home);
  const durableStore = createJsonFinishSubscriptionStore(home);
  const store = {
    ...durableStore,
    async remove(id: string) {
      if (removalFailures > 0) {
        removalFailures--;
        throw new Error("Subscription removal unavailable");
      }
      await durableStore.remove(id);
    },
  };
  const observation = new Observation();
  const delivery = new Delivery();
  let active = true;
  const service = createFinishSubscriptions({
    store,
    messages: () => delivery,
    open: observation.open.bind(observation),
    pendingWork: observation.pendingWork.bind(observation),
    callerIsActive: async () => active,
    serverId: "origin",
    logger: createTestLogger(),
    retryDelayMs,
    ...(followLimitMs === undefined ? {} : { followLimitMs }),
  });
  services.push(service);
  await service.start();
  return {
    home,
    store,
    observation,
    delivery,
    service,
    archive: () => {
      active = false;
    },
  };
}
const intent = { callerAgentId: "parent", childAgentId: "child" };
function outcome(
  status: "idle" | "running" | "closed" | "error" = "closed",
  childAgentId = "child",
  lastMessage = "Partial work saved",
): WaitForFinishResult {
  return {
    status: status === "error" ? "error" : "idle",
    final: buildStoredAgentPayload(
      {
        id: childAgentId,
        provider: "codex",
        cwd: "/tmp",
        title: "Child",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: { "paseo.parent-agent-id": "parent" },
        lastStatus: status,
      },
      ["codex"],
      (_provider, own) => own ?? {},
    ),
    lastMessage,
    error: null,
  };
}
async function until(check: () => boolean) {
  await expect.poll(check).toBe(true);
}

test("retains intent until parent dispatch acknowledgment, then restart sends nothing", async () => {
  const first = await scenario();
  await first.service.register(intent);
  await until(() => first.observation.waits.length === 1);
  first.observation.waits[0]!.result.resolve(outcome());
  await until(() => first.delivery.prompts.length === 1);
  expect(first.delivery.prompts[0]).toContain("was closed");
  expect(first.delivery.prompts[0]).toContain("Partial work saved");
  expect(await first.store.list()).toHaveLength(1);
  first.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await first.store.list()).length).toBe(0);
  await first.service.close();
  const restarted = await scenario(first.home);
  expect(restarted.observation.waits).toHaveLength(0);
});

test("restart coalesces predecessor and queued candidate into one settled notification", async () => {
  const first = await scenario();
  await first.service.register(intent);
  await first.service.register(intent, true);
  expect(await first.store.list()).toHaveLength(2);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.waits.length === 1);
  restarted.observation.waits[0]!.result.resolve(outcome());
  await until(() => restarted.delivery.prompts.length === 1);
  restarted.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await restarted.store.list()).length).toBe(0);
  expect(restarted.delivery.prompts).toHaveLength(1);
});

test("rejected queued follow-up preserves the predecessor and its buffered finish", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const pending = await state.service.register(intent, true);
  state.observation.waits[0]!.result.resolve(outcome("idle"));
  await Promise.resolve();
  expect(state.delivery.prompts).toHaveLength(0);
  await pending.reject();
  await until(() => state.delivery.prompts.length === 1);
  expect(await state.store.list()).toHaveLength(1);
});

test("accepted replacement ignores old idle and stale acknowledgment cannot delete new intent", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  const next = await state.service.register(intent, true);
  next.accept();
  await until(() => state.observation.waits.length === 2);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(1);
  state.observation.waits[1]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 2);
});

test("shutdown before dispatch acknowledgment leaves intent for recovery", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome());
  await until(() => state.delivery.prompts.length === 1);
  await state.service.close();
  state.delivery.acknowledgments[0]!.resolve("steered");
  const restarted = await scenario(state.home);
  await until(() => restarted.observation.waits.length === 1);
  restarted.observation.waits[0]!.result.resolve(outcome());
  await until(() => restarted.delivery.prompts.length === 1);
});

test("remote recovery before three failed observations still reports child completion", async () => {
  const first = await scenario();
  await first.service.register({ ...intent, serverId: "remote" });
  await first.service.close();
  const state = await scenario(first.home);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.reject(new HostObservationError("unreachable"));
  await until(() => state.observation.waits.length === 2);
  expect(await state.store.list()).toHaveLength(1);
  expect(state.delivery.prompts).toHaveLength(0);
  state.observation.waits[1]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("Server: remote");
});

test("archived parent suppresses delivery and removes obsolete intent", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.archive();
  state.observation.waits[0]!.result.resolve(outcome());
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
  expect(state.delivery.prompts).toHaveLength(0);
});

test("permission checkpoint retains intent and completion reports after permission clears", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const result = outcome("running");
  result.status = "permission";
  result.final!.pendingPermissions = [
    {
      id: "permission",
      name: "Write",
      input: { path: "file" },
      kind: "tool",
    } as (typeof result.final.pendingPermissions)[number],
  ];
  state.observation.waits[0]!.result.resolve(result);
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("respond_to_permission");
  expect(await state.store.list()).toHaveLength(1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  state.observation.permission.resolve();
  await until(() => state.observation.waits.length === 2);
  state.observation.waits[1]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 2);
});

test("coalesced unconditional follow-up survives detachment of a parent-owned creation", async () => {
  const first = await scenario();
  await first.service.register({ ...intent, requireParentOwnership: true });
  await first.service.register(intent, true);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.waits.length === 1);
  const detached = outcome();
  detached.final!.labels = {};
  restarted.observation.waits[0]!.result.resolve(detached);
  await until(() => restarted.delivery.prompts.length === 1);
});

test("detached child suppresses a parent-owned creation subscription", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, requireParentOwnership: true });
  await until(() => state.observation.waits.length === 1);
  const detached = outcome();
  detached.final!.labels = {};
  state.observation.waits[0]!.result.resolve(detached);
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
  expect(state.delivery.prompts).toHaveLength(0);
});

test("dispatch failure retains intent and retries the ordinary finish notification", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome());
  await until(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.reject(new Error("Provider unavailable"));
  await until(() => state.delivery.prompts.length === 2);
  expect(await state.store.list()).toHaveLength(1);
  expect(state.observation.waits).toHaveLength(1);
  state.delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
});

test("error and missing-child notifications never claim successful completion", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("error"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("errored");
  await state.service.register({ ...intent, childAgentId: "missing-child" });
  await until(() => state.observation.waits.length === 2);
  state.observation.waits[1]!.result.resolve({
    status: "error",
    final: null,
    error: "Agent not found: missing-child",
    lastMessage: null,
  });
  await until(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("is unavailable");
  expect(state.delivery.prompts[1]).not.toContain("finished");
});

test("finish notification limits a long last response and points to activity for the remainder", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const result = outcome("idle");
  result.lastMessage = "x".repeat(4100);
  state.observation.waits[0]!.result.resolve(result);
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("x".repeat(4000));
  expect(state.delivery.prompts[0]).not.toContain("x".repeat(4001));
  expect(state.delivery.prompts[0]).toContain("get_agent_activity");
});

test("three failed remote observations consume intent only after unavailable-notification acknowledgment", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, serverId: "remote" });
  for (let attempt = 0; attempt < 3; attempt++) {
    await until(() => state.observation.waits.length === attempt + 1);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[attempt]!.result.reject(new HostObservationError("unreachable"));
  }
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain(
    "Could not observe child agent child on host remote after three failed attempts.",
  );
  expect(state.delivery.prompts[0]).toContain("Status of child agent child (child) is unknown.");
  expect(state.delivery.prompts[0]).not.toContain("finished.");
  expect(await state.store.list()).toHaveLength(1);
  expect(state.observation.waits).toHaveLength(3);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
  await state.service.close();
  const restarted = await scenario(state.home);
  expect(restarted.observation.waits).toEqual([]);
  expect(restarted.delivery.prompts).toEqual([]);
});

test("connecting does not spend the remote failure budget and recovery before three failures still completes", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, serverId: "remote" });
  for (let attempt = 0; attempt < 4; attempt++) {
    await until(() => state.observation.waits.length === attempt + 1);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[attempt]!.result.reject(new HostObservationError("connecting"));
  }
  for (let attempt = 4; attempt < 6; attempt++) {
    await until(() => state.observation.waits.length === attempt + 1);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[attempt]!.result.reject(new HostObservationError("unreachable"));
  }
  await until(() => state.observation.waits.length === 7);
  expect(state.delivery.prompts).toEqual([]);
  state.observation.waits[6]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("finished.");
});

test("removed-host notice retries parent dispatch without observing again or deleting unacknowledged intent", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, serverId: "remote" });
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.reject(new HostObservationError("removed"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("Host remote was removed or is unavailable.");
  expect(state.delivery.prompts[0]).toContain("Status of child agent child (child) is unknown.");
  state.delivery.acknowledgments[0]!.reject(new Error("Parent provider unavailable"));
  await until(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toBe(state.delivery.prompts[0]);
  expect(state.observation.waits).toHaveLength(1);
  expect(await state.store.list()).toHaveLength(1);
  state.delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
});

test("failed removal after dispatch acknowledgment retries only storage, preserving the accepted outcome", async () => {
  const state = await scenario(undefined, 2, 1000);
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, { timeout: 10000 }).toBe(0);
  expect(state.delivery.prompts).toHaveLength(1);
  expect(state.delivery.prompts[0]).toContain("finished.");
  expect(state.observation.waits).toHaveLength(1);
});

test("shutdown during observation setup owns rejection of the already-canceled next result", async () => {
  const state = await scenario();
  const opening = deferred<void>();
  state.observation.opening = opening.promise;
  await state.service.register(intent);
  await until(() => state.observation.openedSignals.length === 1);
  const closing = state.service.close();
  await until(() => state.observation.openedSignals[0]!.aborted);
  opening.resolve();
  await closing;
  expect(await state.store.list()).toHaveLength(1);
  expect(state.delivery.prompts).toEqual([]);
});

test("remote finish intent protects its caller through registration, observation and delivery", async () => {
  const s = await scenario();
  let time = 61 * 60_000;
  let collected = false;
  const runtime = {
    identity: {},
    agentId: "parent",
    parentAgentId: undefined,
    provider: "test",
    sessionId: "parent",
    lastActivityAt: 0,
    isEligible: () => !collected,
    closeIfEligible: async (revalidate: () => boolean) => {
      if (!revalidate()) return false;
      collected = true;
      return true;
    },
  };
  const cleanup = createIdleRuntimeCleanup({
    enabled: true,
    logger: createTestLogger(),
    now: () => time,
    runtimes: () => (collected ? [] : [runtime]),
    isProtected: (agentId) => s.service.hasPendingForCaller(agentId),
    schedule: () => () => {},
  });
  const savedPut = s.store.put.bind(s.store);
  const writing = deferred<void>();
  s.store.put = async (record) => {
    await writing.promise;
    await savedPut(record);
  };
  const registration = s.service.register({ ...intent, serverId: "remote" }, true);
  const protectedDuringRegistration = s.service.hasPendingForCaller?.("parent") ?? false;
  writing.resolve();
  const accepted = await registration;
  expect(protectedDuringRegistration).toBe(true);
  expect((await cleanup.sweep()).collected).toEqual([]);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  accepted.accept();
  await until(() => s.observation.waits.length === 1);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  s.observation.waits[0]!.result.resolve(outcome());
  await until(() => s.delivery.prompts.length === 1);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  s.delivery.acknowledgments[0]!.resolve("steered");
  await until(() => !s.service.hasPendingForCaller("parent"));
  expect(await s.store.list()).toEqual([]);
  time = 62 * 60_000;
  expect((await cleanup.sweep()).collected).toEqual([]);
  time = 122 * 60_000;
  expect((await cleanup.sweep()).collected).toHaveLength(1);
  await cleanup.close();
});

test("finish recovery protects callers before durable intent has loaded", async () => {
  const s = await scenario();
  await s.service.register({ ...intent, serverId: "remote" });
  await s.service.close();
  const loading = deferred<void>();
  const recovered = createFinishSubscriptions({
    store: {
      ...s.store,
      list: async () => {
        await loading.promise;
        return s.store.list();
      },
    },
    messages: () => s.delivery,
    open: s.observation.open.bind(s.observation),
    pendingWork: s.observation.pendingWork.bind(s.observation),
    callerIsActive: async () => true,
    serverId: "origin",
    logger: createTestLogger(),
  });
  services.push(recovered);
  expect(recovered.hasPendingForCaller("parent")).toBe(true);
  const starting = recovered.start();
  expect(recovered.hasPendingForCaller("parent")).toBe(true);
  loading.resolve();
  await starting;
  expect(recovered.hasPendingForCaller("parent")).toBe(true);
  expect(recovered.hasPendingForCaller("unrelated")).toBe(false);
});

test("an undispatched follow-up does not block the running child's permission notification", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  await state.service.register(intent, true);
  const result = outcome("running");
  result.status = "permission";
  result.final!.pendingPermissions = [
    {
      id: "approval",
      provider: "codex",
      name: "Bash",
      kind: "tool",
      input: { command: "run tests" },
    } as NonNullable<typeof result.final>["pendingPermissions"][number],
  ];
  state.observation.waits[0]!.result.resolve(result);
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("needs permission");
  expect(state.delivery.prompts[0]).toContain("approval");
  expect(await state.store.list()).toHaveLength(2);
});

describe("a child that ends its turn while it is still working", () => {
  async function following(state: Awaited<ReturnType<typeof scenario>>) {
    await state.service.register(intent);
    await until(() => state.observation.waits.length === 1);
    state.observation.work.set("child", ["background work"]);
    state.observation.waits[0]!.result.resolve(outcome("idle", "child", "Waiting for the build"));
    await until(() => state.delivery.prompts.length === 1);
    state.delivery.acknowledgments[0]!.resolve("steered");
    await until(() => state.observation.waits.length === 2);
  }

  test("reports one interim notice, then finished with the reply of the turn that settles it", async () => {
    const state = await scenario();
    await following(state);
    const interim = state.delivery.prompts[0]!;
    expect(interim).toContain("Agent child (Child) ended its turn but is still working");
    expect(interim).toContain("background work");
    expect(interim).toContain("This is not its final reply");
    expect(interim).toContain("Waiting for the build");
    expect(interim).not.toContain("Child) finished.");
    expect(parseAgentMessage(state.delivery.enqueued[0]!)).toMatchObject({
      source: { kind: "agent-notification", event: "message" },
    });
    expect(await state.store.list()).toEqual([
      expect.objectContaining({ followingSince: expect.any(String) }),
    ]);

    state.observation.work.set("child", []);
    state.observation.waits[1]!.result.resolve(outcome("idle", "child", "FINAL: done"));
    await until(() => state.delivery.prompts.length === 2);
    expect(state.delivery.prompts[1]).toContain("Agent child (Child) finished.");
    expect(state.delivery.prompts[1]).toContain("FINAL: done");
    expect(parseAgentMessage(state.delivery.enqueued[1]!)).toMatchObject({
      source: { event: "finished" },
    });
    state.delivery.acknowledgments[1]!.resolve("steered");
    await expect.poll(async () => (await state.store.list()).length).toBe(0);
    // A turn a person starts after the child settled has no observer left to report it.
    expect(state.observation.waits).toHaveLength(2);
    expect(state.service.hasPendingForCaller("parent")).toBe(false);
  });

  test("stays silent for turns that end while work is still pending", async () => {
    const state = await scenario();
    await following(state);
    state.observation.waits[1]!.result.resolve(outcome("idle", "child", "Still waiting"));
    await until(() => state.observation.waits.length === 3);
    expect(state.delivery.prompts).toHaveLength(1);
    state.observation.work.set("child", []);
    state.observation.waits[2]!.result.resolve(outcome("idle", "child", "FINAL"));
    await until(() => state.delivery.prompts.length === 2);
    expect(state.delivery.prompts[1]).toContain("finished.");
  });

  test("sends finished when its work drains while it is idle, without another turn", async () => {
    const state = await scenario();
    await following(state);
    state.observation.work.set("child", []);
    state.observation.waits[1]!.result.resolve({
      ...outcome("idle", "child", "Waiting for the build"),
      workChanged: true,
    });
    await until(() => state.delivery.prompts.length === 2);
    expect(state.delivery.prompts[1]).toContain("Agent child (Child) finished.");
  });

  test("ignores a work change before the child's first turn ends", async () => {
    const state = await scenario();
    await state.service.register(intent);
    await until(() => state.observation.waits.length === 1);
    state.observation.waits[0]!.result.resolve({ ...outcome("idle"), workChanged: true });
    await until(() => state.observation.waits.length === 2);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[1]!.result.resolve(outcome("idle"));
    await until(() => state.delivery.prompts.length === 1);
    expect(state.delivery.prompts[0]).toContain("finished.");
  });

  test("restart while following neither repeats the notice nor loses the final finish", async () => {
    const first = await scenario();
    await following(first);
    await first.service.close();
    const restarted = await scenario(first.home);
    await until(() => restarted.observation.waits.length === 1);
    restarted.observation.work.set("child", ["queued messages"]);
    restarted.observation.waits[0]!.result.resolve(outcome("idle", "child", "Still waiting"));
    await until(() => restarted.observation.waits.length === 2);
    expect(restarted.delivery.prompts).toEqual([]);
    restarted.observation.work.set("child", []);
    restarted.observation.waits[1]!.result.resolve(outcome("idle", "child", "FINAL"));
    await until(() => restarted.delivery.prompts.length === 1);
    expect(restarted.delivery.prompts[0]).toContain("finished.");
    expect(restarted.delivery.prompts[0]).toContain("FINAL");
  });

  test("a permission request raised after waking up reaches the parent", async () => {
    const state = await scenario();
    await following(state);
    const result = outcome("running");
    result.status = "permission";
    result.final!.pendingPermissions = [
      { id: "plan", name: "ExitPlanMode", input: {}, kind: "plan" } as NonNullable<
        typeof result.final
      >["pendingPermissions"][number],
    ];
    state.observation.waits[1]!.result.resolve(result);
    await until(() => state.delivery.prompts.length === 2);
    expect(state.delivery.prompts[1]).toContain("needs permission");
    expect(state.delivery.prompts[1]).toContain("respond_to_permission");
    state.delivery.acknowledgments[1]!.resolve("steered");
    await until(() => state.observation.waits.length === 3);
    state.observation.work.set("child", []);
    state.observation.waits[2]!.result.resolve(outcome("idle", "child", "Plan approved and done"));
    await until(() => state.delivery.prompts.length === 3);
    expect(state.delivery.prompts[2]).toContain("finished.");
    expect(state.delivery.prompts[2]).toContain("Plan approved and done");
  });

  test("a helper waiting on its own delegated agent is followed until that delegation settles", async () => {
    const state = await scenario();
    await state.service.register({ callerAgentId: "parent", childAgentId: "helper" });
    await state.service.register({ callerAgentId: "helper", childAgentId: "sub" });
    await until(() => state.observation.waits.length === 2);
    const wait = (child: string, index = 0) => state.observation.waitsFor(child)[index]!;

    wait("helper").result.resolve(outcome("idle", "helper", "Waiting for my helper"));
    await until(() => state.delivery.prompts.length === 1);
    expect(state.delivery.prompts[0]).toContain("ended its turn but is still working");
    expect(state.delivery.prompts[0]).toContain("agents it is waiting on");
    state.delivery.acknowledgments[0]!.resolve("steered");

    wait("sub").result.resolve(outcome("idle", "sub", "Sub result"));
    await until(() => state.delivery.prompts.length === 2);
    expect(state.delivery.prompts[1]).toContain("Agent sub (Child) finished.");
    state.delivery.acknowledgments[1]!.resolve("steered");
    await until(() => !state.service.hasPendingForCaller("helper"));

    await until(() => state.observation.waitsFor("helper").length === 2);
    wait("helper", 1).result.resolve(outcome("idle", "helper", "Helper final"));
    await until(() => state.delivery.prompts.length === 3);
    expect(state.delivery.prompts[2]).toContain("Agent helper (Child) finished.");
    expect(state.delivery.prompts[2]).toContain("Helper final");
  });

  test("a followed helper settles when its last delegation ends without reporting to it", async () => {
    const state = await scenario();
    await state.service.register({ callerAgentId: "parent", childAgentId: "helper" });
    await state.service.register({
      callerAgentId: "helper",
      childAgentId: "sub",
      requireParentOwnership: true,
    });
    await until(() => state.observation.waits.length === 2);
    const wait = (child: string, index = 0) => state.observation.waitsFor(child)[index]!;

    wait("helper").result.resolve(outcome("idle", "helper", "Waiting for my helper"));
    await until(() => state.delivery.prompts.length === 1);
    expect(state.delivery.prompts[0]).toContain("ended its turn but is still working");
    state.delivery.acknowledgments[0]!.resolve("steered");

    // The sub was detached from the helper, so its result is not reported to the helper.
    wait("sub").result.resolve(outcome("idle", "sub", "Sub result"));
    await until(() => state.delivery.prompts.length === 2);
    expect(state.delivery.prompts[1]).toContain("Agent helper (Child) finished.");
    expect(state.delivery.prompts[1]).toContain("Waiting for my helper");
    expect(state.delivery.prompts[1]).not.toContain("Sub result");
  });

  test("agents that only wait on each other settle and both callers hear finished", async () => {
    const state = await scenario();
    await state.service.register({ callerAgentId: "parent", childAgentId: "helper" });
    await until(() => state.observation.waits.length === 1);
    // The helper asks its parent a question and waits for the answer.
    await state.service.register({ callerAgentId: "helper", childAgentId: "parent" });
    await until(() => state.observation.waits.length === 2);
    const wait = (child: string, index = 0) => state.observation.waitsFor(child)[index]!;

    state.observation.work.set("parent", ["turn"]);
    wait("helper").result.resolve(outcome("idle", "helper", "Asked my parent"));
    await until(() => state.delivery.prompts.length === 1);
    expect(state.delivery.prompts[0]).toContain("Agent helper (Child) ended its turn");
    state.delivery.acknowledgments[0]!.resolve("steered");

    // The parent answers. It waits on the helper, and the helper waits only on it.
    state.observation.work.set("parent", []);
    wait("parent").result.resolve(outcome("idle", "parent", "The answer"));
    await until(() => state.delivery.prompts.length === 2);
    expect(state.delivery.prompts[1]).toContain("Agent parent (Child) finished.");
    expect(state.delivery.prompts[1]).toContain("The answer");
    state.delivery.acknowledgments[1]!.resolve("steered");
    await until(() => !state.service.hasPendingForCaller("helper"));

    await until(() => state.observation.waitsFor("helper").length === 2);
    wait("helper", 1).result.resolve(outcome("idle", "helper", "Helper final"));
    await until(() => state.delivery.prompts.length === 3);
    expect(state.delivery.prompts[2]).toContain("Agent helper (Child) finished.");
    expect(state.delivery.prompts[2]).toContain("Helper final");
  });

  test("stops following at the follow limit and says the child is still working", async () => {
    const state = await scenario(undefined, 0, 1, 50);
    await following(state);
    await until(() => state.delivery.prompts.length === 2);
    expect(state.delivery.prompts[1]).toContain("Agent child (Child) is still working");
    expect(state.delivery.prompts[1]).toContain("This finish subscription has ended");
    expect(state.delivery.prompts[1]).not.toContain("finished.");
    state.delivery.acknowledgments[1]!.resolve("steered");
    await expect.poll(async () => (await state.store.list()).length).toBe(0);
  });

  test("errors while following end the subscription as they do today", async () => {
    const state = await scenario();
    await following(state);
    state.observation.waits[1]!.result.resolve(outcome("error"));
    await until(() => state.delivery.prompts.length === 2);
    expect(state.delivery.prompts[1]).toContain("errored");
    state.delivery.acknowledgments[1]!.resolve("steered");
    await expect.poll(async () => (await state.store.list()).length).toBe(0);
  });
});
