import React, { createContext, useContext, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { BottomSheetScrollView, BottomSheetBackdrop } from "@gorhom/bottom-sheet";
import { X } from "lucide-react-native";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import {
  IsolatedBottomSheetModal,
  type ContextBridge,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import type { ToolCallIconComponent } from "@/utils/tool-call-icon";
import { ToolCallDetailsContent } from "./tool-call-details";

// ----- Types -----

export interface ToolCallSheetData {
  toolName: string;
  displayName: string;
  summary?: string;
  detail?: ToolCallDetail;
  errorText?: string;
  icon: ToolCallIconComponent;
  showLoadingSkeleton?: boolean;
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

export function useToolCallSheetContextBridge(): ContextBridge {
  const context = useToolCallSheet();
  return useCallback(
    (children) => (
      <ToolCallSheetContext.Provider value={context}>{children}</ToolCallSheetContext.Provider>
    ),
    [context],
  );
}

interface ToolCallHeaderIconProps {
  icon: ToolCallIconComponent;
  size: number;
  color?: string;
}

function ToolCallHeaderIcon({ icon: Icon, size, color }: ToolCallHeaderIconProps) {
  return <Icon size={size} color={color} />;
}

const ThemedToolCallHeaderIcon = withUnistyles(ToolCallHeaderIcon, (theme) => ({
  color: theme.colors.foreground,
}));
const ThemedCloseIcon = withUnistyles(X, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export const ToolCallSheetModal = withUnistyles(IsolatedBottomSheetModal, (theme) => ({
  backgroundStyle: {
    backgroundColor: theme.colors.surface2,
    borderRadius: 16,
  },
  handleIndicatorStyle: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
}));

// ----- Provider Component -----

interface ToolCallSheetProviderProps {
  children: ReactNode;
}

export function ToolCallSheetProvider({ children }: ToolCallSheetProviderProps) {
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

  return (
    <ToolCallSheetContext.Provider value={contextValue}>
      {children}
      <ToolCallSheetModal
        ref={bottomSheetRef}
        contextBridge={null}
        snapPoints={snapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        onDismiss={handleToolCallSheetDismiss}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
      >
        {sheetData && <ToolCallSheetContent data={sheetData} onClose={closeToolCall} />}
      </ToolCallSheetModal>
    </ToolCallSheetContext.Provider>
  );
}

// ----- Sheet Content Component -----

interface ToolCallSheetContentProps {
  data: ToolCallSheetData;
  onClose: () => void;
}

function ToolCallSheetContent({ data, onClose }: ToolCallSheetContentProps) {
  const { t } = useTranslation();
  const {
    toolName,
    displayName,
    detail,
    errorText,
    icon: IconComponent,
    showLoadingSkeleton,
  } = data;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <ThemedToolCallHeaderIcon icon={IconComponent} size={20} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
        <Pressable
          onPress={onClose}
          style={styles.closeButton}
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.close")}
          testID="tool-call-sheet-close"
        >
          <ThemedCloseIcon size={20} />
        </Pressable>
      </View>

      {/* Content */}
      <BottomSheetScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <ToolCallDetailsContent
          toolName={toolName}
          detail={detail}
          errorText={errorText}
          fillAvailableHeight
          showLoadingSkeleton={showLoadingSkeleton}
        />
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
    fontSize: theme.fontSize.base,
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
