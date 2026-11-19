import React, {
  createContext,
  useContext,
  useMemo,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { GestureType } from "react-native-gesture-handler";

/**
 * Ref for a drag gesture inside the sheet's content, set through the gesture's `withRef`. Keep it
 * out of worklet closures: Reanimated freezes captured objects in dev, and RNGH can then no longer
 * set `.current`.
 */
export type SheetContentDragGesture = MutableRefObject<GestureType | undefined>;

/**
 * Registers a child's drag with the sheet, so the sheet's content pan waits for it to fail and the
 * child keeps the touch instead of moving the sheet. Returns the unregister. Call it after the
 * gesture has attached: RNGH resolves the ref to a handler tag when the sheet builds its pan, and
 * drops a ref that is still empty.
 */
export type AttachSheetContentDrag = (gesture: SheetContentDragGesture) => () => void;

interface BottomSheetScopeValue {
  attachContentDrag: AttachSheetContentDrag;
}

const BottomSheetScopeContext = createContext<BottomSheetScopeValue | null>(null);

export function BottomSheetScope({
  attachContentDrag,
  children,
}: BottomSheetScopeValue & { children: ReactNode }) {
  const value = useMemo(() => ({ attachContentDrag }), [attachContentDrag]);
  return (
    <BottomSheetScopeContext.Provider value={value}>{children}</BottomSheetScopeContext.Provider>
  );
}

export function useIsInsideBottomSheet(): boolean {
  return useContext(BottomSheetScopeContext) !== null;
}

export function useAttachSheetContentDrag(): AttachSheetContentDrag | undefined {
  return useContext(BottomSheetScopeContext)?.attachContentDrag;
}
