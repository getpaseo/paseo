import { en } from "@/i18n/resources/en";
import { getKeyboardShortcutSearchText } from "@/keyboard/keyboard-shortcuts";
import {
  BROWSER_TOOLS_TITLE,
  BROWSER_TOOLS_WARNING,
} from "@/screens/settings/browser-tools-config";
import type { HostSectionSlug, SettingsSectionSlug } from "@/utils/host-routes";

/** Search spans both settings route namespaces; host routes remain separate because they carry a server id. */
export type SettingsSearchSectionSlug = SettingsSectionSlug | HostSectionSlug;

export interface SettingsSearchIndexEntry {
  id: string;
  section: SettingsSearchSectionSlug;
  titleKey: string;
  /** Translation subtrees rendered by this settings group. */
  translationPrefixes: readonly string[];
  /** Additional text derived from dynamic UI data rendered by this settings group. */
  getSearchText?: (translate: (key: string) => string) => string;
  /** Use sidebar-only when a page owns its own navigation surface and cannot be embedded safely. */
  resultMode?: "sidebar-only";
}

function isTranslationTree(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectTranslationKeys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return prefix ? [prefix] : [];
  if (!isTranslationTree(value)) return [];

  return Object.entries(value).flatMap(([key, child]) =>
    collectTranslationKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

const TRANSLATION_KEYS = collectTranslationKeys(en);

function isUnderPrefix(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}.`);
}

/**
 * Builds searchable text from the same translation resource used by the UI.
 * Groups declare ownership of translation subtrees; individual labels do not
 * need to be copied into a second, failure-prone list.
 */
export function getSettingsSearchText(
  entry: SettingsSearchIndexEntry,
  translate: (key: string) => string,
): string {
  const keys = new Set<string>([entry.titleKey]);
  for (const prefix of entry.translationPrefixes) {
    for (const key of TRANSLATION_KEYS) {
      if (isUnderPrefix(key, prefix)) keys.add(key);
    }
  }
  const text = Array.from(keys, (key) => translate(key));
  if (entry.getSearchText) text.push(entry.getSearchText(translate));
  return text.join(" ");
}

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchIndexEntry[] = [
  {
    id: "general",
    section: "general",
    titleKey: "settings.sections.general",
    translationPrefixes: ["settings.general.language", "settings.general.setup"],
  },
  {
    id: "general.sending",
    section: "general",
    titleKey: "settings.general.sending",
    translationPrefixes: [
      "settings.general.sending",
      "settings.general.sendShortcut",
      "settings.general.defaultSend",
    ],
  },
  {
    id: "general.open-location",
    section: "general",
    titleKey: "settings.layout.openInSidePane.title",
    translationPrefixes: ["settings.layout.openInSidePane"],
  },
  {
    id: "appearance",
    section: "appearance",
    titleKey: "settings.sections.appearance",
    translationPrefixes: [
      "settings.appearance.theme",
      "settings.appearance.fonts",
      "settings.appearance.layout",
      "settings.appearance.syntax",
    ],
  },
  {
    id: "sidebar",
    section: "sidebar",
    titleKey: "settings.sections.sidebar",
    translationPrefixes: ["settings.appearance.sidebar"],
  },
  {
    id: "chat",
    section: "chat",
    titleKey: "settings.sections.chat",
    translationPrefixes: [
      "settings.appearance.detailLevel",
      "settings.general.autoExpandReasoning",
      "settings.general.chatDisplay",
      "settings.appearance.chatOutline",
    ],
  },
  {
    id: "terminal",
    section: "terminal",
    titleKey: "settings.sections.terminal",
    translationPrefixes: ["settings.general.terminalScrollback"],
  },
  {
    id: "browser",
    section: "browser",
    titleKey: "settings.sections.browser",
    translationPrefixes: ["settings.general.browserData"],
  },
  {
    id: "editor",
    section: "editor",
    titleKey: "settings.sections.editor",
    translationPrefixes: ["settings.editor"],
  },
  {
    id: "files",
    section: "files",
    titleKey: "settings.sections.files",
    translationPrefixes: ["settings.files"],
  },
  {
    id: "shortcuts",
    section: "shortcuts",
    titleKey: "settings.sections.shortcuts",
    translationPrefixes: [],
    getSearchText: getKeyboardShortcutSearchText,
  },
  {
    id: "integrations",
    section: "integrations",
    titleKey: "settings.sections.integrations",
    translationPrefixes: ["settings.integrations"],
  },
  {
    id: "notifications",
    section: "notifications",
    titleKey: "settings.sections.notifications",
    translationPrefixes: ["settings.notifications"],
  },
  {
    id: "permissions",
    section: "permissions",
    titleKey: "settings.sections.permissions",
    translationPrefixes: ["settings.permissions"],
  },
  {
    id: "diagnostics",
    section: "diagnostics",
    titleKey: "settings.sections.diagnostics",
    translationPrefixes: ["settings.diagnostics"],
  },
  {
    id: "about",
    section: "about",
    titleKey: "settings.sections.about",
    translationPrefixes: ["settings.about"],
  },
  {
    id: "host",
    section: "host",
    titleKey: "settings.hostSections.host",
    translationPrefixes: [],
  },
  {
    id: "host.appearance",
    section: "host",
    titleKey: "settings.host.appearance.title",
    translationPrefixes: ["settings.host.appearance"],
  },
  {
    id: "host.danger",
    section: "host",
    titleKey: "settings.host.daemon.dangerZone",
    translationPrefixes: [
      "settings.host.daemon.restart.title",
      "settings.host.daemon.restart.hint",
      "settings.host.daemon.restart.confirm",
      "settings.host.daemon.restart.restarting",
      "settings.host.daemon.restart.closeTerminals",
      "settings.host.daemon.restart.closeTerminalsHint",
      "settings.host.daemon.remove.title",
      "settings.host.daemon.remove.localTitle",
      "settings.host.daemon.remove.hint",
      "settings.host.daemon.remove.localHint",
      "settings.host.connections.removeAction",
    ],
  },
  {
    id: "projects",
    section: "projects",
    titleKey: "settings.hostSections.projects",
    translationPrefixes: ["settings.projects"],
  },
  {
    id: "connections",
    section: "connections",
    titleKey: "settings.hostSections.connections",
    translationPrefixes: ["settings.host.connections"],
  },
  {
    id: "pair-device",
    section: "pair-device",
    titleKey: "openProject.tiles.pairDevice.title",
    translationPrefixes: ["settings.host.pairDevices", "openProject.tiles.pairDevice"],
  },
  {
    id: "agents",
    section: "agents",
    titleKey: "settings.hostSections.agents",
    translationPrefixes: [
      "settings.host.orchestration.enableTools",
      "settings.host.orchestration.systemPrompt.title",
      "settings.host.orchestration.systemPrompt.hint",
      "settings.host.orchestration.systemPrompt.edit",
      "settings.host.agents.resumeOnStartup.title",
      "settings.host.agents.resumeOnStartup.hint",
      "settings.host.agents.resumeOnStartup.edit",
      "settings.host.agents.idleRuntimeCleanup.title",
      "settings.host.agents.idleRuntimeCleanup.hint",
    ],
    getSearchText: () => `${BROWSER_TOOLS_TITLE} ${BROWSER_TOOLS_WARNING}`,
  },
  {
    id: "agents.skills",
    section: "agents",
    titleKey: "settings.host.skills.sectionTitle",
    translationPrefixes: ["settings.host.skills"],
  },
  {
    id: "agents.profiles",
    section: "agents",
    titleKey: "settings.host.agentProfiles.sectionTitle",
    translationPrefixes: ["settings.host.agentProfiles"],
  },
  {
    id: "metadata",
    section: "metadata",
    titleKey: "settings.hostSections.metadata",
    translationPrefixes: ["settings.project.metadata"],
  },
  {
    id: "voice",
    section: "voice",
    titleKey: "settings.hostSections.voice",
    translationPrefixes: ["settings.voice"],
  },
  {
    id: "workspaces",
    section: "workspaces",
    titleKey: "settings.hostSections.workspaces",
    translationPrefixes: ["settings.host.workspaces"],
  },
  {
    id: "providers",
    section: "providers",
    titleKey: "settings.hostSections.providers",
    translationPrefixes: ["settings.providers"],
  },
  {
    id: "usage",
    section: "usage",
    titleKey: "settings.hostSections.usage",
    translationPrefixes: ["providerUsage"],
  },
  {
    id: "terminals",
    section: "terminals",
    titleKey: "settings.hostSections.terminals",
    translationPrefixes: ["settings.host.terminalProfiles"],
  },
  {
    id: "plugins",
    section: "plugins",
    titleKey: "settings.hostSections.plugins",
    translationPrefixes: ["settings.plugins"],
    // The plugin gallery has its own search and navigation surface.
    resultMode: "sidebar-only",
  },
];
