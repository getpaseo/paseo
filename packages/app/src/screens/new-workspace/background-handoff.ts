import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";

interface WorkspaceDraftCleanupInput {
  draftId?: string;
  draftKey: string;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  draftContextScopeKey: string | null;
}

/** Capture ownership before workspace creation starts, not when its response arrives. */
export function captureWorkspaceDraftCleanup(input: WorkspaceDraftCleanupInput): () => void {
  const draftId = input.draftId?.trim() ?? "";
  const scopeKey = input.draftContextScopeKey ?? "";
  const draftVersion = useDraftStore.getState().drafts[input.draftKey]?.version;
  const setup = useWorkspaceDraftSubmissionStore.getState().setupByDraftId[draftId];
  const attachments = useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey];

  return () => {
    // These stores update independently. A context-only edit does not bump the text version.
    // Any newer draft state owns the whole draft, including its unchanged context.
    if (
      useDraftStore.getState().drafts[input.draftKey]?.version !== draftVersion ||
      useWorkspaceDraftSubmissionStore.getState().setupByDraftId[draftId] !== setup ||
      useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey] !== attachments
    ) {
      return;
    }
    useWorkspaceDraftSubmissionStore.getState().clearDraftSetup({ draftId });
    if (scopeKey) {
      useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({ scopeKey });
    }
    input.clearDraft("sent");
  };
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
export async function createWorkspaceAgentInBackground(input: {
  clearConsumedDraft: () => void;
  createAgent: () => Promise<unknown>;
}): Promise<void> {
  await input.createAgent();
  input.clearConsumedDraft();
}
