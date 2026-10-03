import { useMemo, type ReactNode } from "react";
import { View, useWindowDimensions } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SheetHeaderView, SHEET_HORIZONTAL_PADDING_SCALE } from "@/components/adaptive-modal-sheet";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";

// `backgroundStyle` and `handleIndicatorStyle` are style-shaped props the Babel plugin does not
// track, so the sheet is wrapped rather than reading the theme through a hook.
// See docs/unistyles.md.
const ThemedBottomSheetModal = withUnistyles(IsolatedBottomSheetModal, (theme) => ({
  backgroundStyle: {
    backgroundColor: theme.colors.surface0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
  },
  handleIndicatorStyle: { backgroundColor: theme.colors.palette.zinc[600] },
}));

/**
 * The context window meter's details on compact screens, in a sheet as tall as its content.
 * Gorhom mounts the content only while the sheet is presented, so whatever it fetches stops once
 * the sheet closes.
 */
export function ContextWindowSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const header = useMemo(() => ({ title: t("contextWindow.title") }), [t]);
  const scrollContentStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible: open,
    onClose,
  });

  return (
    <ThemedBottomSheetModal
      ref={sheetRef}
      contextBridge={null}
      // Content-sized rather than fixed snap points: the usage cards stream in one at a time.
      enableDynamicSizing
      maxDynamicContentSize={height * 0.8}
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
      backdropOpacity={0.45}
      enablePanDownToClose
    >
      <BottomSheetScrollView
        contentContainerStyle={scrollContentStyle}
        showsVerticalScrollIndicator={false}
        testID="context-window-sheet"
      >
        <SheetHeaderView header={header} onClose={onClose} />
        {/* The inset sits on a View: a themed contentContainerStyle resolves to nothing on web. */}
        <View style={styles.body}>{children}</View>
      </BottomSheetScrollView>
    </ThemedBottomSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    padding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    gap: theme.spacing[4],
  },
}));
