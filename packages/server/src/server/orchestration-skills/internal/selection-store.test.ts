import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonConfigStore, type MutableDaemonConfigPatch } from "../../daemon-config-store";
import { loadPersistedConfig } from "../../persisted-config";
import { createSkillSelectionStore } from "./selection-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-skills-config-"));
  roots.push(root);
  const config = new DaemonConfigStore(root, {
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  });
  return { config, root, store: createSkillSelectionStore(config) };
}

describe("daemon agent skill selection", () => {
  it("defaults missing selection to all without persisting it", async () => {
    const { root, store } = await createStore();
    expect(await store.get()).toEqual({ mode: "all" });
    expect(await store.isSet()).toBe(false);
    expect(loadPersistedConfig(root).agents?.skills).toBeUndefined();
  });

  it("persists a normalized custom selection under agents.skills.selection", async () => {
    const { root, store } = await createStore();
    await store.set({ mode: "custom", skills: ["paseo-loop", "paseo", "paseo"] });
    expect(loadPersistedConfig(root).agents?.skills?.selection).toEqual({
      mode: "custom",
      skills: ["paseo", "paseo-loop"],
    });
  });

  it("replaces a custom selection with all without retaining custom skill names", async () => {
    const { config, root, store } = await createStore();
    await store.set({ mode: "custom", skills: ["paseo"] });

    await store.set({ mode: "all" });

    expect(config.get().skills?.selection).toEqual({ mode: "all" });
    expect(loadPersistedConfig(root).agents?.skills?.selection).toEqual({ mode: "all" });
  });

  it("does not expose selection through the generic config patch path", async () => {
    const { config, root, store } = await createStore();

    config.patch({
      skills: { selection: { mode: "custom", skills: ["paseo"] } },
    } as MutableDaemonConfigPatch);

    expect(await store.isSet()).toBe(false);
    expect(loadPersistedConfig(root).agents?.skills).toBeUndefined();
  });

  it("reads and saves the requested settings profile after another profile becomes active", async () => {
    const { config, store } = await createStore();
    const base = {
      appendSystemPrompt: "",
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      agentProfiles: [],
    };
    config.patch({
      agentSettingsProfiles: {
        activeProfileId: "coding",
        profiles: [
          {
            id: "coding",
            name: "Coding",
            settings: {
              ...base,
              skills: { selection: { mode: "custom", skills: ["paseo"] } },
            },
          },
          {
            id: "reverse",
            name: "Reverse",
            settings: {
              ...base,
              skills: { selection: { mode: "custom", skills: ["hexrays-ida"] } },
            },
          },
        ],
      },
    });
    expect(await store.get("coding")).toEqual({ mode: "custom", skills: ["paseo"] });
    config.patch({
      agentSettingsProfiles: { ...config.get().agentSettingsProfiles!, activeProfileId: "reverse" },
    });
    await store.set({ mode: "custom", skills: ["paseo", "paseo-loop"] }, "coding");

    expect(
      config.get().agentSettingsProfiles?.profiles.find((profile) => profile.id === "coding")
        ?.settings.skills?.selection,
    ).toEqual({ mode: "custom", skills: ["paseo", "paseo-loop"] });
    expect(
      config.get().agentSettingsProfiles?.profiles.find((profile) => profile.id === "reverse")
        ?.settings.skills?.selection,
    ).toEqual({ mode: "custom", skills: ["hexrays-ida"] });
    expect(config.get().skills?.selection).toEqual({
      mode: "custom",
      skills: ["hexrays-ida"],
    });
  });

  it("rejects a requested settings profile that was deleted", async () => {
    const { config, store } = await createStore();
    const settings = {
      appendSystemPrompt: "",
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      agentProfiles: [],
      skills: { selection: { mode: "all" as const } },
    };
    config.patch({
      agentSettingsProfiles: {
        activeProfileId: "coding",
        profiles: [
          { id: "coding", name: "Coding", settings },
          { id: "deleted", name: "Deleted", settings },
        ],
      },
    });
    config.patch({
      agentSettingsProfiles: {
        activeProfileId: "coding",
        profiles: config
          .get()
          .agentSettingsProfiles!.profiles.filter((profile) => profile.id !== "deleted"),
      },
    });

    await expect(store.get("deleted")).rejects.toThrow("does not exist");
    await expect(store.set({ mode: "all" }, "deleted")).rejects.toThrow("does not exist");
    expect(config.get().agentSettingsProfiles?.profiles.map((profile) => profile.id)).toEqual([
      "coding",
    ]);
  });
});
