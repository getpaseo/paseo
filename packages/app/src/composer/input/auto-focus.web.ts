import { useEffect, useRef, type MutableRefObject } from "react";
import type { EditingTextInputHandle as ComposerTextInputHandle } from "@/components/ui/text-input";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { hasActiveWebOverlay, hasOpenDomPopover } from "@/lib/overlay-root";
import { focusWithRetries } from "@/utils/web-focus";

function shouldPreserveBrowserFocus(input: HTMLElement): boolean {
  if (hasActiveWebOverlay() || hasOpenDomPopover()) return true;
  if (window.getSelection()?.isCollapsed === false) return true;
  const activeElement = document.activeElement;
  return (
    activeElement instanceof HTMLElement &&
    activeElement.getClientRects().length > 0 &&
    activeElement.matches('input, textarea, [contenteditable="true"]') &&
    activeElement !== input
  );
}

function watchBrowserFocusIntent(onInteraction: () => void): () => void {
  const previousFocus = document.activeElement;
  const onFocusChange = (event: FocusEvent) => {
    // Chromium also restores focus to the old element during window activation.
    if (event.target !== previousFocus) onInteraction();
  };
  window.addEventListener("pointerdown", onInteraction, true);
  document.addEventListener("focusin", onFocusChange, true);
  return () => {
    window.removeEventListener("pointerdown", onInteraction, true);
    document.removeEventListener("focusin", onFocusChange, true);
  };
}

export function useComposerAutoFocus(
  textInputRef: MutableRefObject<ComposerTextInputHandle | null>,
  autoFocus: boolean,
  autoFocusKey: string | undefined,
): void {
  const isAppActivelyVisible = useAppActivelyVisible();
  const wasAppActivelyVisible = useRef(isAppActivelyVisible);
  const interactedWhileInactive = useRef(false);
  useEffect(() => {
    const isBrowserReturn = isAppActivelyVisible && !wasAppActivelyVisible.current;
    const preserveActivationTarget = isBrowserReturn && interactedWhileInactive.current;
    wasAppActivelyVisible.current = isAppActivelyVisible;
    if (isAppActivelyVisible) interactedWhileInactive.current = false;
    if (!isAppActivelyVisible) {
      // Native activation clicks can finish before the returning passive effect runs.
      return watchBrowserFocusIntent(() => {
        interactedWhileInactive.current = true;
      });
    }
    if (!autoFocus || preserveActivationTarget) return;
    const cancelFocus: () => void = focusWithRetries({
      focus: () => {
        if (isBrowserReturn) {
          const element = textInputRef.current?.getNativeRef();
          const cannotEdit =
            !(element instanceof HTMLElement) || element.matches(":disabled, [readonly]");
          if (cannotEdit || shouldPreserveBrowserFocus(element)) {
            cancelFocus();
            return;
          }
        }
        textInputRef.current?.focus();
      },
      isFocused: () => textInputRef.current?.isFocused() === true,
      deferInitialAttempt: true,
    });
    if (!isBrowserReturn) return cancelFocus;
    const stopWatching = watchBrowserFocusIntent(cancelFocus);
    return () => {
      cancelFocus();
      stopWatching();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, autoFocusKey, isAppActivelyVisible]);
}
