import { i18n } from "@/i18n/i18next";

export type AgentInputSubmitResult = "noop" | "queued" | "submitted" | "failed";

export interface AgentInputSubmitActionInput<TAttachment> {
  message: string;
  attachments: TAttachment[];
  hasExternalContent?: boolean;
  allowEmptySubmit?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
  forceSend?: boolean;
  isAgentRunning: boolean;
  canSubmit: boolean;
  queueMessage: (input: { message: string; attachments: TAttachment[] }) => Promise<void> | void;
  submitMessage: (input: { message: string; attachments: TAttachment[] }) => Promise<void>;
  beginDraftAttempt: (input: { message: string; attachments: TAttachment[] }) => number | null;
  settleDraftAttempt: (input: { attemptId: number; outcome: "accepted" | "failed" }) => void;
  setSendError: (message: string | null) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  onSubmitError?: (error: unknown) => void;
  failedToSendMessage?: string;
}

export async function submitAgentInput<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
): Promise<AgentInputSubmitResult> {
  const trimmedMessage = input.message.trim();
  const attachments = input.attachments;
  const shouldClearOnSubmit = input.submitBehavior !== "preserve-and-lock";

  if (
    !trimmedMessage &&
    attachments.length === 0 &&
    !input.hasExternalContent &&
    !input.allowEmptySubmit
  ) {
    return "noop";
  }

  if (!input.canSubmit) {
    return "noop";
  }

  if (input.isAgentRunning && !input.forceSend) {
    try {
      // queueMessage owns the synchronous clear and reconciles a failed
      // queued draft with input entered during its network round-trip.
      await input.queueMessage({ message: trimmedMessage, attachments });
      return "queued";
    } catch (error) {
      input.onSubmitError?.(error);
      input.setSendError(
        error instanceof Error
          ? error.message
          : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
      );
      return "failed";
    }
  }

  let draftAttemptId: number | null = null;
  if (shouldClearOnSubmit) {
    draftAttemptId = input.beginDraftAttempt({ message: trimmedMessage, attachments });
    if (draftAttemptId === null) {
      return "noop";
    }
  }
  input.setSendError(null);
  input.setIsProcessing(true);

  try {
    await input.submitMessage({ message: trimmedMessage, attachments });
    if (draftAttemptId !== null) {
      input.settleDraftAttempt({ attemptId: draftAttemptId, outcome: "accepted" });
    }
    input.setIsProcessing(false);
    return "submitted";
  } catch (error) {
    input.onSubmitError?.(error);
    if (draftAttemptId !== null) {
      input.settleDraftAttempt({ attemptId: draftAttemptId, outcome: "failed" });
    }
    input.setSendError(
      error instanceof Error
        ? error.message
        : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
    );
    input.setIsProcessing(false);
    return "failed";
  }
}
