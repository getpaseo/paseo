import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import type { MessagePayload } from "@/composer/types";

export interface WebTextInputKeyPressEvent {
  nativeEvent: {
    key: string;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  };
  preventDefault: () => void;
}

export interface DesktopKeyPressContext {
  onKeyPressCallback: ((event: { key: string; preventDefault: () => void }) => boolean) | undefined;
  submitOnEnter: boolean;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  disabled: boolean;
  value: string;
  selection: { start: number; end: number };
  onChangeText: (text: string) => void;
  onSelectionChange: (selection: { start: number; end: number }) => void;
  handleAlternateSendAction: () => void;
  handleDefaultSendAction: () => void;
}

export function insertNewlineAtSelection(
  value: string,
  selection: { start: number; end: number },
): { nextValue: string; nextSelection: { start: number; end: number } } {
  const before = value.slice(0, selection.start);
  const after = value.slice(selection.end);
  const nextValue = `${before}\n${after}`;
  const cursor = selection.start + 1;
  return { nextValue, nextSelection: { start: cursor, end: cursor } };
}

export function handleDesktopKeyPressImpl(
  event: WebTextInputKeyPressEvent,
  ctx: DesktopKeyPressContext,
): void {
  if (isImeComposingKeyboardEvent(event.nativeEvent)) return;

  if (ctx.onKeyPressCallback) {
    const handled = ctx.onKeyPressCallback({
      key: event.nativeEvent.key,
      preventDefault: () => event.preventDefault(),
    });
    if (handled) return;
  }

  const { shiftKey, altKey, metaKey, ctrlKey } = event.nativeEvent;

  if (event.nativeEvent.key !== "Enter") return;

  if (shiftKey || altKey) {
    event.preventDefault();
    const { nextValue, nextSelection } = insertNewlineAtSelection(ctx.value, ctx.selection);
    ctx.onChangeText(nextValue);
    ctx.onSelectionChange(nextSelection);
    return;
  }

  if (!ctx.submitOnEnter) return;

  if ((metaKey || ctrlKey) && ctx.isAgentRunning && ctx.onQueue) {
    if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) return;
    event.preventDefault();
    ctx.handleAlternateSendAction();
    return;
  }

  if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) return;
  event.preventDefault();
  ctx.handleDefaultSendAction();
}
