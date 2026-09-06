import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PaseoToolCatalog, PaseoToolRuntimeContext } from "../agent/tools/types.js";
import { LiveVoiceToolExecutor } from "./live-voice-tool-executor.js";

function request() {
  return {
    type: "voice.live.tool.execute.request" as const,
    requestId: "execute-request-1",
    toolName: "list_agents",
    arguments: { includeArchived: false },
  };
}

describe("LiveVoiceToolExecutor", () => {
  it("executes a normal top-level catalog without caller agent authority", async () => {
    const runtimeContexts: PaseoToolRuntimeContext[] = [];
    const executeTool = vi.fn().mockResolvedValue({
      content: [],
      structuredContent: { agents: [] },
    });
    const executor = new LiveVoiceToolExecutor({
      createCatalog: (runtime) => {
        runtimeContexts.push(runtime);
        return { executeTool } as unknown as PaseoToolCatalog;
      },
    });

    await expect(executor.execute(request())).resolves.toEqual({
      type: "voice.live.tool.execute.response",
      payload: {
        requestId: "execute-request-1",
        ok: true,
        toolResult: {
          content: [],
          structuredContent: { agents: [] },
        },
      },
    });
    expect(runtimeContexts).toEqual([{}]);
    expect(executeTool).toHaveBeenCalledWith("list_agents", { includeArchived: false });
  });

  it("returns a structured error only to the caller when the target tool fails", async () => {
    const executor = new LiveVoiceToolExecutor({
      createCatalog: () =>
        ({
          tools: new Map([["list_agents", {}]]),
          getTool: () => undefined,
          executeTool: async () => {
            throw new Error("Paseo tool not found: made_up_tool");
          },
        }) as unknown as PaseoToolCatalog,
    });

    await expect(executor.execute({ ...request(), toolName: "made_up_tool" })).resolves.toEqual({
      type: "voice.live.tool.execute.response",
      payload: {
        requestId: "execute-request-1",
        ok: false,
        error: {
          code: "tool_not_found",
          message: "Paseo tool not found: made_up_tool. Discover tools before executing.",
          retryable: false,
        },
      },
    });
  });

  it("sanitizes catalog results before they cross the JSON wire", async () => {
    const executor = new LiveVoiceToolExecutor({
      createCatalog: () =>
        ({
          executeTool: async () => ({
            content: [{ type: "text", text: "done" }],
            structuredContent: {
              missing: undefined,
              count: 42n,
              at: new Date("2026-07-30T12:00:00.000Z"),
            },
          }),
        }) as unknown as PaseoToolCatalog,
    });

    await expect(executor.execute(request())).resolves.toMatchObject({
      payload: {
        ok: true,
        toolResult: {
          structuredContent: {
            missing: null,
            count: "42",
            at: "2026-07-30T12:00:00.000Z",
          },
        },
      },
    });
  });

  it("returns a structured error for a circular catalog result", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const executor = new LiveVoiceToolExecutor({
      createCatalog: () =>
        ({
          executeTool: async () => ({
            content: [],
            structuredContent: circular,
          }),
        }) as unknown as PaseoToolCatalog,
    });

    await expect(executor.execute(request())).resolves.toMatchObject({
      payload: {
        ok: false,
        error: {
          code: "tool_execution_failed",
          message: "Cannot serialize circular structure to JSON",
        },
      },
    });
  });

  it("classifies schema validation failures as invalid arguments", async () => {
    const tool = { name: "list_agents" };
    const executor = new LiveVoiceToolExecutor({
      createCatalog: () =>
        ({
          tools: new Map([["list_agents", tool]]),
          getTool: () => tool,
          executeTool: async (_name: string, input: unknown) => {
            z.object({ limit: z.number().int().positive() }).parse(input);
            return { content: [] };
          },
        }) as unknown as PaseoToolCatalog,
    });

    await expect(
      executor.execute({ ...request(), arguments: { limit: "many" } }),
    ).resolves.toMatchObject({
      payload: {
        ok: false,
        error: { code: "invalid_tool_arguments", retryable: false },
      },
    });
  });
  it("passes the background-work hook only when the caller asked to be told", async () => {
    const runtimeContexts: PaseoToolRuntimeContext[] = [];
    const onBackgroundAgentStarted = vi.fn();
    const executor = new LiveVoiceToolExecutor({
      createCatalog: (runtime) => {
        runtimeContexts.push(runtime);
        return {
          executeTool: async () => {
            runtime.onBackgroundAgentStarted?.({ agentId: "agent-1" });
            return { content: [], structuredContent: { agentId: "agent-1" } };
          },
        } as unknown as PaseoToolCatalog;
      },
    });

    const watched = await executor.execute(
      { ...request(), toolName: "create_agent", notifyOnAgentFinish: true },
      { onBackgroundAgentStarted },
    );
    await executor.execute(
      { ...request(), toolName: "create_agent" },
      { onBackgroundAgentStarted },
    );

    expect(onBackgroundAgentStarted).toHaveBeenCalledExactlyOnceWith({ agentId: "agent-1" });
    expect(watched.payload).toMatchObject({ ok: true, backgroundAgentId: "agent-1" });
    expect(runtimeContexts[1]).toEqual({});
  });

  it("defaults agent work to the background whenever it will report the outcome", async () => {
    const runtimeContexts: PaseoToolRuntimeContext[] = [];
    const executor = new LiveVoiceToolExecutor({
      createCatalog: (runtime) => {
        runtimeContexts.push(runtime);
        return {
          executeTool: async () => ({ content: [], structuredContent: {} }),
        } as unknown as PaseoToolCatalog;
      },
    });

    await executor.execute(
      { ...request(), toolName: "send_agent_prompt", notifyOnAgentFinish: true },
      { onBackgroundAgentStarted: vi.fn() },
    );

    // Without this the tool blocks, the hook never fires, and the outcome the
    // caller was promised is silently never reported.
    expect(runtimeContexts[0]?.defaultAgentWorkToBackground).toBe(true);
  });
});
