import { describe, expect, test } from "vitest";

import {
  MutableDaemonConfigPatchSchema,
  MutableDaemonConfigSchema,
  ServerInfoStatusPayloadSchema,
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
