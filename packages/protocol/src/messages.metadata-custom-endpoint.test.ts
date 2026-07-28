import { describe, expect, test } from "vitest";

import {
  MetadataCustomEndpointListModelsRequestSchema,
  MetadataCustomEndpointListModelsResponseSchema,
  MutableDaemonConfigPatchSchema,
  MutableDaemonConfigSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("metadataGeneration.customEndpoint mutable config", () => {
  test("parses a fully set custom endpoint", () => {
    const parsed = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: true },
      metadataGeneration: {
        providers: [],
        customEndpoint: {
          enabled: true,
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "sk-test",
          model: "llama3",
        },
      },
    });

    expect(parsed.metadataGeneration.customEndpoint).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-test",
      model: "llama3",
    });
  });

  test("defaults custom endpoint to disabled empty strings when omitted", () => {
    const parsed = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: true },
    });

    expect(parsed.metadataGeneration.customEndpoint).toEqual({
      enabled: false,
      baseUrl: "",
      apiKey: "",
      model: "",
    });
  });

  test("accepts a partial customEndpoint patch", () => {
    const parsed = MutableDaemonConfigPatchSchema.parse({
      metadataGeneration: {
        customEndpoint: {
          enabled: true,
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    });

    expect(parsed.metadataGeneration?.customEndpoint).toMatchObject({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
    });
  });
});

describe("server_info.features.metadataCustomEndpoint", () => {
  test("accepts the metadataCustomEndpoint feature flag", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
      features: {
        metadataCustomEndpoint: true,
      },
    });

    expect(parsed.features?.metadataCustomEndpoint).toBe(true);
  });

  test("still parses server_info without metadataCustomEndpoint", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
      features: {},
    });

    expect(parsed.features?.metadataCustomEndpoint).toBeUndefined();
  });
});

describe("metadataGeneration.customEndpoint.listModels RPC", () => {
  test("parses listModels request and response", () => {
    expect(
      MetadataCustomEndpointListModelsRequestSchema.parse({
        type: "metadataGeneration.customEndpoint.listModels.request",
        requestId: "req-1",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "sk-test",
      }),
    ).toMatchObject({
      type: "metadataGeneration.customEndpoint.listModels.request",
      requestId: "req-1",
      baseUrl: "http://127.0.0.1:11434/v1",
    });

    expect(
      MetadataCustomEndpointListModelsResponseSchema.parse({
        type: "metadataGeneration.customEndpoint.listModels.response",
        payload: {
          requestId: "req-1",
          models: [{ id: "llama3" }],
          error: null,
        },
      }),
    ).toMatchObject({
      type: "metadataGeneration.customEndpoint.listModels.response",
      payload: {
        models: [{ id: "llama3" }],
        error: null,
      },
    });
  });

  test("registers listModels in session inbound/outbound unions", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "metadataGeneration.customEndpoint.listModels.request",
        requestId: "req-2",
      }).type,
    ).toBe("metadataGeneration.customEndpoint.listModels.request");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "metadataGeneration.customEndpoint.listModels.response",
        payload: {
          requestId: "req-2",
          models: [],
          error: { code: "missing_base_url", message: "Base URL is required" },
        },
      }).type,
    ).toBe("metadataGeneration.customEndpoint.listModels.response");
  });
});
