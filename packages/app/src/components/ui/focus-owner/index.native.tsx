import { useCallback } from "react";
import { View } from "react-native";
import { FocusOwnerContext, type FocusOwnerScopeProps } from "./context";

export { useFocusOwner, type FocusOwner, type FocusOwnerScopeProps } from "./context";

/**
 * Native: a touch that starts anywhere in the scope's React subtree calls its owner, including
 * a native `Modal` (it keeps the React tree) and, through `FocusOwnerScope` re-opened on the far
 * side of `@gorhom/portal`, a popover or bottom sheet drawn at the app root. Touch events follow
 * the React tree (`topTouchStart` is a phased event), so the capture handler hears each touch
 * before any child does, and no child can stop it.
 */
export function FocusOwnerScope({ owner, style, children }: FocusOwnerScopeProps) {
  const claim = useCallback(() => owner?.(), [owner]);
  if (!owner) return children;
  return (
    <FocusOwnerContext.Provider value={owner}>
      <View style={style} pointerEvents="box-none" onTouchStartCapture={claim}>
        {children}
      </View>
    </FocusOwnerContext.Provider>
  );
}

/** Web only; native has no document-level listener to tell. */
export function wasClaimedByFocusOwner(_event: Event): boolean {
  return false;
}
