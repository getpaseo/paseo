import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  getStructuredAgentResponse,
  generateStructuredAgentResponseWithFallback,
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
  type AgentCaller,
} from "./agent-response-loop.js";
import type { AgentManager } from "./agent-manager.js";

function createScriptedCaller(responses: string[]) {
  const prompts: string[] = [];
  const caller: AgentCaller = async (prompt) => {
    prompts.push(prompt);
    const index = prompts.length - 1;
    return responses[index] ?? responses[responses.length - 1] ?? "";
  };
  return { caller, prompts };
}

describe("getStructuredAgentResponse", () => {
  it("retries on invalid JSON and succeeds", async () => {
    const schema = z.object({ title: z.string() });
    const { caller, prompts } = createScriptedCaller([
      "not json",
      '{"title":"ok"}',
    ]);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a title",
      schema,
      maxRetries: 2,
    });

    expect(result).toEqual({ title: "ok" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Previous response was invalid");
    expect(prompts[1]).toContain("Invalid JSON");
  });

  it("retries on schema mismatch with validation errors", async () => {
    const schema = z.object({ count: z.number() });
    const { caller, prompts } = createScriptedCaller([
      '{"count":"nope"}',
      '{"count":2}',
    ]);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a count",
      schema,
      maxRetries: 2,
    });

    expect(result).toEqual({ count: 2 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("validation errors");
    expect(prompts[1]).toContain("count");
  });

  it("fails after maxRetries with last response and validation errors", async () => {
    const schema = z.object({ count: z.number() });
    const { caller } = createScriptedCaller([
      '{"count":"nope"}',
      '{"count":"still"}',
    ]);

    try {
      await getStructuredAgentResponse({
        caller,
        prompt: "Provide a count",
        schema,
        maxRetries: 1,
      });
      throw new Error("Expected getStructuredAgentResponse to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredAgentResponseError);
      expect(error).toEqual(
        expect.objectContaining({
          name: "StructuredAgentResponseError",
          lastResponse: '{"count":"still"}',
          validationErrors: expect.arrayContaining([expect.stringContaining("count")]),
        })
      );
    }
  });

  it("retries on raw JSON Schema validation errors and succeeds", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    };
    const { caller, prompts } = createScriptedCaller([
      '{"name": 123}',
      '{"name": "ok"}',
    ]);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a name",
      schema,
      maxRetries: 2,
    });

    expect(result).toEqual({ name: "ok" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("validation errors");
  });

  it("extracts JSON from markdown code fences", async () => {
    const schema = z.object({ message: z.string() });
    const { caller } = createScriptedCaller([
      '```json\n{"message": "hello"}\n```',
    ]);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a message",
      schema,
      maxRetries: 0,
    });

    expect(result).toEqual({ message: "hello" });
  });

  it("extracts JSON from plain code fences", async () => {
    const schema = z.object({ value: z.number() });
    const { caller } = createScriptedCaller([
      '```\n{"value": 42}\n```',
    ]);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a value",
      schema,
      maxRetries: 0,
    });

    expect(result).toEqual({ value: 42 });
  });
});

describe("generateStructuredAgentResponseWithFallback", () => {
  const schema = z.object({ summary: z.string() });

  function createManager(availability: Array<{ provider: string; available: boolean; error: string | null }>) {
    return {
      listProviderAvailability: async () => availability,
    } as unknown as AgentManager;
  }

  it("uses the first available provider in the waterfall", async () => {
    const calls: Array<{ provider: string; model?: string }> = [];
    const manager = createManager([
      { provider: "claude", available: true, error: null },
      { provider: "codex", available: true, error: null },
      { provider: "opencode", available: true, error: null },
    ]);

    const result = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.1-codex-mini" },
      ],
      runner: async (options) => {
        calls.push({
          provider: options.agentConfig.provider,
          model: options.agentConfig.model ?? undefined,
        });
        return { summary: "ok" };
      },
    });

    expect(result).toEqual({ summary: "ok" });
    expect(calls).toEqual([{ provider: "claude", model: "haiku" }]);
  });

  it("skips unavailable providers and uses the next available one", async () => {
    const calls: Array<{ provider: string; model?: string }> = [];
    const manager = createManager([
      { provider: "claude", available: false, error: "missing auth" },
      { provider: "codex", available: true, error: null },
      { provider: "opencode", available: true, error: null },
    ]);

    const result = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.1-codex-mini" },
      ],
      runner: async (options) => {
        calls.push({
          provider: options.agentConfig.provider,
          model: options.agentConfig.model ?? undefined,
        });
        return { summary: "ok" };
      },
    });

    expect(result).toEqual({ summary: "ok" });
    expect(calls).toEqual([{ provider: "codex", model: "gpt-5.1-codex-mini" }]);
  });

  it("falls back when an available provider fails", async () => {
    const calls: Array<{ provider: string; model?: string }> = [];
    const manager = createManager([
      { provider: "claude", available: true, error: null },
      { provider: "codex", available: true, error: null },
      { provider: "opencode", available: true, error: null },
    ]);

    const result = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.1-codex-mini" },
      ],
      runner: async (options) => {
        calls.push({
          provider: options.agentConfig.provider,
          model: options.agentConfig.model ?? undefined,
        });
        if (options.agentConfig.provider === "claude") {
          throw new Error("claude failed");
        }
        return { summary: "ok" };
      },
    });

    expect(result).toEqual({ summary: "ok" });
    expect(calls).toEqual([
      { provider: "claude", model: "haiku" },
      { provider: "codex", model: "gpt-5.1-codex-mini" },
    ]);
  });

  it("throws a fallback error when all providers are unavailable or fail", async () => {
    const manager = createManager([
      { provider: "claude", available: false, error: "missing auth" },
      { provider: "codex", available: true, error: null },
      { provider: "opencode", available: false, error: "not installed" },
    ]);

    await expect(
      generateStructuredAgentResponseWithFallback({
        manager,
        cwd: "/tmp/project",
        prompt: "Return JSON",
        schema,
        providers: [
          { provider: "claude", model: "haiku" },
          { provider: "codex", model: "gpt-5.1-codex-mini" },
          { provider: "opencode", model: "opencode/kimi-k2.5-free" },
        ],
        runner: async () => {
          throw new Error("failed");
        },
      })
    ).rejects.toBeInstanceOf(StructuredAgentFallbackError);
  });
});
