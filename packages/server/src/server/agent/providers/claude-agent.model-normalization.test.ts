import { describe, expect, test } from "vitest";
import { normalizeClaudeRuntimeModelId } from "./claude-agent.js";
import { CLAUDE_MODEL_CATALOG } from "./claude/model-catalog.js";

describe("normalizeClaudeRuntimeModelId", () => {
  function latestModelId(family: "sonnet" | "opus" | "haiku"): string {
    const latest = CLAUDE_MODEL_CATALOG.find(
      (model) => model.family === family && model.isLatestInFamily
    );
    if (latest) {
      return latest.modelId;
    }
    const fallback = CLAUDE_MODEL_CATALOG.find((model) => model.family === family);
    if (!fallback) {
      throw new Error(`Missing Claude model family in catalog: ${family}`);
    }
    return fallback.modelId;
  }

  const SONNET = latestModelId("sonnet");
  const OPUS = latestModelId("opus");
  const HAIKU = latestModelId("haiku");
  const supportedModelIds = new Set([SONNET, OPUS, HAIKU]);
  const supportedModelFamilyAliases = new Map([
    ["sonnet", SONNET],
    ["opus", OPUS],
    ["haiku", HAIKU],
  ] as const);

  test("preserves runtime model when it already exists in the supported catalog", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: SONNET,
      supportedModelIds,
    });
    expect(normalized).toBe(SONNET);
  });

  test("maps unknown runtime Sonnet versions to the catalog Sonnet model ID", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-sonnet-4-6-20260101",
      supportedModelIds,
      supportedModelFamilyAliases,
    });
    expect(normalized).toBe(SONNET);
  });

  test("maps unknown runtime Opus versions to the catalog Opus model ID", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-opus-4-5-20251101",
      supportedModelIds,
      supportedModelFamilyAliases,
    });
    expect(normalized).toBe(OPUS);
  });

  test("maps unknown runtime Haiku versions to the catalog Haiku model ID", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-haiku-4-6-20260101",
      supportedModelIds,
      supportedModelFamilyAliases,
    });
    expect(normalized).toBe(HAIKU);
  });

  test("uses configured model when runtime ID is unknown", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-custom-unknown",
      supportedModelIds,
      configuredModelId: OPUS,
    });
    expect(normalized).toBe(OPUS);
  });

  test("uses current model when runtime and configured IDs are unknown", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-custom-unknown",
      supportedModelIds,
      configuredModelId: "claude-unknown",
      currentModelId: HAIKU,
    });
    expect(normalized).toBe(HAIKU);
  });

  test("preserves runtime model when mapping is not possible", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-custom-unknown",
      supportedModelIds: new Set(["x", "y"]),
    });
    expect(normalized).toBe("claude-custom-unknown");
  });

  test("does not force family fallback for unknown runtime families", () => {
    const normalized = normalizeClaudeRuntimeModelId({
      runtimeModelId: "claude-custom-unknown",
      supportedModelIds,
    });
    expect(normalized).toBe("claude-custom-unknown");
  });
});
