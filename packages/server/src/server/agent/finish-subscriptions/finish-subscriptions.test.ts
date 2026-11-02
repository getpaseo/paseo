import { createIdleRuntimeCleanup } from "../idle-runtime-cleanup/index.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { sendPreparedPromptToAgent } from "../agent-prompt.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { HostObservationError } from "../host-operations/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { buildStoredAgentPayload } from "../agent-projections.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { FinishRunStarted } from "./internal/observation-buffer.js";
import {
  createFinishObservation,
  createFinishSubscriptions,
  createJsonFinishSubscriptionStore,
  type FinishObservation,
  type FinishSubscription,
  type FinishSubscriptions,
} from "./index.js";

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
    result: ReturnType<typeof deferred<WaitForFinishResult | FinishRunStarted>>;
  }> = [];
  permission = deferred<void>();
  opening: Promise<void> = Promise.resolve();
  openedSignals: AbortSignal[] = [];
  openedRecords: FinishSubscription[] = [];
  async open(record: FinishSubscription, signal: AbortSignal) {
    this.openedSignals.push(signal);
    this.openedRecords.push(record);
    await this.opening;
    return { next: () => this.wait(signal), close: async () => {} };
  }
  async wait(signal: AbortSignal) {
    signal.throwIfAborted();
    const result = deferred<WaitForFinishResult | FinishRunStarted>();
    signal.addEventListener("abort", () => result.reject(new Error("Stopped")), { once: true });
    this.waits.push({ signal, result });
    return result.promise;
  }
  afterPermission() {
    return this.permission.promise;
  }
}
class Delivery implements AgentMessageDelivery {
  prompts: string[] = [];
  acknowledgments: Array<ReturnType<typeof deferred<"steered">>> = [];
  enqueue(message: Parameters<AgentMessageDelivery["enqueue"]>[0]) {
    this.prompts.push(String(message.prompt));
    const acknowledgment = deferred<"steered">();
    this.acknowledgments.push(acknowledgment);
    return {
      status: "queued" as const,
      messageId: "notification",
      dispatched: acknowledgment.promise,
    };
  }
  dispatchWaits = 0;
  async close() {}
  async waitForDispatch() {
    this.dispatchWaits++;
  }
}
const homes: string[] = [];
const services: FinishSubscriptions[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function scenario(directory?: string, removalFailures = 0, retryDelayMs = 1) {
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
    callerIsActive: async () => active,
    serverId: "origin",
    logger: createTestLogger(),
    retryDelayMs,
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
function outcome(status: "idle" | "running" | "closed" | "error" = "closed"): WaitForFinishResult {
  return {
    status: status === "error" ? "error" : "idle",
    final: buildStoredAgentPayload(
      {
        id: "child",
        provider: "codex",
        cwd: "/tmp",
        title: "Child",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: { "paseo.parent-agent-id": "parent" },
        lastStatus: status,
      },
      ["codex"],
    ),
    lastMessage: "Partial work saved",
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

const standing = { ...intent, requireParentOwnership: true, standing: true };
const runStarted: FinishRunStarted = { runStarted: true };
function archived(): WaitForFinishResult {
  const result = outcome("closed");
  result.final!.archivedAt = "2026-01-02T00:00:00.000Z";
  return { ...result, noRun: true } as WaitForFinishResult;
}
async function reportFirstRun(s: Awaited<ReturnType<typeof scenario>>) {
  await s.service.register(standing, true).then((registration) => registration.accept());
  await until(() => s.observation.waits.length === 1);
  s.observation.waits[0]!.result.resolve(outcome("idle"));
  await until(() => s.delivery.prompts.length === 1);
  s.delivery.acknowledgments[0]!.resolve("steered");
  await until(() => s.observation.waits.length === 2);
}

test("standing subscription reports each settled run until the child is archived", async () => {
  const s = await scenario();
  await reportFirstRun(s);
  expect(await s.store.list()).toMatchObject([{ standing: true, reported: true }]);
  const second = outcome("idle");
  second.lastMessage = "Second run";
  s.observation.waits[1]!.result.resolve(second);
  await until(() => s.delivery.prompts.length === 2);
  expect(s.delivery.prompts[1]).toContain("Second run");
  s.delivery.acknowledgments[1]!.resolve("steered");
  await until(() => s.observation.waits.length === 3);
  s.observation.waits[2]!.result.resolve(archived());
  await expect.poll(async () => (await s.store.list()).length).toBe(0);
  expect(s.delivery.prompts).toHaveLength(2);
});

test("restart resumes a standing subscription without repeating the reported run", async () => {
  const first = await scenario();
  await reportFirstRun(first);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.openedRecords.length === 1);
  expect(restarted.observation.openedRecords[0]).toMatchObject({ standing: true, reported: true });
});

test("restart still owes a standing run that started after the reported outcome", async () => {
  const first = await scenario();
  await reportFirstRun(first);
  first.observation.waits[1]!.result.resolve(runStarted);
  await expect.poll(async () => (await first.store.list())[0]?.reported).toBe(false);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.openedRecords.length === 1);
  expect(restarted.observation.openedRecords[0]!.reported).toBe(false);
});

test("restart still owes a standing outcome whose dispatch was not acknowledged", async () => {
  const first = await scenario();
  await reportFirstRun(first);
  first.observation.waits[1]!.result.resolve(runStarted);
  await until(() => first.observation.waits.length === 3);
  first.observation.waits[2]!.result.resolve(outcome("idle"));
  await until(() => first.delivery.prompts.length === 2);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.openedRecords.length === 1);
  expect(restarted.observation.openedRecords[0]!.reported).toBe(false);
});

test("a follow-up registration for a standing pair keeps reporting after its own outcome", async () => {
  const s = await scenario();
  await reportFirstRun(s);
  const followUp = await s.service.register(intent, true);
  followUp.accept();
  await until(() => s.observation.waits.length === 3);
  expect(s.observation.waits[1]!.signal.aborted).toBe(true);
  expect(s.observation.openedRecords[1]).toMatchObject({ standing: true, reported: false });
  s.observation.waits[2]!.result.resolve(outcome("idle"));
  await until(() => s.delivery.prompts.length === 2);
  s.delivery.acknowledgments[1]!.resolve("steered");
  await until(() => s.observation.waits.length === 4);
  expect(await s.store.list()).toMatchObject([{ standing: true, reported: true }]);
});

test("a standing subscription holds its caller from each run's start until its outcome is acknowledged", async () => {
  const s = await scenario();
  await s.service.register(standing, true).then((registration) => registration.accept());
  await until(() => s.observation.waits.length === 1);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  s.observation.waits[0]!.result.resolve(outcome("idle"));
  await until(() => s.delivery.prompts.length === 1);
  s.delivery.acknowledgments[0]!.resolve("steered");
  await until(() => s.observation.waits.length === 2);
  expect(s.service.hasPendingForCaller("parent")).toBe(false);
  s.observation.waits[1]!.result.resolve(runStarted);
  await until(() => s.observation.waits.length === 3);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  s.observation.waits[2]!.result.resolve(outcome("idle"));
  await until(() => s.delivery.prompts.length === 2);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  s.delivery.acknowledgments[1]!.resolve("steered");
  await until(() => s.observation.waits.length === 4);
  expect(s.service.hasPendingForCaller("parent")).toBe(false);
});

test("detachment ends a standing subscription without reporting the detached run", async () => {
  const s = await scenario();
  await reportFirstRun(s);
  const detached = outcome("idle");
  detached.final!.labels = {};
  s.observation.waits[1]!.result.resolve(detached);
  await expect.poll(async () => (await s.store.list()).length).toBe(0);
  expect(s.delivery.prompts).toHaveLength(1);
});

async function liveStanding(options: { recordReadDelayMs?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), "finish-standing-live-"));
  homes.push(home);
  const logger = createTestLogger();
  const agentStorage = new AgentStorage(join(home, "agents"), logger);
  const held = deferred<void>();
  const agentManager = new AgentManager({
    clients: createTestAgentClients({
      beforeTurnComplete: async (prompt) =>
        String(prompt).includes("HOLD") ? held.promise : undefined,
    }),
    registry: agentStorage,
    logger,
  });
  const parent = await agentManager.createAgent({ provider: "claude", cwd: home }, undefined, {
    workspaceId: undefined,
  });
  const child = await agentManager.createAgent({ provider: "claude", cwd: home }, undefined, {
    workspaceId: undefined,
    labels: { "paseo.parent-agent-id": parent.id },
  });
  const delivery = new Delivery();
  const store = createJsonFinishSubscriptionStore(home);
  const { recordReadDelayMs } = options;
  const observedStorage: AgentStorage =
    recordReadDelayMs === undefined
      ? agentStorage
      : Object.assign(Object.create(agentStorage), {
          async get(agentId: string) {
            const record = await agentStorage.get(agentId);
            await new Promise((resolve) => setTimeout(resolve, recordReadDelayMs));
            return record;
          },
        });
  const service = createFinishSubscriptions({
    store,
    messages: () => delivery,
    callerIsActive: async () => true,
    serverId: "origin",
    logger,
    retryDelayMs: 1,
    ...createFinishObservation({
      agentManager,
      agentStorage: observedStorage,
      waitForResume: async () => {},
      messages: () => delivery,
      hosts: () => {
        throw new Error("No connected hosts");
      },
      serverId: "origin",
      logger,
    }),
  });
  services.push(service);
  await service.start();
  const send = (prompt: string) =>
    sendPreparedPromptToAgent({ agentManager, agentStorage, agentId: child.id, prompt, logger });
  const registration = await service.register(
    {
      callerAgentId: parent.id,
      childAgentId: child.id,
      requireParentOwnership: true,
      standing: true,
    },
    true,
  );
  return { agentManager, agentStorage, child, delivery, store, send, registration, held };
}
async function liveChild() {
  const live = await liveStanding();
  await live.send("First task");
  live.registration.accept();
  await until(() => live.delivery.prompts.length === 1);
  live.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await live.store.list())[0]?.reported).toBe(true);
  return live;
}

