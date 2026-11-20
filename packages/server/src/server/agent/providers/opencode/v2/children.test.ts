import type { SessionInfo } from "@opencode/client";
import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { SessionChildren } from "./children.js";

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

describe("OpenCode v2 child presentation", () => {
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
