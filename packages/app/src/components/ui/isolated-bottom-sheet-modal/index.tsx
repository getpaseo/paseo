import {
  BottomSheetModal as GorhomBottomSheetModal,
  BottomSheetModalProvider,
  type BottomSheetModalProps,
} from "@gorhom/bottom-sheet";
import { Portal } from "@gorhom/portal";
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
>;

export type IsolatedBottomSheetModalRef = GorhomBottomSheetModalMethods;

const IsolatedBottomSheetScopeContext = createContext(false);

export const IsolatedBottomSheetModal = forwardRef<
  IsolatedBottomSheetModalRef,
  IsolatedBottomSheetModalProps
>(function IsolatedBottomSheetModal(props, ref) {
  const isNestedSheet = useContext(IsolatedBottomSheetScopeContext);
  const { children, ...bottomSheetProps } = props;
  const scopedChildren =
    typeof children === "function" ? (
      (input: { data?: unknown }) => (
        <IsolatedBottomSheetScopeContext.Provider value={true}>
          {children(input) as React.ReactNode}
        </IsolatedBottomSheetScopeContext.Provider>
      )
    ) : (
      <IsolatedBottomSheetScopeContext.Provider value={true}>
        {children}
      </IsolatedBottomSheetScopeContext.Provider>
    );
  const modal = (
    <GorhomBottomSheetModal
      {...bottomSheetProps}
      ref={ref}
      enableDismissOnClose
      stackBehavior={isNestedSheet ? "push" : "replace"}
    >
      {scopedChildren}
    </GorhomBottomSheetModal>
  );

  if (isNestedSheet) {
    return modal;
  }

  return (
    <Portal hostName="root">
      <BottomSheetModalProvider>{modal}</BottomSheetModalProvider>
    </Portal>
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
