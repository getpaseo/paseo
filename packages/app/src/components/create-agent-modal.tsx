import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetScrollView,
  BottomSheetTextInput,
  BottomSheetFooter,
} from "@gorhom/bottom-sheet";
import type {
  BottomSheetBackdropProps,
  BottomSheetFooterProps,
} from "@gorhom/bottom-sheet";
import { StyleSheet } from "react-native-unistyles";
import { theme as defaultTheme } from "@/styles/theme";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useSession } from "@/contexts/session-context";
import { useRouter } from "expo-router";
import { generateMessageId } from "@/types/stream";

interface CreateAgentModalProps {
  isVisible: boolean;
  onClose: () => void;
}

const MODES = [
  {
    value: "plan",
    label: "Plan",
    description: "Plan and design before implementing",
  },
  {
    value: "bypassPermissions",
    label: "Bypass Permissions",
    description: "Skip permission prompts for faster execution",
  },
] as const;

export function CreateAgentModal({
  isVisible,
  onClose,
}: CreateAgentModalProps) {
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const { recentPaths, addRecentPath } = useRecentPaths();
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const { ws, createAgent } = useSession();
  const router = useRouter();

  const [workingDir, setWorkingDir] = useState("");
  const [selectedMode, setSelectedMode] = useState("plan");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);

  const snapPoints = useMemo(() => ["90%"], []);

  // Keyboard animation for footer
  const animatedFooterStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const padding = Math.max(0, absoluteHeight - insets.bottom);
    return {
      paddingBottom: padding,
    };
  });

  const renderBackdrop = useMemo(
    () => (props: BottomSheetBackdropProps) =>
      (
        <BottomSheetBackdrop
          {...props}
          disappearsOnIndex={-1}
          appearsOnIndex={0}
          opacity={0.5}
        />
      ),
    []
  );

  const renderFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props} style={animatedFooterStyle}>
        <Animated.View
          style={[styles.footer, { paddingBottom: insets.bottom }]}
        >
          <Pressable
            style={[
              styles.createButton,
              (!workingDir.trim() || isLoading) && styles.createButtonDisabled,
            ]}
            onPress={handleCreate}
            disabled={!workingDir.trim() || isLoading}
          >
            {isLoading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator color={defaultTheme.colors.palette.white} />
                <Text style={styles.createButtonText}>Creating...</Text>
              </View>
            ) : (
              <Text style={styles.createButtonText}>Create Agent</Text>
            )}
          </Pressable>
        </Animated.View>
      </BottomSheetFooter>
    ),
    [insets.bottom, workingDir, animatedFooterStyle, isLoading]
  );

  useEffect(() => {
    if (isVisible) {
      bottomSheetRef.current?.present();
    }
  }, [isVisible]);

  // Listen for agent_created events
  useEffect(() => {
    if (!pendingRequestId) return;

    const unsubscribe = ws.on("agent_created", (message) => {
      if (message.type !== "agent_created") return;

      const { agentId, requestId } = message.payload;

      // Check if this is the response to our request
      if (requestId === pendingRequestId) {
        console.log("[CreateAgentModal] Agent created:", agentId);
        setIsLoading(false);
        setPendingRequestId(null);

        // Navigate to the agent page BEFORE closing modal
        // This prevents race condition on Android where router.push() happens
        // while the modal is unmounting, causing NullPointerException
        router.push(`/agent/${agentId}`);

        // Close modal after navigation starts
        handleClose();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [pendingRequestId, ws, router]);

  async function handleCreate() {
    if (!workingDir.trim()) {
      setErrorMessage("Working directory is required");
      return;
    }

    if (isLoading) {
      return;
    }

    const path = workingDir.trim();

    // Save to recent paths
    try {
      await addRecentPath(path);
    } catch (error) {
      console.error("[CreateAgentModal] Failed to save recent path:", error);
      // Continue anyway - don't block agent creation
    }

    // Generate request ID
    const requestId = generateMessageId();

    setIsLoading(true);
    setPendingRequestId(requestId);
    setErrorMessage("");

    // Create the agent
    try {
      createAgent({
        cwd: path,
        initialMode: selectedMode,
        requestId,
      });
    } catch (error) {
      console.error("[CreateAgentModal] Failed to create agent:", error);
      setErrorMessage("Failed to create agent. Please try again.");
      setIsLoading(false);
      setPendingRequestId(null);
    }
  }

  function handleClose() {
    bottomSheetRef.current?.dismiss();
  }

  function handleDismiss() {
    // Reset all state
    setWorkingDir("");
    setSelectedMode("plan");
    setErrorMessage("");
    setIsLoading(false);
    setPendingRequestId(null);
    onClose();
  }

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose={true}
      onDismiss={handleDismiss}
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.handleIndicator}
      backdropComponent={renderBackdrop}
      footerComponent={renderFooter}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      topInset={insets.top}
    >
      <BottomSheetView style={styles.sheetContent}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Create New Agent</Text>
        </View>

        {/* Form */}
        <BottomSheetScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Working Directory Input */}
          <View style={styles.formSection}>
            <Text style={styles.label}>Working Directory</Text>
            <BottomSheetTextInput
              style={[styles.input, isLoading && styles.inputDisabled]}
              placeholder="/path/to/project"
              placeholderTextColor={defaultTheme.colors.mutedForeground}
              value={workingDir}
              onChangeText={(text) => {
                setWorkingDir(text);
                setErrorMessage("");
              }}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isLoading}
            />
            {errorMessage && (
              <Text style={styles.errorText}>{errorMessage}</Text>
            )}

            {/* Recent Paths Chips */}
            {recentPaths.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.recentPathsContainer}
                keyboardShouldPersistTaps="handled"
              >
                {recentPaths.map((path) => (
                  <Pressable
                    key={path}
                    style={styles.recentPathChip}
                    onPress={() => setWorkingDir(path)}
                  >
                    <Text style={styles.recentPathChipText} numberOfLines={1}>
                      {path}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>

          {/* Mode Selector */}
          <View style={styles.formSection}>
            <Text style={styles.label}>Mode</Text>
            <View style={styles.modeContainer}>
              {MODES.map((mode) => (
                <Pressable
                  key={mode.value}
                  onPress={() => setSelectedMode(mode.value)}
                  disabled={isLoading}
                  style={[
                    styles.modeOption,
                    selectedMode === mode.value && styles.modeOptionSelected,
                    isLoading && styles.modeOptionDisabled,
                  ]}
                >
                  <View style={styles.modeOptionContent}>
                    <View
                      style={[
                        styles.radioOuter,
                        selectedMode === mode.value
                          ? styles.radioOuterSelected
                          : styles.radioOuterUnselected,
                      ]}
                    >
                      {selectedMode === mode.value && (
                        <View style={styles.radioInner} />
                      )}
                    </View>
                    <View style={styles.modeTextContainer}>
                      <Text style={styles.modeLabel}>{mode.label}</Text>
                      <Text style={styles.modeDescription}>
                        {mode.description}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        </BottomSheetScrollView>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheetBackground: {
    backgroundColor: theme.colors.card,
  },
  handleIndicator: {
    backgroundColor: theme.colors.border,
  },
  sheetContent: {
    flex: 1,
  },
  header: {
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing[6],
    paddingBottom: theme.spacing[6],
  },
  formSection: {
    marginBottom: theme.spacing[6],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[2],
  },
  input: {
    backgroundColor: theme.colors.background,
    color: theme.colors.foreground,
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  inputDisabled: {
    opacity: theme.opacity[50],
  },
  helperText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
  },
  modeContainer: {
    gap: theme.spacing[3],
  },
  modeOption: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
  },
  modeOptionSelected: {
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.muted,
  },
  modeOptionDisabled: {
    opacity: theme.opacity[50],
  },
  modeOptionContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[2],
    marginRight: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterSelected: {
    borderColor: theme.colors.palette.blue[500],
  },
  radioOuterUnselected: {
    borderColor: theme.colors.border,
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
  modeTextContainer: {
    flex: 1,
  },
  modeLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[1],
  },
  modeDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    backgroundColor: theme.colors.card,
  },
  createButton: {
    backgroundColor: theme.colors.palette.blue[500],
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[4],
    alignItems: "center",
  },
  createButtonDisabled: {
    backgroundColor: theme.colors.palette.blue[900],
    opacity: theme.opacity[50],
  },
  createButtonText: {
    color: theme.colors.palette.white,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  loadingContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  recentPathsContainer: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  recentPathChip: {
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    maxWidth: 200,
  },
  recentPathChipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));
