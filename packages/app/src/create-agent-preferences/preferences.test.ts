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

  it("does not commit a failed write or leak it into the next update", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const failedWrite = preferences.update({ provider: "claude" });
    await storage.nextWrite();
    storage.failOldestWrite(new Error("disk full"));
    await expect(failedWrite).rejects.toThrow("disk full");

    expect(await preferences.load()).toEqual({});

    const successfulWrite = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await successfulWrite;

    expect(storage.savedPreferences()).toEqual({ isolation: "worktree" });
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

  it("does not erase a saved mode when a later partial update has no mode", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.5",
              mode: "full-access",
              thinkingByModel: { "gpt-5.5": "high" },
            },
          },
        },
        provider: "codex",
        updates: {
          model: "gpt-5.6",
          mode: undefined,
          thinkingByModel: undefined,
          featureValues: undefined,
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.6",
          mode: "full-access",
          thinkingByModel: { "gpt-5.5": "high" },
        },
      },
    });
  });

  it("loads invalid stored preferences as empty preferences", () => {
    expect(parseFormPreferences({ providerPreferences: { codex: { mode: 42 } } })).toEqual({});
  });

  it("persists and reloads the workspace isolation choice", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({ isolation: "worktree" });
    expect(await new CreateAgentPreferencesService(storage).load()).toEqual({
      isolation: "worktree",
    });
  });

  it("preserves legacy favourites across preference writes until host migration", async () => {
    const favoriteModels = [{ provider: "claude", modelId: "opus" }];
    const storage = new FakeCreateAgentPreferenceStorage({ stored: { favoriteModels } });
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({ favoriteModels, isolation: "worktree" });
  });

  it("treats stored preferences without an isolation choice as undefined", () => {
    expect(parseFormPreferences({ provider: "codex" }).isolation).toBeUndefined();
  });

  it("rejects an unknown isolation value as invalid stored preferences", () => {
    expect(parseFormPreferences({ provider: "codex", isolation: "sandbox" })).toEqual({});
  });

  it("persists and reloads a terminal launch target", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ launchTarget: { kind: "terminal", profileId: "claude" } });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({
      launchTarget: { kind: "terminal", profileId: "claude" },
    });
    expect(await new CreateAgentPreferencesService(storage).load()).toEqual({
      launchTarget: { kind: "terminal", profileId: "claude" },
    });
  });

  it("treats stored preferences without a launch target as undefined, defaulting to chat", () => {
    expect(parseFormPreferences({ provider: "codex" }).launchTarget).toBeUndefined();
  });

  it("rejects a terminal launch target missing a profileId as invalid stored preferences", () => {
    expect(parseFormPreferences({ launchTarget: { kind: "terminal" } })).toEqual({});
  });

  it("rejects an unknown launch target kind as invalid stored preferences", () => {
    expect(parseFormPreferences({ launchTarget: { kind: "shell" } })).toEqual({});
  });
});
