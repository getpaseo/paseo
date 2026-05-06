import {
  BottomSheetModal as GorhomBottomSheetModal,
  BottomSheetModalProvider,
  type BottomSheetModalProps,
} from "@gorhom/bottom-sheet";
import { Portal } from "@gorhom/portal";
import React, { createContext, useContext } from "react";
import { forwardRef, useCallback, useEffect, useRef } from "react";
import type { ElementRef } from "react";

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
  const sheetRef = useRef<IsolatedBottomSheetModalRef | null>(null);
  const visibleRef = useRef(visible);
  const isEnabledRef = useRef(isEnabled);
  const isPresentedRef = useRef(false);
  const hasNotifiedCloseRef = useRef(false);

  visibleRef.current = visible;
  isEnabledRef.current = isEnabled;

  const presentSheet = useCallback((sheet: IsolatedBottomSheetModalRef) => {
    if (isPresentedRef.current) {
      return;
    }

    isPresentedRef.current = true;
    hasNotifiedCloseRef.current = false;
    sheet.present();
  }, []);

  const dismissSheet = useCallback((sheet: IsolatedBottomSheetModalRef) => {
    if (!isPresentedRef.current) {
      return;
    }

    isPresentedRef.current = false;
    sheet.dismiss();
  }, []);

  const notifyClose = useCallback(() => {
    if (hasNotifiedCloseRef.current) {
      return;
    }

    hasNotifiedCloseRef.current = true;
    onClose();
  }, [onClose]);

  const handleSheetDismiss = useCallback(() => {
    isPresentedRef.current = false;
    if (visibleRef.current) {
      notifyClose();
      return;
    }
    hasNotifiedCloseRef.current = false;
  }, [notifyClose]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1 && visibleRef.current) {
        notifyClose();
      }
    },
    [notifyClose],
  );

  const setSheetRef = useCallback(
    (instance: IsolatedBottomSheetModalRef | null) => {
      sheetRef.current = instance;
      if (instance && visibleRef.current && isEnabledRef.current !== false) {
        presentSheet(instance);
      }
    },
    [presentSheet],
  );

  useEffect(() => {
    if (isEnabled === false) return;

    const sheet = sheetRef.current;
    if (visible) {
      if (!sheet) {
        return;
      }

      presentSheet(sheet);
      return;
    }

    if (sheet) {
      dismissSheet(sheet);
    }
  }, [dismissSheet, isEnabled, presentSheet, visible]);

  return {
    sheetRef: setSheetRef,
    handleSheetChange,
    handleSheetDismiss,
  };
}
