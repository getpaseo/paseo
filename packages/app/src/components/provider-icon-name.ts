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
const providerSnapshotBasesByServer = new Map<string, ReadonlyMap<string, string>>();
const MAX_DERIVATION_DEPTH = 4;

export function replaceProviderSnapshotIcons(
  serverId: string,
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "iconSvg" | "derivedFrom">[],
): void {
  const icons = new Map<string, string>();
  const bases = new Map<string, string>();
  for (const entry of entries) {
    if (entry.iconSvg) {
      icons.set(entry.provider, entry.iconSvg);
    }
    if (entry.derivedFrom && entry.derivedFrom !== entry.provider) {
      bases.set(entry.provider, entry.derivedFrom);
    }
  }
  providerSnapshotIconSvgsByServer.set(serverId, icons);
  providerSnapshotBasesByServer.set(serverId, bases);
}

export function resolveProviderIconName(
  provider: string,
  serverId?: string | null,
): ProviderIconName {
  let current = provider;
  for (let depth = 0; depth <= MAX_DERIVATION_DEPTH; depth += 1) {
    if (BUILTIN_PROVIDER_IDS.has(current)) {
      return { kind: "builtin", id: current };
    }
    const iconSvg = serverId
      ? providerSnapshotIconSvgsByServer.get(serverId)?.get(current)
      : undefined;
    if (iconSvg) {
      return { kind: "svg", svg: iconSvg };
    }
    if (KNOWN_PROVIDER_IDS.has(current)) {
      return { kind: "catalog", id: current };
    }
    const base = serverId ? providerSnapshotBasesByServer.get(serverId)?.get(current) : undefined;
    if (!base) {
      break;
    }
    current = base;
  }
  return { kind: "bot" };
}
