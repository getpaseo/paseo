import { describe, expect, it } from "vitest";
import { ar } from "@/i18n/resources/ar";
import { en } from "@/i18n/resources/en";
import { es } from "@/i18n/resources/es";
import { fr } from "@/i18n/resources/fr";
import { ja } from "@/i18n/resources/ja";
import { ko } from "@/i18n/resources/ko";
import { ptBR } from "@/i18n/resources/pt-BR";
import { ru } from "@/i18n/resources/ru";
import { zhCN } from "@/i18n/resources/zh-CN";
import { HOST_SECTION_SLUGS, SETTINGS_SECTION_SLUGS } from "@/utils/host-routes";
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  resolveSettingsPageIdForView,
  resolveVisibleSettingsPages,
} from "./settings-pages";

function pageIdsInGroup(groupId: string): string[] {
  return SETTINGS_PAGES.filter((page) => page.group === groupId).map((page) => page.id);
}

function lookup(resource: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (typeof node !== "object" || node === null) return undefined;
    const child: unknown = Reflect.get(node, part);
    return child;
  }, resource);
}

describe("settings pages", () => {
  it("gives every routable settings slug exactly one page", () => {
    const appIds = SETTINGS_PAGES.filter((page) => page.scope === "app").map((page) => page.id);
    const hostIds = SETTINGS_PAGES.filter((page) => page.scope === "host").map((page) => page.id);
    expect([...appIds].sort()).toEqual([...SETTINGS_SECTION_SLUGS].sort());
    expect([...hostIds].sort()).toEqual([...HOST_SECTION_SLUGS].sort());
  });

  it("groups pages the way the navigation reads", () => {
    const byGroup = Object.fromEntries(
      SETTINGS_GROUPS.map((group) => [group.id, pageIdsInGroup(group.id)]),
    );
    expect(byGroup).toEqual({
      you: [
        "general",
        "appearance",
        "layout",
        "sidebar",
        "chat",
        "terminal",
        "editor",
        "shortcuts",
        "notifications",
      ],
      agents: ["providers", "usage", "agents", "system-one", "metadata", "plugins"],
      work: ["projects", "workspaces", "linked-accounts"],
      host: [
        "host",
        "connections",
        "pair-device",
        "browser",
        "terminals",
        "integrations",
        "permissions",
        "diagnostics",
        "about",
      ],
    });
  });

  it("hides desktop, web and host pages where they cannot work", () => {
    const mobileWithoutHost = resolveVisibleSettingsPages({
      isDesktopApp: false,
      isWeb: false,
      hasHost: false,
    }).map((page) => page.id);
    expect(mobileWithoutHost).toEqual([
      "general",
      "appearance",
      "sidebar",
      "chat",
      "terminal",
      "diagnostics",
      "about",
    ]);

    const browser = resolveVisibleSettingsPages({
      isDesktopApp: false,
      isWeb: true,
      hasHost: true,
    });
    expect(browser.some((page) => page.id === "editor")).toBe(true);
    expect(browser.some((page) => page.id === "shortcuts")).toBe(false);
    expect(browser.some((page) => page.id === "providers")).toBe(true);

    const desktop = resolveVisibleSettingsPages({ isDesktopApp: true, isWeb: true, hasHost: true });
    expect(desktop).toHaveLength(SETTINGS_PAGES.length);
  });

  it("maps every settings view to the page that owns it", () => {
    expect(resolveSettingsPageIdForView({ kind: "root" })).toBeNull();
    expect(resolveSettingsPageIdForView({ kind: "section", section: "appearance" })).toBe(
      "appearance",
    );
    expect(resolveSettingsPageIdForView({ kind: "host", serverId: "s", section: "usage" })).toBe(
      "usage",
    );
    expect(resolveSettingsPageIdForView({ kind: "project", serverId: "s", projectId: "p" })).toBe(
      "projects",
    );
    expect(
      resolveSettingsPageIdForView({ kind: "plugin", serverId: "s", pluginId: "x", screenId: "y" }),
    ).toBe("plugins");
  });

  it("points every label, section and hint at a translated string", () => {
    const keys = SETTINGS_GROUPS.map((group) => group.labelKey);
    for (const page of SETTINGS_PAGES) {
      keys.push(page.labelKey, page.hintsKey, ...page.sectionKeys);
    }
    for (const resource of [en, ar, es, fr, ja, ko, ptBR, ru, zhCN]) {
      const missing = keys.filter((key) => {
        const value = lookup(resource, key);
        return typeof value !== "string" || value.trim().length === 0;
      });
      expect(missing).toEqual([]);
    }
  });
});
