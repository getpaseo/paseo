import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { createPiExtensionHost } from "../index.js";
import { readSubagentFixture, verifySubagentFixture } from "../subagent-fixture-test.js";
import { streamPiHistory } from "../../history-mapper.js";
import { GOTGENES_CHILD_SESSION_MARKER, gotgenesRuntimeBridge } from "./runtime-bridge.js";

const SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");

function loadRuntimeBridge() {
  const listeners = new Map<string, (event: unknown, ctx?: unknown) => void>();
  const pi = {
    on: (name: string, listener: (event: unknown, ctx?: unknown) => void) =>
      listeners.set(name, listener),
    events: {
      on: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    },
  };
  new Function("pi", gotgenesRuntimeBridge)(pi);
  return (name: string, event: unknown, ctx?: unknown) => listeners.get(name)?.(event, ctx);
}

function publishService(agents: Array<{ id: string; outputFile?: string }>): void {
  (globalThis as Record<symbol, unknown>)[SERVICE_KEY] = { listAgents: () => agents };
}

describe("@gotgenes/pi-subagents adapter", () => {
  test("reports a child's file after the child republishes the gotgenes service", async () => {
    const notifications: string[] = [];
    const emit = loadRuntimeBridge();
    const file = "/sessions/parent/tasks/2026-09-30_child-session.jsonl";
    try {
      publishService([{ id: "native-1", outputFile: file }]);
      emit(
        "session_start",
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      );
      // Pi loads gotgenes again inside the child, and that copy replaces the global service.
      publishService([]);
      emit("subagents:child:session-created", { sessionId: "child-session" });

      await expect.poll(() => notifications).toHaveLength(1);
      const host = createPiExtensionHost();
      host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { subagent_type: "Explore", prompt: "Inspect" },
        status: "completed",
        result: { details: { agentId: "native-1", status: "background" } },
      });
      expect(host.mapRuntimeNotification(notifications[0]!)?.childSessions).toEqual([
        { id: "call-1", file },
      ]);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
    }
  });

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
  test("keeps claimed notification text in a tool row in history", async () => {
    const fixture = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url));
    const notification = fixture.messages.find((message) => message.role === "custom");
    const text = notification?.content;
    const events = [];
    for await (const event of streamPiHistory("pi", fixture.messages)) events.push(event);
    expect(events).toContainEqual({
      type: "timeline",
      provider: "pi",
      item: {
        type: "tool_call",
        callId: "pi-custom-1",
        name: notification?.customType,
        status: "completed",
        detail: { type: "plain_text", text },
        metadata: {
          synthetic: true,
          customType: notification?.customType,
          details: notification?.details,
        },
        error: null,
      },
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
