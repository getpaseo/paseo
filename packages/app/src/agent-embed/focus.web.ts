import { useCallback, useEffect, useRef } from "react";
import type { View } from "react-native";
import { blurEmbed, focusEmbed, useIsEmbedFocused } from "./focus-store";

/**
 * Web: the embed is focused from a pointer press or a focus move inside it until one lands
 * outside it, the way a workspace pane takes focus from a click anywhere in it.
 */
export function useEmbedFocus(embedId: string) {
  const isFocused = useIsEmbedFocused(embedId);
  const nodeRef = useRef<HTMLElement | null>(null);
  const ref = useCallback((node: View | null) => {
    // React Native Web hands a View's ref the DOM element.
    nodeRef.current = node as unknown as HTMLElement | null;
  }, []);
  useEffect(() => {
    const follow = (event: Event) => {
      const node = nodeRef.current;
      if (node && event.target instanceof Node && node.contains(event.target)) focusEmbed(embedId);
      else blurEmbed(embedId);
    };
    document.addEventListener("pointerdown", follow, true);
    document.addEventListener("focusin", follow, true);
    return () => {
      document.removeEventListener("pointerdown", follow, true);
      document.removeEventListener("focusin", follow, true);
      blurEmbed(embedId);
    };
  }, [embedId]);
  return { isFocused, ref, onTouchStart: undefined };
}
