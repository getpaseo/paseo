import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { getClaudeModels, normalizeClaudeRuntimeModelId } from "./models.js";

const createdClaudeConfigDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    createdClaudeConfigDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  createdClaudeConfigDirs.length = 0;
});

async function createClaudeConfigDir(settings: unknown): Promise<string> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-models-"));
  createdClaudeConfigDirs.push(configDir);
  await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify(settings, null, 2));
  return configDir;
}

async function createClaudeConfigDirWithRawSettings(settings: string): Promise<string> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-models-"));
  createdClaudeConfigDirs.push(configDir);
  await fs.writeFile(path.join(configDir, "settings.json"), settings);
  return configDir;
}

describe("getClaudeModels", () => {
  it("returns all claude models", () => {
    const models = getClaudeModels();
    expect(models.map((m) => m.id)).toEqual([
      "claude-fable-5",
      "claude-opus-4-8[1m]",
      "claude-opus-4-8",
      "claude-opus-4-7[1m]",
      "claude-opus-4-7",
      "claude-opus-4-6[1m]",
      "claude-opus-4-6",
      "claude-sonnet-4-6[1m]",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("marks exactly one model as default", () => {
    const models = getClaudeModels();
    const defaults = models.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe("claude-opus-4-8");
  });

  it("returns fresh copies each call", () => {
    const a = getClaudeModels();
    const b = getClaudeModels();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });
});

describe("ClaudeAgentClient.fetchCatalog", () => {
  it("appends concrete models from Claude settings.json", async () => {
    const configDir = await createClaudeConfigDir({
      model: "us.anthropic.claude-opus-4-7[1m]",
      env: {
        ANTHROPIC_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
        ANTHROPIC_SMALL_FAST_MODEL: "ollama/qwen3-coder",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "bedrock-opus-from-env",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5",
      },
    });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const client = new ClaudeAgentClient({ logger: createTestLogger() });

    const { models } = await client.fetchCatalog({ cwd: os.tmpdir(), force: true });

    expect(models).toEqual([
      ...getClaudeModels(),
      {
        provider: "claude",
        id: "us.anthropic.claude-opus-4-7[1m]",
        label: "us.anthropic.claude-opus-4-7[1m]",
        description: "From Claude settings.json model",
      },
      {
        provider: "claude",
        id: "openrouter/anthropic/claude-sonnet-4.5",
        label: "openrouter/anthropic/claude-sonnet-4.5",
        description: "From Claude settings.json env.ANTHROPIC_MODEL",
      },
      {
        provider: "claude",
        id: "ollama/qwen3-coder",
        label: "ollama/qwen3-coder",
        description: "From Claude settings.json env.ANTHROPIC_SMALL_FAST_MODEL",
      },
      {
        provider: "claude",
        id: "bedrock-opus-from-env",
        label: "bedrock-opus-from-env",
        description: "From Claude settings.json env.ANTHROPIC_DEFAULT_OPUS_MODEL",
      },
      {
        provider: "claude",
        id: "glm-5.1",
        label: "glm-5.1",
        description: "From Claude settings.json env.ANTHROPIC_DEFAULT_SONNET_MODEL",
      },
      {
        provider: "claude",
        id: "glm-5",
        label: "glm-5",
        description: "From Claude settings.json env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
      },
    ]);
  });

  it("falls back to hardcoded models when settings.json is missing", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-models-"));
    createdClaudeConfigDirs.push(configDir);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const client = new ClaudeAgentClient({ logger: createTestLogger() });

    const { models } = await client.fetchCatalog({ cwd: os.tmpdir(), force: true });

    expect(models).toEqual(getClaudeModels());
  });

  it("falls back to hardcoded models when settings.json is malformed", async () => {
    const configDir = await createClaudeConfigDirWithRawSettings("{ nope");
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const client = new ClaudeAgentClient({ logger: createTestLogger() });

    const { models } = await client.fetchCatalog({ cwd: os.tmpdir(), force: true });

    expect(models).toEqual(getClaudeModels());
  });

  it("ignores empty env blocks and unexpected settings shapes", async () => {
    const configDir = await createClaudeConfigDir({
      model: " ",
      env: {
        ANTHROPIC_MODEL: "",
        ANTHROPIC_DEFAULT_OPUS_MODEL: 42,
      },
    });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const client = new ClaudeAgentClient({ logger: createTestLogger() });

    const { models } = await client.fetchCatalog({ cwd: os.tmpdir(), force: true });

    expect(models).toEqual(getClaudeModels());
  });

  it("deduplicates discovered settings models by ID", async () => {
    const configDir = await createClaudeConfigDir({
      model: "glm-5.1",
      env: {
        ANTHROPIC_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-opus-4-6",
      },
    });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const client = new ClaudeAgentClient({ logger: createTestLogger() });

    const { models } = await client.fetchCatalog({ cwd: os.tmpdir(), force: true });

    expect(models.map((model) => model.id)).toEqual([
      ...getClaudeModels().map((model) => model.id),
      "glm-5.1",
    ]);
  });
});

describe("normalizeClaudeRuntimeModelId", () => {
  it("returns exact match for known model IDs", () => {
    expect(normalizeClaudeRuntimeModelId("claude-fable-5")).toBe("claude-fable-5");
    expect(normalizeClaudeRuntimeModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-opus-4-6[1m]")).toBe("claude-opus-4-6[1m]");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("normalizes dated model IDs to base model", () => {
    expect(normalizeClaudeRuntimeModelId("claude-fable-5-20260301")).toBe("claude-fable-5");
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
