import { describe, expect, it } from "vitest";

import {
  CLAUDE_MODEL_ENV_MAPPINGS,
  getClaudeModels,
  normalizeClaudeRuntimeModelId,
} from "./claude-models.js";
import { applyModelEnvOverrides } from "../shared/model-env-override.js";

describe("getClaudeModels", () => {
  it("returns all claude models", () => {
    const models = getClaudeModels();
    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-4-7[1m]",
      "claude-opus-4-7",
      "claude-opus-4-6[1m]",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("marks exactly one model as default", () => {
    const models = getClaudeModels();
    const defaults = models.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe("claude-opus-4-6");
  });

  it("returns fresh copies each call", () => {
    const a = getClaudeModels();
    const b = getClaudeModels();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });
});

describe("normalizeClaudeRuntimeModelId", () => {
  it("returns exact match for known model IDs", () => {
    expect(normalizeClaudeRuntimeModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-opus-4-6[1m]")).toBe("claude-opus-4-6[1m]");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("normalizes dated model IDs to base model", () => {
    expect(normalizeClaudeRuntimeModelId("claude-opus-4-6-20260101")).toBe("claude-opus-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-4-6-20260101")).toBe("claude-sonnet-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("preserves [1m] suffix from runtime model strings", () => {
    expect(normalizeClaudeRuntimeModelId("claude-opus-4-6[1m]")).toBe("claude-opus-4-6[1m]");
  });

  it("returns null for empty/null/undefined", () => {
    expect(normalizeClaudeRuntimeModelId(null)).toBeNull();
    expect(normalizeClaudeRuntimeModelId(undefined)).toBeNull();
    expect(normalizeClaudeRuntimeModelId("")).toBeNull();
    expect(normalizeClaudeRuntimeModelId("  ")).toBeNull();
  });

  it("returns null for unrecognized strings", () => {
    expect(normalizeClaudeRuntimeModelId("gpt-5")).toBeNull();
    expect(normalizeClaudeRuntimeModelId("random")).toBeNull();
  });
});

describe("applyModelEnvOverrides", () => {
  it("returns unmodified list when env is empty", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(models, {}, CLAUDE_MODEL_ENV_MAPPINGS);
    expect(result.map((m) => m.id)).toEqual(models.map((m) => m.id));
  });

  it("returns unmodified list when no model env vars are set", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(models, { OTHER_VAR: "foo" }, CLAUDE_MODEL_ENV_MAPPINGS);
    expect(result).toHaveLength(models.length);
  });

  it("adds ANTHROPIC_MODEL alongside built-ins and marks it default", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_MODEL: "deepseek/deepseek-v4-pro[1m]",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    // Built-ins remain — ANTHROPIC_MODEL is a default override, not a collapse.
    expect(result).toHaveLength(models.length + 1);
    const custom = result.find((m) => m.id === "deepseek/deepseek-v4-pro[1m]");
    expect(custom?.isDefault).toBe(true);
    expect(result.filter((m) => m.isDefault)).toHaveLength(1);
  });

  it("adds ANTHROPIC_SMALL_FAST_MODEL without making it default", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_SMALL_FAST_MODEL: "deepseek/deepseek-v4-flash",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.map((m) => m.id)).toContain("deepseek/deepseek-v4-flash");
    const custom = result.find((m) => m.id === "deepseek/deepseek-v4-flash");
    expect(custom?.isDefault).toBeUndefined();
  });

  it("does not duplicate when env var value matches existing model ID", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-7",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.filter((m) => m.id === "claude-opus-4-7")).toHaveLength(1);
  });

  it("transfers isDefault when env family matches current default", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus-model",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    const custom = result.find((m) => m.id === "custom-opus-model");
    expect(custom?.isDefault).toBe(true);
  });

  it("does not transfer isDefault when env family differs from current default", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_DEFAULT_SONNET_MODEL: "custom-sonnet-model",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    const defaultModel = result.find((m) => m.isDefault);
    expect(defaultModel?.id).toBe("claude-opus-4-6");
  });

  it("globalDefault wins the default flag but does not suppress family replacement", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_MODEL: "force-default-model",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    // Default goes to ANTHROPIC_MODEL (globalDefault), AND opus family is still replaced.
    expect(result.find((m) => m.isDefault)?.id).toBe("force-default-model");
    expect(result.map((m) => m.id)).toContain("custom-opus");
    expect(result.find((m) => m.id === "claude-opus-4-7")).toBeUndefined();
    expect(result.map((m) => m.id)).toContain("force-default-model");
  });

  it("adds multiple custom models from different env vars", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "custom-sonnet",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "custom-haiku",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.map((m) => m.id)).toContain("custom-opus");
    expect(result.map((m) => m.id)).toContain("custom-sonnet");
    expect(result.map((m) => m.id)).toContain("custom-haiku");
  });

  it("replaces every family at once when all DEFAULT_*_MODEL env vars are set (no forceDefault)", () => {
    const models = getClaudeModels(); // default: claude-opus-4-6
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.7",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek/deepseek-v4-pro[1m]",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek/deepseek-v4-flash",
        ANTHROPIC_SMALL_FAST_MODEL: "deepseek/deepseek-v4-flash",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    // All built-ins gone, three replacements + small-fast (deduped against haiku replacement).
    expect(result.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4.7",
      "deepseek/deepseek-v4-pro[1m]",
      "deepseek/deepseek-v4-flash",
    ]);
    // Default transfers to the opus replacement (since the original default was opus).
    expect(result.find((m) => m.isDefault)?.id).toBe("anthropic/claude-opus-4.7");
  });

  it("gives Opus thinking options to custom opus model", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    const custom = result.find((m) => m.id === "custom-opus");
    expect(custom?.thinkingOptions?.map((o) => o.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("gives standard thinking options to custom sonnet model", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_DEFAULT_SONNET_MODEL: "custom-sonnet",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    const custom = result.find((m) => m.id === "custom-sonnet");
    expect(custom?.thinkingOptions?.map((o) => o.id)).toEqual(["low", "medium", "high", "max"]);
  });

  it("gives no thinking options to custom haiku model", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "custom-haiku",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    const custom = result.find((m) => m.id === "custom-haiku");
    expect(custom?.thinkingOptions).toBeUndefined();
  });

  it("ignores whitespace-only env values", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_MODEL: "   ",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.map((m) => m.id)).toEqual(models.map((m) => m.id));
    expect(result.find((m) => m.isDefault)?.id).toBe("claude-opus-4-6");
  });

  it("trims whitespace around env values when injecting models", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      { ANTHROPIC_DEFAULT_SONNET_MODEL: "  custom-sonnet  " },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.map((m) => m.id)).toContain("custom-sonnet");
  });

  it("does not match family when name is a substring inside another segment", () => {
    // "octopus-3" contains "opus" as a substring but is not the opus family.
    const models = [
      { provider: "claude" as const, id: "octopus-3-1", label: "octopus-3-1", isDefault: true },
    ];
    const result = applyModelEnvOverrides(
      models,
      { ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus" },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    // Default must remain on octopus, not transfer to custom-opus.
    expect(result.find((m) => m.isDefault)?.id).toBe("octopus-3-1");
    // The custom model is still injected (so users can pick it explicitly).
    expect(result.map((m) => m.id)).toContain("custom-opus");
  });

  it("matches family on segments preceding the [1m] suffix", () => {
    const models = [
      {
        provider: "claude" as const,
        id: "claude-opus-4-7[1m]",
        label: "Opus 4.7 1M",
        isDefault: true,
      },
    ];
    const result = applyModelEnvOverrides(
      models,
      { ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus" },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.find((m) => m.isDefault)?.id).toBe("custom-opus");
  });

  it("replaces all built-in family members when DEFAULT_*_MODEL is set", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      { ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus" },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    // All four built-in opus variants are gone.
    expect(result.find((m) => m.id === "claude-opus-4-7")).toBeUndefined();
    expect(result.find((m) => m.id === "claude-opus-4-7[1m]")).toBeUndefined();
    expect(result.find((m) => m.id === "claude-opus-4-6")).toBeUndefined();
    expect(result.find((m) => m.id === "claude-opus-4-6[1m]")).toBeUndefined();
    // Replacement is present, sonnet/haiku untouched.
    expect(result.map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "custom-opus",
    ]);
  });

  it("only replaces the specific family, others remain", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      { ANTHROPIC_DEFAULT_HAIKU_MODEL: "custom-haiku" },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.find((m) => m.id === "claude-haiku-4-5")).toBeUndefined();
    expect(result.find((m) => m.id === "custom-haiku")).toBeDefined();
    expect(result.find((m) => m.id === "claude-sonnet-4-6")).toBeDefined();
    expect(result.find((m) => m.id === "claude-opus-4-7")).toBeDefined();
  });

  it("ANTHROPIC_MODEL alone adds the override and marks it default without collapsing", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      { ANTHROPIC_MODEL: "deepseek/deepseek-v4-pro[1m]" },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result).toHaveLength(models.length + 1);
    const injected = result.find((m) => m.id === "deepseek/deepseek-v4-pro[1m]");
    expect(injected?.isDefault).toBe(true);
    // Built-ins remain.
    expect(result.find((m) => m.id === "claude-opus-4-6")).toBeDefined();
    expect(result.find((m) => m.id === "claude-sonnet-4-6")).toBeDefined();
    expect(result.find((m) => m.id === "claude-haiku-4-5")).toBeDefined();
  });

  it("ANTHROPIC_MODEL pointing at an existing built-in just transfers the default flag", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      { ANTHROPIC_MODEL: "claude-opus-4-7" },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    // Catalog length unchanged — env value matched an existing entry, so no injection.
    expect(result).toHaveLength(models.length);
    const target = result.find((m) => m.id === "claude-opus-4-7");
    expect(target?.label).toBe("Opus 4.7");
    expect(target?.thinkingOptions?.length).toBeGreaterThan(0);
    expect(target?.isDefault).toBe(true);
    // Default flag moved off the prior default.
    expect(result.filter((m) => m.isDefault)).toHaveLength(1);
  });

  it("user's full settings.json scenario yields a clean catalog (no duplicates)", () => {
    // Mirrors the user's reported config. Family replacements remove the four opus
    // built-ins, sonnet, and haiku; ANTHROPIC_MODEL (globalDefault) just sets the
    // default flag without collapsing the catalog.
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_MODEL: "deepseek/deepseek-v4-pro[1m]",
        ANTHROPIC_SMALL_FAST_MODEL: "deepseek/deepseek-v4-flash",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek/deepseek-v4-flash",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.7",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek/deepseek-v4-pro[1m]",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4.7",
      "deepseek/deepseek-v4-pro[1m]",
      "deepseek/deepseek-v4-flash",
    ]);
    // ANTHROPIC_MODEL (globalDefault) wins the default flag.
    expect(result.find((m) => m.isDefault)?.id).toBe("deepseek/deepseek-v4-pro[1m]");
  });

  it("transfers default to family replacement when previous default was in that family", () => {
    const models = getClaudeModels(); // default: claude-opus-4-6
    const result = applyModelEnvOverrides(
      models,
      { ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus" },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.find((m) => m.isDefault)?.id).toBe("custom-opus");
  });

  it("ANTHROPIC_SMALL_FAST_MODEL alone does not remove any built-ins", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      { ANTHROPIC_SMALL_FAST_MODEL: "deepseek/deepseek-v4-flash" },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result).toHaveLength(models.length + 1);
    expect(result.find((m) => m.id === "claude-haiku-4-5")).toBeDefined();
  });
});
