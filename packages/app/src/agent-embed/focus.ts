import { useCallback, useEffect } from "react";
import { blurEmbed, focusEmbed, useIsEmbedFocused } from "./focus-store";

/**
 * Native: a touch inside the embed focuses it, and focuses away from any other embed. A touch
 * outside every embed leaves the last one focused; only a hardware keyboard reads it there.
 */
export function useEmbedFocus(embedId: string) {
  const isFocused = useIsEmbedFocused(embedId);
  const onTouchStart = useCallback(() => focusEmbed(embedId), [embedId]);
  useEffect(() => () => blurEmbed(embedId), [embedId]);
  return { isFocused, ref: undefined, onTouchStart };
}
