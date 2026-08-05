import {
  BUILTIN_PROVIDER_ICON_NAMES,
  KNOWN_PROVIDER_ICON_NAMES,
} from "@getpaseo/protocol/provider-icon-names";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export type ProviderIconName =
  | { kind: "builtin"; id: string }
  | { kind: "catalog"; id: string }
  | { kind: "svg"; svg: string }
  | { kind: "bot" };

const BUILTIN_PROVIDER_IDS = new Set(BUILTIN_PROVIDER_ICON_NAMES);
const KNOWN_PROVIDER_IDS = new Set(KNOWN_PROVIDER_ICON_NAMES);
const providerSnapshotIconSvgsByServer = new Map<string, ReadonlyMap<string, string>>();

export function replaceProviderSnapshotIcons(
  serverId: string,
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "iconSvg">[],
): void {
  const icons = new Map<string, string>();
  for (const entry of entries) {
    if (entry.iconSvg) {
      icons.set(entry.provider, entry.iconSvg);
    }
  }
  providerSnapshotIconSvgsByServer.set(serverId, icons);
}

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

export function resolveProviderIconName(
  provider: string,
  serverId?: string | null,
): ProviderIconName {
  if (BUILTIN_PROVIDER_IDS.has(provider)) {
    return { kind: "builtin", id: provider };
  }
  const iconSvg = serverId
    ? providerSnapshotIconSvgsByServer.get(serverId)?.get(provider)
    : undefined;
  if (iconSvg) {
    return { kind: "svg", svg: iconSvg };
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
