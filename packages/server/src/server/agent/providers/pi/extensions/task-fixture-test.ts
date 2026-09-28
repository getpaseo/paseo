import { readFileSync } from "node:fs";
import pino from "pino";
import { expect } from "vitest";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { PiRpcAgentClient } from "../agent.js";
import { PiHistoryMapper } from "../history-mapper.js";
import type { PiAgentMessage, PiAgentSessionEvent } from "../rpc-types.js";
import { FakePi } from "../test-utils/fake-pi.js";
import { parseToolResult } from "../tool-call-mapper.js";
import { createPiExtensionHost } from "./index.js";
import type { PiExtensionToolCall } from "./contract.js";

interface TaskFixture {
  provenance: {
    package: string;
    version: string;
    sourceCommit: string;
    piVersion: string;
    captureDate: string;
  };
  events: PiAgentSessionEvent[];
  messages: PiAgentMessage[];
}

function todos(events: readonly AgentStreamEvent[]) {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "todo" ? [event.item] : [],
  );
}

export function capturedToolCall(path: URL, index = 0): PiExtensionToolCall {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as TaskFixture;
  const ends = fixture.events.filter((event) => event.type === "tool_execution_end");
  const end = ends[index];
  if (!end) throw new Error(`Missing captured tool result ${index}`);
  const start = fixture.events.find(
    (event) => event.type === "tool_execution_start" && event.toolCallId === end.toolCallId,
  );
  if (!start || start.type !== "tool_execution_start")
    throw new Error("Missing captured tool start");
  return {
    callId: end.toolCallId,
    toolName: end.toolName,
    args: start.args,
    status: end.isError ? "failed" : "completed",
    result: parseToolResult(end.result),
  };
}

export async function verifyTaskFixture(path: URL, expectedStatuses: string[]): Promise<void> {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as TaskFixture;
  expect(fixture.provenance).toEqual(
    expect.objectContaining({
      package: expect.any(String),
      version: expect.any(String),
      sourceCommit: expect.any(String),
      piVersion: expect.any(String),
      captureDate: expect.any(String),
    }),
  );
  const host = createPiExtensionHost();
  const starts = new Map<string, Extract<PiAgentSessionEvent, { type: "tool_execution_start" }>>();
  const mapped = [];
  for (const event of fixture.events) {
    if (event.type === "tool_execution_start") starts.set(event.toolCallId, event);
    if (event.type !== "tool_execution_end") continue;
    const start = starts.get(event.toolCallId);
    expect(start).toBeDefined();
    const mapping = host.mapToolCall({
      callId: event.toolCallId,
      toolName: event.toolName,
      args: start?.args,
      status: event.isError ? "failed" : "completed",
      result: parseToolResult(event.result),
    });
    mapped.push(...(mapping?.timeline ?? []).filter((item) => item.type === "todo"));
  }
  expect(mapped.map((item) => item.items.map((task) => task.status))).toEqual(
    expectedStatuses.map((status) => status.split(",")),
  );

  const pi = new FakePi();
  const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
  const session = await client.createSession({ provider: "pi", cwd: "/tmp/paseo-pi-task-fixture" });
  const live: AgentStreamEvent[] = [];
  session.subscribe((event) => live.push(event));
  try {
    await session.startTurn("Use tasks");
    for (const event of fixture.events) pi.latestSession().emit(event);
    pi.latestSession().finishTurn();
    expect(todos(live)).toEqual(mapped);
    const replay = new PiHistoryMapper("pi").mapMessages(fixture.messages);
    expect(todos(replay)).toEqual(mapped);
    expect(
      replay.filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.status === "completed",
      ),
    ).toHaveLength(fixture.events.filter((event) => event.type === "tool_execution_end").length);
  } finally {
    await session.close();
  }
}
