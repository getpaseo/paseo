import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("Paseo Agent config RPC schemas", () => {
  test("parses provider config requests with providerType outside the message type field", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.set_provider.request",
      requestId: "req-set-openrouter",
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        apiKey: "sk-test",
        models: [{ id: "anthropic/claude-3.7-sonnet", reasoning: true }],
      },
    });

    expect(parsed.type).toBe("config.paseo_agent.set_provider.request");
    expect(parsed.providerType).toBe("openrouter");
  });

  test("parses provider config requests without model overrides", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.set_provider.request",
      requestId: "req-set-openrouter",
      name: "openrouter",
      providerType: "openrouter",
      options: {
        apiKey: "sk-test",
      },
    });

    expect(parsed.options.models).toBeUndefined();
  });

  test("parses a provider type this client has never heard of (new daemon, old client)", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "config.paseo_agent.get_providers.response",
      payload: {
        requestId: "req-get-future",
        defaultModel: null,
        providers: [
          {
            name: "kimi-main",
            providerType: "kimi-coding",
            models: [{ id: "kimi-k3" }],
            auth: { kind: "future_auth_kind", configured: true, source: "future_source" },
            available: true,
            error: null,
          },
        ],
        error: null,
      },
    });

    expect(parsed.payload.providers[0]?.providerType).toBe("kimi-coding");
  });

  test("parses redacted provider responses without raw secret fields", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "config.paseo_agent.get_providers.response",
      payload: {
        requestId: "req-get",
        defaultModel: "openrouter-main/anthropic/claude-3.7-sonnet",
        providers: [
          {
            name: "openrouter-main",
            providerType: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            models: [{ id: "anthropic/claude-3.7-sonnet" }],
            auth: { kind: "api_key", configured: true, source: "literal" },
            available: true,
            error: null,
          },
        ],
        error: null,
      },
    });

    expect(parsed.payload.providers[0]?.providerType).toBe("openrouter");
    expect(JSON.stringify(parsed)).not.toContain("apiKey");
  });

  test("parses get_catalog request and response with forward-tolerant entries", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.get_catalog.request",
      requestId: "req-catalog",
    });
    const response = SessionOutboundMessageSchema.parse({
      type: "config.paseo_agent.get_catalog.response",
      payload: {
        requestId: "req-catalog",
        catalog: [
          {
            id: "future-provider",
            label: "Future Provider",
            iconName: "sparkles",
            docsUrl: "https://docs.example.test/provider",
            api: "future-api",
            baseUrl: "https://api.example.test",
            headers: { "User-Agent": "PaseoTest/1" },
            compat: { minHost: "0.1.104" },
            auth: { kind: "future_oauth", flow: "future-flow", extraAuthField: true },
            models: [
              {
                id: "future-model",
                label: "Future Model",
                futureModelField: "kept",
              },
            ],
            futureEntryField: { keep: true },
          },
        ],
        error: null,
      },
    });

    expect(request.type).toBe("config.paseo_agent.get_catalog.request");
    expect(response.payload.catalog[0]?.auth.kind).toBe("future_oauth");
    expect(response.payload.catalog[0]?.futureEntryField).toEqual({ keep: true });
    expect(response.payload.catalog[0]?.models[0]?.futureModelField).toBe("kept");
  });

  test("parses oauth.start request and device-code response", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.oauth.start.request",
      requestId: "req-oauth-start",
      name: "subscription",
      mode: "device_code",
    });
    const response = SessionOutboundMessageSchema.parse({
      type: "config.paseo_agent.oauth.start.response",
      payload: {
        requestId: "req-oauth-start",
        success: true,
        name: "subscription",
        authorization: {
          kind: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.example.test/device",
          intervalSeconds: 5,
          expiresInSeconds: 900,
          futureField: "kept",
        },
        error: null,
      },
    });

    expect(request.name).toBe("subscription");
    expect(request.mode).toBe("device_code");
    expect(response.payload.authorization?.kind).toBe("device_code");
    expect(response.payload.authorization?.futureField).toBe("kept");
  });

  test("parses oauth.start auth-url response", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "config.paseo_agent.oauth.start.response",
      payload: {
        requestId: "req-oauth-start-url",
        success: true,
        name: "subscription",
        authorization: {
          kind: "auth_url",
          url: "https://auth.example.test/oauth",
          instructions: "Open this URL to continue.",
        },
        error: null,
      },
    });

    expect(parsed.payload.authorization?.url).toBe("https://auth.example.test/oauth");
  });

  test("parses oauth.complete request and response", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.oauth.complete.request",
      requestId: "req-oauth-complete",
      name: "subscription",
    });
    const response = SessionOutboundMessageSchema.parse({
      type: "config.paseo_agent.oauth.complete.response",
      payload: {
        requestId: "req-oauth-complete",
        success: true,
        name: "subscription",
        auth: { kind: "oauth", configured: true, source: "stored" },
        error: null,
      },
    });

    expect(request.name).toBe("subscription");
    expect(response.payload.auth?.configured).toBe(true);
  });

  test("preserves future OAuth credential fields on inbound schema parse", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.oauth.store_credential.request",
      requestId: "req-oauth",
      name: "subscription",
      credential: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
        futureField: { keep: true },
      },
    });

    expect(parsed.credential.futureField).toEqual({ keep: true });
  });

  test("parses oauth.store_credential response without credential material", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "config.paseo_agent.oauth.store_credential.response",
      payload: {
        requestId: "req-oauth",
        success: true,
        name: "subscription",
        auth: { kind: "oauth", configured: true, source: "stored" },
        error: null,
      },
    });

    expect(parsed.payload.name).toBe("subscription");
    expect(JSON.stringify(parsed)).not.toContain("access-token");
    expect(JSON.stringify(parsed)).not.toContain("refresh-token");
  });

  test("parses provider rename request and response with display name", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.rename_provider.request",
      requestId: "req-rename-provider",
      name: "subscription",
      displayName: "Work account",
    });
    const response = SessionOutboundMessageSchema.parse({
      type: "config.paseo_agent.rename_provider.response",
      payload: {
        requestId: "req-rename-provider",
        success: true,
        provider: {
          name: "subscription",
          displayName: "Work account",
          providerType: "chatgpt",
          models: [{ id: "gpt-5.4-mini" }],
          auth: { kind: "oauth", configured: true, source: "stored" },
          available: true,
          error: null,
        },
        error: null,
      },
    });

    expect(request.displayName).toBe("Work account");
    expect(response.payload.provider?.displayName).toBe("Work account");
  });

  test("parses ChatGPT provider config separately from credential storage", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.set_provider.request",
      requestId: "req-set-chatgpt",
      name: "chatgpt",
      providerType: "openai-codex",
      options: {
        models: [{ id: "gpt-5.4-mini", reasoning: true }],
      },
    });

    expect(parsed.providerType).toBe("openai-codex");
    expect(JSON.stringify(parsed)).not.toContain("access-token");
  });
});
