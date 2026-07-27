import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";

export interface ComposerKeyPressEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  preventDefault: () => void;
}

export interface ComposerKeyPressContext {
  onKeyPressCallback: ((event: { key: string; preventDefault: () => void }) => boolean) | undefined;
  submitOnEnter: boolean;
  submitOnModEnter: boolean;
  useAlternateSendAction: boolean;
  isSubmitBlocked: boolean;
  handleAlternateSendAction: () => void;
  handleDefaultSendAction: () => void;
}

export interface ComposerBeforeInputEvent {
  inputType: string;
  isComposing?: boolean;
  preventDefault: () => void;
}

export interface ComposerBeforeInputContext {
  submitOnEnter: boolean;
  isSubmitBlocked: boolean;
  handleDefaultSendAction: () => void;
}

export function shouldSubmitComposerFromNativeReturn(input: {
  enterKeyBehavior: "send" | "newline";
  isSubmitBlocked: boolean;
}): boolean {
  return input.enterKeyBehavior === "send" && !input.isSubmitBlocked;
}

export function handleComposerBeforeInput(
  event: ComposerBeforeInputEvent,
  context: ComposerBeforeInputContext,
): void {
  if (event.isComposing || !context.submitOnEnter) return;
  if (event.inputType !== "insertLineBreak" && event.inputType !== "insertParagraph") return;

  event.preventDefault();
  if (!context.isSubmitBlocked) {
    context.handleDefaultSendAction();
  }
}

export function handleComposerKeyPress(
  event: ComposerKeyPressEvent,
  context: ComposerKeyPressContext,
): void {
  if (isImeComposingKeyboardEvent(event)) return;

  if (
    context.onKeyPressCallback?.({
      key: event.key,
      preventDefault: event.preventDefault,
    })
  ) {
    return;
  }

  if (event.key !== "Enter" || event.shiftKey) return;

  const hasModifier = Boolean(event.metaKey || event.ctrlKey);
  if (hasModifier && context.submitOnEnter && context.useAlternateSendAction) {
    event.preventDefault();
    if (!context.isSubmitBlocked) {
      context.handleAlternateSendAction();
    }
    return;
  }

  const shouldSubmit = context.submitOnEnter || (hasModifier && context.submitOnModEnter);
  if (!shouldSubmit) return;

  event.preventDefault();
  if (!context.isSubmitBlocked) {
    context.handleDefaultSendAction();
  }
}
