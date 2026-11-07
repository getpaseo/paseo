import { useEffect, type RefObject } from "react";

const EDITABLE_SELECTOR = "input, textarea, [contenteditable]:not([contenteditable='false'])";

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

/** The selected chat text to copy, or null when the selection is not a chat text selection. */
export function readChatSelectionToCopy(
  selection: Selection | null,
  container: HTMLElement,
): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const anchor = elementOf(selection.anchorNode);
  const focus = elementOf(selection.focusNode);
  if (!anchor || !focus || !container.contains(anchor) || !container.contains(focus)) return null;
  // Editable fields keep their own selection semantics; copying there would surprise.
  if (anchor.closest(EDITABLE_SELECTOR) || focus.closest(EDITABLE_SELECTOR)) return null;
  const text = selection.toString();
  return text.trim() ? text : null;
}

export function useChatCopyOnSelect(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      if (!readChatSelectionToCopy(window.getSelection(), container)) return;
      // Runs inside the selecting mouseup, so the browser allows it and copies the
      // DOM selection as-is. navigator.clipboard.writeText is denied here without a
      // clipboard-write grant and on plain-HTTP origins.
      document.execCommand("copy");
    };
    // The document sees mouseups that end outside the feed after a drag that began in it.
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [containerRef, enabled]);
}
