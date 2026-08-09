import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import {
  CLAUDE_DISABLED_THINKING_OPTION_ID,
  CLAUDE_ULTRACODE_THINKING_OPTION_ID,
  claudeManifestModelSupportsFastMode,
  enrichClaudeCatalogModel,
  normalizeClaudeManifestModelId,
  parseClaudeCodeVersion,
  resolveClaudeDisabledThinkingForModel,
} from "./model-manifest.js";
import {
  applyClaudeAutoCompactWindowEnv,
  applyClaudeCustomModelEnvPins,
  buildClaudeCustomModelEnvPins,
  CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY,
  CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS,
  findClaudeModel,
  getClaudeModels,
  isClaudeCustomNonFamilyModel,
  normalizeClaudeRuntimeModelId,
  resolveClaudeContextWindowMaxTokens,
  resolveObservedClaudeModelId,
} from "./models.js";

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

function createCatalogClient(claudeCodeVersion = "2.1.219"): ClaudeAgentClient {
  return new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveVersion: async () => claudeCodeVersion,
  });
}

describe("getClaudeModels", () => {
  it("returns all claude models", () => {
    const models = getClaudeModels();
    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-5",
      "claude-fable-5",
      "claude-fable-5[1m]",
      "claude-opus-4-8[1m]",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-sonnet-5[1m]",
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
    expect(defaults[0].id).toBe("claude-opus-5");
  });

  it("defines context window sizes in the catalog", () => {
    const contextWindows = new Map(
      getClaudeModels().map((model) => [model.id, model.contextWindowMaxTokens]),
    );

    expect(contextWindows).toEqual(
      new Map([
        ["claude-opus-5", 1_000_000],
        ["claude-fable-5", 1_000_000],
        ["claude-fable-5[1m]", 1_000_000],
        ["claude-opus-4-8[1m]", 1_000_000],
        ["claude-opus-4-8", 200_000],
        ["claude-sonnet-5", 200_000],
        ["claude-sonnet-5[1m]", 1_000_000],
        ["claude-opus-4-7[1m]", 1_000_000],
        ["claude-opus-4-7", 200_000],
        ["claude-opus-4-6[1m]", 1_000_000],
        ["claude-opus-4-6", 200_000],
        ["claude-sonnet-4-6[1m]", 1_000_000],
        ["claude-sonnet-4-6", 200_000],
        ["claude-haiku-4-5", 200_000],
      ]),
    );
  });

  it("filters models by their minimum Claude Code version", () => {
    const oldVersionModels = getClaudeModels("2.1.218");
    expect(oldVersionModels.map((model) => model.id)).not.toContain("claude-opus-5");
    expect(oldVersionModels.find((model) => model.isDefault)?.id).toBe("claude-opus-4-8");
    expect(getClaudeModels("2.1.219").map((model) => model.id)).toContain("claude-opus-5");

    expect(getClaudeModels("2.1.168").map((model) => model.id)).not.toContain("claude-fable-5");
    expect(getClaudeModels("2.1.169").map((model) => model.id)).toContain("claude-fable-5");
  });

  it("derives thinking options from model effort capabilities", () => {
    const models = new Map(getClaudeModels().map((model) => [model.id, model]));

    expect(models.get("claude-opus-5")?.thinkingOptions?.map((option) => option.id)).toEqual([
      CLAUDE_DISABLED_THINKING_OPTION_ID,
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      CLAUDE_ULTRACODE_THINKING_OPTION_ID,
    ]);
    expect(models.get("claude-sonnet-5")?.thinkingOptions?.map((option) => option.id)).toEqual([
      CLAUDE_DISABLED_THINKING_OPTION_ID,
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      CLAUDE_ULTRACODE_THINKING_OPTION_ID,
    ]);
    expect(
      models
        .get("claude-sonnet-5")
        ?.thinkingOptions?.find((option) => option.id === CLAUDE_ULTRACODE_THINKING_OPTION_ID)
        ?.label,
    ).toBe("Ultra Code");
    expect(models.get("claude-sonnet-5")?.defaultThinkingOptionId).toBe("high");
    expect(models.get("claude-sonnet-5[1m]")?.thinkingOptions).toEqual(
      models.get("claude-sonnet-5")?.thinkingOptions,
    );

    expect(models.get("claude-opus-4-7")?.thinkingOptions?.map((option) => option.id)).toEqual([
      CLAUDE_DISABLED_THINKING_OPTION_ID,
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      CLAUDE_ULTRACODE_THINKING_OPTION_ID,
    ]);
    expect(models.get("claude-sonnet-4-6")?.thinkingOptions?.map((option) => option.id)).toEqual([
      CLAUDE_DISABLED_THINKING_OPTION_ID,
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(models.get("claude-fable-5")?.thinkingOptions?.map((option) => option.id)).not.toContain(
      CLAUDE_DISABLED_THINKING_OPTION_ID,
    );
    expect(models.get("claude-haiku-4-5")?.thinkingOptions).toBeUndefined();
  });

  it.each([
    ["claude-opus-5", true, "high"],
    ["claude-opus-5-20260724", true, "high"],
    ["claude-sonnet-5", true, "high"],
    ["claude-sonnet-5[1m]", true, "high"],
    ["claude-sonnet-5-20260101", true, "high"],
    ["claude-fable-5", false, "high"],
    ["claude-haiku-4-5", false, undefined],
    ["openrouter/anthropic/claude-opus-4-8", false, undefined],
    [null, false, undefined],
  ])("resolves disabled thinking for model %s", (modelId, supported, fallbackThinkingOptionId) => {
    expect(resolveClaudeDisabledThinkingForModel(modelId)).toEqual({
      supported,
      fallbackThinkingOptionId,
    });
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
        ANTHROPIC_DEFAULT_FABLE_MODEL: "fable-from-settings",
      },
    });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const client = createCatalogClient();

    const { models } = await client.fetchCatalog({
      scope: "workspace",
      cwd: os.tmpdir(),
      force: true,
    });

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
      {
        provider: "claude",
        id: "fable-from-settings",
        label: "fable-from-settings",
        description: "From Claude settings.json env.ANTHROPIC_DEFAULT_FABLE_MODEL",
      },
    ]);
  });

  it("falls back to hardcoded models when settings.json is missing", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-models-"));
    createdClaudeConfigDirs.push(configDir);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const client = createCatalogClient();

    const { models } = await client.fetchCatalog({
      scope: "workspace",
      cwd: os.tmpdir(),
      force: true,
    });

    expect(models).toEqual(getClaudeModels());
  });

  it("falls back to hardcoded models when settings.json is malformed", async () => {
    const configDir = await createClaudeConfigDirWithRawSettings("{ nope");
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const client = createCatalogClient();

    const { models } = await client.fetchCatalog({
      scope: "workspace",
      cwd: os.tmpdir(),
      force: true,
    });

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
    const client = createCatalogClient();

    const { models } = await client.fetchCatalog({
      scope: "workspace",
      cwd: os.tmpdir(),
      force: true,
    });

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
    const client = createCatalogClient();

    const { models } = await client.fetchCatalog({
      scope: "workspace",
      cwd: os.tmpdir(),
      force: true,
    });

    expect(models.map((model) => model.id)).toEqual([
      ...getClaudeModels().map((model) => model.id),
      "glm-5.1",
    ]);
  });

  it("lets an exact settings model override the hidden Fable compatibility entry", async () => {
    const configDir = await createClaudeConfigDir({ model: "claude-fable-5[1m]" });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const client = createCatalogClient();

    const { models } = await client.fetchCatalog({
      scope: "workspace",
      cwd: os.tmpdir(),
      force: true,
    });

    const configured = models.filter((model) => model.id === "claude-fable-5[1m]");
    expect(configured).toHaveLength(1);
    expect(configured[0]).toMatchObject({
      id: "claude-fable-5[1m]",
      isSelectable: true,
      defaultThinkingOptionId: "high",
    });
  });

  it("omits models that require a newer Claude Code version", async () => {
    const client = createCatalogClient("2.1.218");

    const { models } = await client.fetchCatalog({
      scope: "workspace",
      cwd: os.tmpdir(),
      force: true,
    });

    expect(models.map((model) => model.id)).not.toContain("claude-opus-5[1m]");
    expect(models.map((model) => model.id)).not.toContain("claude-opus-5");
  });
});

