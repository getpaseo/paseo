import type { SessionInfo } from "@opencode/client";
import { describe, expect, test, vi } from "vitest";

import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { SessionChildren } from "./children.js";
import { ProviderSubagentStore } from "../../../provider-subagents/store.js";

function setup() {
  const harness = new V2Harness();
  const child: SessionInfo = {
    ...harness.info,
    id: "child",
    parentID: "session",
    title: "Check the worker model",
    agent: "worker",
    model: { providerID: "test", id: "worker-model", variant: "xhigh" },
    tokens: { input: 10000, output: 3000, reasoning: 2000, cache: { read: 3000, write: 800 } },
  };
  harness.api.session.list = async (input) => ({
    data: input?.parentID === "session" ? [child] : [],
    cursor: {},
  });
  harness.api.session.get = async () => child;
  const events: AgentStreamEvent[] = [];
  const children = new SessionChildren({
    client: () => harness.api,
    id: "session",
    emit: (event) => events.push(event),
    reconcilePermissions: async () => {},
  });
  const upserts = () =>
    events.flatMap((event) =>
      event.type === "provider_subagent" && event.event.type === "upsert" ? [event.event] : [],
    );
  return { children, child, upserts };
}

function setupTree() {
  const harness = new V2Harness();
  const sessions = new Map<string, SessionInfo>(
    [
      { ...harness.info, id: "first", parentID: "session" },
      { ...harness.info, id: "second", parentID: "session" },
      { ...harness.info, id: "grandchild", parentID: "first" },
    ].map((info) => [info.id, info]),
  );
  harness.api.session.list = async (input) => ({
    data: [...sessions.values()].filter((info) => info.parentID === input?.parentID),
    cursor: {},
  });
  harness.api.session.get = async ({ sessionID }) => {
    const info = sessions.get(sessionID);
    if (!info) throw { _tag: "SessionNotFoundError", sessionID };
    return info;
  };
  const store = new ProviderSubagentStore();
  const children = new SessionChildren({
    client: () => harness.api,
    id: "session",
    emit: (event) => {
      if (event.type === "provider_subagent") store.apply("parent", "opencode", event.event);
    },
    reconcilePermissions: async () => {},
  });
  const ids = () =>
    store
      .list("parent")
      .map((child) => child.id)
      .sort();
  return { harness, sessions, children, ids, store };
}

