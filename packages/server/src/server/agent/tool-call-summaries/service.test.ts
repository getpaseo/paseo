import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { AgentManager } from "../agent-manager.js";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import type { ToolCallSummarySource, ToolCallSummaryTarget } from "./types.js";
import { ToolCallSummarizer, SummaryCancellationError, type SummaryGenerator } from "./service.js";
import type { SummaryCall, SummaryResponse } from "./prompt.js";

const services: ToolCallSummarizer[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  vi.useRealTimers();
});

function fixture(manager?: AgentManager) {
  const sources = new Map<string, ToolCallSummarySource>();
  const generate = vi
    .fn<SummaryGenerator["generate"]>()
    .mockImplementation(async (_agentId, calls) => ({
      descriptions: calls.map((call) => ({ id: call.id, description: `Described ${call.id}.` })),
    }));
  const apply = vi.fn(async (_target: ToolCallSummaryTarget, _description: string) => {});
  const invalidate = vi.fn(async (_agentId: string) => {});
  const service = new ToolCallSummarizer({
    manager,
    getSource: (target) => sources.get(target.key) ?? null,
    apply,
    generator: { generate, invalidate, dispose: async () => {} },
    logger: pino({ level: "silent" }),
  });
  services.push(service);
  function enqueue(agentId: string, count = 1, input = "echo hello") {
    const targets: ToolCallSummaryTarget[] = [];
    for (let i = 0; i < count; i++) {
      const key = `${agentId}-${sources.size}`;
      const target = { agentId, epoch: "epoch", seq: sources.size + 1, key };
      sources.set(key, {
        item: {
          type: "tool_call",
          callId: key,
          name: "shell",
          status: "completed",
          error: null,
          detail: { type: "shell", command: input, output: "hello" },
        },
        timestamp: "2026-09-10T00:00:00Z",
      });
      service.enqueue(target);
      targets.push(target);
    }
    return targets;
  }
  return { service, sources, generate, apply, invalidate, enqueue };
}

async function activityFixture() {
  const manager = new AgentManager({
    clients: { codex: createTestAgentClient("codex") },
    logger: pino({ level: "silent" }),
  });
  const source = await manager.createAgent(
    { provider: "codex", cwd: "/tmp", internal: true },
    undefined,
    { workspaceId: undefined, persistSession: false },
  );
  const f = fixture(manager);
  return {
    ...f,
    manager,
    source,
    status: (id: string) =>
      manager.backgroundActivity.snapshot().requests.find((request) => request.id === id)?.status,
    dispose: async () => {
      await f.service.dispose();
      await manager.closeAgent(source.id);
    },
  };
}

function response(calls: SummaryCall[]): SummaryResponse {
  return { descriptions: calls.map((call) => ({ id: call.id, description: "Read the data." })) };
}

