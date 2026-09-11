import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { PluginSubagentSources } from "../../agent/provider-subagents/reporters.js";
import { ProviderSubagentStore } from "../../agent/provider-subagents/store.js";
import { PluginSubagentRequests } from "./host.js";
import type { PluginSubagentRequest } from "./protocol.js";

function setup() {
  const store = new ProviderSubagentStore();
  const sources = new PluginSubagentSources(store, () => undefined);
  const host = new PluginSubagentRequests("installation", {
    open: (pluginId, parentAgentId) =>
      sources.open(pluginId, { id: parentAgentId, provider: "pi", isCurrent: () => true }),
  });
  const reporterId = randomUUID();
  const send = (operation: PluginSubagentRequest["operation"]) =>
    host.receive({ type: "subagents.request", requestId: randomUUID(), reporterId, operation });
  return { store, host, send };
}

test("acknowledges a retried sequence once and rejects changed or skipped sequences", async () => {
  const { store, host, send } = setup();
  await send({ type: "open", parentAgentId: "parent" });
  await send({ type: "report", sequence: 1, event: { type: "upsert", id: "child" } });
  const timeline = {
    type: "report",
    sequence: 2,
    event: { type: "timeline", id: "child", item: { type: "assistant_message", text: "One row" } },
  } as const;
  await Promise.all([send(timeline), send(timeline)]);
  const child = store.list("parent")[0]!;
  expect(child.id).toMatch(/^plugin\/installation\//);
  expect(store.fetchTimeline("parent", child.id).rows).toHaveLength(1);
  await expect(
    send({
      ...timeline,
      event: { ...timeline.event, item: { type: "assistant_message", text: "Different" } },
    }),
  ).rejects.toThrow("different data");
  await expect(send({ ...timeline, sequence: 4 })).rejects.toThrow("out of order");
  await send({ type: "close" });
  await send({ type: "close" });
  await expect(send({ ...timeline, sequence: 3 })).rejects.toThrow("closed");
  await host.stop();
});

test("failed reports consume a sequence and retries preserve the error", async () => {
  const { send } = setup();
  await send({ type: "open", parentAgentId: "parent" });
  const operation = {
    type: "report",
    sequence: 1,
    event: {
      type: "timeline",
      id: "missing",
      item: { type: "assistant_message", text: "Unknown" },
    },
  } as const;
  await expect(send(operation)).rejects.toThrow("Declare");
  await expect(send(operation)).rejects.toThrow("Declare");
  await send({ type: "report", sequence: 2, event: { type: "upsert", id: "missing" } });
  await send({ type: "close" });
});

test("process stop removes only its reports and rejects late opens and reports", async () => {
  const { store, host, send } = setup();
  store.apply("parent", "pi", { type: "upsert", id: "native" });
  await send({ type: "open", parentAgentId: "parent" });
  await send({ type: "report", sequence: 1, event: { type: "upsert", id: "external" } });
  await host.stop();
  await host.stop();
  await send({ type: "close" });
  await expect(send({ type: "open", parentAgentId: "parent" })).rejects.toThrow("stopped");
  await expect(
    send({ type: "report", sequence: 2, event: { type: "upsert", id: "late" } }),
  ).rejects.toThrow("stopped");
  expect(store.list("parent").map((child) => child.id)).toEqual(["native"]);
});
