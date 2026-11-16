import { en } from "@/i18n/resources/en";
import type { HostSectionSlug, SettingsSectionSlug } from "@/utils/host-routes";

/** Search spans both settings route namespaces; host routes remain separate because they carry a server id. */
export type SettingsSearchSectionSlug = SettingsSectionSlug | HostSectionSlug;

export interface SettingsSearchGroup {
  id?: string;
  titleKey?: string;
  /** Translation subtrees rendered by this settings group. */
  translationPrefixes: readonly string[];
  /** Additional text derived from dynamic UI data rendered by this settings group. */
  getSearchText?: (translate: (key: string) => string) => string;
  /** Use sidebar-only when a page owns its own navigation surface and cannot be embedded safely. */
  resultMode?: "sidebar-only";
}

export interface SettingsSearchSectionSource {
  id: SettingsSearchSectionSlug;
  labelKey: string;
  searchGroups: readonly SettingsSearchGroup[];
}

export interface SettingsSearchIndexEntry extends SettingsSearchGroup {
  id: string;
  section: SettingsSearchSectionSlug;
  titleKey: string;
  translationPrefixes: readonly string[];
}

/**
 * Builds the index from the navigation section declarations. Search groups
 * live beside the route and component that render them, so adding a settings
 * section cannot silently leave the index behind.
 */
export function buildSettingsSearchIndex(
  sources: readonly SettingsSearchSectionSource[],
): readonly SettingsSearchIndexEntry[] {
  return sources.flatMap((source) =>
    source.searchGroups.map((group) => ({
      ...group,
      id: group.id ?? source.id,
      section: source.id,
      titleKey: group.titleKey ?? source.labelKey,
    })),
  );
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
