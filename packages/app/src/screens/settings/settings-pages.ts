import type { SettingsView } from "@/navigation/settings-navigation";
import type { HostSectionSlug, SettingsSectionSlug } from "@/utils/host-routes";

export type SettingsGroupId = "you" | "agents" | "work" | "host";
export type SettingsPageId = SettingsSectionSlug | HostSectionSlug;

export type SettingsPageAvailability = "everywhere" | "desktop" | "web";

interface SettingsPageBase {
  group: SettingsGroupId;
  labelKey: string;

  sectionKeys: readonly string[];

  hintsKey: string;
  availability: SettingsPageAvailability;
}

export interface AppSettingsPage extends SettingsPageBase {
  scope: "app";
  id: SettingsSectionSlug;
}

export interface HostSettingsPage extends SettingsPageBase {
  scope: "host";
  id: HostSectionSlug;
}

export type SettingsPage = AppSettingsPage | HostSettingsPage;

export interface SettingsGroup {
  id: SettingsGroupId;
  labelKey: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: "you", labelKey: "settings.groups.you" },
  { id: "agents", labelKey: "settings.groups.agents" },
  { id: "work", labelKey: "settings.groups.work" },
  { id: "host", labelKey: "settings.groups.host" },
];

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    scope: "app",
    id: "general",
    group: "you",
    labelKey: "settings.sections.general",
    sectionKeys: [
      "settings.general.defaultSend.label",
      "settings.general.language.label",
      "settings.general.terminalScrollback.label",
    ],
    hintsKey: "settings.search.hints.general",
    availability: "everywhere",
  },
  {
    scope: "app",
    id: "appearance",
    group: "you",
    labelKey: "settings.sections.appearance",
    sectionKeys: [
      "settings.appearance.theme.title",
      "settings.appearance.detailLevel.title",
      "settings.appearance.sidebar.title",
      "settings.appearance.cards.title",
      "settings.appearance.fonts.title",
      "settings.appearance.syntax.title",
    ],
    hintsKey: "settings.search.hints.appearance",
    availability: "everywhere",
  },
  {
    scope: "app",
    id: "layout",
    group: "you",
    labelKey: "settings.layout.openInSidePane.title",
    sectionKeys: ["settings.layout.openInSidePane.title"],
    hintsKey: "settings.search.hints.layout",
    availability: "desktop",
  },
  {
    scope: "app",
    id: "sidebar",
    group: "you",
    labelKey: "settings.sections.sidebar",
    sectionKeys: ["settings.appearance.sidebar.title"],
    hintsKey: "settings.search.hints.appearance",
    availability: "everywhere",
  },
  {
    scope: "app",
    id: "chat",
    group: "you",
    labelKey: "settings.sections.chat",
    sectionKeys: ["settings.appearance.detailLevel.title"],
    hintsKey: "settings.search.hints.appearance",
    availability: "everywhere",
  },
  {
    scope: "app",
    id: "terminal",
    group: "you",
    labelKey: "settings.sections.terminal",
    sectionKeys: ["settings.general.terminalScrollback.label"],
    hintsKey: "settings.search.hints.general",
    availability: "everywhere",
  },
  {
    scope: "app",
    id: "editor",
    group: "you",
    labelKey: "settings.sections.editor",
    sectionKeys: ["settings.editor.vimKeybindings"],
    hintsKey: "settings.search.hints.editor",
    availability: "web",
  },
  {
    scope: "app",
    id: "shortcuts",
    group: "you",
    labelKey: "settings.sections.shortcuts",
    sectionKeys: [],
    hintsKey: "settings.search.hints.shortcuts",
    availability: "desktop",
  },
  {
    scope: "app",
    id: "notifications",
    group: "you",
    labelKey: "settings.sections.notifications",
    sectionKeys: ["settings.notifications.playSound", "settings.notifications.test"],
    hintsKey: "settings.search.hints.notifications",
    availability: "desktop",
  },
  {
    scope: "host",
    id: "providers",
    group: "agents",
    labelKey: "settings.hostSections.providers",
    sectionKeys: ["settings.providers.title", "settings.providers.addProvider"],
    hintsKey: "settings.search.hints.providers",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "usage",
    group: "agents",
    labelKey: "settings.hostSections.usage",
    sectionKeys: [],
    hintsKey: "settings.search.hints.usage",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "agents",
    group: "agents",
    labelKey: "settings.hostSections.agents",
    sectionKeys: [
      "settings.host.orchestration.enableTools.title",
      "settings.host.orchestration.resourcePolicy.title",
      "settings.host.orchestration.systemPrompt.title",
      "settings.host.skills.sectionTitle",
      "settings.host.agentProfiles.sectionTitle",
    ],
    hintsKey: "settings.search.hints.agents",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "system-one",
    group: "agents",
    labelKey: "settings.hostSections.systemOne",
    sectionKeys: ["settings.systemOne.title", "settings.systemOne.agentUse.title"],
    hintsKey: "settings.search.hints.systemOne",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "metadata",
    group: "agents",
    labelKey: "settings.hostSections.metadata",
    sectionKeys: ["settings.metadataGeneration.title"],
    hintsKey: "settings.search.hints.metadata",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "plugins",
    group: "agents",
    labelKey: "settings.hostSections.plugins",
    sectionKeys: ["settings.plugins.title", "settings.plugins.trustedTitle"],
    hintsKey: "settings.search.hints.plugins",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "projects",
    group: "work",
    labelKey: "settings.hostSections.projects",
    sectionKeys: [],
    hintsKey: "settings.search.hints.projects",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "workspaces",
    group: "work",
    labelKey: "settings.hostSections.workspaces",
    sectionKeys: [],
    hintsKey: "settings.search.hints.workspaces",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "linked-accounts",
    group: "work",
    labelKey: "settings.hostSections.linkedAccounts",
    sectionKeys: ["settings.linkedAccounts.github.title"],
    hintsKey: "settings.search.hints.linkedAccounts",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "host",
    group: "host",
    labelKey: "settings.hostSections.host",
    sectionKeys: ["settings.host.appearance.title", "settings.host.daemon.dangerZone"],
    hintsKey: "settings.search.hints.host",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "connections",
    group: "host",
    labelKey: "settings.hostSections.connections",
    sectionKeys: ["settings.host.connections.title"],
    hintsKey: "settings.search.hints.connections",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "pair-device",
    group: "host",
    labelKey: "openProject.tiles.pairDevice.title",
    sectionKeys: ["settings.host.pairDevices.title"],
    hintsKey: "settings.search.hints.pairDevice",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "browser",
    group: "host",
    labelKey: "settings.hostSections.browser",
    sectionKeys: ["settings.browser.title", "settings.general.browserData.title"],
    hintsKey: "settings.search.hints.browser",
    availability: "everywhere",
  },
  {
    scope: "host",
    id: "terminals",
    group: "host",
    labelKey: "settings.hostSections.terminals",
    sectionKeys: ["settings.host.terminalProfiles.sectionTitle"],
    hintsKey: "settings.search.hints.terminals",
    availability: "everywhere",
  },
  {
    scope: "app",
    id: "integrations",
    group: "host",
    labelKey: "settings.sections.integrations",
    sectionKeys: ["settings.integrations.commandLine.title"],
    hintsKey: "settings.search.hints.integrations",
    availability: "desktop",
  },
  {
    scope: "app",
    id: "permissions",
    group: "host",
    labelKey: "settings.sections.permissions",
    sectionKeys: ["settings.permissions.microphone"],
    hintsKey: "settings.search.hints.permissions",
    availability: "desktop",
  },
  {
    scope: "app",
    id: "diagnostics",
    group: "host",
    labelKey: "settings.sections.diagnostics",
    sectionKeys: ["settings.diagnostics.app.rowTitle", "settings.diagnostics.testAudio"],
    hintsKey: "settings.search.hints.diagnostics",
    availability: "everywhere",
  },
  {
    scope: "app",
    id: "about",
    group: "host",
    labelKey: "settings.sections.about",
    sectionKeys: [
      "settings.about.appVersion",
      "changelog.title",
      "settings.about.releaseChannel.label",
      "settings.about.updates.label",
      "settings.about.connectedHosts",
    ],
    hintsKey: "settings.search.hints.about",
    availability: "everywhere",
  },
];

export interface SettingsPageVisibilityInput {
  isDesktopApp: boolean;
  isWeb: boolean;

  hasHost: boolean;
}

export function resolveVisibleSettingsPages(input: SettingsPageVisibilityInput): SettingsPage[] {
  return SETTINGS_PAGES.filter((page) => {
    if (page.scope === "host" && !input.hasHost) return false;
    if (page.availability === "desktop") return input.isDesktopApp;
    if (page.availability === "web") return input.isWeb;
    return true;
  });
}

export function findSettingsPage(id: SettingsPageId): SettingsPage | null {
  return SETTINGS_PAGES.find((page) => page.id === id) ?? null;
}

export function resolveSettingsPageIdForView(view: SettingsView): SettingsPageId | null {
  switch (view.kind) {
    case "root":
      return null;
    case "section":
    case "host":
      return view.section;
    case "project":
      return "projects";
    case "plugin":
      return "plugins";
  }
}
