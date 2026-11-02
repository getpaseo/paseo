import { defineRpc } from "@getpaseo/plugin";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import type { ComposerAgent, ComposerInput } from "@/composer/session";
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
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    composerItems: [],
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

function fakeAgent(context: ComposerAgent["context"]) {
  const calls: string[] = [];
  const agent: ComposerAgent = {
    context,
    provider: "claude",
    model: "sonnet",
    mode: "default",
    thinking: null,
    options: { effort: "high" },
    metadata: { flag: true },
    setProvider: async (provider) => void calls.push(`provider:${provider}`),
    setModel: async (model) => void calls.push(`model:${model}`),
    setMode: async (mode) => void calls.push(`mode:${mode}`),
    setThinking: async (thinking) => void calls.push(`thinking:${thinking}`),
    setOptions: async (patch) => void calls.push(`options:${JSON.stringify(patch)}`),
    setMetadata: async (patch: Record<string, JsonValue>) =>
      void calls.push(`metadata:${JSON.stringify(patch)}`),
  };
  return { agent, calls };
}

function fakeInput(initial: UserComposerAttachment[] = []) {
  const state = { text: "", attachments: initial };
  const input: ComposerInput = {
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
  return { input, state };
}

describe("toPluginComposer", () => {
  it("reads the agent the composer configures and the context it sits in", () => {
    const { agent } = fakeAgent("new-workspace");
    const { input } = fakeInput();
    const composer = toPluginComposer({
      plugin: installed(),
      agent,
      composerInput: input,
      prompt: "hello",
    });
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
      const composer = toPluginComposer({
        plugin: installed(),
        agent,
        composerInput: input,
        prompt: "",
      });
      await composer.setProvider("codex");
      await composer.setModel("gpt");
      await composer.setMode("plan");
      await composer.setThinking("high");
      await composer.setOptions({ effort: "low" });
      await composer.setMetadata({ flag: null });
      expect(calls).toEqual([
        "provider:codex",
        "model:gpt",
        "mode:plan",
        "thinking:high",
        'options:{"effort":"low"}',
        'metadata:{"flag":null}',
      ]);
    },
  );

  it("changes the prompt and inserts at the cursor", () => {
    const { agent } = fakeAgent("draft");
    const { input, state } = fakeInput();
    const composer = toPluginComposer({
      plugin: installed(),
      agent,
      composerInput: input,
      prompt: "",
    });
    composer.setPrompt("a");
    composer.insertText("b");
    expect(state.text).toBe("ab");
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
    const composer = toPluginComposer({
      plugin: installed(),
      agent,
      composerInput: input,
      prompt: "",
    });

    composer.addAttachment({ sourceId: "issues", item: issue });
    composer.addAttachment({ sourceId: "issues", item: issue });
    expect(state.attachments).toHaveLength(2);

    const next = toPluginComposer({
      plugin: installed(),
      agent,
      composerInput: input,
      prompt: "",
    });
    expect(next.attachments).toEqual([{ sourceId: "issues", item: issue }]);

    composer.removeAttachment({ sourceId: "issues", itemId: "ISS-1" });
    expect(state.attachments).toEqual([other]);
  });

  it("rejects an attachment from a source the plugin did not register", () => {
    const { agent } = fakeAgent("agent");
    const { input } = fakeInput();
    const composer = toPluginComposer({
      plugin: installed(),
      agent,
      composerInput: input,
      prompt: "",
    });
    expect(() => composer.addAttachment({ sourceId: "nope", item: issue })).toThrow(
      "Unknown attachment source: nope",
    );
  });
});
