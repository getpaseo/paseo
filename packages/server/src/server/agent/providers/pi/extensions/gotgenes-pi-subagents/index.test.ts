import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { createPiExtensionHost } from "../index.js";
import { readSubagentFixture, verifySubagentFixture } from "../subagent-fixture-test.js";
import { streamPiHistory } from "../../history-mapper.js";
import { GOTGENES_CHILD_SESSION_MARKER } from "./runtime-bridge.js";

describe("@gotgenes/pi-subagents adapter", () => {
  test("accepts a live child path before or after the spawn result", () => {
    for (const early of [true, false]) {
      const host = createPiExtensionHost();
      const marker = `${GOTGENES_CHILD_SESSION_MARKER} ${JSON.stringify({ agentId: "native-1", file: "/tmp/child.jsonl" })}`;
      if (early) expect(host.mapRuntimeNotification(marker)?.subagents).toEqual([]);
      const spawn = host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { subagent_type: "Explore", prompt: "Inspect" },
        status: "completed",
        result: { details: { agentId: "native-1", status: "background" } },
      });
      const path = early
        ? spawn?.childSessions
        : host.mapRuntimeNotification(marker)?.childSessions;
      expect(path).toEqual([{ id: "call-1", file: "/tmp/child.jsonl" }]);
    }
  });

  test("accepts a running subagent-update without a status field", () => {
    const host = createPiExtensionHost();
    host.mapToolCall({
      callId: "call-1",
      toolName: "subagent",
      args: { subagent_type: "Explore", prompt: "Inspect" },
      status: "completed",
      result: { details: { agentId: "native-1", status: "background" } },
    });
    const update = host.mapCustomMessage({
      role: "custom",
      customType: "subagent-update",
      content: "progress",
      details: { id: "native-1", description: "Inspect", message: "progress" },
    });
    expect(update?.subagents).toEqual([
      { type: "upsert", id: "call-1", description: "Inspect", status: "running" },
    ]);
  });
  test("maps captured foreground lifecycle live and on replay", async () => {
    const events = await verifySubagentFixture(
      readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url)),
    );
    expect(
      events
        .filter((event) => event.event.type === "upsert")
        .map((event) => (event.event.type === "upsert" ? event.event.status : null)),
    ).toEqual(["running", "completed"]);
  });
  test("correlates a background notification and result collection", async () => {
    const source = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url));
    const file = (
      source.messages.find((message) => message.role === "custom") as {
        details: { outputFile: string };
      }
    ).details.outputFile;
    const fixture = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url), {
      from: file,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    const events = await verifySubagentFixture(fixture);
    const upserts = events
      .filter((event) => event.event.type === "upsert")
      .map((event) => (event.event.type === "upsert" ? event.event : null));
    expect(upserts.map((event) => event?.status)).toEqual([
      "running",
      "running",
      "completed",
      "completed",
    ]);
    expect(new Set(upserts.map((event) => event?.id)).size).toBe(1);
    expect(events.filter((event) => event.event.type === "timeline").length).toBeGreaterThan(0);
  });
  test("keeps claimed notification text visible in history", async () => {
    const fixture = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url));
    const text = fixture.messages.find((message) => message.role === "custom")?.content;
    const events = [];
    for await (const event of streamPiHistory("pi", fixture.messages)) events.push(event);
    expect(events).toContainEqual({
      type: "timeline",
      provider: "pi",
      item: { type: "assistant_message", text },
    });
    expect(events.some((event) => event.type === "provider_subagent")).toBe(true);
  });
  test("shares the subagent tool name with Nico without claiming Nico's args", () => {
    const host = createPiExtensionHost();
    const nico = host.mapToolCall({
      callId: "nico",
      toolName: "subagent",
      args: { agent: "scout", task: "Inspect" },
      status: "running",
      result: null,
    });
    const gotgenes = host.mapToolCall({
      callId: "gotgenes",
      toolName: "subagent",
      args: { subagent_type: "general-purpose", prompt: "Inspect" },
      status: "running",
      result: null,
    });
    expect(nico?.detail).toEqual(
      expect.objectContaining({ type: "sub_agent", subAgentType: "scout" }),
    );
    expect(gotgenes?.detail).toEqual(
      expect.objectContaining({ type: "sub_agent", subAgentType: "general-purpose" }),
    );
    expect(
      host.mapToolCall({
        callId: "foreign",
        toolName: "subagent",
        args: { description: "Inspect" },
        status: "running",
        result: null,
      }),
    ).toBeUndefined();
  });
});
