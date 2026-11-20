import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { View } from "react-native";
import { BottomSheetScrollView, type BottomSheetScrollViewMethods } from "@gorhom/bottom-sheet";
import { Wrench } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  type ContextBridge,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { SheetHeaderView, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ToolCallSheetModal, useToolCallSheetContextBridge } from "@/components/tool-call-sheet";
import { useToolCallExpansionContextBridge } from "@/tool-calls/expansion-context";
import { ICON_SIZE, type Theme } from "@/styles/theme";

interface OverviewToolCallGroupSheetProps {
  visible: boolean;
  summary: string;
  children: ReactNode;
  onClose: () => void;
}

const SNAP_POINTS = ["60%", "95%"];
const ThemedWrench = withUnistyles(Wrench);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const headerIcon = <ThemedWrench size={ICON_SIZE.md} uniProps={foregroundMapping} />;

export function OverviewToolCallGroupSheet({
  visible,
  summary,
  children,
  onClose,
}: OverviewToolCallGroupSheetProps) {
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  const sheetContextBridge = useToolCallSheetContextBridge();
  const expansionContextBridge = useToolCallExpansionContextBridge();
  const contextBridge = useCallback<ContextBridge>(
    (content) => sheetContextBridge(expansionContextBridge(content)),
    [expansionContextBridge, sheetContextBridge],
  );
  const header = useMemo<SheetHeader>(
    () => ({ title: summary, titleTestID: "tool-call-group-sheet-summary", leading: headerIcon }),
    [summary],
  );
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    onClose,
  });

  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  useEffect(() => {
    if (!visible) {
      return;
    }
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [children, scrollToLatest, visible]);

  return (
    <ToolCallSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      snapPoints={SNAP_POINTS}
      index={0}
      enableDynamicSizing={false}
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
      backdropOpacity={0.5}
      enablePanDownToClose
    >
      <View style={styles.container} testID="tool-call-group-sheet">
        <SheetHeaderView
          header={header}
          onClose={onClose}
          closeTestID="tool-call-group-sheet-close"
        />
        <BottomSheetScrollView ref={scrollRef} style={styles.content}>
          <View style={styles.contentContainer}>{children}</View>
        </BottomSheetScrollView>
      </View>
    </ToolCallSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface2,
  },
  content: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface2,
  },
  contentContainer: {
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
}));
