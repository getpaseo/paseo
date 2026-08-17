import React, { createContext, useContext, useCallback, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { BackHandler, View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import { isWeb } from "@/constants/platform";
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

// ----- Types -----

export interface ToolCallSheetData {
  displayName: string;
  summary?: string;
  detail?: ToolCallDetail;
  errorText?: string;
  icon: ToolCallIconComponent;
  showLoadingSkeleton?: boolean;
}

interface ToolCallSheetContextValue {
  openToolCall: (token: object, data: ToolCallSheetData) => void;
  closeToolCall: () => void;
  syncToolCallData: (token: object, data: ToolCallSheetData) => void;
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

// The sheet renders live tool call data through a token-scoped sync: the caller
// opens with an opaque token and re-syncs on every stream update, so the sheet
// follows streaming output instead of freezing at the moment it was opened.
interface ToolCallSheetSession {
  token: object;
  data: ToolCallSheetData;
}

export function ToolCallSheetProvider({ children }: ToolCallSheetProviderProps) {
  const { theme } = useUnistyles();
  const [session, setSession] = React.useState<ToolCallSheetSession | null>(null);
  const [isSheetOpen, setIsSheetOpen] = React.useState(false);

  const snapPoints = useMemo(() => ["60%", "95%"], []);

  const openToolCall = useCallback((token: object, data: ToolCallSheetData) => {
    setSession({ token, data });
    setIsSheetOpen(true);
  }, []);

  const closeToolCall = useCallback(() => {
    setIsSheetOpen(false);
  }, []);

  const syncToolCallData = useCallback((token: object, data: ToolCallSheetData) => {
    setSession((current) =>
      current !== null && current.token === token ? { ...current, data } : current,
    );
  }, []);

  // Android's hardware back closes the sheet instead of exiting the app. Gorhom
  // v5 mounts no native Modal, so no onRequestClose exists; a BackHandler is the
  // only path. Web and desktop never see this handler.
  useEffect(() => {
    if (isWeb || !isSheetOpen) {
      return;
    }
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      closeToolCall();
      return true;
    });
    return () => handler.remove();
  }, [closeToolCall, isSheetOpen]);

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
    setSession(null);
  }, [handleSheetDismiss]);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  const contextValue = useMemo(
    () => ({ openToolCall, closeToolCall, syncToolCallData }),
    [openToolCall, closeToolCall, syncToolCallData],
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
        contextBridge={null}
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
        {session && <ToolCallSheetContent data={session.data} onClose={closeToolCall} />}
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
  const { displayName, detail, errorText, icon: IconComponent, showLoadingSkeleton } = data;

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
        <ToolCallDetailsContent
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
