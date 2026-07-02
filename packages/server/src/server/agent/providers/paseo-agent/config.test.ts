import { describe, expect, it } from "vitest";
import { getModels } from "@earendil-works/pi-ai";

import {
  PaseoAgentConfigSchema,
  encodePaseoAgentModelId,
  listPaseoAgentModels,
  paseoAgentHasUsableModel,
  paseoAgentModelProviders,
  parsePaseoAgentModelId,
  resolvePaseoAgentCatalogAuth,
  resolvePaseoAgentModel,
  type PaseoAgentConfig,
} from "./config.js";
import { PASEO_AGENT_PROVIDER_CATALOG } from "./catalog.js";

const CATALOG_AUTH_ENV_VARS = [
  ...new Set([
    "OPENROUTER_API_KEY",
    "KIMI_API_KEY",
    "OPENCODE_API_KEY",
    ...PASEO_AGENT_PROVIDER_CATALOG.flatMap((entry) =>
      entry.auth?.kind === "api_key" ? [entry.auth.envVar] : [],
    ),
  ]),
];

function piModelIds(provider: Parameters<typeof getModels>[0]): string[] {
  return getModels(provider).map((model) => model.id);
}

function deleteEnvVars(names: readonly string[]): Map<string, string | undefined> {
  const previousValues = new Map<string, string | undefined>();
  for (const name of names) {
    previousValues.set(name, process.env[name]);
    delete process.env[name];
  }

  return previousValues;
}

function restoreEnvVars(previousValues: ReadonlyMap<string, string | undefined>): void {
  for (const [name, value] of previousValues) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function resolveCatalogAuthEntries(): Array<
  [string, ReturnType<typeof resolvePaseoAgentCatalogAuth>]
> {
  return PASEO_AGENT_PROVIDER_CATALOG.map((entry) => [
    entry.id,
    resolvePaseoAgentCatalogAuth(entry),
  ]);
}

function configWith(overrides?: Partial<PaseoAgentConfig>): PaseoAgentConfig {
  return PaseoAgentConfigSchema.parse({
    providers: {
      "openrouter-main": {
        type: "openrouter",
        options: {
          apiKey: "sk-test",
          models: [
            { id: "anthropic/claude", label: "Claude", reasoning: true },
            { id: "openai/gpt", reasoning: false },
          ],
        },
      },
    },
    ...overrides,
  });
}

describe("PaseoAgentConfigSchema", () => {
  it("rejects unknown keys (strict)", () => {
    expect(() => PaseoAgentConfigSchema.parse({ providers: {}, unexpected: true })).toThrow();
  });

  it("accepts unknown model provider types structurally", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        future: { type: "future-provider", options: { models: [{ id: "m" }] } },
      },
    });
    expect(config.providers?.future?.type).toBe("future-provider");
  });

  it("rejects an empty instance model override", () => {
    expect(() =>
      PaseoAgentConfigSchema.parse({
        providers: { p: { type: "openrouter", options: { models: [] } } },
      }),
    ).toThrow();
  });

  it("accepts a provider entry without options when the catalog supplies defaults", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: { chatgpt: { type: "chatgpt" } },
    });
    expect(config.providers?.chatgpt?.options).toEqual({});
  });

  it("accepts multiple entries of the same type with distinct names", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        "openrouter-a": {
          type: "openrouter",
          options: { apiKey: "sk-a", models: [{ id: "model-a" }] },
        },
        "openrouter-b": {
          type: "openrouter",
          options: {
            baseUrl: "https://proxy.test/v1",
            apiKey: "sk-b",
            models: [{ id: "model-b" }],
          },
        },
      },
    });
    expect(Object.keys(config.providers ?? {})).toEqual(["openrouter-a", "openrouter-b"]);
  });
});

describe("model id encoding", () => {
  it("round-trips provider + model id", () => {
    const id = encodePaseoAgentModelId("openrouter-main", "anthropic/claude");
    expect(parsePaseoAgentModelId(id)).toEqual({
      provider: "openrouter-main",
      id: "anthropic/claude",
    });
  });

  it("returns null for an unprefixed id", () => {
    expect(parsePaseoAgentModelId("noslash")).toBeNull();
  });
});

