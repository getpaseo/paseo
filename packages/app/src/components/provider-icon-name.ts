import {
  BUILTIN_PROVIDER_ICON_NAMES,
  KNOWN_PROVIDER_ICON_NAMES,
} from "@getpaseo/protocol/provider-icon-names";

export type ProviderIconName =
  | { kind: "builtin"; id: string }
  | { kind: "catalog"; id: string }
  | { kind: "bot" };

const BUILTIN_PROVIDER_IDS = new Set(BUILTIN_PROVIDER_ICON_NAMES);
const KNOWN_PROVIDER_IDS = new Set(KNOWN_PROVIDER_ICON_NAMES);

/* Provider accounts get user-chosen ids ("claude-work") that no static icon
 * list can anticipate; the snapshot layer registers each account's base
 * provider here so every icon call site resolves the real logo. */
const PROVIDER_ICON_ALIASES = new Map<string, string>();

export function registerProviderIconAliases(
  entries: ReadonlyArray<{ provider: string; baseProviderId?: string }>,
): void {
  for (const entry of entries) {
    if (entry.baseProviderId && entry.baseProviderId !== entry.provider) {
      PROVIDER_ICON_ALIASES.set(entry.provider, entry.baseProviderId);
    }
  }
}

export function resolveProviderIconName(provider: string): ProviderIconName {
  if (BUILTIN_PROVIDER_IDS.has(provider)) {
    return { kind: "builtin", id: provider };
  }
  if (KNOWN_PROVIDER_IDS.has(provider)) {
    return { kind: "catalog", id: provider };
  }
  const base = PROVIDER_ICON_ALIASES.get(provider);
  if (base !== undefined) {
    if (BUILTIN_PROVIDER_IDS.has(base)) {
      return { kind: "builtin", id: base };
    }
    if (KNOWN_PROVIDER_IDS.has(base)) {
      return { kind: "catalog", id: base };
    }
  }
  return { kind: "bot" };
}
