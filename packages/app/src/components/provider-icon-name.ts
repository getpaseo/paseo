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
  return { kind: "bot" };
}
