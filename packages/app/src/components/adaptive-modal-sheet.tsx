import { forwardRef, useCallback, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { TextInputProps } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getOverlayRoot, OVERLAY_Z } from "../lib/overlay-root";
import {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
  type BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import { X } from "lucide-react-native";
import { FileDropZone } from "@/components/file-drop-zone";
import type { ImageAttachment } from "@/components/message-input";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { isWeb } from "@/constants/platform";

type EscHandler = () => void;
const escStack: EscHandler[] = [];
let escListenerAttached = false;

function handleEscKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const top = escStack[escStack.length - 1];
  if (!top) return;
  event.stopPropagation();
  event.preventDefault();
  top();
}

function pushEscHandler(handler: EscHandler): () => void {
  escStack.push(handler);
  if (!escListenerAttached && typeof window !== "undefined") {
    window.addEventListener("keydown", handleEscKeyDown, true);
    escListenerAttached = true;
  }
  return () => {
    const index = escStack.lastIndexOf(handler);
    if (index !== -1) escStack.splice(index, 1);
    if (escStack.length === 0 && escListenerAttached && typeof window !== "undefined") {
      window.removeEventListener("keydown", handleEscKeyDown, true);
      escListenerAttached = false;
    }
  };
}

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
  },
  header: {
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[4],
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
    gap: theme.spacing[3],
  },
  headerTitleGroup: {
    flex: 1,
    gap: theme.spacing[2],
    minWidth: 0,
  },
  title: {
    flex: 1,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: theme.spacing[3],
    marginRight: theme.spacing[2],
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
  bottomSheetHeader: {
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
    gap: theme.spacing[3],
  },
  bottomSheetContent: {
    padding: theme.spacing[6],
    gap: theme.spacing[4],
  },
  bottomSheetStaticContent: {
    flex: 1,
    padding: theme.spacing[6],
    gap: theme.spacing[4],
    minHeight: 0,
  },
  desktopStaticContent: {
    flexShrink: 1,
    minHeight: 0,
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
  /** Optional content rendered below the title in the header area. */
  subtitle?: ReactNode;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  headerActions?: ReactNode;
  snapPoints?: string[];
  testID?: string;
  /** Override the max width of the desktop card. */
  desktopMaxWidth?: number;
  /** When provided, wraps the card content in a FileDropZone. */
  onFilesDropped?: (files: ImageAttachment[]) => void;
  scrollable?: boolean;
}

export function AdaptiveModalSheet({
  title,
  subtitle,
  visible,
  onClose,
  children,
  headerActions,
  snapPoints,
  testID,
  desktopMaxWidth,
  onFilesDropped,
  scrollable = true,
}: AdaptiveModalSheetProps) {
  const { theme } = useUnistyles();
  const isMobile = useIsCompactFormFactor();
  const titleColor = theme.colors.foreground;
  const resolvedSnapPoints = useMemo(() => snapPoints ?? ["65%", "90%"], [snapPoints]);
  const { sheetRef, handleSheetChange } = useIsolatedBottomSheetVisibility({
    visible,
    isEnabled: isMobile,
    onClose,
  });

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.45} />
    ),
    [],
  );

  useEffect(() => {
    if (!isWeb || isMobile || !visible) return;
    return pushEscHandler(onClose);
  }, [visible, isMobile, onClose]);

  if (isMobile) {
    return (
      <IsolatedBottomSheetModal
        ref={sheetRef}
        snapPoints={resolvedSnapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundComponent={SheetBackground}
        handleIndicatorStyle={{ backgroundColor: theme.colors.surface2 }}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        accessible={false}
      >
        <View style={styles.bottomSheetHeader} testID={testID}>
          <View style={styles.headerTitleGroup}>
            <Text key={titleColor} style={[styles.title, { color: titleColor }]} numberOfLines={1}>
              {title}
            </Text>
            {subtitle}
          </View>
          {headerActions ? <View style={styles.headerActions}>{headerActions}</View> : null}
          <Pressable accessibilityLabel="Close" style={styles.closeButton} onPress={onClose}>
            <X size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        {scrollable ? (
          <BottomSheetScrollView
            contentContainerStyle={styles.bottomSheetContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </BottomSheetScrollView>
        ) : (
          <View style={styles.bottomSheetStaticContent}>{children}</View>
        )}
      </IsolatedBottomSheetModal>
    );
  }

  const cardInner = (
    <>
      <View style={styles.header}>
        <View style={styles.headerTitleGroup}>
          <Text key={titleColor} style={[styles.title, { color: titleColor }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle}
        </View>
        {headerActions ? <View style={styles.headerActions}>{headerActions}</View> : null}
        <Pressable accessibilityLabel="Close" style={styles.closeButton} onPress={onClose}>
          <X size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {scrollable ? (
        <ScrollView
          style={styles.desktopScroll}
          contentContainerStyle={styles.desktopContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.desktopStaticContent}>{children}</View>
      )}
    </>
  );

  const desktopContent = (
    <View style={styles.desktopOverlay} testID={testID}>
      <Pressable
        accessibilityLabel="Dismiss"
        style={{ ...StyleSheet.absoluteFillObject }}
        onPress={onClose}
      />
      <View style={[styles.desktopCard, desktopMaxWidth != null && { maxWidth: desktopMaxWidth }]}>
        {onFilesDropped ? (
          <FileDropZone onFilesDropped={onFilesDropped}>{cardInner}</FileDropZone>
        ) : (
          cardInner
        )}
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
export const AdaptiveTextInput = forwardRef<TextInput, TextInputProps>(
  function AdaptiveTextInput(props, ref) {
    const isMobile = useIsCompactFormFactor();

    if (isMobile) {
      return <BottomSheetTextInput ref={ref as any} {...props} />;
    }

    return <TextInput ref={ref} {...props} />;
  },
);
