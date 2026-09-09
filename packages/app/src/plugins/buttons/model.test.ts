import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { PluginButton } from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";
import { PluginButtonStore, buttonMatches } from "./model";

function installation(): InstalledPlugin {
  return {
    id: "review",
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
}

function store() {
  return new PluginButtonStore({
    validateIconName(name) {
      if (name !== "Scan") throw new Error("Unknown icon");
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
