import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";

export interface HostLabelCatalog {
  serverId: string;
  labels: readonly WorkspaceLabelDefinition[];
}

export function mergeWorkspaceLabelCatalogs(input: {
  catalogs: readonly HostLabelCatalog[];
  targetServerId?: string;
}): WorkspaceLabelDefinition[] {
  const ordered = [...input.catalogs].sort((left, right) => {
    if (left.serverId === input.targetServerId) return -1;
    if (right.serverId === input.targetServerId) return 1;
    return left.serverId.localeCompare(right.serverId);
  });
  const merged = new Map<string, WorkspaceLabelDefinition>();
  for (const catalog of ordered) {
    for (const label of catalog.labels) {
      const key = workspaceLabelKey(label.name);
      if (!merged.has(key)) merged.set(key, label);
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}
