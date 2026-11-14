import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { ComposerPlaceholderStore } from "./model";

function installation(serverId = "host-a"): InstalledPlugin {
  return {
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({
      getLocale: () => "en",
      subscribe: () => () => {},
    }),
    id: "suggest",
    serverId,
    clientBundle: "bundle",
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    subscribe: () => {
      throw new Error("Subscriptions are not used here");
    },
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("composer placeholders", () => {
  it("shows the latest non-empty text for one agent and clears it on removal", () => {
    const store = new ComposerPlaceholderStore();
    const plugin = installation();
    const first = store.set(plugin, {
      agentId: "agent",
      text: "  Run the tests  ",
    });
    expect(store.textFor("host-a", "agent")).toBe("Run the tests");
    expect(store.textFor("host-b", "agent")).toBeNull();
    expect(store.textFor("host-a", "other")).toBeNull();

    const second = store.set(plugin, {
      agentId: "agent",
      text: "Open the diff",
    });
    expect(store.textFor("host-a", "agent")).toBe("Open the diff");

    first.update("Older suggestion");
    expect(store.textFor("host-a", "agent")).toBe("Open the diff");
    second.update("   ");
    expect(store.textFor("host-a", "agent")).toBeNull();
    second.update("Open the diff");
    expect(store.textFor("host-a", "agent")).toBe("Open the diff");

    second.remove();
    expect(store.textFor("host-a", "agent")).toBe("Older suggestion");

    first.update("   ");
    expect(store.textFor("host-a", "agent")).toBeNull();
    first.remove();
    first.update("Gone");
    expect(store.textFor("host-a", "agent")).toBeNull();
  });

  it("drops the hint when the installation stops, before plugin cleanup", () => {
    const store = new ComposerPlaceholderStore();
    const plugin = installation();
    const hint = store.set(plugin, { agentId: "agent", text: "Run the tests" });
    plugin.lifetime.abort();
    expect(store.textFor("host-a", "agent")).toBeNull();
    expect(store.getSnapshot()).toEqual([]);
    hint.update("Still here");
    expect(store.textFor("host-a", "agent")).toBeNull();

    const stopped = installation();
    stopped.lifetime.abort();
    store.set(stopped, { agentId: "agent", text: "Too late" });
    expect(store.getSnapshot()).toEqual([]);
  });

  it("rejects a missing agent and caps long text", () => {
    const store = new ComposerPlaceholderStore();
    expect(() => store.set(installation(), { agentId: "  ", text: "Next" })).toThrow(
      "Plugin composer placeholder needs an agent",
    );
    store.set(installation(), { agentId: "agent", text: "x".repeat(600) });
    expect(store.textFor("host-a", "agent")).toHaveLength(500);
  });
});
