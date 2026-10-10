import { useDraftStore } from "@/stores/draft-store";

/**
 * Launch identity for a draft: persisted metadata wins for journal-backed drafts; an ordinary draft
 * gets a fresh message ID from the caller's generator.
 */
export function resolveDraftLaunchIdentity(
  draftId: string,
  generateMessageId: () => string,
): {
  clientMessageId: string;
  labels?: Record<string, string>;
  journalKey?: string;
  readOnly: boolean;
} {
  const metadata = useDraftStore.getState().getAgentLaunchMetadata(draftId);
  if (!metadata) return { clientMessageId: generateMessageId(), readOnly: false };
  return {
    clientMessageId: metadata.clientMessageId,
    labels: { ...metadata.labels },
    journalKey: metadata.journalKey,
    readOnly: metadata.submissionState === "outcome_unknown_readonly",
  };
}

export const LAUNCH_OUTCOME_UNKNOWN_MESSAGE =
  "This launch may already have created an agent. Check status before retrying.";

/** Read-only composer state for a journal-backed draft whose request outcome is unknown. */
export function useLaunchOutcomeUnknown(draftKey: string | null): {
  readOnly: boolean;
  placeholder: string | undefined;
} {
  const readOnly = useDraftStore((state) => {
    if (!draftKey) return false;
    return state.drafts[draftKey]?.agentLaunch?.submissionState === "outcome_unknown_readonly";
  });
  return { readOnly, placeholder: readOnly ? LAUNCH_OUTCOME_UNKNOWN_MESSAGE : undefined };
}