describe("tool-call summary scheduling", () => {
  it("cancels retries whose sources have all disappeared", async () => {
    const f = await activityFixture();
    try {
      f.generate.mockRejectedValueOnce(new Error("Retry needed"));
      const targets = f.enqueue(f.source.id, 2);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = f.manager.backgroundActivity.snapshot().requests[0].id;
      for (const target of targets) f.sources.delete(target.key);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.status(requestId)).toBe("canceled");
      expect(f.generate).toHaveBeenCalledTimes(1);
    } finally {
      await f.dispose();
    }
  });

  it("cancels overflowed retries only after the last member is dropped", async () => {
    const f = await activityFixture();
    try {
      f.generate.mockRejectedValueOnce(new Error("Retry needed"));
      f.enqueue(f.source.id, 2);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = f.manager.backgroundActivity.snapshot().requests[0].id;
      f.enqueue(f.source.id, 249);
      expect(f.status(requestId)).toBe("queued");
      f.enqueue(f.source.id);
      expect(f.status(requestId)).toBe("canceled");
      expect(f.generate).toHaveBeenCalledTimes(1);
    } finally {
      await f.dispose();
    }
  });

  it("keeps a split retry request until its active member finishes even if the rest overflow", async () => {
    const f = await activityFixture();
    let finish: () => void = () => {};
    try {
      f.generate.mockRejectedValueOnce(new Error("Retry needed"));
      const targets = f.enqueue(f.source.id, 4);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = f.manager.backgroundActivity.snapshot().requests[0].id;
      for (const target of targets) {
        const source = f.sources.get(target.key)!;
        source.item.detail = { type: "shell", command: "x".repeat(6000), output: "x".repeat(4000) };
      }
      f.generate.mockImplementationOnce(
        (_id, calls) =>
          new Promise((resolve) => {
            finish = () => resolve(response(calls));
          }),
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.generate.mock.calls[1][1]).toHaveLength(3);
      f.enqueue(f.source.id, 250);
      expect(f.status(requestId)).toBe("queued");
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.status(requestId)).toBe("completed");
    } finally {
      finish();
      await f.dispose();
    }
  });

  it("finishes a split retry request when refused cancellation pauses all work", async () => {
    const f = await activityFixture();
    try {
      f.generate.mockRejectedValueOnce(new Error("Retry needed"));
      const targets = f.enqueue(f.source.id, 4);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = f.manager.backgroundActivity.snapshot().requests[0].id;
      for (const target of targets) {
        const source = f.sources.get(target.key)!;
        source.item.detail = {
          type: "shell",
          command: "x".repeat(6000),
          output: "x".repeat(4000),
        };
      }
      f.generate.mockRejectedValueOnce(new SummaryCancellationError("Still running"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.generate.mock.calls[1][1]).toHaveLength(3);
      expect(f.status(requestId)).toBe("failed");
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.generate).toHaveBeenCalledTimes(2);
    } finally {
      await f.dispose();
    }
  });

  it("keeps surviving retries when another source disappears and when a retry splits", async () => {
    const f = await activityFixture();
    try {
      f.generate.mockRejectedValueOnce(new Error("Retry needed"));
      const targets = f.enqueue(f.source.id, 5);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = f.manager.backgroundActivity.snapshot().requests[0].id;
      f.sources.delete(targets[0].key);
      for (const target of targets.slice(1)) {
        const source = f.sources.get(target.key)!;
        source.item.detail = { type: "shell", command: "x".repeat(6000), output: "x".repeat(4000) };
      }
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.generate.mock.calls[1][1]).toHaveLength(3);
      expect(f.status(requestId)).toBe("queued");
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.generate.mock.calls[2][1]).toHaveLength(1);
      expect(f.status(requestId)).toBe("completed");
    } finally {
      await f.dispose();
    }
  });
  it("records queued batches without changing their scheduling", async () => {
    const manager = new AgentManager({
      clients: { codex: createTestAgentClient("codex") },
      logger: pino({ level: "silent" }),
    });
    const source = await manager.createAgent(
      { provider: "codex", cwd: "/tmp", internal: true },
      undefined,
      { workspaceId: undefined, persistSession: false },
    );
    try {
      const { enqueue, generate } = fixture(manager);
      enqueue(source.id, 12);
      expect(manager.backgroundActivity.snapshot().requests).toMatchObject([
        { status: "queued", count: 12, sourceAgentId: source.id },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(generate.mock.calls[0][4]).toBeTruthy();
      expect(
        manager.backgroundActivity
          .snapshot()
          .requests.map((request) => [request.status, request.count]),
      ).toEqual([
        ["completed", 10],
        ["queued", 2],
      ]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        manager.backgroundActivity.snapshot().requests.map((request) => request.status),
      ).toEqual(["completed", "completed"]);
    } finally {
      await manager.closeAgent(source.id);
    }
  });
  it("starts immediately, then spaces batches by five seconds and rotates fairly", async () => {
    const { enqueue, generate } = fixture();
    enqueue("a", 12);
    enqueue("b", 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(generate.mock.calls.map(([id, calls]) => [id, calls.length])).toEqual([["a", 10]]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(generate.mock.calls.map(([id, calls]) => [id, calls.length])).toEqual([
      ["a", 10],
      ["b", 2],
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(generate.mock.calls.map(([id, calls]) => [id, calls.length])).toEqual([
      ["a", 10],
      ["b", 2],
      ["a", 2],
    ]);
  });

  it("keeps one request in flight, deduplicates events, and queues new arrivals", async () => {
    const { enqueue, generate, service } = fixture();
    let finish!: () => void;
    generate.mockImplementationOnce(
      (_id, calls) =>
        new Promise((resolve) => {
          finish = () => resolve(response(calls));
        }),
    );
    const [target] = enqueue("a");
    service.enqueue(target);
    await vi.advanceTimersByTimeAsync(5000);
    service.enqueue(target);
    enqueue("a");
    enqueue("b");
    await vi.advanceTimersByTimeAsync(10000);
    expect(generate).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][1]).toHaveLength(1);
  });

  it("caps input and pending work without delaying coding-agent delivery", async () => {
    const { enqueue, generate } = fixture();
    enqueue("a", 260, "x".repeat(20000));
    await vi.advanceTimersByTimeAsync(5000);
    const calls = generate.mock.calls[0][1];
    expect(calls[0].id).toBe("a-10");
    expect(JSON.stringify(calls).length).toBeLessThanOrEqual(32000);
    expect(calls[0].input).toContain("[truncated]");
  });

  it("retries once through the throttled queue and leaves failures unapplied", async () => {
    const { enqueue, generate, apply } = fixture();
    generate.mockRejectedValue(new Error("Provider unavailable"));
    enqueue("a");
    await vi.advanceTimersByTimeAsync(15000);
    expect(generate.mock.calls.map((call) => call[2])).toEqual([0, 1]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("discards invalidated work even when the helper returns late", async () => {
    const { enqueue, generate, service, apply } = fixture();
    let finish!: () => void;
    generate.mockImplementationOnce(
      (_id, calls) =>
        new Promise((resolve) => {
          finish = () => resolve(response(calls));
        }),
    );
    enqueue("a");
    await vi.advanceTimersByTimeAsync(5000);
    service.invalidate("a");
    finish();
    await vi.advanceTimersByTimeAsync(10000);
    expect(apply).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not release a timed-out slot until cancellation settles", async () => {
    const { enqueue, generate } = fixture();
    let settle!: () => void;
    const generation: SummaryGenerator["generate"] = (_id, _calls, _attempt, signal) =>
      new Promise((_resolve, reject) => {
        const onAbort = () => {
          settle = () => reject(new Error("Canceled"));
        };
        signal.addEventListener("abort", onAbort);
      });
    generate.mockImplementationOnce(generation);
    enqueue("a");
    enqueue("b");
    await vi.advanceTimersByTimeAsync(70000);
    expect(generate).toHaveBeenCalledTimes(1);
    settle();
    await vi.advanceTimersByTimeAsync(1);
    expect(generate.mock.calls[1][0]).toBe("b");
  });

  it("pauses all generation when helper cancellation is refused", async () => {
    const { enqueue, generate } = fixture();
    generate.mockRejectedValue(new SummaryCancellationError("Still running"));
    enqueue("a");
    enqueue("b");
    await vi.advanceTimersByTimeAsync(20000);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
