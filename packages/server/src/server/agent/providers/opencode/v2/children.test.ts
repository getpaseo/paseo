import type { SessionInfo } from "@opencode/client";
import { describe, expect, test } from "vitest";

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
  return { harness, sessions, children, ids };
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
      await children.observe({
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
        await children.observe({
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
    await children.observe({ id: "created", created: 1, type: "session.created", data: child });
    child.model = { providerID: "test", id: "next-model", variant: "low" };
    child.tokens.output += 1200;
    await children.observe({
      id: "finished",
      created: 2,
      type: "session.execution.succeeded",
      durable: { aggregateID: "child", seq: 1, version: 1 },
      data: { sessionID: "child" },
    });
    expect(upserts().map((event) => event.subtitle)).toEqual([
      "worker · worker-model · Extra High · 18.8k tokens",
      "worker · next-model · Low · 20k tokens",
    ]);
  });

  test("keeps available agent information before a child has a model or token usage", async () => {
    const { children, child, upserts } = setup();
    delete child.model;
    child.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    await children.reconcile("session");
    expect(upserts()[0]).toMatchObject({ title: "Check the worker model", subtitle: "worker" });
  });
});
