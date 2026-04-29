import { describe, it, expect } from "vitest";
import { buildEmbeddingEnv, envSnapshotEquals } from "./embedding-env.js";
import { normalizeIndexingState, type IndexingState } from "./types.js";

function makeState(provider: IndexingState["embeddingProvider"], enabled = true): IndexingState {
  return normalizeIndexingState({
    enabled,
    embeddingProvider: provider,
  });
}

describe("buildEmbeddingEnv", () => {
  it("returns empty env when no workspace is eligible", () => {
    expect(buildEmbeddingEnv([])).toEqual({
      env: {},
      source: { workspaceId: null, providerKind: "unset" },
    });
  });

  it("skips disabled workspaces", () => {
    const snapshot = buildEmbeddingEnv([
      {
        workspaceId: "ws1",
        state: makeState(
          {
            kind: "openai-compat",
            config: { baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" },
          },
          false,
        ),
      },
    ]);
    expect(snapshot.source.providerKind).toBe("unset");
  });

  it("skips workspaces without a configured provider", () => {
    const snapshot = buildEmbeddingEnv([{ workspaceId: "ws1", state: makeState(undefined, true) }]);
    expect(snapshot.source.providerKind).toBe("unset");
  });

  it("sets CRG_OPENAI_* vars + accepts cloud egress", () => {
    const snapshot = buildEmbeddingEnv([
      {
        workspaceId: "ws1",
        state: makeState({
          kind: "openai-compat",
          config: {
            baseUrl: "http://localhost:11434/v1",
            model: "nomic-embed-text",
            apiKey: "dummy",
            dimension: 768,
          },
        }),
      },
    ]);
    expect(snapshot.env).toEqual({
      CRG_EMBEDDINGS_PROVIDER: "openai-compat",
      CRG_OPENAI_BASE_URL: "http://localhost:11434/v1",
      CRG_OPENAI_MODEL: "nomic-embed-text",
      CRG_OPENAI_API_KEY: "dummy",
      CRG_OPENAI_DIMENSION: "768",
      CRG_ACCEPT_CLOUD_EMBEDDINGS: "1",
    });
    expect(snapshot.source).toEqual({ workspaceId: "ws1", providerKind: "openai-compat" });
  });

  it("sets CRG_EMBEDDING_MODEL for sentence-transformers provider", () => {
    const snapshot = buildEmbeddingEnv([
      {
        workspaceId: "ws1",
        state: makeState({
          kind: "sentence-transformers",
          config: { model: "BAAI/bge-base-en-v1.5" },
        }),
      },
    ]);
    expect(snapshot.env).toEqual({
      CRG_EMBEDDINGS_PROVIDER: "local",
      CRG_EMBEDDING_MODEL: "BAAI/bge-base-en-v1.5",
    });
  });

  it("emits a CRG_HUBCODE_LOCAL marker for the hubcode-local provider", () => {
    const snapshot = buildEmbeddingEnv([
      {
        workspaceId: "ws1",
        state: makeState({ kind: "hubcode-local" }),
      },
    ]);
    expect(snapshot.env).toEqual({
      CRG_HUBCODE_LOCAL: "1",
      CRG_EMBEDDINGS_PROVIDER: "openai-compat",
      CRG_ACCEPT_CLOUD_EMBEDDINGS: "1",
    });
    expect(snapshot.source.providerKind).toBe("hubcode-local");
  });

  it("emits no env for provider=none", () => {
    const snapshot = buildEmbeddingEnv([
      { workspaceId: "ws1", state: makeState({ kind: "none" }) },
    ]);
    expect(snapshot.env).toEqual({});
    expect(snapshot.source.providerKind).toBe("none");
  });

  it("prefers the most recently updated eligible workspace", () => {
    const snapshot = buildEmbeddingEnv([
      {
        workspaceId: "ws-old",
        state: makeState({
          kind: "openai-compat",
          config: { baseUrl: "http://old/v1", model: "a" },
        }),
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        workspaceId: "ws-new",
        state: makeState({
          kind: "openai-compat",
          config: { baseUrl: "http://new/v1", model: "b" },
        }),
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
    expect(snapshot.source.workspaceId).toBe("ws-new");
    expect(snapshot.env.CRG_OPENAI_BASE_URL).toBe("http://new/v1");
  });
});

describe("envSnapshotEquals", () => {
  const a = {
    env: { CRG_OPENAI_BASE_URL: "http://a/v1" },
    source: { workspaceId: "ws1", providerKind: "openai-compat" as const },
  };
  it("returns true for identical snapshots", () => {
    const copy = {
      env: { CRG_OPENAI_BASE_URL: "http://a/v1" },
      source: { workspaceId: "ws1", providerKind: "openai-compat" as const },
    };
    expect(envSnapshotEquals(a, copy)).toBe(true);
  });
  it("returns false when env values differ", () => {
    const b = {
      env: { CRG_OPENAI_BASE_URL: "http://b/v1" },
      source: { workspaceId: "ws1", providerKind: "openai-compat" as const },
    };
    expect(envSnapshotEquals(a, b)).toBe(false);
  });
  it("returns false when provider kind differs", () => {
    const b = {
      env: {},
      source: { workspaceId: "ws1", providerKind: "sentence-transformers" as const },
    };
    expect(envSnapshotEquals(a, b)).toBe(false);
  });
  it("returns false when workspace source differs", () => {
    const b = {
      env: { CRG_OPENAI_BASE_URL: "http://a/v1" },
      source: { workspaceId: "ws2", providerKind: "openai-compat" as const },
    };
    expect(envSnapshotEquals(a, b)).toBe(false);
  });
});
