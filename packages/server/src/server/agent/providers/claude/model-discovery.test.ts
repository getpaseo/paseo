import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  CLAUDE_MODEL_DISCOVERY_ENV,
  fetchDiscoveredClaudeModels,
  mergeDiscoveredClaudeModels,
} from "./model-discovery.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup.length = 0;
});

const API_BODY = {
  anthropic: {
    models: {
      "claude-opus-6": {
        id: "claude-opus-6",
        name: "Claude Opus 6",
        description: "The next Opus",
        limit: { context: 500_000, output: 64_000 },
      },
      "claude-haiku-6": { id: "claude-haiku-6" },
      // A new minor under a known major: fuzzy normalization maps it onto
      // claude-opus-5, but it must still be offered.
      "claude-opus-5-6": { id: "claude-opus-5-6", name: "Claude Opus 5.6" },
      // Already in the compiled manifest: must not be duplicated. Version-gated
      // entries (Opus 5.5 needs Claude Code >= 2.1.280) stay gated.
      "claude-opus-4-8": { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      // Dated variants and non-Claude ids never become picker rows.
      "claude-opus-6-20270101": { id: "claude-opus-6-20270101", name: "Claude Opus 6 dated" },
      "some-other-model": { id: "some-other-model" },
    },
  },
};

interface ModelsDevStub {
  apiUrl: string;
  requestCount: () => number;
}

async function stubModelsDev(status: number, body: unknown): Promise<ModelsDevStub> {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { apiUrl: `http://127.0.0.1:${port}/api.json`, requestCount: () => requests };
}

async function tempCacheFile(contents?: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-model-discovery-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, "claude-models.json");
  if (contents !== undefined) {
    await fs.writeFile(cacheFile, JSON.stringify(contents));
  }
  return cacheFile;
}

