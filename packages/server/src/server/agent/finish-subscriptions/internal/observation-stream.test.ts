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
  emit(status: "idle" | "running", event?: AgentStreamEvent) {
    this.handler!(
      buildStoredAgentPayload(
        {
          id: "child",
          cwd: "/tmp",
          provider: "codex",
          labels: {},
          lastStatus: status,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
        ["codex"],
      ),
      event,
      "Last response",
    );
  }
}
function permission(id: string): AgentStreamEvent {
  return {
    type: "permission_requested",
    provider: "codex",
    request: { id, provider: "codex", name: "Write", kind: "tool", input: { path: id } },
  };
}
async function scenario() {
  const host = new Host();
  const controller = new AbortController();
  const observation = await openFinishObservation(
    { use: async (_server, action) => action(host) },
    { id: "watch", callerAgentId: "parent", childAgentId: "child" },
    controller.signal,
  );
  return { host, observation, controller };
}

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
