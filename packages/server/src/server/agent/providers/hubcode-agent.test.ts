// Unit tests for the Hubcode agent client + session.
// Exercises:
//   1. SSE frame parsing (delta, [DONE], unknown frames)
//   2. listModels with and without an upgrade flag
//   3. startTurn streaming: user_message + assistant_message + turn_completed
//   4. Auth token passthrough to the backend
//   5. Cancellation (AbortSignal)
//
// No real HTTP — a stubbed fetch feeds the client whatever it should receive.

import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types";
import {
  HubcodeAgentClient,
  HubcodeAgentSession,
  HubcodeUpgradeRequiredError,
  parseSseFrame,
} from "./hubcode-agent";

function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function bundleResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("parseSseFrame", () => {
  it("parses a tool_call delta with index, id, name and arguments fragment", () => {
    const frame =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"foo","arguments":"{\\"a"}}]}}]}';
    const parsed = parseSseFrame(frame);
    expect(parsed?.toolCallDeltas).toEqual([
      { index: 0, id: "call_1", name: "foo", arguments: '{"a' },
    ]);
  });

  it("parses a delta frame", () => {
    const frame = 'data: {"choices":[{"delta":{"content":"hello"}}]}';
    expect(parseSseFrame(frame)).toEqual({ delta: "hello" });
  });

  it("returns done for [DONE]", () => {
    expect(parseSseFrame("data: [DONE]")).toEqual({ done: true });
  });

  it("ignores comment/ping frames", () => {
    expect(parseSseFrame(": keep-alive")).toBeNull();
    expect(parseSseFrame("event: ping")).toBeNull();
  });

  it("returns null on unparseable JSON", () => {
    expect(parseSseFrame("data: not-json")).toBeNull();
  });

  it("returns null when delta has no content", () => {
    const frame = 'data: {"choices":[{"delta":{"role":"assistant"}}]}';
    expect(parseSseFrame(frame)).toBeNull();
  });
});

