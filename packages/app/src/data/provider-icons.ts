import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { createStore } from "zustand/vanilla";

export const providerSnapshotIcons = createStore<ReadonlyMap<string, ReadonlyMap<string, string>>>(
  () => new Map(),
);

export function replaceProviderSnapshotIcons(
  serverId: string,
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "iconSvg">[],
): void {
  const icons = new Map<string, string>();
  for (const entry of entries) {
    if (entry.iconSvg) icons.set(entry.provider, entry.iconSvg);
  }
  providerSnapshotIcons.setState((previous) => new Map(previous).set(serverId, icons), true);
}
