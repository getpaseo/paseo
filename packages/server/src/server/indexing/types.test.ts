import { describe, it, expect } from "vitest";
import {
  IndexingStateSchema,
  defaultIndexingState,
  isToolEnabledForAgent,
  normalizeIndexingState,
} from "./types.js";

describe("IndexingStateSchema", () => {
  it("parses a fully-populated payload", () => {
    const parsed = IndexingStateSchema.parse({
      enabled: true,
      watchlist: ["node_modules", "dist"],
      exposeTo: {
        "claude-code": { enabled: true, enabledTools: ["crg_blast_radius"] },
        codex: { enabled: false },
      },
      status: { phase: "ready", nodeCount: 12 },
    });
    expect(parsed.watchlist).toEqual(["node_modules", "dist"]);
    expect(parsed.exposeTo["claude-code"]).toEqual({
      enabled: true,
      enabledTools: ["crg_blast_radius"],
    });
    expect(parsed.exposeTo.codex).toEqual({ enabled: false });
  });

  it("rejects payloads missing required fields (no implicit defaults)", () => {
    expect(() => IndexingStateSchema.parse({ enabled: false })).toThrow();
  });

  it("rejects negative numeric counters in status", () => {
    expect(() =>
      IndexingStateSchema.parse({
        enabled: true,
        watchlist: [],
        exposeTo: {},
        status: { phase: "ready", nodeCount: -1 },
      }),
    ).toThrow();
  });

  it("rejects out-of-range progress", () => {
    expect(() =>
      IndexingStateSchema.parse({
        enabled: true,
        watchlist: [],
        exposeTo: {},
        status: { phase: "indexing", progress: 150 },
      }),
    ).toThrow();
  });

  it("accepts the four embedding provider kinds", () => {
    for (const kind of [
      "none",
      "hubcode-local",
      "openai-compat",
      "sentence-transformers",
    ] as const) {
      const parsed = IndexingStateSchema.parse({
        enabled: true,
        watchlist: [],
        exposeTo: {},
        status: { phase: "idle" },
        embeddingProvider: { kind },
      });
      expect(parsed.embeddingProvider?.kind).toBe(kind);
    }
  });

  it("rejects unknown embedding provider kind", () => {
    expect(() =>
      IndexingStateSchema.parse({
        enabled: true,
        watchlist: [],
        exposeTo: {},
        status: { phase: "idle" },
        embeddingProvider: { kind: "anthropic-embed" },
      }),
    ).toThrow();
  });
});

describe("normalizeIndexingState", () => {
  it("returns a fresh default state for null/undefined/non-object", () => {
    expect(normalizeIndexingState(null)).toEqual(defaultIndexingState());
    expect(normalizeIndexingState(undefined)).toEqual(defaultIndexingState());
    expect(normalizeIndexingState("garbage")).toEqual(defaultIndexingState());
  });

  it("fills missing fields with defaults but preserves provided ones", () => {
    const result = normalizeIndexingState({ enabled: true });
    expect(result.enabled).toBe(true);
    expect(result.watchlist).toEqual([]);
    expect(result.exposeTo).toEqual({});
    expect(result.status).toEqual({ phase: "idle" });
  });

  it("validates the merged result and throws on invalid input", () => {
    expect(() =>
      normalizeIndexingState({
        enabled: true,
        status: { phase: "bogus" },
      }),
    ).toThrow();
  });
});

describe("defaultIndexingState", () => {
  it("returns an enabled state with hubcode-local provider as default", () => {
    expect(defaultIndexingState()).toEqual({
      enabled: true,
      embeddingProvider: { kind: "hubcode-local" },
      watchlist: [],
      exposeTo: {},
      status: { phase: "idle" },
    });
  });

  it("returns a fresh object each call (no shared references)", () => {
    const a = defaultIndexingState();
    const b = defaultIndexingState();
    a.watchlist.push("foo");
    expect(b.watchlist).toEqual([]);
  });
});

describe("isToolEnabledForAgent", () => {
  const baseState = normalizeIndexingState({ enabled: true });

  it("returns false when indexing is disabled regardless of exposeTo", () => {
    const state = normalizeIndexingState({
      enabled: false,
      exposeTo: { "claude-code": { enabled: true } },
    });
    expect(isToolEnabledForAgent(state, "claude-code", "crg_blast_radius")).toBe(false);
  });

  it("returns true for any tool/agent when exposeTo is empty (default-on)", () => {
    expect(isToolEnabledForAgent(baseState, "claude-code", "crg_blast_radius")).toBe(true);
    expect(isToolEnabledForAgent(baseState, "codex", "crg_minimal_context")).toBe(true);
  });

  it("returns true when agent entry has enabled=true and no enabledTools list", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: { codex: { enabled: true } },
    });
    expect(isToolEnabledForAgent(state, "codex", "crg_anything")).toBe(true);
  });

  it("returns false when agent entry has enabled=false", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: { codex: { enabled: false } },
    });
    expect(isToolEnabledForAgent(state, "codex", "crg_blast_radius")).toBe(false);
  });

  it("filters individual tools when enabledTools is set", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: {
        "claude-code": { enabled: true, enabledTools: ["crg_blast_radius", "crg_minimal_context"] },
      },
    });
    expect(isToolEnabledForAgent(state, "claude-code", "crg_blast_radius")).toBe(true);
    expect(isToolEnabledForAgent(state, "claude-code", "crg_impact_analysis")).toBe(false);
  });

  it("treats unrelated agents as default-on when only one agent is configured", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: { codex: { enabled: false } },
    });
    expect(isToolEnabledForAgent(state, "claude-code", "crg_blast_radius")).toBe(true);
  });
});
