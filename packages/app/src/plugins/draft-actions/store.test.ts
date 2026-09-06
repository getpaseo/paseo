import { QueryClient } from "@tanstack/react-query";
import type { InstalledPlugin } from "../types";
import { afterEach, describe, expect, it } from "vitest";
import { pluginDraftActionStore } from "./store";

const usedInstallations: InstalledPlugin[] = [];

function installation(id: string): InstalledPlugin {
  const plugin: InstalledPlugin = {
    id,
    serverId: "host-a",
    clientBundle: "bundle",
    queryClient: new QueryClient(),
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
  usedInstallations.push(plugin);
  return plugin;
}

afterEach(() => {
  for (const plugin of usedInstallations.splice(0)) {
    pluginDraftActionStore.removeInstallation(plugin);
  }
  expect(pluginDraftActionStore.getSnapshot()).toEqual([]);
});

function contribution(overrides: Partial<Parameters<typeof pluginDraftActionStore.add>[1]> = {}) {
  return {
    id: "prompt-enhance",
    title: "增强提示词",
    async transform(text: string) {
      return text;
    },
    ...overrides,
  };
}

describe("plugin draft action store", () => {
  it("registers a contribution, reports it in the snapshot, and removes it via cleanup", () => {
    const plugin = installation("review");
    const remove = pluginDraftActionStore.add(plugin, contribution());
    expect(pluginDraftActionStore.getSnapshot()).toHaveLength(1);
    expect(pluginDraftActionStore.getSnapshot()[0]?.contribution.id).toBe("prompt-enhance");

    remove();
    expect(pluginDraftActionStore.getSnapshot()).toEqual([]);

    // Cleanup is idempotent.
    remove();
    expect(pluginDraftActionStore.getSnapshot()).toEqual([]);
  });

  it("notifies subscribers on add and remove", () => {
    const events: number[] = [];
    const unsubscribe = pluginDraftActionStore.subscribe(() => events.push(events.length));
    const remove = pluginDraftActionStore.add(installation("review"), contribution());
    remove();
    unsubscribe();
    expect(events).toHaveLength(2);
  });

  it("removes every contribution of an installation but leaves other installations intact", () => {
    const pluginA = installation("review");
    const pluginB = installation("other");
    pluginDraftActionStore.add(pluginA, contribution());
    pluginDraftActionStore.add(pluginA, contribution({ id: "another-action" }));
    const removeB = pluginDraftActionStore.add(pluginB, contribution());

    pluginDraftActionStore.removeInstallation(pluginA);
    expect(pluginDraftActionStore.getSnapshot().map((e) => e.contribution.id)).toEqual([
      "prompt-enhance",
    ]);

    removeB();
    expect(pluginDraftActionStore.getSnapshot()).toEqual([]);
  });

  it("rejects duplicate ids within the same installation but allows them across installations", () => {
    const plugin = installation("review");
    pluginDraftActionStore.add(plugin, contribution());
    expect(() => pluginDraftActionStore.add(plugin, contribution())).toThrow(
      "Duplicate draft action: prompt-enhance",
    );
    expect(() => pluginDraftActionStore.add(installation("other"), contribution())).not.toThrow();
    pluginDraftActionStore.removeInstallation(plugin);
  });

  it("rejects invalid ids, empty titles, and missing transforms", () => {
    const plugin = installation("review");
    expect(() =>
      pluginDraftActionStore.add(plugin, contribution({ id: "Prompt_Enhance" })),
    ).toThrow("Invalid draft action id: Prompt_Enhance");
    expect(() =>
      pluginDraftActionStore.add(plugin, contribution({ id: "1-leading-digit" })),
    ).toThrow("Invalid draft action id: 1-leading-digit");
    expect(() => pluginDraftActionStore.add(plugin, contribution({ title: "  " }))).toThrow(
      "Draft action prompt-enhance has no title",
    );
    expect(() =>
      pluginDraftActionStore.add(plugin, contribution({ transform: undefined })),
    ).toThrow("Draft action prompt-enhance has no transform");
    expect(pluginDraftActionStore.getSnapshot()).toEqual([]);
  });

  it("trims id and title before registering", () => {
    const plugin = installation("review");
    const remove = pluginDraftActionStore.add(
      plugin,
      contribution({ id: " prompt-enhance ", title: "  增强提示词  " }),
    );
    expect(pluginDraftActionStore.getSnapshot()[0]?.contribution.id).toBe("prompt-enhance");
    expect(pluginDraftActionStore.getSnapshot()[0]?.contribution.title).toBe("增强提示词");
    remove();
  });
});
