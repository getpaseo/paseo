import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  getStructuredAgentResponse,
  generateStructuredAgentResponse,
  generateStructuredAgentResponseWithFallback,
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
  StructuredAgentTimeoutError,
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
    const { caller, prompts } = createScriptedCaller(["not json", '{"title":"ok"}']);

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
    const { caller, prompts } = createScriptedCaller(['{"count":"nope"}', '{"count":2}']);

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
    const { caller } = createScriptedCaller(['{"count":"nope"}', '{"count":"still"}']);

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
        }),
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
    const { caller, prompts } = createScriptedCaller(['{"name": 123}', '{"name": "ok"}']);

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
    const { caller } = createScriptedCaller(['```json\n{"message": "hello"}\n```']);

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
    const { caller } = createScriptedCaller(['```\n{"value": 42}\n```']);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a value",
      schema,
      maxRetries: 0,
    });

    expect(result).toEqual({ value: 42 });
  });
});

describe("generateStructuredAgentResponse", () => {
  const schema = z.object({ summary: z.string() });

  function createRunnerManager(runAgent: () => Promise<{ finalText: string }>) {
    const created: string[] = [];
    const closed: string[] = [];
    const deleted: string[] = [];
    const manager = {
      createAgent: async () => {
        created.push("generator");
        return { id: "generator" };
      },
      runAgent,
      closeAgent: async (id: string) => {
        closed.push(id);
      },
      deleteAgentState: async (id: string) => {
        deleted.push(id);
      },
    } as unknown as AgentManager;
    return { manager, created, closed, deleted };
  }

  it("closes and deletes the ephemeral agent after a successful run", async () => {
    const { manager, closed, deleted } = createRunnerManager(async () => ({
      finalText: '{"summary":"ok"}',
    }));

    const result = await generateStructuredAgentResponse({
      manager,
      agentConfig: { provider: "claude", cwd: "/tmp/project" },
      prompt: "Return JSON",
      schema,
      maxRetries: 0,
    });

    expect(result).toEqual({ summary: "ok" });
    expect(closed).toEqual(["generator"]);
    expect(deleted).toEqual(["generator"]);
  });

  // Regression: a metadata-generation run that never terminates (an internal
  // agent's permission prompt has no UI to answer it) left the provider CLI
  // child process alive forever. See issue #1937.
  it("closes the ephemeral agent when the run never finishes", async () => {
    vi.useFakeTimers();
    try {
      const { manager, closed, deleted } = createRunnerManager(() => new Promise<never>(() => {}));

      const generation = generateStructuredAgentResponse({
        manager,
        agentConfig: { provider: "claude", cwd: "/tmp/project" },
        prompt: "Return JSON",
        schema,
        timeoutMs: 25,
      });
      const settled = expect(generation).rejects.toBeInstanceOf(StructuredAgentTimeoutError);
      await vi.advanceTimersByTimeAsync(25);
      await settled;

      expect(closed).toEqual(["generator"]);
      expect(deleted).toEqual(["generator"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the whole generation, not each retry", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { manager, closed } = createRunnerManager(async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { finalText: "not json" };
      });

      const generation = generateStructuredAgentResponse({
        manager,
        agentConfig: { provider: "claude", cwd: "/tmp/project" },
        prompt: "Return JSON",
        schema,
        maxRetries: 100,
        timeoutMs: 60,
      });
      const settled = expect(generation).rejects.toBeInstanceOf(StructuredAgentTimeoutError);
      await vi.advanceTimersByTimeAsync(60);
      await settled;

      // A per-retry bound would have let all 101 attempts through. One shared
      // 60ms budget at 20ms an attempt starts four (t=0/20/40/60) before the
      // deadline stops it.
      expect(attempts).toBe(4);
      expect(closed).toEqual(["generator"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("generateStructuredAgentResponseWithFallback", () => {
  const schema = z.object({ summary: z.string() });

  function createManager(
    availability: Array<{ provider: string; available: boolean; error: string | null }>,
  ): AgentManager & { checkedProviders: string[] } {
    const checkedProviders: string[] = [];
    const availabilityByProvider = new Map(availability.map((entry) => [entry.provider, entry]));
    return {
      checkedProviders,
      getProviderAvailability: async (provider: string) => {
        checkedProviders.push(provider);
        return (
          availabilityByProvider.get(provider) ?? {
            provider,
            available: false,
            error: `No client registered for provider '${provider}'`,
          }
        );
      },
    } as unknown as AgentManager & { checkedProviders: string[] };
  }

  it("uses the first available provider in the waterfall", async () => {
    const calls: Array<{ provider: string; model?: string; persistSession?: boolean }> = [];
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
        { provider: "codex", model: "gpt-5.4-mini" },
      ],
      persistSession: false,
      runner: async (options) => {
        calls.push({
          provider: options.agentConfig.provider,
          model: options.agentConfig.model ?? undefined,
          persistSession: options.persistSession,
        });
        return { summary: "ok" };
      },
    });

    expect(result).toEqual({ summary: "ok" });
    expect(calls).toEqual([{ provider: "claude", model: "haiku", persistSession: false }]);
    expect(manager.checkedProviders).toEqual(["claude"]);
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
        { provider: "codex", model: "gpt-5.4-mini" },
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
    expect(calls).toEqual([{ provider: "codex", model: "gpt-5.4-mini" }]);
    expect(manager.checkedProviders).toEqual(["claude", "codex"]);
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
        { provider: "codex", model: "gpt-5.4-mini" },
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
      { provider: "codex", model: "gpt-5.4-mini" },
    ]);
    expect(manager.checkedProviders).toEqual(["claude", "codex"]);
  });

  it("spends one shared deadline across the waterfall", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: Array<number | undefined> = [];
      const manager = createManager([
        { provider: "claude", available: true, error: null },
        { provider: "codex", available: true, error: null },
        { provider: "opencode", available: true, error: null },
      ]);

      const generation = generateStructuredAgentResponseWithFallback({
        manager,
        cwd: "/tmp/project",
        prompt: "Return JSON",
        schema,
        providers: [
          { provider: "claude", model: "haiku" },
          { provider: "codex", model: "gpt-5.4-mini" },
          { provider: "opencode", model: "opencode/gpt-5-nano" },
        ],
        timeoutMs: 50,
        runner: async (options) => {
          timeouts.push(options.timeoutMs);
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw new Error("failed");
        },
      });
      const settled = generation.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      const error = await settled;

      // Each candidate gets what is left of the budget, not a fresh copy of it,
      // and once it is spent the rest are skipped instead of run.
      expect(error).toBeInstanceOf(StructuredAgentFallbackError);
      expect(timeouts).toEqual([50, 20]);
      // A skipped candidate was never probed, so the summary must not claim it
      // is unavailable.
      expect((error as Error).message).toContain(
        "opencode (opencode/gpt-5-nano): skipped (structured generation deadline exceeded)",
      );
    } finally {
      vi.useRealTimers();
    }
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
          { provider: "codex", model: "gpt-5.4-mini" },
          { provider: "opencode", model: "opencode/gpt-5-nano" },
        ],
        runner: async () => {
          throw new Error("failed");
        },
      }),
    ).rejects.toBeInstanceOf(StructuredAgentFallbackError);
  });
});
