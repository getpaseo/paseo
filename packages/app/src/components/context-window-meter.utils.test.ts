import { describe, expect, it } from "vitest";
import {
  resolveContextWindowValues,
  resolveModelContextWindowMaxTokens,
} from "./context-window-meter.utils";

const models = [
  {
    provider: "grok" as const,
    id: "grok-4.5",
    label: "Grok 4.5",
    isDefault: true,
    contextWindowMaxTokens: 500_000,
  },
];

describe("resolveModelContextWindowMaxTokens", () => {
  it("resolves the selected model limit", () => {
    expect(
      resolveModelContextWindowMaxTokens({
        models,
        runtimeModelId: "grok-4.5",
        configuredModelId: null,
      }),
    ).toBe(500_000);
  });
});

describe("resolveContextWindowValues", () => {
  it("keeps a model limit when usage has not been reported", () => {
    expect(
      resolveContextWindowValues({
        reportedMaxTokens: null,
        reportedUsedTokens: null,
        modelMaxTokens: 500_000,
      }),
    ).toEqual({ maxTokens: 500_000, usedTokens: null });
  });

  it("prefers reported values once usage arrives", () => {
    expect(
      resolveContextWindowValues({
        reportedMaxTokens: 128_000,
        reportedUsedTokens: 32_000,
        modelMaxTokens: 500_000,
      }),
    ).toEqual({ maxTokens: 128_000, usedTokens: 32_000 });
  });
});
