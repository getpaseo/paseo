export type AgentInputSubmitResult = "noop" | "queued" | "submitted" | "failed";

export interface AgentInputSubmitActionInput<TImage> {
  message: string;
  imageAttachments?: TImage[];
  forceSend?: boolean;
  isAgentRunning: boolean;
  canSubmit: boolean;
  queueMessage: (input: { message: string; imageAttachments?: TImage[] }) => void;
  submitMessage: (input: { message: string; imageAttachments?: TImage[] }) => Promise<void>;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  setUserInput: (text: string) => void;
  setSelectedImages: (images: TImage[]) => void;
  setSendError: (message: string | null) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  onSubmitError?: (error: unknown) => void;
}

export async function submitAgentInput<TImage>(
  input: AgentInputSubmitActionInput<TImage>,
): Promise<AgentInputSubmitResult> {
  const trimmedMessage = input.message.trim();
  const imageAttachments = input.imageAttachments;

  if (!trimmedMessage && !imageAttachments?.length) {
    return "noop";
  }

  if (!input.canSubmit) {
    return "noop";
  }

  if (input.isAgentRunning && !input.forceSend) {
    input.queueMessage({ message: trimmedMessage, imageAttachments });
    input.setUserInput("");
    input.setSelectedImages([]);
    return "queued";
  }

  // Clear immediately so optimistic stream updates and composer state stay in sync.
  input.setUserInput("");
  input.setSelectedImages([]);
  input.setSendError(null);
  input.setIsProcessing(true);

  try {
    await input.submitMessage({ message: trimmedMessage, imageAttachments });
    input.clearDraft("sent");
    input.setIsProcessing(false);
    return "submitted";
  } catch (error) {
    input.onSubmitError?.(error);
    input.setUserInput(trimmedMessage);
    input.setSelectedImages(imageAttachments ?? []);
    input.setSendError(error instanceof Error ? error.message : "Failed to send message");
    input.setIsProcessing(false);
    return "failed";
  }
}
