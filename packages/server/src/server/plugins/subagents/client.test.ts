import { expect, test } from "vitest";
import type { PluginSubagentEvent } from "@getpaseo/plugin/server";
import { PluginSubagentClient } from "./client.js";
import { PluginSubagentRequests } from "./host.js";
import { parseSubagentEvent } from "./protocol.js";

function setup(dropFirstReportAck = false) {
  const events: PluginSubagentEvent[] = [];
  const sequences: number[] = [];
  let closes = 0;
  const host = new PluginSubagentRequests("installation", {
    open: () => ({
      report: async (event) => {
        events.push(event);
      },
      close: async () => {
        closes += 1;
      },
    }),
  });
  const client = new PluginSubagentClient(async (request) => {
    await host.receive(request);
    if (request.operation.type === "report") {
      sequences.push(request.operation.sequence);
      if (dropFirstReportAck) {
        dropFirstReportAck = false;
        return;
      }
    }
    client.receive({ type: "subagents.response", requestId: request.requestId, error: null });
  }, 20);
  return { client, events, sequences, getCloses: () => closes };
}

test("retries a lost report acknowledgement with the same sequence and no duplicate effect", async () => {
  const { client, events, sequences } = setup(true);
  const reporter = await client.open({ parentAgentId: "parent" });
  await reporter.report({ type: "upsert", id: "child" });
  await reporter.report({ type: "upsert", id: "child", status: "completed" });
  expect(events).toEqual([
    { type: "upsert", id: "child" },
    { type: "upsert", id: "child", status: "completed" },
  ]);
  expect(sequences).toEqual([1, 1, 2]);
  await reporter.close();
  client.stop();
});

test("serializes concurrent reports and closes idempotently", async () => {
  const { client, events, sequences, getCloses } = setup();
  const reporter = await client.open({ parentAgentId: "parent" });
  await Promise.all([
    reporter.report({ type: "upsert", id: "child" }),
    reporter.report({
      type: "timeline",
      id: "child",
      item: { type: "assistant_message", text: "Done" },
    }),
  ]);
  expect(events).toHaveLength(2);
  expect(sequences).toEqual([1, 2]);
  await Promise.all([reporter.close(), reporter.close()]);
  expect(getCloses()).toBe(1);
  await expect(reporter.report({ type: "remove", id: "child" })).rejects.toThrow("closed");
  client.stop();
});

test("rejects pending IPC when the process stops", async () => {
  const client = new PluginSubagentClient(async () => undefined);
  const opening = client.open({ parentAgentId: "parent" });
  const rejected = expect(opening).rejects.toThrow("IPC is closed");
  client.stop();
  await rejected;
  await expect(client.open({ parentAgentId: "parent" })).rejects.toThrow("stopped");
});

test("rejects oversized UTF-8 events instead of truncating content", () => {
  expect(() =>
    parseSubagentEvent({
      type: "timeline",
      id: "child",
      item: { type: "assistant_message", text: "x".repeat(65536) },
    }),
  ).toThrow("exceeds");
  expect(() =>
    parseSubagentEvent({ type: "upsert", id: "child", title: "\u20ac".repeat(22000) }),
  ).toThrow("exceeds");
  expect(() => parseSubagentEvent({ type: "upsert", id: "child", status: "idle" })).toThrow();
});
