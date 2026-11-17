import { defineRpc } from "@getpaseo/plugin";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import { composerModelFromHalves } from "@/composer/halves-model";
import type { ComposerAgent, ComposerInput } from "@/composer/session";
import {
  setCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "@/utils/command-center-focus-restore";
import type { InstalledPlugin } from "../types";
import { toPluginComposer } from "./model";

function installed(): InstalledPlugin {
  return {
    id: "review",
    serverId: "host-1",
    clientBundle: "bundle",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    subscribe: () => {
      throw new Error("Subscriptions are not used here");
    },
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    sidebarViews: [],
    filePanels: [],
    composerItems: [],
    newWorkspaceItems: [],
    workspaceRowBadgeItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [
      {
        id: "issues",
        title: "Issues",
        pickerTitle: "Issues",
        searchPlaceholder: "Search issues",
        icon: "Bug",
        search: defineRpc({
          name: "issues.search",
          input: z.object({}),
          output: z.array(z.object({})),
        }),
      },
    ],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

const issue = {
  id: "ISS-1",
  identifier: "ISS-1",
  title: "Fix it",
  url: "https://example.com/ISS-1",
  text: "Fix it",
  resourceType: "issue",
};

function fakeAgent(context: ComposerAgent["context"], locked = false) {
  const calls: string[] = [];
  const agent: ComposerAgent = {
    context,
    locked,
    isLocked: () => locked,
    provider: "claude",
    model: "sonnet",
    mode: "default",
    thinking: null,
    options: { effort: "high" },
    metadata: { flag: true },
    // A running agent keeps its provider, as the real adapter does.
    setProvider: async (provider) => {
      if (context === "agent") throw new Error("A running agent cannot change provider.");
      calls.push(`provider:${provider}`);
    },
    setModel: async (model) => void calls.push(`model:${model}`),
    setMode: async (mode) => void calls.push(`mode:${mode}`),
    setThinking: async (thinking) => void calls.push(`thinking:${thinking}`),
    setOptions: async (patch) => void calls.push(`options:${JSON.stringify(patch)}`),
    setMetadata: async (patch: Record<string, JsonValue>) =>
      void calls.push(`metadata:${JSON.stringify(patch)}`),
  };
  return { agent, calls };
}

function fakeInput(initial: UserComposerAttachment[] = [], locked = false) {
  const state = { text: "", attachments: initial };
  const view = { revealed: true, focused: [] as unknown[] };
  const input: ComposerInput = {
    locked,
    isLocked: () => locked,
    isLive: () => true,
    revealed: true,
    isRevealed: () => view.revealed,
    focus: async (options) => {
      view.focused.push(options);
    },
    textSource: { getSnapshot: () => state.text, subscribe: () => () => {} },
    setText: (text) => {
      state.text = text;
    },
    insertText: (text) => {
      state.text += text;
    },
    get attachments() {
      return state.attachments;
    },
    changeAttachments: (updater) => {
      state.attachments = updater(state.attachments);
    },
  };
  return { input, state, view };
}

function compose(agent: ComposerAgent, input: ComposerInput) {
  const model = composerModelFromHalves({ agent, input });
  return toPluginComposer({ plugin: installed(), model, state: model.getState() });
}

describe("toPluginComposer", () => {
  it("reads the agent the composer configures and the context it sits in", () => {
    const { agent } = fakeAgent("new-workspace");
    const { input, state } = fakeInput();
    state.text = "hello";
    const composer = compose(agent, input);
    expect(composer.context).toBe("new-workspace");
    expect(composer.prompt).toBe("hello");
    expect(composer.agent).toEqual({
      provider: "claude",
      model: "sonnet",
      mode: "default",
      thinking: null,
      options: { effort: "high" },
      metadata: { flag: true },
    });
  });

  it.each(["agent", "draft"] as const)(
    "sends every command to the %s composer's agent",
    async (context) => {
      const { agent, calls } = fakeAgent(context);
      const { input } = fakeInput();
      const composer = compose(agent, input);
      await composer.setModel("gpt");
      await composer.setMode("plan");
      await composer.setThinking("high");
      await composer.setOptions({ effort: "low" });
      await composer.setMetadata({ flag: null });
      expect(calls).toEqual([
        "model:gpt",
        "mode:plan",
        "thinking:high",
        'options:{"effort":"low"}',
        'metadata:{"flag":null}',
      ]);
    },
  );

  it("lets a draft change provider and tells a running agent it cannot", async () => {
    const { input } = fakeInput();
    const draft = fakeAgent("draft");
    await compose(draft.agent, input).setProvider("codex");
    expect(draft.calls).toEqual(["provider:codex"]);

    const running = fakeAgent("agent");
    await expect(compose(running.agent, input).setProvider("codex")).rejects.toThrow(
      "A running agent cannot change provider.",
    );
    expect(running.calls).toEqual([]);
  });

  it("changes the prompt and inserts at the cursor", () => {
    const { agent } = fakeAgent("draft");
    const { input, state } = fakeInput();
    const composer = compose(agent, input);
    composer.setPrompt("a");
    composer.insertText("b");
    expect(state.text).toBe("ab");
  });

  it("refuses every prompt and agent command while the composer is locked", async () => {
    const { agent, calls } = fakeAgent("new-workspace", true);
    const { input, state } = fakeInput([], true);
    const composer = compose(agent, input);

    expect(() => composer.setPrompt("a")).toThrow("The composer is locked");
    expect(() => composer.insertText("b")).toThrow("The composer is locked");
    expect(() => composer.addAttachment({ sourceId: "issues", item: issue })).toThrow(
      "The composer is locked",
    );
    await expect(composer.setProvider("codex")).rejects.toThrow("The composer is locked");
    await expect(composer.setModel("gpt")).rejects.toThrow("The composer is locked");
    await expect(composer.setMode("plan")).rejects.toThrow("The composer is locked");
    await expect(composer.setThinking("high")).rejects.toThrow("The composer is locked");
    await expect(composer.setOptions({ effort: "low" })).rejects.toThrow("The composer is locked");
    await expect(composer.setMetadata({ flag: null })).rejects.toThrow("The composer is locked");
    expect(state.text).toBe("");
    expect(calls).toEqual([]);
  });

  it("refuses a command a plugin kept from before the composer locked", async () => {
    const { agent } = fakeAgent("new-workspace");
    const { input } = fakeInput();
    const composer = compose(agent, input);

    // The plugin's action was awaiting an RPC when the user submitted.
    const lock = { locked: true };
    agent.isLocked = () => lock.locked;
    input.isLocked = () => lock.locked;

    expect(() => composer.insertText("late")).toThrow("The composer is locked");
    expect(() => composer.addAttachment({ sourceId: "issues", item: issue })).toThrow(
      "The composer is locked",
    );
    expect(() => composer.removeAttachment({ sourceId: "issues", itemId: issue.id })).toThrow(
      "The composer is locked",
    );
    await expect(composer.setOptions({ effort: "low" })).rejects.toThrow("The composer is locked");
  });

  it("focuses the input of the draft composer on screen, with the selection asked for", async () => {
    const { agent } = fakeAgent("draft");
    const { input, view } = fakeInput();
    const composer = compose(agent, input);

    await composer.focus({ selection: { start: 0, end: 4 } });

    expect(view.focused).toEqual([{ selection: { start: 0, end: 4 } }]);
  });

  it("rejects focus on a draft composer that is not on screen, leaving the user where they are", async () => {
    const { agent } = fakeAgent("draft");
    const { input, view } = fakeInput();
    view.revealed = false;
    const composer = compose(agent, input);

    await expect(composer.focus()).rejects.toThrow("not on screen");
    expect(view.focused).toEqual([]);
  });

  it("focuses while the composer is locked, since the cursor changes nothing it holds", async () => {
    const { agent } = fakeAgent("new-workspace");
    const { input, view } = fakeInput([], true);
    const composer = compose(agent, input);

    await composer.focus();

    expect(view.focused).toEqual([undefined]);
  });

  it("keeps the Command Center from taking focus back when it closes", async () => {
    const { agent } = fakeAgent("draft");
    const { input } = fakeInput();
    const composer = compose(agent, input);
    setCommandCenterFocusRestoreElement({} as HTMLElement);

    await composer.focus();

    expect(takeCommandCenterFocusRestoreElement()).toBeNull();
  });

  it("hands out options and metadata a plugin cannot change", () => {
    const { agent } = fakeAgent("draft");
    agent.metadata = { nested: { list: [1] } };
    const { input } = fakeInput();
    const composer = compose(agent, input);

    expect(Object.isFrozen(composer.agent.options)).toBe(true);
    expect(Object.isFrozen(composer.agent.metadata)).toBe(true);
    expect(Object.isFrozen((composer.agent.metadata as { nested: object }).nested)).toBe(true);
    expect(agent.metadata).toEqual({ nested: { list: [1] } });
    expect(Object.isFrozen(agent.metadata)).toBe(false);
  });

  it("hands out attachment items a plugin cannot change", () => {
    const { agent } = fakeAgent("draft");
    const { input, state } = fakeInput();
    const handedIn = { ...issue };
    compose(agent, input).addAttachment({ sourceId: "issues", item: handedIn });
    // The draft keeps its own copy, so the object the plugin handed in is not the draft's.
    handedIn.title = "Changed after adding";

    const [attachment] = compose(agent, input).attachments;

    expect(attachment.item).toEqual(issue);
    expect(Object.isFrozen(attachment.item)).toBe(true);
    const [stored] = state.attachments;
    expect(stored.kind === "plugin_resource" && Object.isFrozen(stored.item)).toBe(false);
  });

  it("hands the composer its own copy of the options and metadata a plugin sets", async () => {
    const { agent } = fakeAgent("draft");
    const kept: Record<string, unknown> = {};
    agent.setOptions = async (patch) => void (kept.options = patch);
    agent.setMetadata = async (patch) => void (kept.metadata = patch);
    const { input } = fakeInput();
    const composer = compose(agent, input);

    const sandbox = { mode: "read-only" };
    const linked = { id: "ISS-1" };
    await composer.setOptions({ sandbox });
    await composer.setMetadata({ linked });
    sandbox.mode = "full-access";
    linked.id = "ISS-2";

    expect(kept.options).toEqual({ sandbox: { mode: "read-only" } });
    expect(kept.metadata).toEqual({ linked: { id: "ISS-1" } });
  });

  it("adds and removes the plugin's own attachments only", () => {
    const { agent } = fakeAgent("agent");
    const other: UserComposerAttachment = {
      kind: "plugin_resource",
      pluginId: "other",
      sourceId: "issues",
      sourceTitle: "Issues",
      sourceIcon: "Bug",
      item: issue,
    };
    const { input, state } = fakeInput([other]);
    const composer = compose(agent, input);

    composer.addAttachment({ sourceId: "issues", item: issue });
    composer.addAttachment({ sourceId: "issues", item: issue });
    expect(state.attachments).toHaveLength(2);

    const next = compose(agent, input);
    expect(next.attachments).toEqual([{ sourceId: "issues", item: issue }]);

    composer.removeAttachment({ sourceId: "issues", itemId: "ISS-1" });
    expect(state.attachments).toEqual([other]);
  });

  it("rejects an attachment from a source the plugin did not register", () => {
    const { agent } = fakeAgent("agent");
    const { input } = fakeInput();
    const composer = compose(agent, input);
    expect(() => composer.addAttachment({ sourceId: "nope", item: issue })).toThrow(
      "Unknown attachment source: nope",
    );
  });
});
