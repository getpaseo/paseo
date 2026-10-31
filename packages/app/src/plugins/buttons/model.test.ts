import { defineTranslations } from "@getpaseo/plugin/client";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { PluginButton } from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";
import { PluginButtonStore, buttonMatches } from "./model";

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
    workspaceRowAccessories: [],
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
    header.remove();
    header.remove();
    header.update({ visible: true });
    expect(buttons.getSnapshot().map((entry) => entry.placement)).toEqual(["composer"]);
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
  expect(translated.open).toBe(true);
  expect(translated.button.title).toBe("笔记");
  expect(translated.button.behavior).toMatchObject({
    kind: "menu",
    items: [{ title: "打开笔记" }],
  });
  registration.update({ disabled: false });
  locale = "en";
  for (const listener of listeners) listener();
  expect(buttons.getSnapshot()[0].button.title).toBe("Notes");
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
