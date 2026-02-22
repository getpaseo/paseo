import { describe, expect, test } from "vitest";
import { normalizeClaudeRuntimeModelId } from "./claude-agent.js";

describe("normalizeClaudeRuntimeModelId", () => {
  const supportedModelIds = new Set(["default", "opus", "haiku"]);
  const fallbackCatalogIds = new Set(["default", "sonnet", "haiku"]);

  test("maps runtime Sonnet IDs to default alias", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-sonnet-4-5-20250929",
      supportedModelIds,
    });
    expect(normalized).toBe("default");
  });

  test("prefers alias even when runtime versioned Sonnet ID appears in supported list", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-sonnet-4-5-20250929",
      supportedModelIds: new Set([
        "default",
        "opus",
        "haiku",
        "claude-sonnet-4-5-20250929",
      ]),
    });
    expect(normalized).toBe("default");
  });

  test("maps runtime Opus IDs to opus alias", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-opus-4-5-20251101",
      supportedModelIds,
    });
    expect(normalized).toBe("opus");
  });

  test("maps runtime Opus IDs to catalog-derived family alias when explicit alias is absent", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-opus-4-6",
      supportedModelIds: fallbackCatalogIds,
      supportedModelFamilyAliases: new Map([
        ["sonnet", "sonnet"],
        ["opus", "default"],
        ["haiku", "haiku"],
      ]),
    });
    expect(normalized).toBe("default");
  });

  test("falls back to default for known runtime families when no explicit alias exists", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-opus-4-6",
      supportedModelIds: fallbackCatalogIds,
    });
    expect(normalized).toBe("default");
  });

  test("maps runtime Haiku IDs to haiku alias", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-haiku-4-5-20251001",
      supportedModelIds,
    });
    expect(normalized).toBe("haiku");
  });

  test("uses configured model when runtime ID is unknown", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-custom-unknown",
      supportedModelIds,
      configuredModelId: "opus",
    });
    expect(normalized).toBe("opus");
  });

  test("preserves runtime model when mapping is not possible", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-custom-unknown",
      supportedModelIds: new Set(["x", "y"]),
    });
    expect(normalized).toBe("claude-custom-unknown");
  });

  test("does not force default fallback for unknown runtime families", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-custom-unknown",
      supportedModelIds: fallbackCatalogIds,
    });
    expect(normalized).toBe("claude-custom-unknown");
  });
});
