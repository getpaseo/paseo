import { expect, test } from "vitest";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import {
  HostObservationError,
  createHostObservationResolver,
  type ToolHosts,
  type HostObservation,
} from "../../host-operations/index.js";
import { buildStoredAgentPayload } from "../../agent-projections.js";
import type { FinishSubscription } from "../index.js";
import { openFinishObservation } from "./observation-stream.js";

class Host implements HostObservation {
  handler?: Parameters<HostObservation["observe"]>[1];
  released = false;
  failure?: (error: unknown) => void;
  baseline = Promise.withResolvers<WaitForFinishResult>();
  async wait() {
    return this.baseline.promise;
  }
  async observe(
    _id: string,
    handler: Parameters<HostObservation["observe"]>[1],
    _signal: AbortSignal,
    onError: (error: unknown) => void,
  ) {
    this.handler = handler;
    this.failure = onError;
    return async () => {
      this.released = true;
    };
  }
  emit(status: "idle" | "running" | "closed", event?: AgentStreamEvent, archivedAt?: string) {
    this.handler!(payload(status, archivedAt), event, "Last response");
  }
}
function payload(status: "idle" | "running" | "closed", archivedAt?: string) {
  return buildStoredAgentPayload(
    {
      id: "child",
      cwd: "/tmp",
      provider: "codex",
      labels: {},
      lastStatus: status,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      archivedAt,
    },
    ["codex"],
  );
}
function permission(id: string): AgentStreamEvent {
  return {
    type: "permission_requested",
    provider: "codex",
    request: { id, provider: "codex", name: "Write", kind: "tool", input: { path: id } },
  };
}
async function scenario(record: Partial<FinishSubscription> = {}) {
  const host = new Host();
  const controller = new AbortController();
  const observation = await openFinishObservation(
    { use: async (_server, action) => action(host) },
    { id: "watch", callerAgentId: "parent", childAgentId: "child", ...record },
    controller.signal,
  );
  return { host, observation, controller };
}
function pending<T>(promise: Promise<T>) {
  const state = { settled: false, promise };
  void promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}
const started: AgentStreamEvent = { type: "turn_started", provider: "codex" };
const completed: AgentStreamEvent = { type: "turn_completed", provider: "codex" };

test("permission resolution followed by transient idle waits for resumed work to settle", async () => {
  const { host, observation } = await scenario();
  try {
    host.emit("running", permission("first"));
    expect((await observation.next()).status).toBe("permission");
    host.emit("idle", { type: "permission_resolved", provider: "codex", requestId: "first" });
    let settled = false;
    const next = observation.next().then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.emit("running", { type: "turn_started", provider: "codex" });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.emit("idle", { type: "turn_completed", provider: "codex" });
    expect(await next).toMatchObject({ status: "idle", lastMessage: "Last response" });
  } finally {
    await observation.close();
  }
  expect(host.released).toBe(true);
});

test("second checkpoint and terminal outcome remain buffered while the first callback is pending", async () => {
  const { host, observation } = await scenario();
  try {
    host.emit("running", permission("first"));
    expect((await observation.next()).status).toBe("permission");
    // The recipient has not acknowledged the first callback; no next() is in flight.
    host.emit("running", permission("second"));
    host.emit("idle", { type: "turn_completed", provider: "codex" });
    expect((await observation.next()).final?.pendingPermissions[0]?.id).toBe("second");
    expect((await observation.next()).status).toBe("idle");
  } finally {
    await observation.close();
  }
});

test("abort releases continuous observation even with a pending initial wait", async () => {
  const { host, observation, controller } = await scenario();
  const next = observation.next();
  controller.abort();
  await expect(next).rejects.toThrow();
  await observation.close();
  expect(host.released).toBe(true);
});

