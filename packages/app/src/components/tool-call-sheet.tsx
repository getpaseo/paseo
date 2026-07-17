import React, { createContext, useContext, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import {
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import { X } from "lucide-react-native";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import type { ToolCallIconComponent } from "@/utils/tool-call-icon";
import { ToolCallDetailsContent } from "./tool-call-details";
import {
  TimelineHighlightProvider,
  type TimelineHighlightState,
} from "@/timeline-search/highlight";
import {
  TimelineSearchTargetProvider,
  type TimelineSearchTarget,
} from "@/timeline-search/search-target";
import type { TimelineSearchField } from "@/timeline-search/timeline-search-model";

// ----- Types -----

export interface ToolCallSheetData {
  displayName: string;
  summary?: string;
  detail?: ToolCallDetail;
  errorText?: string;
  icon: ToolCallIconComponent;
  showLoadingSkeleton?: boolean;
  /** Owning stream item id, so the sheet's detail content can match timeline-search field spans. */
  streamItemId?: string;
  timelineSearchField?: TimelineSearchField;
  /**
   * Snapshot of the timeline-search highlight query at the moment the sheet
   * was opened. The sheet (ToolCallSheetContent, below) renders OUTSIDE
   * TimelineHighlightProvider/TimelineSearchTargetProvider — it's a sibling
   * of TimelineSearchProviders inside ToolCallSheetProvider's own render
   * output, not a descendant of it — so it has no live context to read and
   * instead re-provides both contexts locally from this captured snapshot.
   */
  timelineHighlightQuery?: string;
  timelineSearchTarget?: TimelineSearchTarget | null;
}

interface ToolCallSheetContextValue {
  openToolCall: (data: ToolCallSheetData) => void;
  closeToolCall: () => void;
}

// ----- Context -----

const ToolCallSheetContext = createContext<ToolCallSheetContextValue | null>(null);

export function useToolCallSheet(): ToolCallSheetContextValue {
  const context = useContext(ToolCallSheetContext);
  if (!context) {
    throw new Error("useToolCallSheet must be used within a ToolCallSheetProvider");
  }
  return context;
}

// ----- Custom Background Component -----

function CustomSheetBackground({ style }: BottomSheetBackgroundProps) {
  const { theme } = useUnistyles();
  const containerStyle = useMemo(
    () => [style, { backgroundColor: theme.colors.surface2, borderRadius: 16 }],
    [style, theme.colors.surface2],
  );
  return <Animated.View pointerEvents="none" style={containerStyle} />;
}

// ----- Provider Component -----

interface ToolCallSheetProviderProps {
  children: ReactNode;
}

export function ToolCallSheetProvider({ children }: ToolCallSheetProviderProps) {
  const { theme } = useUnistyles();
  const [sheetData, setSheetData] = React.useState<ToolCallSheetData | null>(null);
  const [isSheetOpen, setIsSheetOpen] = React.useState(false);

  const snapPoints = useMemo(() => ["60%", "95%"], []);

  const openToolCall = useCallback((data: ToolCallSheetData) => {
    setSheetData(data);
    setIsSheetOpen(true);
  }, []);

  const closeToolCall = useCallback(() => {
    setIsSheetOpen(false);
  }, []);

  const {
    sheetRef: bottomSheetRef,
    handleSheetChange,
    handleSheetDismiss,
  } = useIsolatedBottomSheetVisibility({
    visible: isSheetOpen,
    onClose: closeToolCall,
  });

  const handleToolCallSheetDismiss = useCallback(() => {
    handleSheetDismiss();
    setSheetData(null);
  }, [handleSheetDismiss]);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  const contextValue = useMemo(
    () => ({ openToolCall, closeToolCall }),
    [openToolCall, closeToolCall],
  );

  const handleIndicatorStyle = useMemo(
    () => ({ backgroundColor: theme.colors.palette.zinc[600] }),
    [theme.colors.palette.zinc],
  );

  return (
    <ToolCallSheetContext.Provider value={contextValue}>
      {children}
      <IsolatedBottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        onDismiss={handleToolCallSheetDismiss}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundComponent={CustomSheetBackground}
        handleIndicatorStyle={handleIndicatorStyle}
      >
        {sheetData && <ToolCallSheetContent data={sheetData} onClose={closeToolCall} />}
      </IsolatedBottomSheetModal>
    </ToolCallSheetContext.Provider>
  );
}

// ----- Sheet Content Component -----

interface ToolCallSheetContentProps {
  data: ToolCallSheetData;
  onClose: () => void;
}

function ToolCallSheetContent({ data, onClose }: ToolCallSheetContentProps) {
  const { theme } = useUnistyles();
  const {
    displayName,
    detail,
    errorText,
    icon: IconComponent,
    showLoadingSkeleton,
    streamItemId,
    timelineSearchField,
    timelineHighlightQuery,
    timelineSearchTarget,
  } = data;

  const highlightState = useMemo<TimelineHighlightState>(
    () => ({ query: timelineHighlightQuery ?? "", target: timelineSearchTarget ?? null }),
    [timelineHighlightQuery, timelineSearchTarget],
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <IconComponent size={20} color={theme.colors.foreground} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
        <Pressable onPress={onClose} style={styles.closeButton}>
          <X size={20} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>

      {/* Content */}
      <BottomSheetScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <TimelineHighlightProvider value={highlightState}>
          <TimelineSearchTargetProvider value={timelineSearchTarget ?? null}>
            <ToolCallDetailsContent
              detail={detail}
              timelineSearchItemId={streamItemId}
              timelineSearchField={timelineSearchField}
              errorText={errorText}
              fillAvailableHeight
              showLoadingSkeleton={showLoadingSkeleton}
            />
          </TimelineSearchTargetProvider>
        </TimelineHighlightProvider>
      </BottomSheetScrollView>
    </View>
  );
}

// ----- Styles -----

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
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
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
  contentContainer: {
    padding: 0,
    flexGrow: 1,
  },
}));
