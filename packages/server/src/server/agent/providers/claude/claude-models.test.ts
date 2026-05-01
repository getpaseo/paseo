import { describe, expect, it } from "vitest";

import {
  CLAUDE_MODEL_ENV_MAPPINGS,
  getClaudeModels,
  normalizeClaudeRuntimeModelId,
} from "./claude-models.js";
import { applyModelEnvOverrides } from "./model-env-override.js";

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

  it("adds custom model when ANTHROPIC_MODEL is set", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_MODEL: "deepseek/deepseek-v4-pro[1m]",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
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

  it("forceDefault takes precedence over family matching", () => {
    const models = getClaudeModels();
    const result = applyModelEnvOverrides(
      models,
      {
        ANTHROPIC_MODEL: "force-default-model",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus",
      },
      CLAUDE_MODEL_ENV_MAPPINGS,
    );
    expect(result.find((m) => m.isDefault)?.id).toBe("force-default-model");
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
});