describe("resolvePaseoAgentCatalogAuth", () => {
  it("resolves every catalog entry without provider key env vars", () => {
    const previousValues = deleteEnvVars(CATALOG_AUTH_ENV_VARS);
    try {
      expect(resolveCatalogAuthEntries()).toEqual([
        ["openrouter", { kind: "api_key", envVar: "OPENROUTER_API_KEY" }],
        ["chatgpt", { kind: "oauth", flow: "openai-codex" }],
        ["kimi", { kind: "api_key", envVar: "KIMI_API_KEY" }],
        ["opencode-go", { kind: "api_key", envVar: "OPENCODE_API_KEY" }],
      ]);
    } finally {
      restoreEnvVars(previousValues);
    }
  });

  it("assigns icon names to every Paseo Agent catalog entry", () => {
    const iconNames = new Map(
      PASEO_AGENT_PROVIDER_CATALOG.map((entry) => [entry.id, entry.iconName]),
    );

    expect(iconNames).toEqual(
      new Map([
        ["openrouter", "openrouter"],
        ["chatgpt", "openai"],
        ["kimi", "kimi"],
        ["opencode-go", "opencode"],
      ]),
    );
  });
});

describe("listPaseoAgentModels", () => {
  it("exposes every configured model with provider-prefixed ids", () => {
    const models = listPaseoAgentModels(configWith());
    expect(models.map((m) => m.id)).toEqual([
      "openrouter-main/anthropic/claude",
      "openrouter-main/openai/gpt",
    ]);
    expect(models.every((m) => m.provider === "paseo")).toBe(true);
  });

  it("uses catalog model defaults when an instance does not override them", () => {
    const models = listPaseoAgentModels(
      PaseoAgentConfigSchema.parse({ providers: { chatgpt: { type: "chatgpt" } } }),
    );
    expect(models.map((m) => m.id)).toEqual(
      piModelIds("openai-codex").map((modelId) => `chatgpt/${modelId}`),
    );
  });

  it("marks the configured default model", () => {
    const models = listPaseoAgentModels(configWith({ defaultModel: "openrouter-main/openai/gpt" }));
    const defaults = models.filter((m) => m.isDefault).map((m) => m.id);
    expect(defaults).toEqual(["openrouter-main/openai/gpt"]);
  });
});

describe("paseoAgentModelProviders", () => {
  it("applies OpenRouter catalog defaults", async () => {
    const [provider] = await paseoAgentModelProviders(configWith());
    expect(provider.name).toBe("openrouter-main");
    expect(provider.config.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(provider.config.apiKey).toBe("sk-test");
    expect(provider.config.models?.[0]).toMatchObject({
      id: "anthropic/claude",
      name: "Claude",
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
  });

  it("falls back to the catalog env var when no apiKey is given", async () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        openrouter: { type: "openrouter", options: { models: [{ id: "m" }] } },
      },
    });
    const [provider] = await paseoAgentModelProviders(config);
    expect(provider.config.apiKey).toBe("$OPENROUTER_API_KEY");
  });

  it("applies the Kimi catalog API and default header", async () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        kimi: { type: "kimi", options: { models: [{ id: "kimi-k2" }] } },
      },
    });
    const [provider] = await paseoAgentModelProviders(config);
    expect(provider.config.baseUrl).toBe("https://api.kimi.com/coding");
    expect(provider.config.apiKey).toBe("$KIMI_API_KEY");
    expect(provider.config.api).toBe("anthropic-messages");
    expect(provider.config.models?.[0]?.headers).toEqual({ "User-Agent": "KimiCLI/1.5" });
    expect(provider.config.models?.[0]?.api).toBe("anthropic-messages");
  });

  it("applies the OpenCode Go catalog base URL", async () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        go: { type: "opencode-go", options: { models: [{ id: "glm-5" }] } },
      },
    });
    const [provider] = await paseoAgentModelProviders(config);
    expect(provider.config.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(provider.config.apiKey).toBe("$OPENCODE_API_KEY");
    expect(provider.config.api).toBe("openai-completions");
  });

  it("maps OAuth catalog entries to flow-based providers without an api key", async () => {
    const [provider] = await paseoAgentModelProviders(
      PaseoAgentConfigSchema.parse({ providers: { chatgpt: { type: "chatgpt" } } }),
      {},
    );
    expect(provider.name).toBe("chatgpt");
    expect(provider.oauth).toEqual({ flow: "openai-codex" });
    expect(provider.config.apiKey).toBeUndefined();
    expect(provider.config.api).toBe("openai-codex-responses");
    expect(provider.config.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(provider.config.models?.map((model) => model.id)).toEqual(piModelIds("openai-codex"));
  });

  it("lets instance models override catalog default models", async () => {
    const [provider] = await paseoAgentModelProviders(
      PaseoAgentConfigSchema.parse({
        providers: {
          chatgpt: {
            type: "chatgpt",
            options: { models: [{ id: "gpt-other", reasoning: false }] },
          },
        },
      }),
    );
    expect(provider.config.models?.map((model) => model.id)).toEqual(["gpt-other"]);
  });

  it("maps the legacy type alias to the catalog entry", async () => {
    const [provider] = await paseoAgentModelProviders(
      PaseoAgentConfigSchema.parse({
        providers: {
          chatgpt: { type: "openai-codex" },
        },
      }),
    );
    expect(provider.oauth).toEqual({ flow: "openai-codex" });
    expect(provider.config.models?.map((model) => model.id)).toEqual(piModelIds("openai-codex"));
  });

  it("rejects unknown provider types at runtime with known ids", async () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        mystery: { type: "mystery", options: { models: [{ id: "m" }] } },
      },
    });
    await expect(paseoAgentModelProviders(config)).rejects.toThrow(
      /Unknown model provider type "mystery". Known provider ids: openrouter, chatgpt, kimi, opencode-go/,
    );
  });
});

