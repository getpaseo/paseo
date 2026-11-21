import { useCallback, useEffect } from "react";
import { blurEmbed, focusEmbed, useIsEmbedFocused } from "./focus-store";

/**
 * Native: a touch in what the embed owns focuses it, and focuses away from any other embed. The
 * embed's `FocusOwnerScope` hears touches along the React tree, so a native `Modal` and the
 * gorhom popovers and sheets it opens count as inside. A touch outside every embed leaves the
 * last one focused; only a hardware keyboard reads it there.
 */
export function useEmbedFocus(embedId: string) {
  const isFocused = useIsEmbedFocused(embedId);
  const owner = useCallback(() => focusEmbed(embedId), [embedId]);
  useEffect(() => () => blurEmbed(embedId), [embedId]);
  return { isFocused, owner };
}
