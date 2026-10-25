import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";

export interface DesktopKeyEvent {
  nativeEvent: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  };
  preventDefault: () => void;
}

export interface GhostSuggestion {
  text: string;
  accept: () => void;
  submit: () => void;
  dismiss: () => void;
}

export interface DesktopKeyPressContext<TInput, TPayload> {
  ghostSuggestion: GhostSuggestion | null;
  onKeyPressCallback:
    | ((event: { key: string; preventDefault: () => void; input: TInput }) => boolean)
    | undefined;
  input: TInput;
  submitOnEnter: boolean;
  isAgentRunning: boolean;
  onQueue: ((payload: TPayload) => void) | undefined;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  disabled: boolean;
  handleAlternateSendAction: () => void;
  handleDefaultSendAction: () => void;
}

export function handleDesktopKeyPressImpl<TInput, TPayload>(
  event: DesktopKeyEvent,
  ctx: DesktopKeyPressContext<TInput, TPayload>,
): void {
  if (isImeComposingKeyboardEvent(event.nativeEvent)) return;

  if (ctx.onKeyPressCallback) {
    const handled = ctx.onKeyPressCallback({
      key: event.nativeEvent.key,
      preventDefault: () => event.preventDefault(),
      input: ctx.input,
    });
    if (handled) return;
  }

  const { shiftKey, metaKey, ctrlKey } = event.nativeEvent;

  // The ghost only claims a key the autocomplete above has already declined, and
  // its Enter answers to the same guard as an ordinary send.
  if (ctx.ghostSuggestion && !metaKey && !ctrlKey && !shiftKey) {
    const canSubmit =
      ctx.submitOnEnter && !ctx.isSubmitDisabled && !ctx.isSubmitLoading && !ctx.disabled;
    if (handleGhostKey(event, ctx.ghostSuggestion, canSubmit)) return;
  }

  if (event.nativeEvent.key !== "Enter") return;
  if (!ctx.submitOnEnter) return;
  if (shiftKey) return;
  handleEnterKey(event, ctx, Boolean(metaKey || ctrlKey));
}

function handleEnterKey<TInput, TPayload>(
  event: DesktopKeyEvent,
  ctx: DesktopKeyPressContext<TInput, TPayload>,
  withModifier: boolean,
): void {
  if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) return;
  if (withModifier && ctx.isAgentRunning && ctx.onQueue) {
    event.preventDefault();
    ctx.handleAlternateSendAction();
    return;
  }
  event.preventDefault();
  ctx.handleDefaultSendAction();
}

function handleGhostKey(
  event: DesktopKeyEvent,
  ghost: GhostSuggestion,
  canSubmitOnEnter: boolean,
): boolean {
  switch (event.nativeEvent.key) {
    case "Tab":
      event.preventDefault();
      ghost.accept();
      return true;
    case "Escape":
      event.preventDefault();
      ghost.dismiss();
      return true;
    case "Enter":
      if (!canSubmitOnEnter) return false;
      event.preventDefault();
      ghost.submit();
      return true;
    default:
      return false;
  }
}
