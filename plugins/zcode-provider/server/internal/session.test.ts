import { describe, expect, test } from "vitest";
import { ZCodeSession } from "./session.js";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { ZCodeEvent, ZCodeTransport } from "./transport.js";

/**
 * A ProviderPrompt carries a delivery mode and a content array. There is no
 * `text` field.
 */
function textPrompt(clientMessageId: string, text: string): ProviderPrompt {
  return {
    clientMessageId,
    delivery: "auto",
    input: { type: "message", content: [{ type: "text", text }] },
  };
}

function fakeTransport() {
  const sent: Array<{ method: string; params: unknown }> = [];
  const listeners = new Set<(event: ZCodeEvent) => void>();
  const transport: ZCodeTransport = {
    capabilities: ["prompt.message", "permission"],
    unavailableMethods: new Set<string>(),
    createSession: async () => ({
      sessionId: "zcode-1",
      workspace: { workspacePath: "/w", workspaceKey: "/w" },
    }),
    resumeSession: async () => ({
      sessionId: "zcode-1",
      workspace: { workspacePath: "/w", workspaceKey: "/w" },
    }),
    send: async (input) => {
      sent.push({ method: "send", params: input });
    },
    stop: async (input) => {
      sent.push({ method: "stop", params: input });
    },
    archive: async () => undefined,
    onRequest: () => () => undefined,
    readSnapshot: async () => ({}),
    listSessions: async () => [],
    setModel: async () => undefined,
    setMode: async () => undefined,
    setThoughtLevel: async () => undefined,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => undefined,
  };
  return {
    transport,
    sent,
    emit(event: ZCodeEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("ZCode session turn state", () => {
  test("acknowledges a prompt with the turn id it generated", async () => {
    const harness = fakeTransport();
    const events: unknown[] = [];
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: (event) => events.push(event),
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        result: expect.objectContaining({ type: "turn" }),
      }),
    );
    expect(harness.sent[0]?.params).toMatchObject({ inputId: expect.any(String) });
  });

  test("a second interrupt retries the cancel instead of opening a second one", async () => {
    const harness = fakeTransport();
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: () => undefined,
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    const first = session.interrupt();
    const second = session.interrupt();
    await Promise.all([first, second]);
    expect(harness.sent.filter((entry) => entry.method === "stop")).toHaveLength(1);
  });

  test("refuses a new prompt while a cancel is unsettled", async () => {
    const harness = fakeTransport();
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: () => undefined,
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    void session.interrupt();
    await expect(session.prompt(textPrompt("m2", "again"))).rejects.toThrow(/cancel/i);
  });

  test("a failed cancel keeps refusing new prompts", async () => {
    const harness = fakeTransport();
    harness.transport.stop = async () => {
      throw new Error("stop failed");
    };
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: () => undefined,
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    await expect(session.interrupt()).rejects.toThrow("stop failed");
    await expect(session.prompt(textPrompt("m2", "again"))).rejects.toThrow(/cancel/i);
  });

  test("a stopped turn reaches a terminal and the session accepts a new prompt", async () => {
    const harness = fakeTransport();
    const events: ProviderEvent[] = [];
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: (event) => events.push(event),
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    await session.interrupt();
    const turns = events.filter((event) => event.type === "session.turn");
    expect(turns.some((event) => event.state === "canceled")).toBe(true);
    // The session must leave the stopping phase, or it refuses every later run.
    await expect(session.prompt(textPrompt("m2", "again"))).resolves.toBeUndefined();
  });

  test("attributes each turn's completion to the turn that started it", async () => {
    const harness = fakeTransport();
    const events: ProviderEvent[] = [];
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: (event) => events.push(event),
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "first"));
    await session.prompt(textPrompt("m2", "second"));

    harness.emit({
      type: "turn.started",
      sessionId: "zcode-1",
      turnId: "native-1",
      seq: 1,
      payload: { inputId: "paseo-input-m1" },
    });
    harness.emit({
      type: "turn.started",
      sessionId: "zcode-1",
      turnId: "native-2",
      seq: 2,
      payload: { inputId: "paseo-input-m2" },
    });
    harness.emit({
      type: "turn.completed",
      sessionId: "zcode-1",
      turnId: "native-1",
      seq: 3,
      payload: {},
    });

    const turns = events.filter((event) => event.type === "session.turn");
    const started = turns.filter((event) => event.state === "started");
    const completed = turns.filter((event) => event.state === "completed");
    expect(started).toHaveLength(2);
    expect(started[0]!.turnId).not.toBe(started[1]!.turnId);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.turnId).toBe(started[0]!.turnId);
  });
});
