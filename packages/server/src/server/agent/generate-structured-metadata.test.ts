import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { StructuredAgentFallbackError } from "./agent-response-loop.js";
import { generateStructuredMetadataResponse } from "./generate-structured-metadata.js";

const schema = z.object({ message: z.string() });

function baseOptions() {
  return {
    manager: {} as never,
    cwd: "/repo",
    prompt: "Write a message",
    schema,
    schemaName: "CommitMessage",
    providers: [{ provider: "claude", model: "haiku" }],
    agentConfigOverrides: { title: "Commit generator", internal: true as const },
    persistSession: false,
  };
}

describe("generateStructuredMetadataResponse", () => {
  test("uses agent path when custom endpoint is off", async () => {
    const generateCustom = vi.fn();
    const generateWithAgents = vi.fn(async () => ({ message: "from-agent" }));

    const result = await generateStructuredMetadataResponse({
      ...baseOptions(),
      daemonConfig: {
        metadataGeneration: {
          customEndpoint: {
            enabled: false,
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "llama3",
          },
        },
      },
      generateCustom,
      generateWithAgents,
    });

    expect(result).toEqual({ message: "from-agent" });
    expect(generateCustom).not.toHaveBeenCalled();
    expect(generateWithAgents).toHaveBeenCalledOnce();
  });

  test("uses agent path when custom endpoint is incomplete", async () => {
    const generateCustom = vi.fn();
    const generateWithAgents = vi.fn(async () => ({ message: "from-agent" }));

    await generateStructuredMetadataResponse({
      ...baseOptions(),
      daemonConfig: {
        metadataGeneration: {
          customEndpoint: {
            enabled: true,
            baseUrl: "",
            model: "llama3",
          },
        },
      },
      generateCustom,
      generateWithAgents,
    });

    expect(generateCustom).not.toHaveBeenCalled();
    expect(generateWithAgents).toHaveBeenCalledOnce();
  });

  test("returns custom result without calling agents on success", async () => {
    const generateCustom = vi.fn(async () => ({ message: "from-custom" }));
    const generateWithAgents = vi.fn();

    const result = await generateStructuredMetadataResponse({
      ...baseOptions(),
      daemonConfig: {
        metadataGeneration: {
          customEndpoint: {
            enabled: true,
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "sk",
            model: "llama3",
          },
        },
      },
      generateCustom,
      generateWithAgents,
    });

    expect(result).toEqual({ message: "from-custom" });
    expect(generateCustom).toHaveBeenCalledOnce();
    expect(generateWithAgents).not.toHaveBeenCalled();
  });

  test("falls through to agents when custom generation throws", async () => {
    const warn = vi.fn();
    const generateCustom = vi.fn(async () => {
      throw new Error("endpoint down");
    });
    const generateWithAgents = vi.fn(async () => ({ message: "from-agent" }));

    const result = await generateStructuredMetadataResponse({
      ...baseOptions(),
      daemonConfig: {
        metadataGeneration: {
          customEndpoint: {
            enabled: true,
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "llama3",
          },
        },
      },
      logger: { info: vi.fn(), warn },
      generateCustom,
      generateWithAgents,
    });

    expect(result).toEqual({ message: "from-agent" });
    expect(generateWithAgents).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
  });

  test("rethrows agent fallback error when both fail", async () => {
    const generateCustom = vi.fn(async () => {
      throw new Error("endpoint down");
    });
    const generateWithAgents = vi.fn(async () => {
      throw new StructuredAgentFallbackError([]);
    });

    await expect(
      generateStructuredMetadataResponse({
        ...baseOptions(),
        daemonConfig: {
          metadataGeneration: {
            customEndpoint: {
              enabled: true,
              baseUrl: "http://127.0.0.1:11434/v1",
              model: "llama3",
            },
          },
        },
        generateCustom,
        generateWithAgents,
      }),
    ).rejects.toBeInstanceOf(StructuredAgentFallbackError);
  });
});
