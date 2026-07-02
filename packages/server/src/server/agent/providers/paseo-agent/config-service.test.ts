import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { loadPersistedConfig, savePersistedConfig } from "../../../persisted-config.js";
import { PaseoAgentConfigService } from "./config-service.js";
import { PaseoAgentConfigSchema } from "./config.js";
import { paseoAgentAuthStoragePath, storeOAuthCredential } from "./oauth-store.js";

function piCatalogModels(provider: Parameters<typeof getModels>[0]) {
  return getModels(provider).map((model) => ({
    id: model.id,
    label: model.name,
    api: model.api,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

describe("PaseoAgentConfigService", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "paseo-agent-config-service-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("persists an OpenRouter provider and returns only redacted auth state", () => {
    const onConfigChanged = vi.fn();
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
      onConfigChanged,
    });

    const provider = service.setProvider({
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        apiKey: "sk-secret-openrouter",
        headers: { Authorization: "Bearer header-secret" },
        models: [{ id: "anthropic/claude-3.7-sonnet", reasoning: true }],
      },
    });

    const persisted = loadPersistedConfig(home);
    expect(persisted.agents?.paseo?.providers?.["openrouter-main"]).toMatchObject({
      type: "openrouter",
      options: { apiKey: "sk-secret-openrouter" },
    });
    expect(provider).toMatchObject({
      name: "openrouter-main",
      providerType: "openrouter",
      auth: { kind: "api_key", configured: true, source: "literal" },
      available: true,
    });
    expect(JSON.stringify(service.getProviders())).not.toContain("sk-secret-openrouter");
    expect(JSON.stringify(service.getProviders())).not.toContain("header-secret");
    expect(onConfigChanged).toHaveBeenCalledWith(
      expect.objectContaining({ providers: expect.any(Object) }),
    );
  });

  test("reports API-key default env auth state without resolving the key value", () => {
    const missingService = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
      env: { PASEO_HOME: home },
    });
    missingService.setProvider({
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        models: [{ id: "anthropic/claude-3.7-sonnet" }],
      },
    });

    expect(missingService.getProviders().providers[0]).toMatchObject({
      auth: {
        kind: "api_key",
        configured: false,
        source: "default_env",
        hint: "OPENROUTER_API_KEY",
      },
      available: false,
    });

    const presentService = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
      env: { PASEO_HOME: home, OPENROUTER_API_KEY: "sk-env-secret" },
    });

    expect(presentService.getProviders().providers[0]).toMatchObject({
      auth: {
        kind: "api_key",
        configured: true,
        source: "default_env",
        hint: "OPENROUTER_API_KEY",
      },
      available: true,
    });
    expect(JSON.stringify(presentService.getProviders())).not.toContain("sk-env-secret");
  });

  test("reports configured API-key providers as available even without exposed models", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });

    service.setProvider({
      name: "openrouter",
      providerType: "openrouter",
      options: {
        apiKey: "sk-test",
      },
    });

    expect(service.getProviders().providers[0]).toMatchObject({
      auth: { kind: "api_key", configured: true, source: "literal" },
      models: [],
      available: true,
    });
  });

  test("rejects an unknown provider type with a clear error and persists nothing", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });

    expect(() =>
      service.setProvider({
        name: "future-main",
        providerType: "kimi-coding",
        options: { apiKey: "sk-test", models: [{ id: "kimi-k3" }] },
      }),
    ).toThrow(
      /Unknown model provider type "kimi-coding". Known provider ids: openrouter, chatgpt, kimi, opencode-go/,
    );
    expect(loadPersistedConfig(home).agents?.paseo?.providers).toBeUndefined();
  });

  test("schema accepts an unknown type structurally and the service rejects it", () => {
    const parsed = PaseoAgentConfigSchema.parse({
      providers: {
        future: { type: "future-provider", options: { models: [{ id: "m" }] } },
      },
    });
    expect(parsed.providers?.future?.type).toBe("future-provider");
    savePersistedConfig(
      home,
      {
        agents: { paseo: parsed },
      },
      createTestLogger(),
    );
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });

    expect(() => service.getProviders()).toThrow(
      /Unknown model provider type "future-provider". Known provider ids: openrouter, chatgpt, kimi, opencode-go/,
    );
  });

  test("maps the legacy provider type alias to the catalog id on write", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });

    const provider = service.setProvider({
      name: "chatgpt",
      providerType: "openai-codex",
      options: {},
    });

    expect(provider.providerType).toBe("chatgpt");
    expect(loadPersistedConfig(home).agents?.paseo?.providers?.chatgpt?.type).toBe("chatgpt");
  });

  test("does not persist Pi catalog defaults as instance model overrides", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });
    const chatgptCatalog = service.getCatalog().find((entry) => entry.id === "chatgpt");
    if (!chatgptCatalog) {
      throw new Error("missing chatgpt catalog entry");
    }

    service.setProvider({
      name: "chatgpt",
      providerType: "chatgpt",
      options: { models: chatgptCatalog.models },
    });

    expect(loadPersistedConfig(home).agents?.paseo?.providers?.chatgpt?.options.models).toBe(
      undefined,
    );
  });

  test("preserves shared config fields when writing agents.paseo", () => {
    const logger = createTestLogger();
    savePersistedConfig(
      home,
      {
        daemon: { appendSystemPrompt: "Keep existing daemon settings." },
        app: { baseUrl: "http://localhost:8081" },
        agents: {
          providers: {
            gemini: {
              extends: "acp",
              label: "Gemini",
              command: ["gemini", "--acp"],
            },
          },
        },
      },
      logger,
    );
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger,
    });

    service.setProvider({
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        apiKey: "sk-secret-openrouter",
        models: [{ id: "anthropic/claude-3.7-sonnet" }],
      },
    });

    const persisted = loadPersistedConfig(home);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Keep existing daemon settings.");
    expect(persisted.app?.baseUrl).toBe("http://localhost:8081");
    expect(persisted.agents?.providers?.gemini).toMatchObject({
      extends: "acp",
      label: "Gemini",
    });
    expect(persisted.agents?.paseo?.providers?.["openrouter-main"]?.options.apiKey).toBe(
      "sk-secret-openrouter",
    );
  });

  test("stores OAuth credentials in the Paseo-owned auth store with future fields intact", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });
    service.setProvider({
      name: "chatgpt",
      providerType: "chatgpt",
      options: {},
    });

    service.storeOAuthCredential("chatgpt", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      accountId: "acct_123",
      futureField: { keep: true },
    });

    const authPath = paseoAgentAuthStoragePath({ PASEO_HOME: home });
    const stored = JSON.parse(readFileSync(authPath, "utf8"));
    expect(stored.chatgpt).toMatchObject({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      binding: {
        flow: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
      },
      futureField: { keep: true },
    });
    expect(authPath).toBe(join(home, "paseo-agent", "auth.json"));
  });

  test("reports OAuth auth as stored without returning tokens", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });
    service.setProvider({
      name: "chatgpt",
      providerType: "chatgpt",
      options: {},
    });
    service.storeOAuthCredential("chatgpt", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const providers = service.getProviders();
    expect(providers.providers).toEqual([
      expect.objectContaining({
        name: "chatgpt",
        providerType: "chatgpt",
        models: piCatalogModels("openai-codex"),
        auth: { kind: "oauth", configured: true, source: "stored" },
        available: true,
      }),
    ]);
    expect(JSON.stringify(providers)).not.toContain("access-token");
    expect(JSON.stringify(providers)).not.toContain("refresh-token");
  });

  test("renames the provider display name without moving stored OAuth credentials", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });
    service.setProvider({
      name: "subscription",
      providerType: "chatgpt",
      options: {},
    });
    service.storeOAuthCredential("subscription", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const provider = service.renameProvider("subscription", "Work account");

    expect(provider).toMatchObject({
      name: "subscription",
      displayName: "Work account",
      auth: { kind: "oauth", configured: true, source: "stored" },
      available: true,
    });
    const stored = JSON.parse(
      readFileSync(paseoAgentAuthStoragePath({ PASEO_HOME: home }), "utf8"),
    );
    expect(Object.keys(stored)).toEqual(["subscription"]);
    expect(stored.subscription).toMatchObject({
      type: "oauth",
      refresh: "refresh-token",
    });
  });

  test("reports OAuth as missing or needing attention for absent and mismatched credentials", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });
    service.setProvider({
      name: "chatgpt",
      providerType: "chatgpt",
      options: {},
    });

    expect(service.getProviders().providers[0]).toMatchObject({
      auth: { kind: "oauth", configured: false },
      available: false,
    });

    storeOAuthCredential({
      providerInstance: "chatgpt",
      env: { PASEO_HOME: home },
      binding: { flow: "openai-codex", baseUrl: "https://chatgpt.example.test/changed" },
      credential: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
      },
    });

    expect(service.getProviders().providers[0]).toMatchObject({
      auth: {
        kind: "oauth",
        configured: false,
        source: "stored",
        hint: "binding_mismatch",
      },
      available: false,
    });
    expect(JSON.stringify(service.getProviders())).not.toContain("access-token");
    expect(JSON.stringify(service.getProviders())).not.toContain("refresh-token");
  });

  test("removes providers and clears a default model owned by that provider", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });
    service.setProvider({
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        apiKey: "sk-secret-openrouter",
        models: [{ id: "anthropic/claude-3.7-sonnet" }],
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        agents: {
          paseo: {
            defaultModel: "openrouter-main/anthropic/claude-3.7-sonnet",
            providers: {
              "openrouter-main": {
                type: "openrouter",
                options: {
                  apiKey: "sk-secret-openrouter",
                  models: [{ id: "anthropic/claude-3.7-sonnet" }],
                },
              },
            },
          },
        },
      }),
    );

    expect(service.removeProvider("openrouter-main")).toBe(true);
    expect(service.getProviders()).toEqual({ defaultModel: null, providers: [] });
  });
});
