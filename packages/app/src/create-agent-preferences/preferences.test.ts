import { describe, expect, it } from "vitest";
import { CreateAgentPreferencesService } from "./service";
import {
  mergeCreateAgentSelectionPreferences,
  mergeProviderPreferences,
  parseFormPreferences,
} from "./preferences";
import { FakeCreateAgentPreferenceStorage } from "./test-utils/fake-preference-storage";

describe("create agent preferences", () => {
  it("keeps the selected mode after saving model and thinking", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const modelWrite = preferences.update((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: "codex",
        updates: { model: "gpt-5.5", thinkingByModel: { "gpt-5.5": "high" } },
      }),
    );
    await storage.nextWrite();

    const modeWrite = preferences.update((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: "codex",
        updates: { mode: "full-access" },
      }),
    );

    expect(storage.pendingWriteCount()).toBe(1);
    storage.finishOldestWrite();
    await modelWrite;

    await storage.nextWrite();
    storage.finishOldestWrite();
    await modeWrite;

    expect(storage.savedPreferences()).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.5",
          thinkingByModel: { "gpt-5.5": "high" },
          mode: "full-access",
        },
      },
    });
  });

  it("flushes the full create-agent selection into provider preferences", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const saveSelection = preferences.update((current) =>
      mergeCreateAgentSelectionPreferences({
        preferences: current,
        provider: "codex",
        modelId: "gpt-5.5",
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
    );

    await storage.nextWrite();
    storage.finishOldestWrite();
    await saveSelection;

    expect(storage.savedPreferences()).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.5",
          mode: "full-access",
          thinkingByModel: { "gpt-5.5": "high" },
          featureValues: { fast_mode: true },
        },
      },
    });
  });

  it("loads invalid stored preferences as empty preferences", () => {
    expect(parseFormPreferences({ providerPreferences: { codex: { mode: 42 } } })).toEqual({});
  });
});