describe("OpenCode v2 child presentation", () => {
  test.each(["deletion event", "reconnect"])("removes a deleted child on %s", async (trigger) => {
    const harness = new V2Harness();
    const child: SessionInfo = { ...harness.info, id: "child", parentID: "session" };
    let exists = true;
    harness.api.session.list = async (input) => ({
      data: exists && input?.parentID === "session" ? [child] : [],
      cursor: {},
    });
    harness.api.session.get = async () => {
      if (!exists) throw { _tag: "SessionNotFoundError", sessionID: child.id };
      return child;
    };
    harness.api.session.active = async () => (exists ? { child: { type: "running" } } : {});
    const store = new ProviderSubagentStore();
    const children = new SessionChildren({
      client: () => harness.api,
      id: "session",
      emit: (event) => {
        if (event.type === "provider_subagent") store.apply("parent", "opencode", event.event);
      },
      reconcilePermissions: async () => {},
    });
    await children.reconcile("session");
    expect(store.list("parent")).toMatchObject([{ id: "child", status: "running" }]);
    exists = false;
    if (trigger === "reconnect") await children.reconcile("session");
    else
      children.enqueue({
        id: "deleted",
        created: 2,
        type: "session.deleted",
        durable: { aggregateID: "child", seq: 1, version: 1 },
        data: { sessionID: "child" },
      });
    expect(store.list("parent")).toEqual([]);
  });

  test.each(["deletion event", "reconnect"])(
    "removes a deleted child's descendants on %s without removing its sibling",
    async (trigger) => {
      const { sessions, children, ids } = setupTree();
      await children.reconcile("session");
      expect(ids()).toEqual(["first", "grandchild", "second"]);
      sessions.delete("first");
      sessions.delete("grandchild");
      if (trigger === "reconnect") await children.reconcile("session");
      else
        children.enqueue({
          id: "deleted",
          created: 2,
          type: "session.deleted",
          durable: { aggregateID: "first", seq: 1, version: 1 },
          data: { sessionID: "first" },
        });
      expect(ids()).toEqual(["second"]);
    },
  );

  test("retains children on later pages and when reconciling only another subtree", async () => {
    const { harness, sessions, children, ids } = setupTree();
    await children.reconcile("session");
    const list = harness.api.session.list;
    harness.api.session.list = async (input) => {
      if (input?.cursor === "second-page") return { data: [sessions.get("second")!], cursor: {} };
      if (input?.parentID === "session")
        return { data: [sessions.get("first")!], cursor: { next: "second-page" } };
      return list(input);
    };
    await children.reconcile("session");
    await children.reconcile("first");
    expect(ids()).toEqual(["first", "grandchild", "second"]);
  });

  test.each(["present", "deleted"])(
    "reconciles a live child skipped by the reconnect cursor when its grandchild is %s",
    async (grandchild) => {
      const { harness, sessions, children, ids, store } = setupTree();
      for (let i = 3; i <= 101; i++) {
        sessions.set(`child-${i}`, {
          ...harness.info,
          id: `child-${i}`,
          parentID: "session",
          time: { created: i, updated: i },
        });
      }
      sessions.get("second")!.time = { created: 2, updated: 2 };
      await children.reconcile("session");
      const expected = ids();
      expect(expected).toHaveLength(102);
      if (grandchild === "deleted") sessions.delete("grandchild");
      const remaining = expected.filter((id) => grandchild === "present" || id !== "grandchild");
      const list = harness.api.session.list;
      harness.api.session.list = async (input) => {
        if (input?.parentID !== "session" && !input?.cursor) return list(input);
        const page = [...sessions.values()]
          .filter((info) => info.parentID === "session")
          .filter((info) => !input.cursor || info.time.updated < Number(input.cursor))
          .sort((a, b) => b.time.updated - a.time.updated)
          .slice(0, input.limit);
        const next = page.length === input.limit ? String(page.at(-1)!.time.updated) : undefined;
        if (!input.cursor) {
          // The oldest child was not on page one. Updating it moves it ahead of that page's cursor.
          const first = sessions.get("first")!;
          first.time = { ...first.time, updated: 200 };
          first.title = "Updated during reconnect";
        }
        return { data: page, cursor: { next } };
      };
      await children.reconcile("session");
      expect(ids()).toEqual(remaining);
      expect(store.list("parent").find((child) => child.id === "first")).toMatchObject({
        title: "Updated during reconnect",
      });
      const get = harness.api.session.get;
      let queuedReads = 0;
      harness.api.session.get = async (input, options) => {
        if (input.sessionID === "first") queuedReads += 1;
        return get(input, options);
      };
      try {
        children.enqueue({
          id: "queued-update",
          created: 200,
          type: "session.execution.started",
          durable: { aggregateID: "first", seq: 1, version: 1 },
          data: { sessionID: "first" },
        });
        await expect.poll(() => queuedReads).toBe(1);
        expect(ids()).toEqual(remaining);
        expect(store.list("parent").find((child) => child.id === "first")).toMatchObject({
          title: "Updated during reconnect",
        });
      } finally {
        children.close();
      }
    },
  );

  test("retains an absent child's subtree when its existence cannot be confirmed", async () => {
    const { harness, sessions, children, ids } = setupTree();
    await children.reconcile("session");
    sessions.delete("first");
    sessions.delete("grandchild");
    const get = harness.api.session.get;
    harness.api.session.get = async () => {
      throw new Error("Provider disconnected");
    };
    await children.reconcile("session");
    expect(ids()).toEqual(["first", "grandchild", "second"]);
    harness.api.session.get = get;
    await children.reconcile("session");
    expect(ids()).toEqual(["second"]);
  });

  test("keeps missing children when a listing fails before its last page", async () => {
    const { harness, sessions, children, ids } = setupTree();
    await children.reconcile("session");
    sessions.delete("first");
    sessions.delete("grandchild");
    const list = harness.api.session.list;
    harness.api.session.list = async (input) => {
      if (input?.cursor) throw new Error("Provider disconnected");
      if (input?.parentID === "session")
        return { data: [sessions.get("second")!], cursor: { next: "second-page" } };
      return list(input);
    };
    await expect(children.reconcile("session")).rejects.toThrow("Provider disconnected");
    expect(ids()).toEqual(["first", "grandchild", "second"]);
    harness.api.session.list = list;
    await children.reconcile("session");
    expect(ids()).toEqual(["second"]);
  });

  test("restores agent, model, variant and all token categories in the child subtitle", async () => {
    const { children, upserts } = setup();
    await children.reconcile("session");
    expect(upserts()).toEqual([
      expect.objectContaining({
        id: "child",
        title: "Check the worker model",
        parentSubagentId: null,
        status: "completed",
        subtitle: "worker · worker-model · Extra High · 18.8k tokens",
      }),
    ]);
    await children.reconcile("session");
    expect(upserts()).toHaveLength(1);
  });

  test("publishes changed child facts on live events even when its timestamp is unchanged", async () => {
    const { children, child, upserts } = setup();
    try {
      children.enqueue({ id: "created", created: 1, type: "session.created", data: child });
      await expect.poll(() => upserts()).toHaveLength(1);
      child.model = { providerID: "test", id: "next-model", variant: "low" };
      child.tokens.output += 1200;
      children.enqueue({
        id: "finished",
        created: 2,
        type: "session.execution.succeeded",
        durable: { aggregateID: "child", seq: 1, version: 1 },
        data: { sessionID: "child" },
      });
      await expect.poll(() => upserts()).toHaveLength(2);
      expect(upserts().map((event) => event.subtitle)).toEqual([
        "worker · worker-model · Extra High · 18.8k tokens",
        "worker · next-model · Low · 20k tokens",
      ]);
    } finally {
      children.close();
    }
  });

  test("keeps available agent information before a child has a model or token usage", async () => {
    const { children, child, upserts } = setup();
    delete child.model;
    child.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    await children.reconcile("session");
    expect(upserts()[0]).toMatchObject({ title: "Check the worker model", subtitle: "worker" });
  });

  test("coalesces rapid child delta bursts via enqueue and syncs child messages from the tail", async () => {
    const harness = new V2Harness();
    const child: SessionInfo = {
      ...harness.info,
      id: "child",
      parentID: "session",
      title: "Worker",
    };
    let getCalls = 0;
    const messageCalls: Array<{ order?: string; cursor?: string }> = [];
    harness.api.session.list = async (input) => ({
      data: input?.parentID === "session" ? [child] : [],
      cursor: {},
    });
    harness.api.session.get = async () => {
      getCalls += 1;
      return child;
    };
    const originalList = harness.api.message.list;
    harness.api.message.list = async (input, options) => {
      messageCalls.push({ order: input.order, cursor: input.cursor });
      return originalList(input, options);
    };
    const events: AgentStreamEvent[] = [];
    const children = new SessionChildren({
      client: () => harness.api,
      id: "session",
      emit: (event) => events.push(event),
      reconcilePermissions: async () => {},
      deltaDebounceMs: 30,
    });
    try {
      await children.reconcile("session");
      getCalls = 0;
      messageCalls.length = 0;
      harness.history.push({
        id: "c-msg-1",
        type: "assistant",
        agent: "worker",
        model: { providerID: "test", id: "model" },
        time: { created: 10 },
        content: [{ type: "text", text: "hello world" }],
      });
      for (let i = 0; i < 40; i++) {
        children.enqueue({
          id: `d-${i}`,
          created: 10 + i,
          type: "session.text.delta",
          data: { sessionID: "child", assistantMessageID: "c-msg-1", ordinal: 0, delta: "a" },
        });
      }
      // Enqueue is synchronous and coalesces the 40-delta burst into a single tail sync.
      expect(getCalls).toBe(0);
      await expect.poll(() => getCalls).toBe(1);
      expect(messageCalls.length).toBeGreaterThan(0);
      expect(messageCalls.every((call) => call.order === "desc")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "provider_subagent" &&
            event.event.type === "timeline" &&
            event.event.item.type === "assistant_message" &&
            event.event.item.text === "hello world",
        ),
      ).toBe(true);
    } finally {
      children.close();
    }
  });

  test("preserves delta debounce under sustained streaming while flushing non-delta events immediately", async () => {
    vi.useFakeTimers();
    const harness = new V2Harness();
    const child: SessionInfo = {
      ...harness.info,
      id: "child",
      parentID: "session",
      title: "Worker",
    };
    let getCalls = 0;
    let releaseGet: (() => void) | null = null;
    harness.api.session.list = async (input) => ({
      data: input?.parentID === "session" ? [child] : [],
      cursor: {},
    });
    harness.api.session.get = async () => {
      getCalls += 1;
      await new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      return child;
    };
    const children = new SessionChildren({
      client: () => harness.api,
      id: "session",
      emit: () => {},
      reconcilePermissions: async () => {},
      deltaDebounceMs: 50,
    });
    try {
      await children.reconcile("session");
      getCalls = 0;

      // Batch 1: delta triggers after 50ms.
      children.enqueue({
        id: "d-1",
        created: 1,
        type: "session.text.delta",
        data: { sessionID: "child", assistantMessageID: "m1", ordinal: 0, delta: "a" },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(getCalls).toBe(1);

      // More deltas arrive while batch 1 is in flight; release batch 1 and verify the debounce holds.
      for (let i = 2; i <= 5; i++) {
        children.enqueue({
          id: `d-${i}`,
          created: i,
          type: "session.text.delta",
          data: { sessionID: "child", assistantMessageID: "m1", ordinal: 0, delta: "b" },
        });
      }
      releaseGet?.();
      releaseGet = null;
      await vi.advanceTimersByTimeAsync(49);
      expect(getCalls).toBe(1);

      // Batch 2 runs once the full 50ms debounce elapses.
      await vi.advanceTimersByTimeAsync(1);
      expect(getCalls).toBe(2);

      // A non-delta event arriving while batch 2 is in flight flushes at 0ms right after batch 2 finishes.
      children.enqueue({
        id: "done",
        created: 10,
        type: "session.execution.succeeded",
        durable: { aggregateID: "child", seq: 1, version: 1 },
        data: { sessionID: "child" },
      });
      releaseGet?.();
      releaseGet = null;
      await vi.advanceTimersByTimeAsync(0);
      expect(getCalls).toBe(3);
      releaseGet?.();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      children.close();
      vi.useRealTimers();
    }
  });
});
