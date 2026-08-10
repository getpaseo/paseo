import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildModelsDevCatalogIndex,
  lookupModelsDevModel,
  lookupModelsDevModelInCatalog,
  resetModelsDevCatalogCacheForTests,
} from "./catalog.js";

const FIXTURE = {
  anthropic: {
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
        reasoning: true,
        structured_output: true,
      },
    },
  },
  impossibl: {
    models: {
      "zai/glm-5.2": {
        id: "zai/glm-5.2",
        name: "GLM 5.2",
        limit: { context: 1_000_000, output: 128_000 },
      },
      "anthropic/claude-sonnet-4-6": {
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet via aggregator",
        limit: { context: 1_000_000, output: 64_000 },
        modalities: { input: ["text"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  openrouter: {
    models: {
      "x-ai/grok-4.5": {
        id: "x-ai/grok-4.5",
        name: "Grok 4.5",
        limit: { context: 500_000, output: 32_768 },
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
        reasoning: true,
      },
    },
  },
  xai: {
    models: {
      "grok-4.5": {
        id: "grok-4.5",
        name: "Grok 4.5",
        limit: { context: 500_000, output: 500_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
        reasoning: true,
      },
    },
  },
  zhipuai: {
    models: {
      "glm-5.1": {
        id: "glm-5.1",
        name: "GLM 5.1",
        limit: { context: 500_000, output: 64_000 },
      },
    },
  },
};

afterEach(() => {
  resetModelsDevCatalogCacheForTests();
  vi.unstubAllGlobals();
});

describe("buildModelsDevCatalogIndex / lookupModelsDevModelInCatalog", () => {
  const catalog = buildModelsDevCatalogIndex(FIXTURE);

  test("exact id match includes output limit and single candidate", () => {
    const result = lookupModelsDevModelInCatalog(catalog, "glm-5.1");
    expect(result).toEqual({
      found: true,
      query: "glm-5.1",
      matchedId: "glm-5.1",
      name: "GLM 5.1",
      contextWindowMaxTokens: 500_000,
      maxOutputTokens: 64_000,
      providerId: "zhipuai",
      candidates: [
        {
          providerId: "zhipuai",
          matchedId: "glm-5.1",
          name: "GLM 5.1",
          contextWindowMaxTokens: 500_000,
          maxOutputTokens: 64_000,
        },
      ],
    });
  });

  test("case-insensitive match", () => {
    const result = lookupModelsDevModelInCatalog(catalog, "GLM-5.1");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchedId).toBe("glm-5.1");
      expect(result.contextWindowMaxTokens).toBe(500_000);
      expect(result.maxOutputTokens).toBe(64_000);
    }
  });

  test("suffix match for provider/model ids", () => {
    const result = lookupModelsDevModelInCatalog(catalog, "glm-5.2");
    expect(result).toMatchObject({
      found: true,
      matchedId: "zai/glm-5.2",
      contextWindowMaxTokens: 1_000_000,
      maxOutputTokens: 128_000,
      providerId: "impossibl",
    });
  });

  test("returns multiple candidates when the same model is hosted by different providers", () => {
    const result = lookupModelsDevModelInCatalog(catalog, "grok-4.5");
    expect(result.found).toBe(true);
    if (!result.found) {
      return;
    }
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.providerId).sort()).toEqual([
      "openrouter",
      "xai",
    ]);
    const xai = result.candidates.find((candidate) => candidate.providerId === "xai");
    const openrouter = result.candidates.find((candidate) => candidate.providerId === "openrouter");
    expect(xai?.maxOutputTokens).toBe(500_000);
    expect(openrouter?.maxOutputTokens).toBe(32_768);
    expect(xai?.capabilities).toEqual(expect.arrayContaining(["tools", "reasoning"]));
    expect(xai?.inputModalities).toEqual(["text", "image"]);
  });

  test("parses modalities and capability flags", () => {
    const result = lookupModelsDevModelInCatalog(catalog, "claude-sonnet-4-6");
    expect(result.found).toBe(true);
    if (!result.found) {
      return;
    }
    expect(result.inputModalities).toEqual(["text", "image"]);
    expect(result.outputModalities).toEqual(["text"]);
    expect(result.capabilities).toEqual(
      expect.arrayContaining(["tools", "reasoning", "structured"]),
    );
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  test("empty query is not found", () => {
    expect(lookupModelsDevModelInCatalog(catalog, "   ")).toEqual({
      found: false,
      query: "",
    });
  });

  test("unknown model is not found", () => {
    expect(lookupModelsDevModelInCatalog(catalog, "no-such-model")).toEqual({
      found: false,
      query: "no-such-model",
    });
  });
});

describe("lookupModelsDevModel", () => {
  test("uses fetch + cache and returns context window", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => FIXTURE,
    })) as unknown as typeof fetch;

    const first = await lookupModelsDevModel("glm-5.1", { fetchImpl, now: () => 1_000 });
    const second = await lookupModelsDevModel("glm-5.1", { fetchImpl, now: () => 2_000 });

    expect(first.found).toBe(true);
    if (first.found) {
      expect(first.contextWindowMaxTokens).toBe(500_000);
      expect(first.maxOutputTokens).toBe(64_000);
      expect(first.candidates).toHaveLength(1);
    }
    expect(second.found).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("returns error when fetch fails and cache is empty", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await lookupModelsDevModel("glm-5.1", { fetchImpl });
    expect(result).toEqual({
      found: false,
      query: "glm-5.1",
      error: "network down",
    });
  });
});
