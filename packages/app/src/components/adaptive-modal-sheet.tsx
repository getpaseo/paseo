import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { TextInputProps } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getOverlayRoot, OVERLAY_Z } from "../lib/overlay-root";
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
  type BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import { X } from "lucide-react-native";
import { isWeb } from "@/constants/platform";

const styles = StyleSheet.create((theme) => ({
  desktopOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
    zIndex: OVERLAY_Z.modal,
    pointerEvents: "auto" as const,
  },
  desktopCard: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "85%",
    flexShrink: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    overflow: "hidden",
  },
  header: {
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  closeButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  desktopScroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  desktopContent: {
    padding: theme.spacing[6],
    gap: theme.spacing[4],
    flexGrow: 1,
  },
  bottomSheetHandle: {
    backgroundColor: theme.colors.surface2,
  },
  bottomSheetHeader: {
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  bottomSheetContent: {
    padding: theme.spacing[6],
    gap: theme.spacing[4],
  },
}));

function SheetBackground({ style }: BottomSheetBackgroundProps) {
  const { theme } = useUnistyles();
  return (
    <View
      style={[
        style,
        {
          backgroundColor: theme.colors.surface1,
          borderTopLeftRadius: theme.borderRadius.xl,
          borderTopRightRadius: theme.borderRadius.xl,
        },
      ]}
    />
  );
}

export interface AdaptiveModalSheetProps {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  snapPoints?: string[];
  stackBehavior?: "push" | "switch" | "replace";
  testID?: string;
}

export function AdaptiveModalSheet({
  title,
  visible,
  onClose,
  children,
  snapPoints,
  stackBehavior,
  testID,
}: AdaptiveModalSheetProps) {
  const { theme } = useUnistyles();
  const isMobile = useIsCompactFormFactor();
  const sheetRef = useRef<BottomSheetModal>(null);
  const dismissingForVisibilityRef = useRef(false);
  const resolvedSnapPoints = useMemo(() => snapPoints ?? ["65%", "90%"], [snapPoints]);

  useEffect(() => {
    if (!isMobile) return;
    if (visible) {
      dismissingForVisibilityRef.current = false;
      sheetRef.current?.present();
    } else {
      dismissingForVisibilityRef.current = true;
      sheetRef.current?.dismiss();
    }
  }, [visible, isMobile]);

  // Desktop: close on Escape. Top-most modal wins via capture-phase listener
  // and Esc is only handled when this modal is actually visible.
  useEffect(() => {
    if (!isWeb) return;
    if (isMobile) return;
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, isMobile, onClose]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        if (dismissingForVisibilityRef.current) {
          dismissingForVisibilityRef.current = false;
          return;
        }
        onClose();
      }
    },
    [onClose],
  );

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.45} />
    ),
    [],
  );

  if (isMobile) {
    return (
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={resolvedSnapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        stackBehavior={stackBehavior}
        backgroundComponent={SheetBackground}
        handleIndicatorStyle={styles.bottomSheetHandle}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
      >
        <View style={styles.bottomSheetHeader}>
          <Text style={styles.title}>{title}</Text>
          <Pressable accessibilityLabel="Close" style={styles.closeButton} onPress={onClose}>
            <X size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        <BottomSheetScrollView
          contentContainerStyle={styles.bottomSheetContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  }

  const desktopContent = (
    <View style={styles.desktopOverlay} testID={testID}>
      <Pressable
        accessibilityLabel="Dismiss"
        style={{ ...StyleSheet.absoluteFillObject }}
        onPress={onClose}
      />
      <View style={styles.desktopCard}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable accessibilityLabel="Close" style={styles.closeButton} onPress={onClose}>
            <X size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        <ScrollView
          style={styles.desktopScroll}
          contentContainerStyle={styles.desktopContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </View>
    </View>
  );

  // On web, use portal to overlay root for consistent stacking with toasts
  if (isWeb && typeof document !== "undefined") {
    if (!visible) return null;
    return createPortal(desktopContent, getOverlayRoot());
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
      hardwareAccelerated
    >
      {desktopContent}
    </Modal>
  );
}

/**
 * TextInput that automatically uses BottomSheetTextInput on mobile
 * for proper keyboard dodging in AdaptiveModalSheet.
 */
type AdaptiveTextInputProps = TextInputProps & {
  /** When set, the input border takes this color while focused. */
  focusBorderColor?: string;
};

export const AdaptiveTextInput = forwardRef<TextInput, AdaptiveTextInputProps>(
  function AdaptiveTextInput(
    { focusBorderColor, style, onFocus, onBlur, ...rest },
    ref,
  ) {
    const isMobile = useIsCompactFormFactor();
    const [focused, setFocused] = useState(false);
    const mergedStyle = useMemo(
      () =>
        focused && focusBorderColor
          ? [style, { borderColor: focusBorderColor }]
          : style,
      [focused, focusBorderColor, style],
    );
    const handleFocus = useCallback<NonNullable<TextInputProps["onFocus"]>>(
      (e) => {
        setFocused(true);
        onFocus?.(e);
      },
      [onFocus],
    );
    const handleBlur = useCallback<NonNullable<TextInputProps["onBlur"]>>(
      (e) => {
        setFocused(false);
        onBlur?.(e);
      },
      [onBlur],
    );

    if (isMobile) {
      return (
        <BottomSheetTextInput
          ref={ref as any}
          style={mergedStyle as TextInputProps["style"]}
          onFocus={handleFocus}
          onBlur={handleBlur}
          {...rest}
        />
      );
    }

    return (
      <TextInput
        ref={ref}
        style={mergedStyle}
        onFocus={handleFocus}
        onBlur={handleBlur}
        {...rest}
      />
    );
  },
);
