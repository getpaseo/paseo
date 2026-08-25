import { useMemo } from "react";
import type { RefObject } from "react";
import type { ComposerHeightResult } from "./height.types";

interface ComposerHeightArgs {
  value: string;
  textareaRef: RefObject<unknown>;
  minHeight: number;
  maxHeight: number;
}

export function useComposerHeight({
  minHeight,
  maxHeight,
}: ComposerHeightArgs): ComposerHeightResult {
  const style = useMemo(() => ({ minHeight, maxHeight }), [maxHeight, minHeight]);
  return { mode: "intrinsic", style, scrollEnabled: true };
}
