import { defineTranslations } from "@getpaseo/plugin/client";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { PluginButton } from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";
import { PluginButtonStore, buttonMatches, globalButtonMatches } from "./model";

function installation(): InstalledPlugin {
  return {
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    id: "review",
    serverId: "host-a",
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
    sidebarViews: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    workspaceRowBadgeItems: [],
    filePanels: [],
    composerItems: [],
    newWorkspaceItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

function store() {
  return new PluginButtonStore({
    parseIcon(icon) {
      if (icon !== "Scan") throw new Error("Unknown icon");
      return icon;
    },
  });
}

function button(onPress = () => {}): PluginButton {
  return { title: "Review", icon: "Scan", behavior: { kind: "action", onPress } };
}

describe("plugin buttons", () => {
  it("shows a composer toolbar button in every composer on its host and nowhere else", () => {
    const buttons = store();
    const plugin = installation();
    const toolbar = buttons.addComposerToolbarButton(plugin, { id: "expand", button: button() });
    const [entry] = buttons.getSnapshot();

    expect(globalButtonMatches(entry, "composer-toolbar", "host-a")).toBe(true);
    expect(globalButtonMatches(entry, "composer-toolbar", "host-b")).toBe(false);
    expect(buttonMatches(entry, "host-a", "workspace", "agent")).toBe(false);
    expect(buttonMatches(entry, "host-a", "workspace", null)).toBe(false);
    expect(globalButtonMatches(entry, "vertical-bar", "host-a")).toBe(false);
    expect(() =>
      buttons.addComposerToolbarButton(plugin, { id: "expand", button: button() }),
    ).toThrow("Duplicate plugin button: expand");

    toolbar.update({ visible: false });
    expect(globalButtonMatches(buttons.getSnapshot()[0], "composer-toolbar", "host-a")).toBe(false);
    toolbar.remove();
    expect(buttons.getSnapshot()).toEqual([]);
  });

  it("registers timeline buttons separately and reserves timeline behavior for them", () => {
    const buttons = store();
    const plugin = installation();
    buttons.addTimelineButton(plugin, {
      id: "last-user-message",
      button: {
        title: "Last user message",
        icon: "Scan",
        behavior: { kind: "timeline", target: "last-user-message" },
      },
    });

    const [entry] = buttons.getSnapshot();
    expect(globalButtonMatches(entry, "timeline", "host-a")).toBe(true);
    expect(globalButtonMatches(entry, "composer-toolbar", "host-a")).toBe(false);
    expect(() =>
      buttons.addComposerToolbarButton(plugin, {
        id: "invalid-timeline",
        button: {
          title: "Invalid timeline",
          icon: "Scan",
          behavior: { kind: "timeline", target: "last-user-message" },
        },
      }),
    ).toThrow("Plugin timeline behavior needs a timeline button");
  });

  it("updates visibility in place, closes hidden content, and scopes each placement", () => {
    const buttons = store();
    const plugin = installation();
    const header = buttons.addHeaderButton(plugin, {
      id: "review",
      workspaceId: "workspace",
      button: button(),
    });
    buttons.addComposerPill(plugin, {
      id: "review",
      workspaceId: "workspace",
      agentId: "agent",
      button: button(),
    });
    const first = buttons.getSnapshot()[0];
    expect(buttonMatches(first, "host-a", "workspace", null)).toBe(true);
    expect(buttonMatches(first, "host-b", "workspace", null)).toBe(false);
    expect(buttonMatches(first, "host-a", "another-workspace", null)).toBe(false);
    expect(buttonMatches(first, "host-a", "workspace", "agent")).toBe(false);
    expect(buttonMatches(buttons.getSnapshot()[1], "host-a", "workspace", "agent")).toBe(true);
    expect(buttonMatches(buttons.getSnapshot()[1], "host-a", "workspace", "other-agent")).toBe(
      false,
    );
    buttons.setOpen(first.key, true);
    header.update({ visible: false, label: "3 reviews" });
    expect(buttonMatches(buttons.getSnapshot()[0], "host-a", "workspace", null)).toBe(false);
    expect(buttons.getSnapshot()[0].open).toBe(false);
    header.update({ visible: true });
    expect(buttons.getSnapshot().map((entry) => entry.key)).toEqual([first.key, first.key + 1]);
    expect(buttons.getSnapshot()[0].button.label).toBe("3 reviews");
    expect(buttons.getSnapshot()[0].behaviorRevision).toBe(0);
    header.remove();
    header.remove();
    header.update({ visible: true });
    expect(buttons.getSnapshot().map((entry) => entry.placement)).toEqual(["composer"]);
  });

  it("keeps a vertical bar button separate from a toolbar button with the same id", () => {
    const buttons = store();
    const plugin = installation();
    buttons.addComposerToolbarButton(plugin, { id: "expand", button: button() });
    buttons.addVerticalBarButton(plugin, { id: "expand", button: button() });
    const [toolbar, bar] = buttons.getSnapshot();

    expect(globalButtonMatches(bar, "vertical-bar", "host-a")).toBe(true);
    expect(globalButtonMatches(bar, "composer-toolbar", "host-a")).toBe(false);
    expect(globalButtonMatches(toolbar, "vertical-bar", "host-a")).toBe(false);
  });

  it("rejects duplicates within a target and validates updates atomically", () => {
    const buttons = store();
    const plugin = installation();
    const contribution = { id: "review", workspaceId: "workspace", button: button() };
    const header = buttons.addHeaderButton(plugin, contribution);
    expect(() => buttons.addHeaderButton(plugin, contribution)).toThrow(
      "Duplicate plugin button: review",
    );
    expect(() => buttons.addHeaderButton(installation(), contribution)).not.toThrow();
    expect(() =>
      buttons.addHeaderButton(plugin, { ...contribution, workspaceId: "other" }),
    ).not.toThrow();
    expect(() => header.update({ title: "Changed", icon: "Invalid" })).toThrow("Unknown icon");
    expect(buttons.getSnapshot()[0].button.title).toBe("Review");
  });

  it("prevents repeated presses and cannot resurrect a removed pending button", async () => {
    const buttons = store();
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const registration = buttons.addHeaderButton(installation(), {
      id: "review",
      workspaceId: "workspace",
      button: button(() => {
        calls++;
        return pending;
      }),
    });
    const key = buttons.getSnapshot()[0].key;
    const action = buttons.run(key);
    await buttons.run(key);
    expect(calls).toBe(1);
    expect(buttons.getSnapshot()[0].pending).toBe(true);
    registration.remove();
    finish();
    await action;
    expect(buttons.getSnapshot()).toEqual([]);
  });

  it("allows retry after failure and respects disabled actions and menu ancestors", async () => {
    const buttons = store();
    let calls = 0;
    const registration = buttons.addHeaderButton(installation(), {
      id: "review",
      workspaceId: "workspace",
      button: button(() => {
        if (++calls === 1) throw new Error("Review unavailable");
      }),
    });
    const key = buttons.getSnapshot()[0].key;
    await expect(buttons.run(key)).rejects.toThrow("Review unavailable");
    expect(buttons.getSnapshot()[0].pending).toBe(false);
    await buttons.run(key);
    expect(calls).toBe(2);
    registration.update({ disabled: true });
    await buttons.run(key);
    expect(calls).toBe(2);
    registration.update({
      disabled: false,
      behavior: {
        kind: "menu",
        items: [
          {
            kind: "item",
            id: "nested",
            title: "Nested",
            disabled: true,
            behavior: {
              kind: "menu",
              items: [
                {
                  kind: "item",
                  id: "run",
                  title: "Run",
                  behavior: {
                    kind: "action",
                    onPress() {
                      calls++;
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    await buttons.run(key, ["nested", "run"]);
    expect(calls).toBe(2);
  });

  it("keeps an open menu across a label update and closes it when behavior is replaced", () => {
    const buttons = store();
    const registration = buttons.addHeaderButton(installation(), {
      id: "review",
      workspaceId: "workspace",
      button: button(),
    });
    const key = buttons.getSnapshot()[0].key;
    buttons.setOpen(key, true);
    const before = buttons.getSnapshot()[0];
    registration.update({ label: "3 reviews" });
    const labeled = buttons.getSnapshot()[0];
    expect(labeled.button.behavior).not.toBe(before.button.behavior);
    expect(labeled.button.label).toBe("3 reviews");
    expect(labeled.open).toBe(true);
    expect(labeled.behaviorRevision).toBe(before.behaviorRevision);
    registration.update({
      behavior: { kind: "action", onPress() {} },
    });
    const replaced = buttons.getSnapshot()[0];
    expect(replaced.open).toBe(false);
    expect(replaced.behaviorRevision).toBe(before.behaviorRevision + 1);
  });
});

it("updates translated tooltips and nested menu labels without closing open content", () => {
  let locale = "en";
  const listeners = new Set<() => void>();
  const plugin = installation();
  plugin.i18n.dispose();
  plugin.i18n = new PluginTranslationRuntime({
    getLocale: () => locale,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const translations = defineTranslations({
    resources: {
      en: { title: "Notes", menu: "Open notes" },
      "zh-CN": { title: "笔记", menu: "打开笔记" },
    },
  });
  const buttons = store();
  const registration = buttons.addHeaderButton(plugin, {
    id: "notes",
    workspaceId: "workspace",
    button: {
      title: translations.message("title"),
      icon: "Scan",
      behavior: {
        kind: "menu",
        items: [
          {
            kind: "item",
            id: "open",
            title: translations.message("menu"),
            behavior: { kind: "action", onPress() {} },
          },
        ],
      },
    },
  });
  const original = buttons.getSnapshot()[0];
  buttons.setOpen(original.key, true);
  locale = "zh-CN";
  for (const listener of listeners) listener();
  const translated = buttons.getSnapshot()[0];
  expect(translated.key).toBe(original.key);
  expect(translated.button.behavior).not.toBe(original.button.behavior);
  expect(translated.open).toBe(true);
  expect(translated.behaviorRevision).toBe(original.behaviorRevision);
  expect(translated.button.title).toBe("笔记");
  expect(translated.button.behavior).toMatchObject({
    kind: "menu",
    items: [{ title: "打开笔记" }],
  });
  registration.update({ disabled: false });
  expect(buttons.getSnapshot()[0].open).toBe(true);
  expect(buttons.getSnapshot()[0].behaviorRevision).toBe(original.behaviorRevision);
  locale = "en";
  for (const listener of listeners) listener();
  expect(buttons.getSnapshot()[0].button.title).toBe("Notes");
  expect(buttons.getSnapshot()[0].open).toBe(true);
  expect(buttons.getSnapshot()[0].behaviorRevision).toBe(original.behaviorRevision);
  registration.remove();
  plugin.i18n.dispose();
  expect(listeners.size).toBe(0);
  expect(buttons.getSnapshot()).toEqual([]);
});

it("keeps the previous descriptor after rejecting an invalid update", () => {
  const buttons = store();
  const plugin = installation();
  const registration = buttons.addHeaderButton(plugin, {
    id: "review",
    workspaceId: "workspace",
    button: button(),
  });
  expect(() => registration.update({ title: "" })).toThrow("Plugin button needs title");
  expect(() => registration.update({ disabled: true })).not.toThrow();
  expect(buttons.getSnapshot()[0].button.title).toBe("Review");
  registration.remove();
  plugin.i18n.dispose();
});