describe("paseoAgentHasUsableModel", () => {
  it("is true for a literal api key", () => {
    expect(paseoAgentHasUsableModel(configWith(), {})).toBe(true);
  });

  it("is false when no providers are configured", () => {
    expect(paseoAgentHasUsableModel(PaseoAgentConfigSchema.parse({}), {})).toBe(false);
  });

  it("is false for an API-key provider without a configured key", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        openrouter: { type: "openrouter", options: { models: [{ id: "m" }] } },
      },
    });
    expect(paseoAgentHasUsableModel(config, {})).toBe(false);
  });

  it("follows the env var for an env-backed key", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: { openrouter: { type: "openrouter", options: { models: [{ id: "m" }] } } },
    });
    expect(paseoAgentHasUsableModel(config, {})).toBe(false);
    expect(paseoAgentHasUsableModel(config, { OPENROUTER_API_KEY: "sk-env" })).toBe(true);
  });

  it("uses the OAuth store predicate, or an advanced refresh token", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: { chatgpt: { type: "chatgpt" } },
    });
    expect(paseoAgentHasUsableModel(config, {})).toBe(false);
    expect(paseoAgentHasUsableModel(config, {}, () => true)).toBe(true);

    const refreshConfig = PaseoAgentConfigSchema.parse({
      providers: {
        chatgpt: { type: "chatgpt", options: { refreshToken: "$OAUTH_REFRESH_TOKEN" } },
      },
    });
    expect(paseoAgentHasUsableModel(refreshConfig, { OAUTH_REFRESH_TOKEN: "rt-env" })).toBe(true);
  });
});

describe("resolvePaseoAgentModel", () => {
  it("prefers the explicit request, then agent model, then default, then first configured", () => {
    const config = configWith({ defaultModel: "openrouter-main/openai/gpt" });
    expect(resolvePaseoAgentModel(config, "openrouter-main/anthropic/claude")).toEqual({
      provider: "openrouter-main",
      id: "anthropic/claude",
    });
    expect(
      resolvePaseoAgentModel(config, null, undefined, "openrouter-main/anthropic/claude"),
    ).toEqual({
      provider: "openrouter-main",
      id: "anthropic/claude",
    });
    expect(resolvePaseoAgentModel(config, null)).toEqual({
      provider: "openrouter-main",
      id: "openai/gpt",
    });
    expect(resolvePaseoAgentModel(configWith(), null)).toEqual({
      provider: "openrouter-main",
      id: "anthropic/claude",
    });
  });

  it("returns undefined when no providers are configured", () => {
    expect(resolvePaseoAgentModel(PaseoAgentConfigSchema.parse({}), null)).toBeUndefined();
  });

  it("uses catalog default models during implicit selection", () => {
    expect(
      resolvePaseoAgentModel(
        PaseoAgentConfigSchema.parse({ providers: { chatgpt: { type: "chatgpt" } } }),
        null,
      ),
    ).toEqual({ provider: "chatgpt", id: piModelIds("openai-codex")[0] });
  });

  it("ignores an implicit default whose provider is not registered", () => {
    const config = configWith({ defaultModel: "ghost/model" });
    expect(resolvePaseoAgentModel(config, null)).toEqual({
      provider: "openrouter-main",
      id: "anthropic/claude",
    });
  });

  it("honors an explicit request even if its provider is not registered", () => {
    expect(resolvePaseoAgentModel(configWith(), "ghost/model")).toEqual({
      provider: "ghost",
      id: "model",
    });
  });
});
