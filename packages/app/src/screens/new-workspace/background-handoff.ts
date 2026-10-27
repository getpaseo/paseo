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
