export type SendButtonVisibility = "always" | "whenContent";

export interface SendableContentInput {
  value: string;
  attachments: readonly unknown[];
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  isSubmitLoading: boolean;
  sendButtonVisibility: SendButtonVisibility;
}

export interface SendableContentOutput {
  canSubmitContent: boolean;
  hasAttachments: boolean;
  hasRealContent: boolean;
  hasSendableContent: boolean;
  shouldShowSendButton: boolean;
}

export function computeSendableContent(input: SendableContentInput): SendableContentOutput {
  const hasAttachments = input.attachments.length > 0;
  const hasText = input.value.trim().length > 0;
  const canSubmitContent =
    hasText || hasAttachments || input.hasExternalContent || input.allowEmptySubmit;
  const hasRealContent = hasText || hasAttachments;
  const hasSendableContent = hasRealContent || input.hasExternalContent;
  const shouldShowSendButton =
    input.sendButtonVisibility === "always"
      ? true
      : hasSendableContent || input.allowEmptySubmit || input.isSubmitLoading;
  return {
    canSubmitContent,
    hasAttachments,
    hasRealContent,
    hasSendableContent,
    shouldShowSendButton,
  };
}
