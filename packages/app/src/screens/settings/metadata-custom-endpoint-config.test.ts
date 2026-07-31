import { describe, expect, test } from "vitest";

import {
  areMetadataCustomEndpointDraftsEqual,
  buildMetadataCustomEndpointFieldResetKey,
  createMetadataCustomEndpointPatch,
  getMetadataCustomEndpointCardState,
  readMetadataCustomEndpointFromConfig,
  shouldShowModelSuggestions,
} from "./metadata-custom-endpoint-config";

describe("metadata custom endpoint config helpers", () => {
  test("card is visible only when connected and feature-enabled", () => {
    expect(
      getMetadataCustomEndpointCardState({
        isConnected: true,
        config: null,
        featureEnabled: true,
      }).isVisible,
    ).toBe(true);
    expect(
      getMetadataCustomEndpointCardState({
        isConnected: false,
        config: null,
        featureEnabled: true,
      }).isVisible,
    ).toBe(false);
    expect(
      getMetadataCustomEndpointCardState({
        isConnected: true,
        config: null,
        featureEnabled: false,
      }).isVisible,
    ).toBe(false);
  });

  test("reads defaults when config is missing customEndpoint", () => {
    expect(readMetadataCustomEndpointFromConfig(null)).toEqual({
      enabled: false,
      baseUrl: "",
      apiKey: "",
      model: "",
    });
  });

  test("builds a daemon config patch for custom endpoint", () => {
    expect(
      createMetadataCustomEndpointPatch({
        enabled: true,
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "sk-test",
        model: "llama3",
      }),
    ).toEqual({
      metadataGeneration: {
        customEndpoint: {
          enabled: true,
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "sk-test",
          model: "llama3",
        },
      },
    });
  });

  test("shows model suggestions only on successful non-empty discovery", () => {
    expect(
      shouldShowModelSuggestions({
        discoveryStatus: "success",
        models: [{ id: "llama3" }],
      }),
    ).toBe(true);
    expect(
      shouldShowModelSuggestions({
        discoveryStatus: "success",
        models: [],
      }),
    ).toBe(false);
    expect(
      shouldShowModelSuggestions({
        discoveryStatus: "error",
        models: [{ id: "llama3" }],
      }),
    ).toBe(false);
  });

  test("compares drafts for dirty state", () => {
    const draft = {
      enabled: true,
      baseUrl: "http://x/v1",
      apiKey: "k",
      model: "m",
    };
    expect(areMetadataCustomEndpointDraftsEqual(draft, { ...draft })).toBe(true);
    expect(areMetadataCustomEndpointDraftsEqual(draft, { ...draft, model: "other" })).toBe(false);
  });

  test("builds a stable field reset key from the persisted snapshot", () => {
    const saved = {
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-test",
      model: "llama3",
    };
    expect(buildMetadataCustomEndpointFieldResetKey(saved)).toBe(
      buildMetadataCustomEndpointFieldResetKey({ ...saved }),
    );
    expect(buildMetadataCustomEndpointFieldResetKey(saved)).not.toBe(
      buildMetadataCustomEndpointFieldResetKey({ ...saved, model: "other" }),
    );
    expect(buildMetadataCustomEndpointFieldResetKey(saved)).not.toBe(
      buildMetadataCustomEndpointFieldResetKey({
        enabled: false,
        baseUrl: "",
        apiKey: "",
        model: "",
      }),
    );
  });

  test("reads saved customEndpoint values after a config reload", () => {
    expect(
      readMetadataCustomEndpointFromConfig({
        metadataGeneration: {
          providers: [],
          customEndpoint: {
            enabled: true,
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "sk-test",
            model: "llama3",
          },
        },
      } as never),
    ).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-test",
      model: "llama3",
    });
  });
});
