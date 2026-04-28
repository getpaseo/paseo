import { describe, it, expect } from "vitest";
import {
  CRG_TOOL_PREFIX,
  authorizeToolCall,
  filterToolsForAgent,
  fromNamespacedToolName,
  namespaceCrgTools,
  toNamespacedToolName,
  type CrgToolManifest,
} from "./tool-filter.js";
import { normalizeIndexingState } from "./types.js";

const rawTools: CrgToolManifest[] = [
  { name: "blast_radius", description: "a" },
  { name: "minimal_context", description: "b" },
  { name: "semantic_search_nodes", description: "c" },
];

describe("toNamespacedToolName / fromNamespacedToolName", () => {
  it("adds and removes the prefix", () => {
    expect(toNamespacedToolName("blast_radius")).toBe("crg_blast_radius");
    expect(fromNamespacedToolName("crg_blast_radius")).toBe("blast_radius");
  });

  it("is idempotent on already-prefixed input", () => {
    expect(toNamespacedToolName("crg_blast_radius")).toBe("crg_blast_radius");
  });

  it("returns null for non-crg names", () => {
    expect(fromNamespacedToolName("foo_bar")).toBeNull();
  });

  it("uses the documented prefix", () => {
    expect(CRG_TOOL_PREFIX).toBe("crg_");
  });
});

describe("namespaceCrgTools", () => {
  it("prefixes every tool and preserves other fields", () => {
    const out = namespaceCrgTools(rawTools);
    expect(out.map((t) => t.name)).toEqual([
      "crg_blast_radius",
      "crg_minimal_context",
      "crg_semantic_search_nodes",
    ]);
    expect(out[0]?.description).toBe("a");
  });
});

describe("filterToolsForAgent", () => {
  const namespaced = namespaceCrgTools(rawTools);

  it("returns [] when indexing is disabled", () => {
    const state = normalizeIndexingState({ enabled: false });
    expect(filterToolsForAgent(namespaced, state, "claude-code")).toEqual([]);
  });

  it("returns all tools when exposeTo is empty (default-on)", () => {
    const state = normalizeIndexingState({ enabled: true });
    expect(filterToolsForAgent(namespaced, state, "claude-code")).toHaveLength(3);
  });

  it("returns all tools when agent entry enabled with no enabledTools list", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: { codex: { enabled: true } },
    });
    expect(filterToolsForAgent(namespaced, state, "codex")).toHaveLength(3);
  });

  it("returns [] when agent is explicitly disabled", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: { codex: { enabled: false } },
    });
    expect(filterToolsForAgent(namespaced, state, "codex")).toEqual([]);
  });

  it("filters by enabledTools (namespaced form)", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: {
        "claude-code": { enabled: true, enabledTools: ["crg_blast_radius"] },
      },
    });
    const out = filterToolsForAgent(namespaced, state, "claude-code");
    expect(out.map((t) => t.name)).toEqual(["crg_blast_radius"]);
  });

  it("filters by enabledTools (raw form — UI may store either)", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: {
        "claude-code": { enabled: true, enabledTools: ["minimal_context"] },
      },
    });
    const out = filterToolsForAgent(namespaced, state, "claude-code");
    expect(out.map((t) => t.name)).toEqual(["crg_minimal_context"]);
  });

  it("falls back to default-on for agents not mentioned in exposeTo", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: { codex: { enabled: false } },
    });
    expect(filterToolsForAgent(namespaced, state, "claude-code")).toHaveLength(3);
    expect(filterToolsForAgent(namespaced, state, "codex")).toEqual([]);
  });
});

describe("authorizeToolCall", () => {
  it("denies when indexing is disabled", () => {
    const state = normalizeIndexingState({ enabled: false });
    const result = authorizeToolCall(state, "claude-code", "crg_blast_radius");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/disabled/i);
  });

  it("denies when agent is explicitly disabled", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: { codex: { enabled: false } },
    });
    const result = authorizeToolCall(state, "codex", "crg_blast_radius");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("codex");
  });

  it("denies when tool not in enabledTools list", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: {
        "claude-code": { enabled: true, enabledTools: ["crg_blast_radius"] },
      },
    });
    const result = authorizeToolCall(state, "claude-code", "crg_semantic_search_nodes");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("crg_semantic_search_nodes");
  });

  it("allows when default-on", () => {
    const state = normalizeIndexingState({ enabled: true });
    expect(authorizeToolCall(state, "claude-code", "crg_anything")).toEqual({ ok: true });
  });

  it("accepts raw or namespaced form in enabledTools", () => {
    const state = normalizeIndexingState({
      enabled: true,
      exposeTo: {
        "claude-code": { enabled: true, enabledTools: ["blast_radius"] },
      },
    });
    expect(authorizeToolCall(state, "claude-code", "crg_blast_radius")).toEqual({ ok: true });
  });
});
