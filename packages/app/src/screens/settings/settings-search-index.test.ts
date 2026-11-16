import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { BROWSER_TOOLS_TITLE } from "@/screens/settings/browser-tools-config";
import {
  getSettingsSearchText,
  SETTINGS_SEARCH_INDEX,
} from "@/screens/settings/settings-search-index";

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
});