describe("normalizeClaudeRuntimeModelId", () => {
  it("returns exact match for known model IDs", () => {
    expect(normalizeClaudeRuntimeModelId("claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeClaudeRuntimeModelId("claude-fable-5")).toBe("claude-fable-5");
    expect(normalizeClaudeRuntimeModelId("claude-fable-5[1m]")).toBe("claude-fable-5");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-5[1m]")).toBe("claude-sonnet-5[1m]");
    expect(normalizeClaudeRuntimeModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-opus-4-6[1m]")).toBe("claude-opus-4-6[1m]");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("normalizes dated model IDs to base model", () => {
    expect(normalizeClaudeRuntimeModelId("claude-opus-5-20260724")).toBe("claude-opus-5");
    expect(normalizeClaudeRuntimeModelId("claude-fable-5-20260301")).toBe("claude-fable-5");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-5-20260101")).toBe("claude-sonnet-5");
    expect(normalizeClaudeRuntimeModelId("claude-opus-4-6-20260101")).toBe("claude-opus-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-4-6-20260101")).toBe("claude-sonnet-4-6");
    expect(normalizeClaudeRuntimeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeClaudeRuntimeModelId("claude-fable-5-20260301[1m]")).toBe("claude-fable-5");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-5-20260101[1m]")).toBe(
      "claude-sonnet-5[1m]",
    );
  });

  it("preserves [1m] only when it identifies a distinct catalog entry", () => {
    expect(normalizeClaudeRuntimeModelId("claude-fable-5[1m]")).toBe("claude-fable-5");
    expect(normalizeClaudeRuntimeModelId("claude-sonnet-5[1m]")).toBe("claude-sonnet-5[1m]");
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

  it("normalizes provider-form runtime model strings", () => {
    expect(normalizeClaudeRuntimeModelId("openrouter/anthropic/claude-opus-4-8")).toBe(
      "claude-opus-4-8",
    );
    expect(normalizeClaudeRuntimeModelId("us.anthropic.claude-opus-4-8[1m]")).toBe(
      "claude-opus-4-8[1m]",
    );
    expect(normalizeClaudeRuntimeModelId("us.anthropic.claude-opus-4-8-20260101")).toBe(
      "claude-opus-4-8",
    );
  });
});

describe("parseClaudeCodeVersion", () => {
  it("prefers the Claude Code version over a wrapper banner", () => {
    expect(parseClaudeCodeVersion("wrapper 1.0.0\n2.1.219 (Claude Code)")).toEqual([2, 1, 219]);
  });
});

describe("findClaudeModel", () => {
  it("resolves runtime model IDs to catalog entries", () => {
    expect(findClaudeModel("claude-sonnet-5-20260101")?.id).toBe("claude-sonnet-5");
    expect(findClaudeModel("claude-sonnet-5[1m]")?.contextWindowMaxTokens).toBe(1_000_000);
    expect(findClaudeModel("us.anthropic.claude-opus-4-8[1m]")?.contextWindowMaxTokens).toBe(
      1_000_000,
    );
  });
});

describe("Claude Opus 5 catalog", () => {
  it("offers a single Opus 5 entry with a 1M context window", () => {
    const opus5Models = getClaudeModels()
      .filter((model) => model.id.startsWith("claude-opus-5"))
      .map(({ id, label, contextWindowMaxTokens }) => ({ id, label, contextWindowMaxTokens }));

    expect(opus5Models).toEqual([
      { id: "claude-opus-5", label: "Opus 5", contextWindowMaxTokens: 1_000_000 },
    ]);
  });

  it("resolves retired and dated Opus 5 IDs to the single catalog entry", () => {
    expect(findClaudeModel("claude-opus-5[1m]")?.id).toBe("claude-opus-5");
    expect(findClaudeModel("claude-opus-5-20260724")?.id).toBe("claude-opus-5");
    expect(findClaudeModel("claude-opus-5-20260724[1m]")?.id).toBe("claude-opus-5");
    expect(findClaudeModel("claude-opus-5[1m]")?.contextWindowMaxTokens).toBe(1_000_000);
  });

  it("keeps disabled thinking available for agents persisted on the retired 1M ID", () => {
    expect(resolveClaudeDisabledThinkingForModel("claude-opus-5[1m]")).toEqual({
      supported: true,
      fallbackThinkingOptionId: "high",
    });
  });
});

describe("Claude Fable 5 catalog", () => {
  it("offers one selectable Fable 5 entry and a compatibility entry for old apps", () => {
    const fable5Models = getClaudeModels()
      .filter((model) => model.id.startsWith("claude-fable-5"))
      .map(({ id, aliases, isSelectable, label, contextWindowMaxTokens }) => ({
        id,
        aliases,
        isSelectable,
        label,
        contextWindowMaxTokens,
      }));

    expect(fable5Models).toEqual([
      {
        id: "claude-fable-5",
        aliases: ["claude-fable-5[1m]"],
        isSelectable: undefined,
        label: "Fable 5",
        contextWindowMaxTokens: 1_000_000,
      },
      {
        id: "claude-fable-5[1m]",
        aliases: undefined,
        isSelectable: false,
        label: "Fable 5",
        contextWindowMaxTokens: 1_000_000,
      },
    ]);
  });

  it("resolves retired Fable 5 IDs to the canonical catalog entry", () => {
    expect(findClaudeModel("claude-fable-5[1m]")?.id).toBe("claude-fable-5");
    expect(findClaudeModel("claude-fable-5-20260301[1m]")?.id).toBe("claude-fable-5");
  });
});

describe("claudeManifestModelSupportsFastMode", () => {
  it("keeps fast mode strict to first-party manifest model IDs", () => {
    expect(normalizeClaudeManifestModelId("openrouter/anthropic/claude-opus-4-8")).toBeNull();
    expect(claudeManifestModelSupportsFastMode("openrouter/anthropic/claude-opus-4-8")).toBe(false);
    expect(claudeManifestModelSupportsFastMode("claude-opus-4-8-20260101")).toBe(true);
  });

  it("supports fast mode on Opus 5 but not on other Claude 5 models", () => {
    expect(claudeManifestModelSupportsFastMode("claude-opus-5")).toBe(true);
    expect(claudeManifestModelSupportsFastMode("claude-sonnet-5")).toBe(false);
    expect(claudeManifestModelSupportsFastMode("claude-fable-5")).toBe(false);
  });
});

describe("Claude custom model env pins", () => {
  it.each([
    [null, false],
    [undefined, false],
    ["", false],
    ["   ", false],
    ["opus", false],
    ["SONNET", false],
    ["haiku", false],
    ["fable", false],
    ["claude-opus-4-8", false],
    ["claude-fable-5", false],
    ["openrouter/anthropic/claude-opus-4-8", false],
    ["glm-5.1", true],
    ["qwen3.5-plus", true],
    ["openrouter/foo/bar", true],
  ] as const)("isClaudeCustomNonFamilyModel(%j) → %s", (modelId, expected) => {
    expect(isClaudeCustomNonFamilyModel(modelId)).toBe(expected);
  });

  it("buildClaudeCustomModelEnvPins maps all pin keys to the selected model", () => {
    expect(buildClaudeCustomModelEnvPins("glm-5.1")).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "glm-5.1",
      CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.1",
    });
    expect(Object.keys(buildClaudeCustomModelEnvPins("glm-5.1"))).toEqual([
      ...CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS,
    ]);
  });

  it("applyClaudeCustomModelEnvPins fills only missing keys for custom models", () => {
    const applied = applyClaudeCustomModelEnvPins(
      {
        PATH: "/usr/bin",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "user-opus-pin",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "",
      },
      "glm-5.1",
    );

    expect(applied.PATH).toBe("/usr/bin");
    expect(applied.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("user-opus-pin");
    expect(applied.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.1");
    expect(applied.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.1");
    expect(applied.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("glm-5.1");
    expect(applied.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.1");
  });

  it("applyClaudeCustomModelEnvPins is a no-op for first-party models", () => {
    const base = { PATH: "/usr/bin" };
    expect(applyClaudeCustomModelEnvPins(base, "claude-opus-4-8")).toEqual(base);
    expect(applyClaudeCustomModelEnvPins(base, "opus")).toEqual(base);
  });

  it("applyClaudeCustomModelEnvPins does not mutate the input env object", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const applied = applyClaudeCustomModelEnvPins(base, "glm-5.1");
    expect(applied).not.toBe(base);
    expect(base).toEqual({ PATH: "/usr/bin" });
    expect(applied.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.1");
  });
});

describe("Claude auto compact window env", () => {
  it("resolveClaudeContextWindowMaxTokens prefers profile models over first-party", () => {
    expect(
      resolveClaudeContextWindowMaxTokens({
        modelId: "glm-5.1",
        profileModels: [{ id: "glm-5.1", contextWindowMaxTokens: 500_000 }],
      }),
    ).toBe(500_000);

    const firstParty = findClaudeModel("claude-sonnet-4-6");
    expect(
      resolveClaudeContextWindowMaxTokens({
        modelId: "claude-sonnet-4-6",
        profileModels: [],
      }),
    ).toBe(firstParty?.contextWindowMaxTokens);
  });

  it("applyClaudeAutoCompactWindowEnv fills missing compact window", () => {
    const applied = applyClaudeAutoCompactWindowEnv({ PATH: "/usr/bin" }, 500_000);
    expect(applied[CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY]).toBe("500000");
    expect(applied.PATH).toBe("/usr/bin");
  });

  it("applyClaudeAutoCompactWindowEnv preserves user env", () => {
    const applied = applyClaudeAutoCompactWindowEnv(
      { [CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY]: "200000" },
      500_000,
    );
    expect(applied[CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY]).toBe("200000");
  });

  it("applyClaudeAutoCompactWindowEnv is a no-op without a positive window", () => {
    const base = { PATH: "/usr/bin" };
    expect(applyClaudeAutoCompactWindowEnv(base, undefined)).toEqual(base);
    expect(applyClaudeAutoCompactWindowEnv(base, 0)).toEqual(base);
  });
});

describe("resolveObservedClaudeModelId", () => {
  it("normalizes known models and falls back to raw custom ids", () => {
    expect(resolveObservedClaudeModelId("claude-opus-5-20260724")).toBe("claude-opus-5");
    expect(resolveObservedClaudeModelId("claude-fable-5[1m]")).toBe("claude-fable-5");
    expect(resolveObservedClaudeModelId("glm-5.1")).toBe("glm-5.1");
    expect(resolveObservedClaudeModelId("<synthetic>")).toBeNull();
    expect(resolveObservedClaudeModelId("")).toBeNull();
  });
});

describe("enrichClaudeCatalogModel", () => {
  it("leaves Haiku without thinking options when the catalog has none", () => {
    expect(
      enrichClaudeCatalogModel({
        provider: "claude",
        id: "claude-haiku-4-5",
        label: "Haiku 4.5",
      }).thinkingOptions,
    ).toBeUndefined();
  });

  it("attaches standard custom thinking options to gateway/custom models", () => {
    const model = enrichClaudeCatalogModel({
      provider: "claude",
      id: "grok-4.5",
      label: "grok-4.5",
    });
    expect(model.thinkingOptions?.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(model.defaultThinkingOptionId).toBe("high");
  });

  it("inherits curated options when a custom id normalizes to a first-party model", () => {
    const model = enrichClaudeCatalogModel({
      provider: "claude",
      id: "us.anthropic.claude-opus-4-8[1m]",
      label: "us.anthropic.claude-opus-4-8[1m]",
    });
    expect(model.thinkingOptions?.map((option) => option.id)).toEqual(
      getClaudeModels()
        .find((entry) => entry.id === "claude-opus-4-8[1m]")
        ?.thinkingOptions?.map((option) => option.id),
    );
  });

  it("preserves an explicit empty thinkingOptions array", () => {
    const model = enrichClaudeCatalogModel({
      provider: "claude",
      id: "claude-opus-5",
      label: "Disabled",
      thinkingOptions: [],
    });
    expect(model.thinkingOptions).toEqual([]);
  });
});
