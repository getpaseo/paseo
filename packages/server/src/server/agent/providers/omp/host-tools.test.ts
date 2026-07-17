import pino from "pino";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { PaseoToolCatalog, PaseoToolDefinition, PaseoToolResult } from "../../tools/types.js";
import {
  clearOmpHostToolState,
  handleOmpHostToolRuntimeEvent,
  serializeOmpHostTools,
  waitForOmpHostToolsIdle,
} from "./host-tools.js";
import type { OmpRpcHostToolResult } from "./rpc-types.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

function createCatalog(tools: PaseoToolDefinition[]): PaseoToolCatalog {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools: toolMap,
    getTool: (name) => toolMap.get(name),
    executeTool: async (name, input, context = {}) => {
      const tool = toolMap.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      return await tool.handler(input, context);
    },
  };
}

class OmpHostToolHarness {
  private readonly logger = pino({ level: "silent" });
  private resolveControlledResult: ((result: PaseoToolResult) => void) | null = null;
  private controlledSignal: AbortSignal | null = null;
  private resolveControlledStart: (() => void) | null = null;
  private readonly controlledStart = new Promise<void>((resolve) => {
    this.resolveControlledStart = resolve;
  });

  private constructor(
    private readonly catalog: PaseoToolCatalog,
    private readonly runtimeSession: Awaited<ReturnType<FakeOmp["startSession"]>>,
  ) {}

  static async withTools(tools: PaseoToolDefinition[]): Promise<OmpHostToolHarness> {
    const omp = new FakeOmp();
    const runtimeSession = await omp.startSession({ cwd: "/workspace/project" });
    return new OmpHostToolHarness(createCatalog(tools), runtimeSession);
  }

  static async cancellable(): Promise<OmpHostToolHarness> {
    let harness: OmpHostToolHarness;
    const tool: PaseoToolDefinition = {
      name: "wait_for_agent",
      description: "Wait for a Paseo agent.",
      handler: async (_input, context) => {
        harness.controlledSignal = context.signal ?? null;
        harness.resolveControlledStart?.();
        return await new Promise<PaseoToolResult>((resolve) => {
          harness.resolveControlledResult = resolve;
        });
      },
    };
    harness = await OmpHostToolHarness.withTools([tool]);
    return harness;
  }

  async call(input: {
    id: string;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<OmpRpcHostToolResult> {
    const result = this.runtimeSession.nextHostToolResult();
    handleOmpHostToolRuntimeEvent({ type: "host_tool_call", ...input }, this.routerInput());
    return await result;
  }

  startControlledCall(): void {
    handleOmpHostToolRuntimeEvent(
      {
        type: "host_tool_call",
        id: "host-cancel",
        toolCallId: "tool-cancel",
        toolName: "wait_for_agent",
        arguments: { agentId: "child-1" },
      },
      this.routerInput(),
    );
  }

  async waitForControlledCall(): Promise<void> {
    await this.controlledStart;
  }

  cancelControlledCall(): void {
    handleOmpHostToolRuntimeEvent(
      { type: "host_tool_cancel", id: "cancel-1", targetId: "host-cancel" },
      this.routerInput(),
    );
  }

  completeControlledCall(result: PaseoToolResult): void {
    if (!this.resolveControlledResult) throw new Error("Controlled host tool has not started");
    this.resolveControlledResult(result);
  }

  async waitForIdle(): Promise<void> {
    await waitForOmpHostToolsIdle(this.runtimeSession);
  }

  wasControlledCallAborted(): boolean {
    return this.controlledSignal?.aborted === true;
  }

  updates() {
    return this.runtimeSession.hostToolUpdates;
  }

  results() {
    return this.runtimeSession.hostToolResults;
  }

  close(): void {
    clearOmpHostToolState(this.runtimeSession);
  }

  private routerInput() {
    return { runtimeSession: this.runtimeSession, paseoTools: this.catalog, logger: this.logger };
  }
}

describe("OMP host tools", () => {
  test("serializes the caller-scoped Paseo catalog for set_host_tools", () => {
    const catalog = createCatalog([
      {
        name: "create_agent",
        title: "Create agent",
        description: "Create a Paseo agent.",
        inputSchema: { initialPrompt: z.string().describe("Prompt for the new agent.") },
        handler: async () => ({ content: [] }),
      },
    ]);

    expect(serializeOmpHostTools(catalog)).toEqual([
      {
        name: "create_agent",
        label: "Create agent",
        description: "Create a Paseo agent.",
        parameters: expect.objectContaining({ type: "object", required: ["initialPrompt"] }),
      },
    ]);
  });

  test("routes calls and progress through the typed OMP runtime", async () => {
    const omp = await OmpHostToolHarness.withTools([
      {
        name: "create_agent",
        description: "Create a Paseo agent.",
        handler: async (input, context) => {
          context.sendUpdate?.({ content: [{ type: "text", text: "creating" }] });
          return { content: [], structuredContent: { input, agentId: "child-1" } };
        },
      },
    ]);

    await expect(
      omp.call({
        id: "host-1",
        toolCallId: "tool-1",
        toolName: "create_agent",
        arguments: { initialPrompt: "Inspect the bug" },
      }),
    ).resolves.toEqual({
      type: "host_tool_result",
      id: "host-1",
      result: {
        content: [{ type: "text", text: expect.stringContaining('"agentId": "child-1"') }],
        details: { input: { initialPrompt: "Inspect the bug" }, agentId: "child-1" },
      },
    });
    expect(omp.updates()).toEqual([
      {
        type: "host_tool_update",
        id: "host-1",
        partialResult: { content: [{ type: "text", text: "creating" }] },
      },
    ]);
  });

  test("cancels an in-flight host tool and drops its late result", async () => {
    const omp = await OmpHostToolHarness.cancellable();

    omp.startControlledCall();
    await omp.waitForControlledCall();
    omp.cancelControlledCall();
    omp.completeControlledCall({ content: [{ type: "text", text: "late" }] });
    await omp.waitForIdle();

    expect(omp.wasControlledCallAborted()).toBe(true);
    expect(omp.results()).toEqual([]);
    expect(omp.updates()).toEqual([]);
    omp.close();
  });
});
