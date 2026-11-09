import type { RefObject } from "react";

// Native text inputs draw their own scroll indicator.
export function ComposerScrollbar(_props: { textareaRef: RefObject<HTMLElement | null> }) {
  return null;
}
