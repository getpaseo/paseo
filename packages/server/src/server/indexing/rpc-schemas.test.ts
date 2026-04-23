import { describe, it, expect } from "vitest";
import {
  IndexingDetectRequestSchema,
  IndexingDetectResponseSchema,
  IndexingGetRequestSchema,
  IndexingGetResponseSchema,
  IndexingListRequestSchema,
  IndexingListResponseSchema,
  IndexingSetEmbeddingProviderRequestSchema,
  IndexingSetEnabledRequestSchema,
  IndexingSetExposeToRequestSchema,
  IndexingSetWatchlistRequestSchema,
  IndexingStateResponseSchema,
  IndexingStatusEventSchema,
} from "./rpc-schemas.js";

describe("IndexingListRequestSchema", () => {
  it("parses a valid request", () => {
    const parsed = IndexingListRequestSchema.parse({
      type: "indexing/list",
      requestId: "r1",
    });
    expect(parsed.type).toBe("indexing/list");
  });

  it("rejects wrong type literal", () => {
    expect(() =>
      IndexingListRequestSchema.parse({ type: "indexing/listz", requestId: "r1" }),
    ).toThrow();
  });
});

describe("IndexingGetRequestSchema", () => {
  it("requires workspaceId", () => {
    expect(() =>
      IndexingGetRequestSchema.parse({ type: "indexing/get", requestId: "r1" }),
    ).toThrow();
  });

  it("parses happy path", () => {
    expect(
      IndexingGetRequestSchema.parse({
        type: "indexing/get",
        requestId: "r1",
        workspaceId: "ws1",
      }),
    ).toMatchObject({ workspaceId: "ws1" });
  });
});

describe("IndexingSetEnabledRequestSchema", () => {
  it("requires a boolean enabled", () => {
    expect(() =>
      IndexingSetEnabledRequestSchema.parse({
        type: "indexing/set-enabled",
        requestId: "r1",
        workspaceId: "ws1",
        enabled: "yes",
      }),
    ).toThrow();
  });
});

describe("IndexingSetExposeToRequestSchema", () => {
  it("accepts null entry (removal)", () => {
    const parsed = IndexingSetExposeToRequestSchema.parse({
      type: "indexing/set-expose-to",
      requestId: "r1",
      workspaceId: "ws1",
      agentId: "claude-code",
      entry: null,
    });
    expect(parsed.entry).toBeNull();
  });

  it("accepts entry with enabledTools", () => {
    const parsed = IndexingSetExposeToRequestSchema.parse({
      type: "indexing/set-expose-to",
      requestId: "r1",
      workspaceId: "ws1",
      agentId: "codex",
      entry: { enabled: true, enabledTools: ["crg_blast_radius"] },
    });
    expect(parsed.entry?.enabledTools).toEqual(["crg_blast_radius"]);
  });
});

describe("IndexingSetEmbeddingProviderRequestSchema", () => {
  it("accepts null (clear)", () => {
    const parsed = IndexingSetEmbeddingProviderRequestSchema.parse({
      type: "indexing/set-embedding-provider",
      requestId: "r1",
      workspaceId: "ws1",
      provider: null,
    });
    expect(parsed.provider).toBeNull();
  });

  it("accepts openai-compat with config", () => {
    const parsed = IndexingSetEmbeddingProviderRequestSchema.parse({
      type: "indexing/set-embedding-provider",
      requestId: "r1",
      workspaceId: "ws1",
      provider: {
        kind: "openai-compat",
        config: { baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" },
      },
    });
    expect(parsed.provider?.kind).toBe("openai-compat");
  });
});

describe("IndexingSetWatchlistRequestSchema", () => {
  it("enforces watchlist as array of strings", () => {
    expect(() =>
      IndexingSetWatchlistRequestSchema.parse({
        type: "indexing/set-watchlist",
        requestId: "r1",
        workspaceId: "ws1",
        watchlist: [1, 2, 3],
      }),
    ).toThrow();
  });
});

describe("IndexingDetectRequestSchema", () => {
  it("treats force as optional", () => {
    const parsed = IndexingDetectRequestSchema.parse({
      type: "indexing/detect",
      requestId: "r1",
    });
    expect(parsed.force).toBeUndefined();
  });
});

describe("response schemas", () => {
  it("IndexingListResponseSchema parses happy path", () => {
    const parsed = IndexingListResponseSchema.parse({
      type: "indexing/list/response",
      payload: {
        requestId: "r1",
        error: null,
        entries: [{ workspaceId: "ws1" }],
      },
    });
    expect(parsed.payload.entries[0]?.workspaceId).toBe("ws1");
  });

  it("IndexingGetResponseSchema accepts null entry", () => {
    const parsed = IndexingGetResponseSchema.parse({
      type: "indexing/get/response",
      payload: { requestId: "r1", error: null, entry: null },
    });
    expect(parsed.payload.entry).toBeNull();
  });

  it("IndexingStateResponseSchema requires workspaceId", () => {
    expect(() =>
      IndexingStateResponseSchema.parse({
        type: "indexing/state/response",
        payload: { requestId: "r1", error: null, indexing: null },
      }),
    ).toThrow();
  });

  it("IndexingDetectResponseSchema handles both success and error", () => {
    const ok = IndexingDetectResponseSchema.parse({
      type: "indexing/detect/response",
      payload: {
        requestId: "r1",
        error: null,
        detection: {
          codeReviewGraph: { name: "code-review-graph", installed: true },
          pipx: { name: "pipx", installed: true },
          python3: { name: "python3", installed: true, meetsMinimumVersion: true },
          canInstall: true,
          suggestedInstall: null,
        },
      },
    });
    expect(ok.payload.detection?.canInstall).toBe(true);

    const err = IndexingDetectResponseSchema.parse({
      type: "indexing/detect/response",
      payload: { requestId: "r1", error: "pipx unavailable", detection: null },
    });
    expect(err.payload.error).toBe("pipx unavailable");
  });
});

describe("IndexingStatusEventSchema", () => {
  it("parses a progress event", () => {
    const parsed = IndexingStatusEventSchema.parse({
      type: "indexing/status",
      payload: {
        workspaceId: "ws1",
        status: { phase: "indexing", progress: 42, fileCount: 10, nodeCount: 200 },
      },
    });
    expect(parsed.payload.status.phase).toBe("indexing");
    expect(parsed.payload.status.progress).toBe(42);
  });

  it("rejects an event with an invalid phase", () => {
    expect(() =>
      IndexingStatusEventSchema.parse({
        type: "indexing/status",
        payload: { workspaceId: "ws1", status: { phase: "bogus" } },
      }),
    ).toThrow();
  });
});
