import { en } from "@/i18n/resources/en";
import type { HostSectionSlug, SettingsSectionSlug } from "@/utils/host-routes";

export interface SettingsSearchIndexEntry {
  id: string;
  kind: "section" | "host";
  section: SettingsSectionSlug | HostSectionSlug;
  titleKey: string;
  /** Translation subtrees rendered by this settings group. */
  translationPrefixes: readonly string[];
  /** Some settings pages own a second toolbar/search surface and cannot be inlined. */
  showInResults?: boolean;
}

type TranslationTree = Record<string, unknown>;

function collectTranslationKeys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return prefix ? [prefix] : [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];

  return Object.entries(value as TranslationTree).flatMap(([key, child]) =>
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
  return Array.from(keys, (key) => translate(key)).join(" ");
}

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchIndexEntry[] = [
  {
    id: "general",
    kind: "section",
    section: "general",
    titleKey: "settings.sections.general",
    translationPrefixes: ["settings.general.language", "settings.general.setup"],
  },
  {
    id: "general.sending",
    kind: "section",
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
    kind: "section",
    section: "general",
    titleKey: "settings.layout.openInSidePane.title",
    translationPrefixes: ["settings.layout.openInSidePane"],
  },
  {
    id: "appearance",
    kind: "section",
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
    kind: "section",
    section: "sidebar",
    titleKey: "settings.sections.sidebar",
    translationPrefixes: ["settings.appearance.sidebar"],
  },
  {
    id: "chat",
    kind: "section",
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
    kind: "section",
    section: "terminal",
    titleKey: "settings.sections.terminal",
    translationPrefixes: ["settings.general.terminalScrollback"],
  },
  {
    id: "browser",
    kind: "section",
    section: "browser",
    titleKey: "settings.sections.browser",
    translationPrefixes: ["settings.general.browserData"],
  },
  {
    id: "editor",
    kind: "section",
    section: "editor",
    titleKey: "settings.sections.editor",
    translationPrefixes: ["settings.editor"],
  },
  {
    id: "files",
    kind: "section",
    section: "files",
    titleKey: "settings.sections.files",
    translationPrefixes: ["settings.files"],
  },
  {
    id: "shortcuts",
    kind: "section",
    section: "shortcuts",
    titleKey: "settings.sections.shortcuts",
    translationPrefixes: ["settings.shortcuts"],
  },
  {
    id: "integrations",
    kind: "section",
    section: "integrations",
    titleKey: "settings.sections.integrations",
    translationPrefixes: ["settings.integrations"],
  },
  {
    id: "notifications",
    kind: "section",
    section: "notifications",
    titleKey: "settings.sections.notifications",
    translationPrefixes: ["settings.notifications"],
  },
  {
    id: "permissions",
    kind: "section",
    section: "permissions",
    titleKey: "settings.sections.permissions",
    translationPrefixes: ["settings.permissions"],
  },
  {
    id: "diagnostics",
    kind: "section",
    section: "diagnostics",
    titleKey: "settings.sections.diagnostics",
    translationPrefixes: ["settings.diagnostics"],
  },
  {
    id: "about",
    kind: "section",
    section: "about",
    titleKey: "settings.sections.about",
    translationPrefixes: ["settings.about"],
  },
  {
    id: "host",
    kind: "host",
    section: "host",
    titleKey: "settings.hostSections.host",
    translationPrefixes: ["settings.host"],
  },
  {
    id: "projects",
    kind: "host",
    section: "projects",
    titleKey: "settings.hostSections.projects",
    translationPrefixes: ["settings.projects"],
  },
  {
    id: "connections",
    kind: "host",
    section: "connections",
    titleKey: "settings.hostSections.connections",
    translationPrefixes: ["settings.host.connections"],
  },
  {
    id: "pair-device",
    kind: "host",
    section: "pair-device",
    titleKey: "openProject.tiles.pairDevice.title",
    translationPrefixes: ["settings.host.pairDevices", "openProject.tiles.pairDevice"],
  },
  {
    id: "agents",
    kind: "host",
    section: "agents",
    titleKey: "settings.hostSections.agents",
    translationPrefixes: ["settings.host.agents"],
  },
  {
    id: "metadata",
    kind: "host",
    section: "metadata",
    titleKey: "settings.hostSections.metadata",
    translationPrefixes: ["settings.project.metadata"],
  },
  {
    id: "voice",
    kind: "host",
    section: "voice",
    titleKey: "settings.hostSections.voice",
    translationPrefixes: ["settings.voice"],
  },
  {
    id: "workspaces",
    kind: "host",
    section: "workspaces",
    titleKey: "settings.hostSections.workspaces",
    translationPrefixes: ["settings.host.workspaces"],
  },
  {
    id: "providers",
    kind: "host",
    section: "providers",
    titleKey: "settings.hostSections.providers",
    translationPrefixes: ["settings.providers"],
  },
  {
    id: "usage",
    kind: "host",
    section: "usage",
    titleKey: "settings.hostSections.usage",
    translationPrefixes: ["providerUsage"],
  },
  {
    id: "terminals",
    kind: "host",
    section: "terminals",
    titleKey: "settings.hostSections.terminals",
    translationPrefixes: ["settings.host.terminalProfiles"],
  },
  {
    id: "plugins",
    kind: "host",
    section: "plugins",
    titleKey: "settings.hostSections.plugins",
    translationPrefixes: ["settings.plugins"],
    showInResults: false,
  },
];
