import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { describe, expect, it } from "vitest";
import { createDirectExampleProvider } from "./provider.js";

describe("direct provider example", () => {
  it("fails steering when no turn is active without creating a turn", async () => {
    const connection = await createDirectExampleProvider().connect({
      versions: [1],
      capabilities: ["prompt.command", "prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "session-1",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    const turnEventsBefore = events.filter((event) => event.type === "session.turn").length;

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-1",
        delivery: "steer",
        input: { type: "command", name: "reset", arguments: "" },
      },
    });

    expect(events).toContainEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "steer-1",
      result: { type: "failed", error: { message: "There is no active turn to steer" } },
    });
    expect(events.filter((event) => event.type === "session.turn")).toHaveLength(turnEventsBefore);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "session.notice" }));
    await connection.close();
  });

  it("demonstrates settings, commands, persistence, and provider-rendered timeline items", async () => {
    const connection = await createDirectExampleProvider().connect({
      versions: [1],
      capabilities: [
        "prompt.message",
        "prompt.command",
        "session.configure",
        "session.persistence",
        "session.subsession",
        "timeline.plugin",
      ],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-complete",
      sessionId: "session-complete",
      config: {
        cwd: "/repo",
        env: { EXAMPLE: "1" },
        systemPrompt: "Be useful",
        mcpServers: {},
        model: "example-1",
        mode: "build",
        settings: { concise: true, voice: "calm" },
        providerOptions: { privateValue: 1 },
        persist: true,
      },
      history: "skip",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          settings: expect.arrayContaining([
            expect.objectContaining({ id: "concise", value: true }),
            expect.objectContaining({ id: "voice", value: "calm" }),
          ]),
        }),
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "session.commands" }));

    await connection.send({
      type: "session.configure",
      requestId: "configure-complete",
      sessionId: "session-complete",
      changes: { settings: { voice: "direct" } },
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "session-complete",
      prompt: {
        clientMessageId: "command-1",
        delivery: "auto",
        input: { type: "command", name: "reset", arguments: "" },
      },
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "session-complete",
      prompt: {
        clientMessageId: "message-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        clientMessageId: "command-1",
        result: { type: "completed" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "user_message", clientMessageId: "message-1" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: "session-complete",
        item: expect.objectContaining({ type: "plugin", kind: "provider-result" }),
      }),
    );
    const child = events.find(
      (event): event is Extract<ProviderEvent, { type: "session.opened" }> =>
        event.type === "session.opened" && event.parentSessionId === "session-complete",
    );
    expect(child?.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: child?.sessionId,
        item: expect.objectContaining({ type: "plugin", kind: "provider-result" }),
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "session.persistence" }));
    await connection.close();
  });

  it("rejects calls after the example connection closes", async () => {
    const connection = await createDirectExampleProvider().connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });

    await connection.close();

    await expect(
      connection.send({ type: "catalog", requestId: "catalog-after-close" }),
    ).rejects.toThrow("Provider connection is closed");
    await expect(
      connection.send({
        type: "session.open",
        requestId: "open-after-close",
        sessionId: "closed-session",
        config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
        history: "skip",
      }),
    ).rejects.toThrow("Provider connection is closed");
  });
});
