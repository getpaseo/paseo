import {
  BottomSheetModal as GorhomBottomSheetModal,
  type BottomSheetModalProps,
} from "@gorhom/bottom-sheet";
import React, { createContext, useContext } from "react";
import { forwardRef, useCallback, useEffect, useMemo, useRef } from "react";
import type { ElementRef } from "react";
import {
  type BottomSheetController,
  createBottomSheetVisibilityTracker,
} from "./visibility-tracker";

type GorhomBottomSheetModalMethods = ElementRef<typeof GorhomBottomSheetModal>;

type IsolatedBottomSheetModalProps = Omit<
  BottomSheetModalProps,
  "enableDismissOnClose" | "stackBehavior"
> & {
  presentation?: "push" | "replace";
};

export type IsolatedBottomSheetModalRef = GorhomBottomSheetModalMethods;

/**
 * True only under an open Gorhom bottom-sheet tree. AdaptiveTextInput and
 * similar inputs must not call BottomSheetTextInput / useBottomSheetInternal
 * outside this scope (e.g. backlog search on a normal screen).
 */
const BottomSheetInputScopeContext = createContext(false);

export function useIsInsideBottomSheetInputScope(): boolean {
  return useContext(BottomSheetInputScopeContext);
}

export const IsolatedBottomSheetModal = forwardRef<
  IsolatedBottomSheetModalRef,
  IsolatedBottomSheetModalProps
>(function IsolatedBottomSheetModal(props, ref) {
  const { children, presentation = "push", ...bottomSheetProps } = props;
  // Cast: Gorhom allows children as render function; Provider needs ReactNode.
  const scopedChildren = (
    <BottomSheetInputScopeContext.Provider value={true}>
      {children as React.ReactNode}
    </BottomSheetInputScopeContext.Provider>
  );

  return (
    <GorhomBottomSheetModal
      {...bottomSheetProps}
      ref={ref}
      enableDismissOnClose
      stackBehavior={presentation}
    >
      {scopedChildren}
    </GorhomBottomSheetModal>
  );
});

export function useIsolatedBottomSheetVisibility({
  visible,
  isEnabled,
  onClose,
}: {
  visible: boolean;
  isEnabled?: boolean;
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const tracker = useMemo(
    () => createBottomSheetVisibilityTracker({ onClose: () => onCloseRef.current() }),
    [],
  );

  const setSheetRef = useCallback(
    (instance: IsolatedBottomSheetModalRef | null) => {
      tracker.attachController(instance as BottomSheetController | null);
    },
    [tracker],
  );

  const handleSheetChange = useCallback(
    (index: number) => tracker.handleSheetIndexChange(index),
    [tracker],
  );

  const handleSheetDismiss = useCallback(() => tracker.handleSheetDismiss(), [tracker]);

  useEffect(() => {
    tracker.syncDesired({ visible, isEnabled });
  }, [isEnabled, tracker, visible]);

  return {
    sheetRef: setSheetRef,
    handleSheetChange,
    handleSheetDismiss,
  };
}