describe("fetchDiscoveredClaudeModels", () => {
  it("offers models the manifest does not know, mapped to catalog rows", async () => {
    const stub = await stubModelsDev(200, API_BODY);
    const cacheFile = await tempCacheFile();

    const models = await fetchDiscoveredClaudeModels(createTestLogger(), {
      apiUrl: stub.apiUrl,
      cacheFile,
    });

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-6",
      "claude-haiku-6",
      "claude-opus-5-6",
    ]);
    const opus = models[0];
    expect(opus.provider).toBe("claude");
    expect(opus.label).toBe("Opus 6");
    expect(opus.description).toBe("The next Opus");
    expect(opus.contextWindowMaxTokens).toBe(500_000);
    expect(opus.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("high");
    const haiku = models[1];
    expect(haiku.label).toBe("claude-haiku-6");
    expect(haiku.description).toBe("Discovered from models.dev");
    expect(haiku.contextWindowMaxTokens).toBeUndefined();
    expect(stub.requestCount()).toBe(1);

    const written = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    expect(Object.keys(written.models)).toContain("claude-opus-6");
  });

  it("returns nothing when the fetch fails and there is no cache", async () => {
    const stub = await stubModelsDev(500, {});
    const cacheFile = await tempCacheFile();

    const models = await fetchDiscoveredClaudeModels(createTestLogger(), {
      apiUrl: stub.apiUrl,
      cacheFile,
    });

    expect(models).toEqual([]);
    expect(stub.requestCount()).toBe(1);
  });

  it("rejects a malformed payload", async () => {
    const stub = await stubModelsDev(200, { anthropic: {} });
    const cacheFile = await tempCacheFile();

    const models = await fetchDiscoveredClaudeModels(createTestLogger(), {
      apiUrl: stub.apiUrl,
      cacheFile,
    });

    expect(models).toEqual([]);
  });

  it("still serves fetched models when the cache cannot be written", async () => {
    const stub = await stubModelsDev(200, API_BODY);
    // A regular file as the cache's parent directory makes the write fail.
    const blocker = await tempCacheFile({});
    const cacheFile = path.join(blocker, "claude-models.json");

    const models = await fetchDiscoveredClaudeModels(createTestLogger(), {
      apiUrl: stub.apiUrl,
      cacheFile,
    });

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-6",
      "claude-haiku-6",
      "claude-opus-5-6",
    ]);
  });

  it("serves a fresh cache without touching the network", async () => {
    const cacheFile = await tempCacheFile({
      fetchedAt: Date.now(),
      models: API_BODY.anthropic.models,
    });

    const models = await fetchDiscoveredClaudeModels(createTestLogger(), {
      apiUrl: "http://127.0.0.1:1/unreachable",
      cacheFile,
    });

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-6",
      "claude-haiku-6",
      "claude-opus-5-6",
    ]);
  });

  it("falls back to a stale cache when the refresh fails", async () => {
    const stub = await stubModelsDev(500, {});
    const cacheFile = await tempCacheFile({
      fetchedAt: Date.now() - 48 * 60 * 60 * 1000,
      models: API_BODY.anthropic.models,
    });

    const models = await fetchDiscoveredClaudeModels(createTestLogger(), {
      apiUrl: stub.apiUrl,
      cacheFile,
    });

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-6",
      "claude-haiku-6",
      "claude-opus-5-6",
    ]);
    expect(stub.requestCount()).toBe(1);
  });

  it("refreshes a stale cache from the network", async () => {
    const stub = await stubModelsDev(200, API_BODY);
    const cacheFile = await tempCacheFile({
      fetchedAt: Date.now() - 48 * 60 * 60 * 1000,
      models: {},
    });

    const models = await fetchDiscoveredClaudeModels(createTestLogger(), {
      apiUrl: stub.apiUrl,
      cacheFile,
    });

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-6",
      "claude-haiku-6",
      "claude-opus-5-6",
    ]);
    expect(stub.requestCount()).toBe(1);
  });

  it("does no work when discovery is disabled", async () => {
    const cacheFile = await tempCacheFile();

    const models = await fetchDiscoveredClaudeModels(createTestLogger(), {
      env: { [CLAUDE_MODEL_DISCOVERY_ENV]: "off" },
      apiUrl: "http://127.0.0.1:1/unreachable",
      cacheFile,
    });

    expect(models).toEqual([]);
  });

  it("treats a corrupt cache as a cold start and refetches", async () => {
    const stub = await stubModelsDev(200, API_BODY);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-model-discovery-"));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const cacheFile = path.join(dir, "claude-models.json");
    await fs.writeFile(cacheFile, "{not json");

    const models = await fetchDiscoveredClaudeModels(createTestLogger(), {
      apiUrl: stub.apiUrl,
      cacheFile,
    });

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-6",
      "claude-haiku-6",
      "claude-opus-5-6",
    ]);
    expect(stub.requestCount()).toBe(1);
  });
});

describe("mergeDiscoveredClaudeModels", () => {
  it("keeps one row per id and fills in discovered capabilities", () => {
    const merged = mergeDiscoveredClaudeModels(
      [{ provider: "claude", id: "claude-opus-6", label: "From Claude settings.json model" }],
      [
        {
          provider: "claude",
          id: "claude-opus-6",
          label: "Opus 6",
          description: "Discovered from models.dev",
          contextWindowMaxTokens: 500_000,
          thinkingOptions: [{ id: "high", label: "High", isDefault: true }],
        },
        { provider: "claude", id: "claude-haiku-6", label: "Haiku 6" },
      ],
    );

    expect(merged.map((model) => model.id)).toEqual(["claude-opus-6", "claude-haiku-6"]);
    const enriched = merged[0];
    expect(enriched.label).toBe("From Claude settings.json model");
    expect(enriched.description).toBe("Discovered from models.dev");
    expect(enriched.contextWindowMaxTokens).toBe(500_000);
    expect(enriched.thinkingOptions?.[0]?.id).toBe("high");
  });
});
