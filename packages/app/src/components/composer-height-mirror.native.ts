import type { RefObject } from "react";

interface Args {
  value: string;
  textareaRef: RefObject<unknown>;
  minHeight: number;
  maxHeight: number;
  onHeight: (height: number) => void;
}

export function useComposerHeightMirror(_args: Args): void {
  // No-op on native: onContentSizeChange drives height natively.
}
