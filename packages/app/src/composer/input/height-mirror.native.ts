import type { RefObject } from "react";

interface Args {
  value: string;
  textareaRef: RefObject<unknown>;
  minHeight: number;
  maxHeight: number;
  onHeight: (height: number) => void;
}

export function useComposerHeightMirror(_args: Args): (_value: string) => void {
  // No-op on native: onContentSizeChange drives height natively.
  return () => undefined;
}
