export interface NewWorkspaceRouteParams {
  serverId?: string | string[];
  dir?: string | string[];
  name?: string | string[];
  projectId?: string | string[];
  draftId?: string | string[];
  q?: string | string[];
}

export interface ResolvedNewWorkspaceRouteParams {
  serverId: string;
  sourceDirectory: string | undefined;
  displayName: string | undefined;
  projectId: string | undefined;
  draftId: string | undefined;
  initialPrompt: string | undefined;
}

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function resolveNewWorkspaceRouteParams(
  params: NewWorkspaceRouteParams,
): ResolvedNewWorkspaceRouteParams {
  return {
    serverId: singleParam(params.serverId) ?? "",
    sourceDirectory: singleParam(params.dir),
    displayName: singleParam(params.name),
    projectId: singleParam(params.projectId),
    draftId: singleParam(params.draftId),
    initialPrompt: singleParam(params.q),
  };
}
