import { describe, expect, it, vi } from "vitest";
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
          code: "tool_execution_failed",
          message: "Paseo tool not found: made_up_tool",
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
});
