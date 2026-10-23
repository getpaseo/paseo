import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { buildStoredAgentPayload } from "../agent-projections.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  createFinishSubscriptions,
  createJsonFinishSubscriptionStore,
  type FinishObservation,
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
  waits: Array<{ signal: AbortSignal; result: ReturnType<typeof deferred<WaitForFinishResult>> }> =
    [];
  permission = deferred<void>();
  async open(_record: unknown, signal: AbortSignal) {
    return { next: () => this.wait(signal), close: async () => {} };
  }
  async wait(signal: AbortSignal) {
    const result = deferred<WaitForFinishResult>();
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
  async close() {}
  async waitForDispatch() {}
}
const homes: string[] = [];
const services: FinishSubscriptions[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function scenario(directory?: string) {
  const home = directory ?? (await mkdtemp(join(tmpdir(), "finish-recovery-")));
  if (!directory) homes.push(home);
  const store = createJsonFinishSubscriptionStore(home);
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
    retryDelayMs: 1,
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

test("unavailable remote retains intent, reconnect observes later completion", async () => {
  const first = await scenario();
  await first.service.register({ ...intent, serverId: "remote" });
  await first.service.close();
  const state = await scenario(first.home);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.reject(new Error("Host unavailable"));
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
  await until(() => state.observation.waits.length === 2);
  expect(await state.store.list()).toHaveLength(1);
  state.observation.waits[1]!.result.resolve(outcome());
  await until(() => state.delivery.prompts.length === 2);
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
