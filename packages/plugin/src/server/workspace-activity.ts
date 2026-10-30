import type { WorkspaceActivityInput } from "@getpaseo/protocol/workspace-activity";

export type PluginWorkspaceActivityContribution = WorkspaceActivityInput;
export type PluginWorkspaceActivityUpdate = Partial<
  Omit<PluginWorkspaceActivityContribution, "id" | "workspaceId">
>;

export interface PluginWorkspaceActivityRegistration {
  /** Update presentation or semantic status. Identity and workspace ownership cannot move. */
  update(patch: PluginWorkspaceActivityUpdate): void;
  /** Idempotent. Removed registrations cannot be updated or revived. */
  remove(): void;
}