test("a standing subscription follows a live child across idle cleanup, resume and archive", async () => {
  const { agentManager, child, delivery, store, send } = await liveChild();
  // Idle cleanup closes the runtime and keeps the record; that is not the end of the child.
  await agentManager.closeAgent(child.id);
  await send("Second task");
  await until(() => delivery.prompts.length === 2);
  expect(delivery.prompts[1]).toContain(`Agent ${child.id}`);
  expect(delivery.prompts[1]).toContain("finished");
  delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await store.list())[0]?.reported).toBe(true);
  await agentManager.closeAgent(child.id);
  await agentManager.archiveSnapshot(child.id, new Date().toISOString());
  await expect.poll(async () => store.list()).toEqual([]);
  expect(delivery.prompts).toHaveLength(2);
});

test("a standing subscription reports a run closed midway and keeps watching", async () => {
  // A slow record read holds back the closed state, so the opening wait's own result arrives first.
  const { agentManager, child, delivery, store, send, registration, held } = await liveStanding({
    recordReadDelayMs: 20,
  });
  // The watch opens while the child's first run is still working, as it does at creation.
  const first = send("HOLD the first task");
  await expect.poll(() => agentManager.getAgent(child.id)?.lifecycle).toBe("running");
  registration.accept();
  await until(() => delivery.dispatchWaits === 1);
  // A close in the middle of a run, as kill_agent or the app's close does, keeps the child.
  await agentManager.closeAgent(child.id);
  await until(() => delivery.prompts.length === 1);
  expect(delivery.prompts[0]).toContain(`Agent ${child.id}`);
  expect(delivery.prompts[0]).toContain("was closed");
  delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await store.list())[0]?.reported).toBe(true);
  held.resolve();
  await first.catch(() => undefined);
  await send("Second task");
  await until(() => delivery.prompts.length === 2);
  expect(delivery.prompts[1]).toContain("finished");
  expect(await store.list()).toHaveLength(1);
});

