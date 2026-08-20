import { useCallback, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { BottomSheetBackdrop, BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { Wrench, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import {
  ToolCallSheetBackground,
  useToolCallSheetContextBridge,
} from "@/components/tool-call-sheet";
import { baseColors, type Theme } from "@/styles/theme";

interface OverviewToolCallGroupSheetProps {
  visible: boolean;
  summary: string;
  children: ReactNode;
  onClose: () => void;
}

const SNAP_POINTS = ["60%", "95%"];
const HANDLE_INDICATOR_STYLE = { backgroundColor: baseColors.zinc[600] };
const CONTENT_CONTAINER_STYLE = { paddingHorizontal: 13, paddingVertical: 8 };
const ThemedWrench = withUnistyles(Wrench);
const ThemedX = withUnistyles(X);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function OverviewToolCallGroupSheet({
  visible,
  summary,
  children,
  onClose,
}: OverviewToolCallGroupSheetProps) {
  const { t } = useTranslation();
  const contextBridge = useToolCallSheetContextBridge();
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    onClose,
  });
  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  return (
    <IsolatedBottomSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      snapPoints={SNAP_POINTS}
      index={0}
      enableDynamicSizing={false}
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
      backdropComponent={renderBackdrop}
      enablePanDownToClose
      backgroundComponent={ToolCallSheetBackground}
      handleIndicatorStyle={HANDLE_INDICATOR_STYLE}
    >
      <View style={styles.container} testID="tool-call-group-sheet">
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <ThemedWrench size={20} uniProps={foregroundMapping} />
            <Text style={styles.headerTitle} numberOfLines={2}>
              {summary}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            style={styles.closeButton}
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.close")}
            testID="tool-call-group-sheet-close"
          >
            <ThemedX size={20} uniProps={foregroundMutedMapping} />
          </Pressable>
        </View>
        <BottomSheetScrollView
          style={styles.content}
          contentContainerStyle={CONTENT_CONTAINER_STYLE}
        >
          {children}
        </BottomSheetScrollView>
      </View>
    </IsolatedBottomSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
  },
  headerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flex: 1,
  },
  closeButton: {
    padding: theme.spacing[2],
  },
  content: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface2,
  },
}));
