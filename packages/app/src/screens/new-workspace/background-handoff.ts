import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";

export interface CreateWorkspaceAgentInBackgroundInput {
  draftId: string;
  draftKey: string;
  draftContextScopeKey: string | null;
  createAgent: () => Promise<unknown>;
}

/**
 * The workspace draft tab normally issues create_agent once it mounts on the destination screen.
 * When the user leaves the New workspace screen before creation resolves, that tab never mounts,
 * so this path issues the request itself. The agent tab opens on its own when the workspace is
 * next visited — `reconcileTabs` auto-opens agents.
 *
 * The caller must not write a pending entry to the draft-submission or create-flow stores on this
 * path: those drive the draft tab's auto-submit, and the daemon does not dedupe create_agent by
 * clientMessageId, so a leftover entry would create a second agent when the workspace is opened.
 */
export async function createWorkspaceAgentInBackground(
  input: CreateWorkspaceAgentInBackgroundInput,
): Promise<void> {
  const draftVersionAtSubmit = useDraftStore.getState().drafts[input.draftKey]?.version ?? null;

  await input.createAgent();

  useWorkspaceDraftSubmissionStore.getState().clearDraftSetup({ draftId: input.draftId });
  if (input.draftContextScopeKey) {
    useWorkspaceAttachmentsStore
      .getState()
      .clearWorkspaceAttachments({ scopeKey: input.draftContextScopeKey });
  }
  // Only on success — a failed creation has no pending-store handoff holding the prompt, so
  // clearing would destroy the text needed to retry. And only if nothing else has written to the
  // draft since: the New workspace draft key is shared, so the user may have reopened the screen
  // and started typing something new while this was in flight.
  if (useDraftStore.getState().drafts[input.draftKey]?.version === draftVersionAtSubmit) {
    useDraftStore.getState().clearDraftInput({ draftKey: input.draftKey, lifecycle: "sent" });
  }
}
