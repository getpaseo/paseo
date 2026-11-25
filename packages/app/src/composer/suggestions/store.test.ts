import { afterEach, describe, expect, it } from "vitest";
import {
  composerSuggestionKey,
  resolveComposerSuggestion,
  useComposerSuggestionStore,
} from "./store";

const composerA = composerSuggestionKey("server-1", "agent-1");
const composerB = composerSuggestionKey("server-1", "agent-2");

afterEach(() => {
  useComposerSuggestionStore.setState({ records: {} });
});

describe("useComposerSuggestionStore", () => {
  it("falls back to the native suggestion when no plugin suggestion is active", () => {
    expect(resolveComposerSuggestion(undefined, "  Run tests  ")).toBe("Run tests");
    expect(resolveComposerSuggestion(undefined, "   ")).toBeNull();
    expect(resolveComposerSuggestion(undefined, null)).toBeNull();
  });

  it("lets a plugin suggestion override the native suggestion and restores native when cleared", () => {
    const store = useComposerSuggestionStore.getState();
    store.setPluginSuggestion({
      composerKey: composerA,
      serverId: "server-1",
      pluginId: "plugin-a",
      text: "Check CI status",
    });

    expect(
      resolveComposerSuggestion(
        useComposerSuggestionStore.getState().records[composerA],
        "Run tests",
      ),
    ).toBe("Check CI status");

    store.setPluginSuggestion({
      composerKey: composerA,
      serverId: "server-1",
      pluginId: "plugin-a",
      text: null,
    });

    expect(
      resolveComposerSuggestion(
        useComposerSuggestionStore.getState().records[composerA],
        "Run tests",
      ),
    ).toBe("Run tests");
  });

  it("prefers the most recently updated plugin suggestion and falls back on clear", () => {
    const store = useComposerSuggestionStore.getState();
    store.setPluginSuggestion({
      composerKey: composerA,
      serverId: "server-1",
      pluginId: "plugin-a",
      text: "First plugin suggestion",
    });
    store.setPluginSuggestion({
      composerKey: composerA,
      serverId: "server-1",
      pluginId: "plugin-b",
      text: "Second plugin suggestion",
    });

    expect(
      resolveComposerSuggestion(useComposerSuggestionStore.getState().records[composerA], "Native"),
    ).toBe("Second plugin suggestion");

    store.setPluginSuggestion({
      composerKey: composerA,
      serverId: "server-1",
      pluginId: "plugin-b",
      text: "   ",
    });

    expect(
      resolveComposerSuggestion(useComposerSuggestionStore.getState().records[composerA], "Native"),
    ).toBe("First plugin suggestion");
  });

  it("clears only the unloaded plugin across all composers", () => {
    const store = useComposerSuggestionStore.getState();
    store.setPluginSuggestion({
      composerKey: composerA,
      serverId: "server-1",
      pluginId: "plugin-a",
      text: "From A on 1",
    });
    store.setPluginSuggestion({
      composerKey: composerB,
      serverId: "server-1",
      pluginId: "plugin-a",
      text: "From A on 2",
    });
    store.setPluginSuggestion({
      composerKey: composerB,
      serverId: "server-1",
      pluginId: "plugin-b",
      text: "From B on 2",
    });

    store.clearPluginSuggestions("server-1", "plugin-a");

    expect(
      resolveComposerSuggestion(useComposerSuggestionStore.getState().records[composerA], "Native"),
    ).toBe("Native");
    expect(
      resolveComposerSuggestion(useComposerSuggestionStore.getState().records[composerB], "Native"),
    ).toBe("From B on 2");
  });

  it("suppresses an accepted native suggestion until the daemon clears or replaces it", () => {
    const store = useComposerSuggestionStore.getState();
    store.acceptSuggestion(composerA, "Run tests");

    expect(
      resolveComposerSuggestion(
        useComposerSuggestionStore.getState().records[composerA],
        "Run tests",
      ),
    ).toBeNull();

    // A new suggestion from the next turn is immediately visible.
    expect(
      resolveComposerSuggestion(
        useComposerSuggestionStore.getState().records[composerA],
        "Fix lint errors",
      ),
    ).toBe("Fix lint errors");

    // Once the daemon clears the native suggestion on a new turn, the same text can appear again.
    store.reconcileNativeSuggestion(composerA, null);
    expect(
      resolveComposerSuggestion(
        useComposerSuggestionStore.getState().records[composerA],
        "Run tests",
      ),
    ).toBe("Run tests");
  });

  it("consumes both active plugin and current-turn native suggestions when accepting", () => {
    const store = useComposerSuggestionStore.getState();
    store.setPluginSuggestion({
      composerKey: composerA,
      serverId: "server-1",
      pluginId: "plugin-a",
      text: "Plugin follow-up",
    });

    store.acceptSuggestion(composerA, "Native follow-up");

    expect(
      resolveComposerSuggestion(
        useComposerSuggestionStore.getState().records[composerA],
        "Native follow-up",
      ),
    ).toBeNull();
  });

  it("clears both plugin and native suggestions when a turn is submitted", () => {
    const store = useComposerSuggestionStore.getState();
    store.setPluginSuggestion({
      composerKey: composerA,
      serverId: "server-1",
      pluginId: "plugin-a",
      text: "Plugin follow-up",
    });

    store.clearComposerSuggestions(composerA, "Native follow-up");

    expect(
      resolveComposerSuggestion(
        useComposerSuggestionStore.getState().records[composerA],
        "Native follow-up",
      ),
    ).toBeNull();
  });
});
