export type AgentInputSubmitResult = "noop" | "queued" | "submitted" | "failed";

export interface AgentInputSubmitActionInput<TImage> {
  message: string;
  /** Legacy name kept for the older agent-input-area caller. */
  imageAttachments?: TImage[];
  /** New composer API name. Either field is accepted. */
  attachments?: TImage[];
  /** Composer-only flags (ignored by legacy callers). */
  hasExternalContent?: boolean;
  allowEmptySubmit?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
  forceSend?: boolean;
  isAgentRunning: boolean;
  canSubmit: boolean;
  queueMessage: (input: {
    message: string;
    imageAttachments?: TImage[];
    attachments?: TImage[];
  }) => void;
  submitMessage: (input: {
    message: string;
    imageAttachments?: TImage[];
    attachments?: TImage[];
  }) => Promise<void>;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  setUserInput: (text: string) => void;
  /** Legacy name. */
  setSelectedImages?: (images: TImage[]) => void;
  /** New composer API name. Either is accepted. */
  setAttachments?: (images: TImage[]) => void;
  setSendError: (message: string | null) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  onSubmitError?: (error: unknown) => void;
}

export async function submitAgentInput<TImage>(
  input: AgentInputSubmitActionInput<TImage>,
): Promise<AgentInputSubmitResult> {
  const trimmedMessage = input.message.trim();
  const attachments = input.attachments ?? input.imageAttachments;
  const setAttachments = input.setAttachments ?? input.setSelectedImages ?? (() => {});
  const allowEmpty = input.allowEmptySubmit ?? false;

  if (!trimmedMessage && !attachments?.length && !allowEmpty && !input.hasExternalContent) {
    return "noop";
  }

  if (!input.canSubmit) {
    return "noop";
  }

  const preserveOnSubmit = input.submitBehavior === "preserve-and-lock";

  if (input.isAgentRunning && !input.forceSend) {
    input.queueMessage({ message: trimmedMessage, attachments, imageAttachments: attachments });
    if (!preserveOnSubmit) {
      input.setUserInput("");
      setAttachments([]);
    }
    // Queueing counts as "sent" for draft lifecycle — the text has left the
    // composer and is now owned by the queue.
    input.clearDraft("sent");
    return "queued";
  }

  if (!preserveOnSubmit) {
    input.setUserInput("");
    setAttachments([]);
  }
  input.setSendError(null);
  input.setIsProcessing(true);

  try {
    await input.submitMessage({
      message: trimmedMessage,
      attachments,
      imageAttachments: attachments,
    });
    input.clearDraft("sent");
    input.setIsProcessing(false);
    return "submitted";
  } catch (error) {
    input.onSubmitError?.(error);
    if (!preserveOnSubmit) {
      input.setUserInput(trimmedMessage);
      setAttachments(attachments ?? []);
    }
    input.setSendError(error instanceof Error ? error.message : "Failed to send message");
    input.setIsProcessing(false);
    return "failed";
  }
}