test("late initial permission snapshot cannot resurrect an already resolved request", async () => {
  const { host, observation } = await scenario();
  try {
    const requestEvent = permission("resolved");
    host.emit("running", requestEvent);
    await observation.next();
    host.emit("idle", { type: "permission_resolved", provider: "codex", requestId: "resolved" });
    const final = buildStoredAgentPayload(
      {
        id: "child",
        cwd: "/tmp",
        provider: "codex",
        labels: {},
        lastStatus: "running",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      ["codex"],
    );
    if (requestEvent.type !== "permission_requested") throw new Error("Expected permission");
    final.pendingPermissions = [requestEvent.request];
    host.baseline.resolve({ status: "permission", final, lastMessage: null, error: null });
    await host.baseline.promise;
    await Promise.resolve();
    host.emit("idle", { type: "turn_completed", provider: "codex" });
    expect((await observation.next()).status).toBe("idle");
  } finally {
    await observation.close();
  }
});

test("lookup failure uses its error channel and never fabricates a missing-child result", async () => {
  const { host, observation } = await scenario();
  try {
    host.failure!(new Error("Route disconnected"));
    await expect(observation.next()).rejects.toThrow("Route disconnected");
  } finally {
    await observation.close();
  }
});

test("a terminal event observed after newer work starts waits for that running work", async () => {
  const { host, observation } = await scenario();
  try {
    host.emit("running", { type: "turn_completed", provider: "codex" });
    let settled = false;
    const next = observation.next().then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.emit("idle", { type: "turn_completed", provider: "codex" });
    expect((await next).status).toBe("idle");
  } finally {
    await observation.close();
  }
});

test.each([
  { status: "connecting", reason: "connecting" },
  { status: "offline", reason: "unreachable" },
  { status: "disabled", reason: "unreachable" },
  { status: "removed", reason: "removed" },
] as const)(
  "remote observation classifies $status from the authoritative directory, ignoring arbitrary error codes",
  async ({ status, reason }) => {
    const row = {
      registrationId: "registration",
      serverId: "remote",
      label: null,
      source: { id: "owner", key: "remote" },
      metadata: {},
      enabled: status !== "disabled",
      status: status === "removed" ? ("offline" as const) : status,
      targetDescription: "Remote",
      lastOnlineAt: null,
      nextRetryAt: null,
      error: null,
    };
    const hosts: ToolHosts = {
      directory: async () => ({
        self: { serverId: "origin", label: "Origin" },
        hosts: status === "removed" ? [] : [row],
      }),
      async use() {
        throw Object.assign(new Error("Untrusted remote error"), { code: "host_unknown" });
      },
    };
    const local = new Host();
    const resolver = createHostObservationResolver({
      serverId: "origin",
      local,
      hosts: () => hosts,
    });
    const error = await resolver.use("remote", async () => {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HostObservationError);
    expect(error).toMatchObject({ reason });
  },
);

test("standing observation reports each later run and skips a runtime close between runs", async () => {
  const { host, observation } = await scenario({ standing: true });
  try {
    host.emit("running", started);
    host.emit("idle", completed);
    expect((await observation.next()).status).toBe("idle");
    // Idle cleanup closes the runtime without archiving the child.
    host.emit("closed");
    host.emit("idle", completed);
    const next = pending(observation.next());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(next.settled).toBe(false);
    host.emit("running", started);
    expect(await next.promise).toEqual({ runStarted: true });
    host.emit("idle", completed);
    expect(await observation.next()).toMatchObject({ status: "idle", final: { status: "idle" } });
  } finally {
    await observation.close();
  }
});

test("a run that starts after a standing outcome is announced before its own outcome", async () => {
  const { host, observation } = await scenario({ standing: true });
  try {
    host.emit("running", started);
    host.emit("idle", completed);
    expect(await observation.next()).toMatchObject({ status: "idle" });
    // The next run starts and settles while the caller is still handling the first outcome.
    host.emit("running", started);
    host.emit("idle", completed);
    expect(await observation.next()).toEqual({ runStarted: true });
    expect(await observation.next()).toMatchObject({ status: "idle", final: { status: "idle" } });
  } finally {
    await observation.close();
  }
});

test("standing runs that settle before the caller asks again are reported once, with the latest outcome", async () => {
  const { host, observation } = await scenario({ standing: true });
  try {
    host.emit("running", started);
    host.emit("idle", completed);
    expect(await observation.next()).toMatchObject({ status: "idle" });
    host.emit("running", started);
    host.emit("idle", { type: "turn_canceled", provider: "codex", reason: "Interrupted" });
    host.emit("running", started);
    host.emit("idle", completed);
    expect(await observation.next()).toEqual({ runStarted: true });
    const latest = await observation.next();
    expect(latest).toMatchObject({ status: "idle", final: { status: "idle" } });
    expect(latest).not.toHaveProperty("reason");
  } finally {
    await observation.close();
  }
});

test("recovered standing observation reports only a run that starts after recovery", async () => {
  const { host, observation } = await scenario({ standing: true, reported: true });
  try {
    // A child collected before the restart reads back as its closed stored record.
    host.emit("closed");
    host.baseline.resolve({
      status: "idle",
      final: payload("closed"),
      lastMessage: "Old",
      error: null,
    });
    const next = pending(observation.next());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(next.settled).toBe(false);
    host.emit("running", started);
    expect(await next.promise).toEqual({ runStarted: true });
    host.emit("idle", completed);
    expect(await observation.next()).toMatchObject({ status: "idle", final: { status: "idle" } });
  } finally {
    await observation.close();
  }
});

test("archiving an idle standing child ends observation with no run to report", async () => {
  const { host, observation } = await scenario({ standing: true, reported: true });
  try {
    host.emit("closed", undefined, "2026-01-02T00:00:00.000Z");
    expect(await observation.next()).toMatchObject({
      noRun: true,
      final: { status: "closed", archivedAt: "2026-01-02T00:00:00.000Z" },
    });
  } finally {
    await observation.close();
  }
});

test("archiving a running standing child reports the run it ended", async () => {
  const { host, observation } = await scenario({ standing: true, reported: true });
  try {
    host.emit("running", started);
    expect(await observation.next()).toEqual({ runStarted: true });
    host.emit("closed", undefined, "2026-01-02T00:00:00.000Z");
    const result = await observation.next();
    expect(result).toMatchObject({ final: { status: "closed" } });
    expect(result).not.toHaveProperty("noRun");
  } finally {
    await observation.close();
  }
});

test.each([false, true])(
  "removal after a run closed keeps that run's outcome (standing=%s)",
  async (standing) => {
    const { host, observation } = await scenario({ standing });
    try {
      host.emit("running", started);
      // The daemon's delete closes the runtime first, then announces removal.
      host.emit("closed");
      host.handler!(null);
      expect(await observation.next()).toMatchObject({
        final: { status: "closed" },
        lastMessage: "Last response",
      });
      if (standing) expect(await observation.next()).toMatchObject({ final: null, noRun: true });
    } finally {
      await observation.close();
    }
  },
);

test("deleting an idle standing child ends observation with no run to report", async () => {
  const { host, observation } = await scenario({ standing: true, reported: true });
  try {
    host.handler!(null);
    expect(await observation.next()).toMatchObject({ noRun: true, final: null });
  } finally {
    await observation.close();
  }
});
