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

  test("exact id match", () => {
    const result = lookupModelsDevModelInCatalog(catalog, "glm-5.1");
    expect(result).toEqual({
      found: true,
      query: "glm-5.1",
      matchedId: "glm-5.1",
      name: "GLM 5.1",
      contextWindowMaxTokens: 500_000,
      providerId: "zhipuai",
    });
  });

  test("case-insensitive match", () => {
    const result = lookupModelsDevModelInCatalog(catalog, "GLM-5.1");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchedId).toBe("glm-5.1");
      expect(result.contextWindowMaxTokens).toBe(500_000);
    }
  });

  test("suffix match for provider/model ids", () => {
    const result = lookupModelsDevModelInCatalog(catalog, "glm-5.2");
    expect(result).toMatchObject({
      found: true,
      matchedId: "zai/glm-5.2",
      contextWindowMaxTokens: 1_000_000,
      providerId: "impossibl",
    });
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
