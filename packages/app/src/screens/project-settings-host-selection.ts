export interface ProjectSettingsHostTarget {
  serverId: string;
  projectId: string;
}

export interface StoredProjectSettingsHostSelection extends ProjectSettingsHostTarget {
  routeKey: string;
}

interface ResolveProjectSettingsHostTargetInput {
  routeKey: string;
  editableHosts: readonly ProjectSettingsHostTarget[];
  defaultHost: ProjectSettingsHostTarget | undefined;
  selection: StoredProjectSettingsHostSelection;
}

export function resolveProjectSettingsHostTarget(
  input: ResolveProjectSettingsHostTargetInput,
): ProjectSettingsHostTarget | undefined {
  const selectedHost =
    input.selection.routeKey === input.routeKey
      ? getEditableHost(input.editableHosts, input.selection)
      : undefined;
  return (
    selectedHost ??
    getEditableHost(input.editableHosts, input.defaultHost) ??
    input.editableHosts[0]
  );
}

function getEditableHost(
  editableHosts: readonly ProjectSettingsHostTarget[],
  target: ProjectSettingsHostTarget | undefined,
): ProjectSettingsHostTarget | undefined {
  if (!target) return undefined;
  for (const host of editableHosts) {
    if (host.serverId === target.serverId && host.projectId === target.projectId) return host;
  }
  return undefined;
}
