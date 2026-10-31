import type { MutableRefObject } from "react";
import type { EditingTextInputHandle } from "@/components/ui/text-input";

export function useComposerAutoFocus(
  _textInputRef: MutableRefObject<EditingTextInputHandle | null>,
  _autoFocus: boolean,
  _autoFocusKey: string | undefined,
): void {
  return undefined;
}
