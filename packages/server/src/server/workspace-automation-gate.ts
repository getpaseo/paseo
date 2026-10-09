import type { WorkspaceRegistry } from "./workspace-registry.js";

export interface UntrustedWorkspaceSource {
  kind: "change_request";
  forge: string;
  number: number;
  headRepository: string;
}

export function formatWorkspaceAutomationBlockedMessage(source: UntrustedWorkspaceSource): string {
  const changeRequestNoun = source.forge === "gitlab" ? "MR" : "PR";
  return `Scripts are blocked for ${changeRequestNoun} #${source.number} from ${source.headRepository}. Run setup to allow them.`;
}

export class WorkspaceAutomationBlockedError extends Error {
  constructor(readonly source: UntrustedWorkspaceSource) {
    super(formatWorkspaceAutomationBlockedMessage(source));
    this.name = "WorkspaceAutomationBlockedError";
  }
}

export function assertWorkspaceAutomationAllowed(
  source: UntrustedWorkspaceSource | undefined,
): void {
  if (source) throw new WorkspaceAutomationBlockedError(source);
}

export async function assertWorkspaceAutomationAllowedForWorkspace(
  registry: Pick<WorkspaceRegistry, "get">,
  workspaceId: string,
): Promise<void> {
  const workspace = await registry.get(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  assertWorkspaceAutomationAllowed(workspace.untrustedSource);
}

export async function clearWorkspaceAutomationBlock(
  registry: Pick<WorkspaceRegistry, "update">,
  workspaceId: string,
): Promise<boolean> {
  let cleared = false;
  const workspace = await registry.update(workspaceId, (record) => {
    if (!record.untrustedSource) return record;
    cleared = true;
    const { untrustedSource: _removed, ...trusted } = record;
    return { ...trusted, updatedAt: new Date().toISOString() };
  });
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  return cleared;
}
