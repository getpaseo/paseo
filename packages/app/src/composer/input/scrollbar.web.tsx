import type { RefObject } from "react";
import { DomOverlayScrollbar } from "@/components/ui/overlay-scrollbar/dom-overlay-scrollbar";

// macOS overlay scrollbars hide the textarea's own thumb until it scrolls, so a
// long draft draws the same overlay thumb as the chat.
export function ComposerScrollbar({ textareaRef }: { textareaRef: RefObject<HTMLElement | null> }) {
  return <DomOverlayScrollbar scrollContainerRef={textareaRef} onUserScrollUp={noop} />;
}

function noop(): void {}
