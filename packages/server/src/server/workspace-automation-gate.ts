import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { setPaseoWorktreeUntrustedSource } from "../utils/worktree-metadata.js";
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

export async function isCheckoutUntrusted(
  registry: Pick<WorkspaceRegistry, "listAll">,
  checkoutPath: string,
): Promise<boolean> {
  const matchesCheckout = createRealpathAwarePathMatcher(checkoutPath);
  const workspaces = await registry.listAll();
  return workspaces.some(
    (workspace) =>
      Boolean(workspace.untrustedSource) &&
      matchesCheckout(workspace.worktreeRoot ?? workspace.cwd),
  );
}

export async function clearWorkspaceAutomationBlock(
  registry: Pick<WorkspaceRegistry, "update" | "listAll">,
  workspaceId: string,
  options?: { checkoutPath?: string | null },
): Promise<boolean> {
  const allWorkspaces = await registry.listAll();
  const target = allWorkspaces.find((record) => record.workspaceId === workspaceId);
  if (!target) throw new Error(`Workspace not found: ${workspaceId}`);
  const checkoutPath = options?.checkoutPath ?? target.worktreeRoot ?? target.cwd;
  // Clear checkout metadata before mutating workspace records so a failed metadata
  // write surfaces an error and leaves workspace records intact to retry approval.
  let cleared = await setPaseoWorktreeUntrustedSource(checkoutPath, null);
  const timestamp = new Date().toISOString();
  const matchesCheckout = createRealpathAwarePathMatcher(checkoutPath);
  for (const candidate of allWorkspaces) {
    if (!candidate.untrustedSource) continue;
    if (
      candidate.workspaceId !== workspaceId &&
      !matchesCheckout(candidate.worktreeRoot ?? candidate.cwd)
    ) {
      continue;
    }
    await registry.update(candidate.workspaceId, (record) => {
      if (!record.untrustedSource) return record;
      cleared = true;
      const { untrustedSource: _removed, ...trusted } = record;
      return { ...trusted, updatedAt: timestamp };
    });
  }
  return cleared;
}
