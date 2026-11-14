import { useCallback, useEffect } from "react";
import { wasClaimedByFocusOwner } from "@/components/ui/focus-owner";
import { blurEmbed, focusEmbed, useIsEmbedFocused } from "./focus-store";

/**
 * Web: a pointer press or focus move in what the embed owns focuses it, until one lands outside
 * every embed, the way a workspace pane takes focus from a click anywhere in it. "Owns" follows
 * the React tree, not the DOM: the embed's `FocusOwnerScope` claims the event, including in its
 * autocomplete, pickers, menus and sheets drawn at the app root. This listener runs after React
 * (document, bubble phase) and blurs only on events no owner claimed.
 */
export function useEmbedFocus(embedId: string) {
  const isFocused = useIsEmbedFocused(embedId);
  const owner = useCallback(() => focusEmbed(embedId), [embedId]);
  useEffect(() => {
    const follow = (event: Event) => {
      if (!wasClaimedByFocusOwner(event)) blurEmbed(embedId);
    };
    document.addEventListener("pointerdown", follow);
    document.addEventListener("focusin", follow);
    return () => {
      document.removeEventListener("pointerdown", follow);
      document.removeEventListener("focusin", follow);
      blurEmbed(embedId);
    };
  }, [embedId]);
  return { isFocused, owner };
}