describe("HubcodeAgentClient.listModels", () => {
  it("returns combo names when the user is on a paid plan", async () => {
    process.env.HUBCODE_SESSION_TOKEN = "session-token-abc";
    const fetchImpl = vi.fn(async (_url, _init) =>
      bundleResponse({
        requiresUpgrade: false,
        planId: "plan_pro",
        apiKey: "ork_test",
        baseUrl: "http://backend.test",
        combos: [
          { comboId: "c1", comboName: "combo-a" },
          { comboId: "c2", comboName: "combo-b" },
        ],
      }),
    );

    const client = new HubcodeAgentClient({ fetch: fetchImpl as never });
    const models = await client.listModels();
    expect(models.map((m) => m.id)).toEqual(["combo-a", "combo-b"]);
    // Bearer token must be forwarded unchanged.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-token-abc");
  });

  it("returns a single upgrade-placeholder model for free users", async () => {
    process.env.HUBCODE_SESSION_TOKEN = "tok";
    const fetchImpl = vi.fn(async () =>
      bundleResponse({
        requiresUpgrade: true,
        planId: "plan_free",
        apiKey: null,
        baseUrl: "http://backend.test",
        combos: [],
      }),
    );
    const client = new HubcodeAgentClient({ fetch: fetchImpl as never });
    const models = await client.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("__upgrade__");
  });

  it("returns [] when no session token is available", async () => {
    delete process.env.HUBCODE_SESSION_TOKEN;
    const fetchImpl = vi.fn();
    const client = new HubcodeAgentClient({ fetch: fetchImpl as never });
    const models = await client.listModels();
    expect(models).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("HubcodeAgentClient.createSession", () => {
  it("throws HubcodeUpgradeRequiredError for a free plan", async () => {
    process.env.HUBCODE_SESSION_TOKEN = "tok";
    const fetchImpl = vi.fn(async () =>
      bundleResponse({
        requiresUpgrade: true,
        planId: "plan_free",
        apiKey: null,
        baseUrl: "http://backend.test",
        combos: [],
      }),
    );
    const client = new HubcodeAgentClient({ fetch: fetchImpl as never });
    await expect(
      client.createSession({ provider: "hubcode", cwd: "/tmp" }, {}),
    ).rejects.toBeInstanceOf(HubcodeUpgradeRequiredError);
  });
});

describe("HubcodeAgentSession.startTurn", () => {
  function makeChatResponse(chunks: string[]): Response {
    return new Response(makeSseStream(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("streams text deltas and emits a final assistant_message", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.model).toBe("combo-a");
      expect(body.stream).toBe(true);
      expect(body.messages[body.messages.length - 1]).toEqual({
        role: "user",
        content: "hi",
      });
      return makeChatResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    });

    const session = new HubcodeAgentSession({
      config: { provider: "hubcode", cwd: "/tmp" },
      model: "combo-a",
      baseUrl: "http://backend.test",
      apiKey: "ork_test",
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {}, error: () => {}, debug: () => {}, info: () => {} },
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.startTurn("hi");

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_completed")).toBe(true);
    });

    const messages = events.filter(
      (e) => e.type === "timeline" && e.item.type === "assistant_message",
    ) as Array<Extract<AgentStreamEvent, { type: "timeline" }>>;
    const last = messages.at(-1);
    expect(last).toBeDefined();
    if (last && last.item.type === "assistant_message") {
      expect(last.item.text).toBe("Hello world");
    }

    expect(events[0]).toMatchObject({ type: "turn_started", provider: "hubcode" });
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", provider: "hubcode" });
  });

  it("forwards a systemPrompt as the first message", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
      return makeChatResponse(["data: [DONE]\n\n"]);
    });
    const session = new HubcodeAgentSession({
      config: { provider: "hubcode", cwd: "/tmp", systemPrompt: "be terse" },
      model: "combo-a",
      baseUrl: "http://backend.test",
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {} },
    });
    await session.startTurn("hi");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  });

  it("emits turn_failed on HTTP error", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const session = new HubcodeAgentSession({
      config: { provider: "hubcode", cwd: "/tmp" },
      model: "combo-a",
      baseUrl: "http://backend.test",
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {} },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.startTurn("hi");
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_failed")).toBe(true);
    });
    const failed = events.find((e) => e.type === "turn_failed") as Extract<
      AgentStreamEvent,
      { type: "turn_failed" }
    >;
    expect(failed.error).toMatch(/500/);
  });

  it("runs a full tool loop: tool_calls → mcp invoke → final assistant text", async () => {
    const { HubcodeMcpRuntime } = await import("./hubcode-mcp-runtime");

    const fakeMcpFactory = vi.fn(async () => ({
      listTools: async () => ({
        tools: [
          {
            name: "echo",
            description: "Echoes",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
        ],
      }),
      callTool: async (args: { name: string; arguments?: Record<string, unknown> }) => ({
        content: [{ type: "text", text: `echoed:${args.arguments?.text}` }],
      }),
      close: async () => {},
    }));

    const mcpRuntime = new HubcodeMcpRuntime({
      servers: { srv: { type: "http", url: "http://mcp" } },
      clientFactory: fakeMcpFactory as never,
    });

    const callsSeen: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      callsSeen.push(body);
      const isFirst = callsSeen.length === 1;
      if (isFirst) {
        // First step: emit a tool_call for srv__echo with text="hello".
        return makeChatResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"srv__echo","arguments":"{\\"text\\":\\"hello\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]);
      }
      // Second step: assistant produces final text.
      return makeChatResponse([
        'data: {"choices":[{"delta":{"content":"All done."}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    });

    const session = new HubcodeAgentSession({
      config: {
        provider: "hubcode",
        cwd: "/tmp",
        mcpServers: { srv: { type: "http", url: "http://mcp" } },
      },
      model: "combo-a",
      baseUrl: "http://backend.test",
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {}, debug: () => {} },
      mcpRuntime,
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.startTurn("hi");

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_completed")).toBe(true);
    });

    // Two HTTP round-trips: first triggers the tool, second finishes.
    expect(callsSeen).toHaveLength(2);

    // First call carried tools[]; second call has tool_calls in messages.
    expect((callsSeen[0] as { tools?: unknown[] }).tools).toBeDefined();
    const secondMessages = (callsSeen[1] as { messages: Array<Record<string, unknown>> }).messages;
    const lastUserOrToolMsg = secondMessages.at(-1);
    expect(lastUserOrToolMsg).toMatchObject({ role: "tool", content: "echoed:hello" });
    const assistantWithCall = secondMessages.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(assistantWithCall).toBeDefined();

    // Timeline emitted tool_call running + completed.
    const toolCalls = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: "timeline" }> =>
        e.type === "timeline" && e.item.type === "tool_call",
    );
    const statuses = toolCalls
      .map((e) => (e.item.type === "tool_call" ? e.item.status : null))
      .filter(Boolean);
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");

    // Final assistant_message is the second-step text.
    const lastMsg = [...events]
      .reverse()
      .find((e) => e.type === "timeline" && e.item.type === "assistant_message") as
      | Extract<AgentStreamEvent, { type: "timeline" }>
      | undefined;
    expect(lastMsg && lastMsg.item.type === "assistant_message" && lastMsg.item.text).toBe(
      "All done.",
    );
  });

  it("forwards reasoning_effort, skills, sessionId and pass-through knobs", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.reasoning_effort).toBe("high");
      expect(body.skills).toEqual(["s1", "s2"]);
      expect(body.sessionId).toBe("session-123");
      expect(body.temperature).toBe(0.4);
      expect(body.tool_choice).toBe("auto");
      return makeChatResponse(["data: [DONE]\n\n"]);
    });
    const session = new HubcodeAgentSession({
      config: {
        provider: "hubcode",
        cwd: "/tmp",
        thinkingOptionId: "high",
        featureValues: {
          skills: ["s1", "s2"],
          sessionId: "session-123",
          temperature: 0.4,
          tool_choice: "auto",
        },
      },
      model: "combo-a",
      baseUrl: "http://backend.test",
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {} },
    });
    await session.startTurn("hi");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  });

  it("auto-resolves skills:true to 'auto' for backend auto-selection", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.skills).toBe("auto");
      return makeChatResponse(["data: [DONE]\n\n"]);
    });
    const session = new HubcodeAgentSession({
      config: {
        provider: "hubcode",
        cwd: "/tmp",
        featureValues: { skills: true },
      },
      model: "combo-a",
      baseUrl: "http://backend.test",
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {} },
    });
    await session.startTurn("hi");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  });

  it("gates tool execution behind respondToPermission when approvalPolicy is 'ask'", async () => {
    const { HubcodeMcpRuntime } = await import("./hubcode-mcp-runtime");

    const callTool = vi.fn(async (args: { name: string; arguments?: Record<string, unknown> }) => ({
      content: [{ type: "text", text: `ran:${args.name}` }],
    }));
    const mcpRuntime = new HubcodeMcpRuntime({
      servers: { srv: { type: "http", url: "http://mcp" } },
      clientFactory: (async () => ({
        listTools: async () => ({
          tools: [{ name: "danger", inputSchema: { type: "object", properties: {} } }],
        }),
        callTool,
        close: async () => {},
      })) as never,
    });

    const callsSeen: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      callsSeen.push(JSON.parse((init?.body as string) ?? "{}"));
      const isFirst = callsSeen.length === 1;
      if (isFirst) {
        return makeChatResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_42","type":"function","function":{"name":"srv__danger","arguments":"{}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]);
      }
      return makeChatResponse([
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    });

    const session = new HubcodeAgentSession({
      config: {
        provider: "hubcode",
        cwd: "/tmp",
        approvalPolicy: "ask",
        mcpServers: { srv: { type: "http", url: "http://mcp" } },
      },
      model: "combo-a",
      baseUrl: "http://backend.test",
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {} },
      mcpRuntime,
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.startTurn("hi");

    // Wait for the permission request to surface.
    await vi.waitFor(() => {
      const pending = session.getPendingPermissions();
      expect(pending).toHaveLength(1);
    });
    expect(callTool).not.toHaveBeenCalled(); // tool blocked until approval

    const pending = session.getPendingPermissions();
    expect(pending[0].id).toBe("call_42");
    expect(pending[0].kind).toBe("tool");

    // Approve.
    await session.respondToPermission(pending[0].id, { behavior: "allow" });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_completed")).toBe(true);
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "permission_requested")).toBe(true);
    expect(events.some((e) => e.type === "permission_resolved")).toBe(true);
  });

  it("respects deny+interrupt: cancels turn and never invokes the tool", async () => {
    const { HubcodeMcpRuntime } = await import("./hubcode-mcp-runtime");

    const callTool = vi.fn();
    const mcpRuntime = new HubcodeMcpRuntime({
      servers: { srv: { type: "http", url: "http://mcp" } },
      clientFactory: (async () => ({
        listTools: async () => ({
          tools: [{ name: "danger", inputSchema: { type: "object", properties: {} } }],
        }),
        callTool: callTool as never,
        close: async () => {},
      })) as never,
    });

    const fetchImpl = vi.fn(async () =>
      makeChatResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_99","type":"function","function":{"name":"srv__danger","arguments":"{}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const session = new HubcodeAgentSession({
      config: {
        provider: "hubcode",
        cwd: "/tmp",
        approvalPolicy: "ask",
        mcpServers: { srv: { type: "http", url: "http://mcp" } },
      },
      model: "combo-a",
      baseUrl: "http://backend.test",
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {} },
      mcpRuntime,
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.startTurn("hi");

    await vi.waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));
    const pending = session.getPendingPermissions();
    await session.respondToPermission(pending[0].id, {
      behavior: "deny",
      interrupt: true,
      message: "no thanks",
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_canceled")).toBe(true);
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("emits turn_canceled when interrupt() is called mid-stream", async () => {
    let release: (() => void) | null = null;
    const fetchImpl = vi.fn(async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'));
          await new Promise<void>((resolve) => {
            release = resolve;
            signal?.addEventListener("abort", resolve, { once: true });
          });
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            controller.close();
          }
        },
      });
      return new Response(body, { status: 200 });
    });

    const session = new HubcodeAgentSession({
      config: { provider: "hubcode", cwd: "/tmp" },
      model: "combo-a",
      baseUrl: "http://backend.test",
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {} },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.startTurn("hi");
    // Wait until stream is open before interrupting.
    await vi.waitFor(() => expect(release).not.toBeNull());
    await session.interrupt();
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_canceled")).toBe(true));
  });
});
