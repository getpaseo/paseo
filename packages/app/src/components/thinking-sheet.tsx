import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  ReactNode,
} from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from "@gorhom/bottom-sheet";
import { Brain, X } from "lucide-react-native";
import type { ThoughtStatus } from "@/types/stream";
import { AgentThoughtContent } from "./agent-thought-content";

export interface ThinkingSheetData {
  message: string;
  status?: ThoughtStatus;
}

interface ThinkingSheetContextValue {
  openThinking: (data: ThinkingSheetData) => void;
  closeThinking: () => void;
}

const ThinkingSheetContext = createContext<ThinkingSheetContextValue | null>(null);

export function useThinkingSheet(): ThinkingSheetContextValue {
  const context = useContext(ThinkingSheetContext);
  if (!context) {
    throw new Error("useThinkingSheet must be used within a ThinkingSheetProvider");
  }
  return context;
}

export function ThinkingSheetProvider({ children }: { children: ReactNode }) {
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const [sheetData, setSheetData] = React.useState<ThinkingSheetData | null>(null);

  const snapPoints = useMemo(() => ["60%", "95%"], []);

  const openThinking = useCallback((data: ThinkingSheetData) => {
    setSheetData(data);
    bottomSheetRef.current?.present();
  }, []);

  const closeThinking = useCallback(() => {
    bottomSheetRef.current?.dismiss();
  }, []);

  const handleSheetChange = useCallback((index: number) => {
    if (index === -1) {
      setSheetData(null);
    }
  }, []);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
      />
    ),
    []
  );

  const contextValue = useMemo(
    () => ({ openThinking, closeThinking }),
    [openThinking, closeThinking]
  );

  return (
    <ThinkingSheetContext.Provider value={contextValue}>
      {children}
      <BottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handleIndicator}
      >
        {sheetData && (
          <ThinkingSheetContent data={sheetData} onClose={closeThinking} />
        )}
      </BottomSheetModal>
    </ThinkingSheetContext.Provider>
  );
}

function ThinkingSheetContent({
  data,
  onClose,
}: {
  data: ThinkingSheetData;
  onClose: () => void;
}) {
  const { message } = data;
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Brain size={20} color={styles.headerIcon.color} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            Thinking
          </Text>
        </View>
        <Pressable onPress={onClose} style={styles.closeButton}>
          <X size={20} color={styles.closeIcon.color} />
        </Pressable>
      </View>

      <BottomSheetScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
      >
        <AgentThoughtContent message={message} />
      </BottomSheetScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheetBackground: {
    backgroundColor: theme.colors.surface2,
  },
  handleIndicator: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
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
  headerIcon: {
    color: theme.colors.foreground,
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
  closeIcon: {
    color: theme.colors.foregroundMuted,
  },
  content: {
    flex: 1,
    backgroundColor: theme.colors.surface2,
  },
  contentContainer: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[8],
  },
}));
