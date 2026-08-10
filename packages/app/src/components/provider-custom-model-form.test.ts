import { describe, expect, test } from "vitest";

import {
  applyCandidateToFields,
  buildSavedCustomModel,
  candidateSourceId,
  canAutofillField,
  describeCandidateOption,
  parsePositiveTokenInput,
  pickPreferredCandidate,
} from "./provider-custom-model-form";

describe("provider-custom-model-form helpers", () => {
  test("parsePositiveTokenInput accepts blank and positive integers only", () => {
    expect(parsePositiveTokenInput("")).toBeUndefined();
    expect(parsePositiveTokenInput("500000")).toBe(500_000);
    expect(parsePositiveTokenInput("12.5")).toBe("invalid");
    expect(parsePositiveTokenInput("-1")).toBe("invalid");
  });

  test("canAutofillField only replaces empty or previously autofilled values", () => {
    expect(canAutofillField("", null)).toBe(true);
    expect(canAutofillField("500000", "500000")).toBe(true);
    expect(canAutofillField("200000", "500000")).toBe(false);
  });

  test("applyCandidateToFields preserves manual values", () => {
    const applied = applyCandidateToFields(
      {
        providerId: "xai",
        matchedId: "grok-4.5",
        name: "Grok 4.5",
        contextWindowMaxTokens: 500_000,
        maxOutputTokens: 500_000,
      },
      {
        label: "My Grok",
        contextWindow: "200000",
        maxOutput: "",
      },
      {
        label: "",
        contextWindow: "",
        maxOutput: "",
      },
    );
    expect(applied.next.label).toBe("My Grok");
    expect(applied.next.contextWindow).toBe("200000");
    expect(applied.next.maxOutput).toBe("500000");
  });

  test("pickPreferredCandidate prefers matching provider id", () => {
    const candidates = [
      {
        providerId: "openrouter",
        matchedId: "x-ai/grok-4.5",
        contextWindowMaxTokens: 500_000,
        maxOutputTokens: 32_768,
      },
      {
        providerId: "xai",
        matchedId: "grok-4.5",
        contextWindowMaxTokens: 500_000,
        maxOutputTokens: 500_000,
      },
    ];
    expect(pickPreferredCandidate(candidates, "xai")?.providerId).toBe("xai");
    expect(pickPreferredCandidate(candidates)?.providerId).toBe("openrouter");
  });

  test("describeCandidateOption formats human limits", () => {
    const option = describeCandidateOption({
      providerId: "xai",
      matchedId: "grok-4.5",
      contextWindowMaxTokens: 500_000,
      maxOutputTokens: 500_000,
    });
    expect(option.id).toBe(candidateSourceId({ providerId: "xai", matchedId: "grok-4.5" }));
    expect(option.label).toBe("xai");
    expect(option.description).toContain("500k context");
    expect(option.description).toContain("500k max output");
  });
});

test("buildSavedCustomModel stores custom source or listing metadata", () => {
  expect(
    buildSavedCustomModel({
      id: "grok-4.5",
      label: "Grok",
      contextTokens: 500_000,
      maxOutputTokens: 500_000,
      sourceId: "custom",
      selectedCandidate: null,
    }),
  ).toMatchObject({
    id: "grok-4.5",
    modelsDevProviderId: "custom",
    contextWindowMaxTokens: 500_000,
    maxOutputTokens: 500_000,
  });

  expect(
    buildSavedCustomModel({
      id: "grok-4.5",
      label: "Grok",
      contextTokens: 500_000,
      maxOutputTokens: 32_768,
      sourceId: "openrouter\0x-ai/grok-4.5",
      selectedCandidate: {
        providerId: "openrouter",
        matchedId: "x-ai/grok-4.5",
        contextWindowMaxTokens: 500_000,
        maxOutputTokens: 32_768,
        capabilities: ["tools"],
      },
    }),
  ).toMatchObject({
    modelsDevProviderId: "openrouter",
    modelsDevMatchedId: "x-ai/grok-4.5",
    capabilities: ["tools"],
  });
});
