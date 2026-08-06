import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "./agent-types.js";
import { compactProviderSnapshot, expandProviderSnapshot } from "./provider-snapshot-codec.js";

const sharedThinking = [
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", description: "Balanced reasoning" },
  { id: "high", label: "High", isDefault: true },
  { id: "xhigh", label: "XHigh", description: "Very deep reasoning" },
  { id: "max", label: "Max", description: "Extreme reasoning" },
];

function providerEntry(): ProviderSnapshotEntry {
  return {
    provider: "pi",
    status: "ready",
    enabled: true,
    models: [
      {
        provider: "pi",
        id: "openai/gpt-a",
        label: "GPT A",
        description: "openai/gpt-a",
        metadata: { provider: "openai", modelId: "gpt-a" },
        thinkingOptions: sharedThinking,
        defaultThinkingOptionId: "high",
      },
      {
        provider: "pi",
        id: "openai/gpt-b",
        label: "GPT B",
        metadata: { provider: "openai", modelId: "gpt-b" },
        thinkingOptions: structuredClone(sharedThinking),
        defaultThinkingOptionId: "high",
      },
    ],
    modes: [{ id: "build", label: "Build" }],
  };
}

describe("provider snapshot codec", () => {
  it("shares repeated thinking options while preserving the public snapshot shape", () => {
    const original = [providerEntry()];
    const compact = compactProviderSnapshot(original);
    const expanded = expandProviderSnapshot(compact);

    expect(compact.thinkingSets).toHaveLength(1);
    expect(compact.entries[0]?.models?.map((model) => model.thinkingSet)).toEqual([0, 0]);
    expect(expanded).toEqual(original);
    expect(expanded[0]?.models?.[0]?.thinkingOptions).toBe(
      expanded[0]?.models?.[1]?.thinkingOptions,
    );
  });

  it("shrinks catalogs dominated by one repeated thinking set", () => {
    const model = providerEntry().models?.[0];
    if (!model) throw new Error("fixture model missing");
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "pi",
        status: "ready",
        enabled: true,
        models: Array.from({ length: 200 }, (_, index) => ({
          ...model,
          id: `openai/model-${index}`,
          label: `Model ${index}`,
          metadata: { provider: "openai", modelId: `model-${index}` },
        })),
      },
    ];

    const legacyBytes = JSON.stringify(entries).length;
    const compactBytes = JSON.stringify(compactProviderSnapshot(entries)).length;

    expect(compactBytes).toBeLessThan(legacyBytes * 0.5);
  });
});
