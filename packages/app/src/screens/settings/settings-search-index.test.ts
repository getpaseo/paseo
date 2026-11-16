import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { getKeyboardShortcutSearchText } from "@/keyboard/keyboard-shortcuts";
import { BROWSER_TOOLS_TITLE } from "@/screens/settings/browser-tools-config";
import {
  buildSettingsSearchIndex,
  getSettingsSearchText,
  getSettingsSearchTextIndex,
} from "@/screens/settings/settings-search-index";
import type { SettingsSearchSectionSource } from "@/screens/settings/settings-search-index";

const SETTINGS_SEARCH_INDEX = buildSettingsSearchIndex([
  {
    id: "usage",
    labelKey: "settings.hostSections.usage",
    searchGroups: [{ translationPrefixes: ["providerUsage"] }],
  },
  {
    id: "shortcuts",
    labelKey: "settings.sections.shortcuts",
    searchGroups: [
      {
        translationPrefixes: [],
        getSearchText: getKeyboardShortcutSearchText,
      },
    ],
  },
  {
    id: "agents",
    labelKey: "settings.hostSections.agents",
    searchGroups: [
      {
        translationPrefixes: ["settings.host.agents.resumeOnStartup.title"],
        getSearchText: () => BROWSER_TOOLS_TITLE,
      },
      {
        id: "agents.skills",
        titleKey: "settings.host.skills.sectionTitle",
        translationPrefixes: ["settings.host.skills"],
      },
      {
        id: "agents.profiles",
        titleKey: "settings.host.agentProfiles.sectionTitle",
        translationPrefixes: ["settings.host.agentProfiles"],
      },
    ],
  },
  {
    id: "terminals",
    labelKey: "settings.hostSections.terminals",
    searchGroups: [
      {
        id: "terminals.agents",
        translationPrefixes: [],
        getSearchText: () => "Terminal agents",
      },
    ],
  },
  {
    id: "metadata",
    labelKey: "settings.hostSections.metadata",
    searchGroups: [{ translationPrefixes: ["settings.metadataGeneration"] }],
  },
  {
    id: "notifications",
    labelKey: "settings.sections.notifications",
    searchGroups: [{ translationPrefixes: ["settings.notifications"] }],
  },
  {
    id: "general",
    labelKey: "settings.sections.general",
    searchGroups: [
      { translationPrefixes: ["settings.general.language"] },
      {
        id: "general.open-location",
        titleKey: "settings.layout.openInSidePane.title",
        translationPrefixes: ["settings.layout.openInSidePane"],
      },
    ],
  },
  {
    id: "host",
    labelKey: "settings.hostSections.host",
    searchGroups: [
      {
        id: "host.danger",
        titleKey: "settings.host.daemon.dangerZone",
        translationPrefixes: ["settings.host.daemon.restart.title"],
      },
    ],
  },
] satisfies readonly SettingsSearchSectionSource[]);

function translate(key: string): string {
  const value = key.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, en);
  return typeof value === "string" ? value : key;
}

function searchText(id: string): string {
  const entry = SETTINGS_SEARCH_INDEX.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown settings search entry: ${id}`);
  return getSettingsSearchText(entry, translate);
}

describe("settings search index", () => {
  it("includes every translated leaf in a group's declared subtrees", () => {
    const usageText = searchText("usage");

    expect(usageText).toContain(en.providerUsage.title);
    expect(usageText).toContain(en.providerUsage.checkUsage);
    expect(usageText).toContain(en.providerUsage.displayAs);
    expect(searchText("shortcuts")).toContain(en.settings.shortcuts.help.openProject);
    expect(searchText("shortcuts")).not.toContain(en.settings.shortcuts.help.sendMessage);
    expect(searchText("agents")).toContain(BROWSER_TOOLS_TITLE);
    expect(searchText("agents")).not.toContain(en.settings.host.agents.resumeOnStartup.info);
    expect(searchText("agents.skills")).toContain(en.settings.host.skills.title);
    expect(searchText("agents.profiles")).toContain(en.settings.host.agentProfiles.sectionTitle);
    expect(searchText("terminals.agents")).toContain("Terminal agents");
    expect(searchText("metadata")).toContain(en.settings.metadataGeneration.title);
    expect(searchText("metadata")).not.toContain(
      en.settings.project.metadata.pullRequestPlaceholder,
    );
  });

  it("keeps split groups independent", () => {
    expect(searchText("notifications")).toContain(en.settings.notifications.playSound);
    expect(searchText("general")).not.toContain(en.settings.general.sendShortcut.label);
    expect(searchText("general.open-location")).not.toContain(
      en.settings.general.sendShortcut.label,
    );
    expect(searchText("host.danger")).toContain(en.settings.host.daemon.restart.title);
    expect(searchText("host.danger")).not.toContain(
      en.settings.host.daemon.restart.requestFailedMessage,
    );
  });

  it("caches translated search text per index and locale", () => {
    const first = getSettingsSearchTextIndex(SETTINGS_SEARCH_INDEX, "en", translate);
    const second = getSettingsSearchTextIndex(SETTINGS_SEARCH_INDEX, "en", translate);
    const otherLocale = getSettingsSearchTextIndex(SETTINGS_SEARCH_INDEX, "da", translate);

    expect(second).toBe(first);
    expect(otherLocale).not.toBe(first);
  });
});
