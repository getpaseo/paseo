import type { InstalledPlugin } from "./types";

export interface PluginSidebarWorkspaceGrouping {
  key: string;
  logicalWorkspaceRefLabelPrefix: string;
  defaultPlacementLabel: string;
  serverIds?: readonly string[];
  retainedHistoryBindings?: readonly PluginSidebarWorkspaceRetainedHistoryBinding[];
}

export interface PluginSidebarWorkspaceRetainedHistoryBinding {
  serverId: string;
  workspaceId: string;
  physicalWorkspaceRef: string;
  logicalWorkspaceRef: string;
}

interface RetainedHistoryBindingDraft {
  binding: PluginSidebarWorkspaceRetainedHistoryBinding;
  conflict: boolean;
}

interface GroupingDraft extends Omit<PluginSidebarWorkspaceGrouping, "retainedHistoryBindings"> {
  serverIds: string[];
  retainedHistoryBindingsByIdentity: Map<string, RetainedHistoryBindingDraft>;
  conflict: boolean;
}

/**
 * Equal plugin/contribution ids form one cross-host namespace. A host disagreement is not a
 * precedence question: choosing either codec by connection order could regroup native history,
 * so the contribution fails open and physical rows remain visible.
 */
export function resolvePluginSidebarWorkspaceGroupings(
  plugins: readonly InstalledPlugin[],
): PluginSidebarWorkspaceGrouping[] {
  const byKey = new Map<string, GroupingDraft>();
  for (const plugin of plugins) {
    for (const contribution of plugin.sidebarWorkspaceGroupings ?? []) {
      const key = `${plugin.id}/sidebar-workspace-grouping/${contribution.id}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          key,
          logicalWorkspaceRefLabelPrefix: contribution.logicalWorkspaceRefLabelPrefix,
          defaultPlacementLabel: contribution.defaultPlacementLabel,
          serverIds: [plugin.serverId],
          retainedHistoryBindingsByIdentity: new Map(),
          conflict: false,
        });
      } else if (
        existing.logicalWorkspaceRefLabelPrefix !== contribution.logicalWorkspaceRefLabelPrefix ||
        existing.defaultPlacementLabel !== contribution.defaultPlacementLabel
      ) {
        existing.conflict = true;
      } else if (!existing.serverIds.includes(plugin.serverId)) {
        existing.serverIds.push(plugin.serverId);
      }

      const draft = byKey.get(key);
      if (!draft) continue;
      for (const binding of contribution.retainedHistoryBindings ?? []) {
        const identity = JSON.stringify([plugin.serverId, binding.workspaceId]);
        const existingBinding = draft.retainedHistoryBindingsByIdentity.get(identity);
        const resolved = { serverId: plugin.serverId, ...binding };
        if (!existingBinding) {
          draft.retainedHistoryBindingsByIdentity.set(identity, {
            binding: resolved,
            conflict: false,
          });
          continue;
        }
        if (
          existingBinding.binding.physicalWorkspaceRef !== binding.physicalWorkspaceRef ||
          existingBinding.binding.logicalWorkspaceRef !== binding.logicalWorkspaceRef
        ) {
          existingBinding.conflict = true;
        }
      }
    }
  }

  return [...byKey.values()]
    .filter((grouping) => !grouping.conflict)
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((grouping) => ({
      key: grouping.key,
      logicalWorkspaceRefLabelPrefix: grouping.logicalWorkspaceRefLabelPrefix,
      defaultPlacementLabel: grouping.defaultPlacementLabel,
      serverIds: [...grouping.serverIds].sort(),
      retainedHistoryBindings: [...grouping.retainedHistoryBindingsByIdentity.values()]
        .filter((draft) => !draft.conflict)
        .map((draft) => draft.binding)
        .sort(
          (left, right) =>
            left.serverId.localeCompare(right.serverId) ||
            left.workspaceId.localeCompare(right.workspaceId),
        ),
    }));
}
