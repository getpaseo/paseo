import {
  BottomSheetModal as GorhomBottomSheetModal,
  type BottomSheetModalProps,
} from "@gorhom/bottom-sheet";
import React from "react";
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ElementRef, Ref, ReactNode } from "react";
import { BackHandler } from "react-native";
import {
  type BottomSheetController,
  createBottomSheetVisibilityTracker,
} from "./visibility-tracker";
import { BottomSheetScope } from "@/components/ui/bottom-sheet-scope";

type GorhomBottomSheetModalMethods = ElementRef<typeof GorhomBottomSheetModal>;

/**
 * Re-establishes React context on the far side of the portal.
 *
 * `@gorhom/portal` is not a React portal. It stores the element and a host elsewhere in the tree
 * renders it, so context resolves at the *host's* position: everything provided between
 * `PortalProvider` (see `app/_layout.tsx`) and this sheet is invisible to its content. React
 * cannot copy contexts reflectively, so the only way across is to render the providers again —
 * with values captured out here, where they are still readable.
 *
 * Write it as a closure over what you already have:
 *
 * ```tsx
 * const contextBridge = useCallback<ContextBridge>(
 *   (content) => <ThingContext.Provider value={thing}>{content}</ThingContext.Provider>,
 *   [thing],
 * );
 * ```
 */
export type ContextBridge = (children: ReactNode) => ReactNode;

type IsolatedBottomSheetModalProps = Omit<
  BottomSheetModalProps,
  "enableDismissOnClose" | "stackBehavior" | "children"
> & {
  /**
   * Nodes only. Gorhom also accepts a render function, but nothing here uses it and a bridge
   * would have to reach around it.
   */
  children?: ReactNode;
  presentation?: "push" | "replace";
  /**
   * Required, and `null` is a real answer: a sheet that needs nothing from its call site should
   * have to say so. The failure it prevents is invisible until someone adds a `useContext` deep
   * inside the sheet and it throws on device only.
   */
  contextBridge: ContextBridge | null;
};

export type IsolatedBottomSheetModalRef = GorhomBottomSheetModalMethods;

export const IsolatedBottomSheetModal = forwardRef<
  IsolatedBottomSheetModalRef,
  IsolatedBottomSheetModalProps
>(function IsolatedBottomSheetModal(props, ref) {
  const {
    children,
    presentation = "push",
    contextBridge,
    onChange,
    onDismiss,
    ...bottomSheetProps
  } = props;
  const sheet = useRef<IsolatedBottomSheetModalRef | null>(null);
  const attachSheet = useCallback(
    (instance: IsolatedBottomSheetModalRef | null) => {
      sheet.current = instance;
      assignRef(ref, instance);
    },
    [ref],
  );

  // The sheet lives in a portal inside the app's own view tree, not in a native modal window, so
  // Android hands Back to the navigator underneath it. Claim the press for as long as the sheet
  // is on screen, or Back dismisses the screen the sheet is covering instead of the sheet.
  const [isOnScreen, setIsOnScreen] = useState(false);
  const handleChange = useCallback(
    (index: number, ...rest: SheetChangeRest) => {
      setIsOnScreen(index !== -1);
      onChange?.(index, ...rest);
    },
    [onChange],
  );
  const handleDismiss = useCallback(() => {
    setIsOnScreen(false);
    onDismiss?.();
  }, [onDismiss]);

  useEffect(() => {
    if (!isOnScreen) return;
    // Listeners are offered the press newest-first, so a stacked sheet answers before the one
    // below it. `BackHandler` never fires off Android, which is why this needs no platform check.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      sheet.current?.dismiss();
      return true;
    });
    return () => subscription.remove();
  }, [isOnScreen]);

  const modal = (
    <GorhomBottomSheetModal
      {...bottomSheetProps}
      ref={attachSheet}
      onChange={handleChange}
      onDismiss={handleDismiss}
      enableDismissOnClose
      stackBehavior={presentation}
    >
      <BottomSheetScope>{contextBridge ? contextBridge(children) : children}</BottomSheetScope>
    </GorhomBottomSheetModal>
  );

  return modal;
});

type SheetChangeRest =
  NonNullable<BottomSheetModalProps["onChange"]> extends (
    index: number,
    ...rest: infer Rest
  ) => void
    ? Rest
    : never;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

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