test("a standing observation opened over a stale running record waits for a real run", async () => {
  const { agentManager, agentStorage, child, delivery, send } = await liveChild();
  // A close whose snapshot write failed leaves the record running with no runtime behind it.
  await agentManager.closeAgent(child.id);
  await agentStorage.upsert({ ...(await agentStorage.get(child.id))!, lastStatus: "running" });
  const observation = createFinishObservation({
    agentManager,
    agentStorage,
    waitForResume: async () => {},
    messages: () => new Delivery(),
    hosts: () => {
      throw new Error("No connected hosts");
    },
    serverId: "origin",
    logger: createTestLogger(),
  });
  const controller = new AbortController();
  const session = await observation.open(
    {
      id: "reopened",
      callerAgentId: "parent",
      childAgentId: child.id,
      standing: true,
      reported: true,
    },
    controller.signal,
  );
  try {
    let announced = false;
    const next = session.next();
    void next.then(
      () => (announced = true),
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(announced).toBe(false);
    await send("Second task");
    expect(await next).toEqual({ runStarted: true });
    expect(await session.next()).toMatchObject({ status: "idle", final: { status: "idle" } });
    await until(() => delivery.prompts.length === 2);
  } finally {
    controller.abort();
    await session.close();
  }
});

test("a standing subscription ends when its live child is deleted", async () => {
  const { agentManager, agentStorage, child, delivery, store } = await liveChild();
  // The daemon's delete request closes the runtime, removes the record, then announces removal.
  await agentManager.closeAgent(child.id);
  await agentStorage.remove(child.id);
  await agentManager.deleteAgentState(child.id);
  agentManager.notifyAgentRemoved({ id: child.id, workspaceId: undefined });
  await expect.poll(async () => store.list()).toEqual([]);
  expect(delivery.prompts).toHaveLength(1);
});
