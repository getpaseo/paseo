import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  InteractionManager,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import {
  BottomSheetModal,
  BottomSheetBackdrop,
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
import {
  listAgentTypeDefinitions,
  type AgentType,
  type AgentTypeDefinition,
} from "@server/server/acp/agent-types";

interface CreateAgentModalProps {
  isVisible: boolean;
  onClose: () => void;
}

const agentTypeDefinitions = listAgentTypeDefinitions();

const agentTypeDefinitionMap: Record<AgentType, AgentTypeDefinition> =
  {} as Record<AgentType, AgentTypeDefinition>;
for (const definition of agentTypeDefinitions) {
  agentTypeDefinitionMap[definition.id] = definition;
}

const fallbackDefinition = agentTypeDefinitionMap.claude ?? agentTypeDefinitions[0];
const DEFAULT_AGENT_TYPE: AgentType = fallbackDefinition
  ? fallbackDefinition.id
  : "claude";
const DEFAULT_MODE_FOR_DEFAULT_AGENT = fallbackDefinition?.defaultModeId;

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
  const [selectedAgentType, setSelectedAgentType] = useState<AgentType>(
    DEFAULT_AGENT_TYPE
  );
  const [selectedMode, setSelectedMode] = useState(
    DEFAULT_MODE_FOR_DEFAULT_AGENT ?? ""
  );
  const [worktreeName, setWorktreeName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const agentDefinition = agentTypeDefinitionMap[selectedAgentType];
  const modeOptions = agentDefinition?.availableModes ?? [];

  useEffect(() => {
    if (!agentDefinition) {
      return;
    }

    const availableModeIds = agentDefinition.availableModes.map(
      (mode) => mode.id
    );

    if (availableModeIds.length === 0) {
      if (selectedMode !== "") {
        setSelectedMode("");
      }
      return;
    }

    if (!availableModeIds.includes(selectedMode)) {
      const fallbackModeId =
        agentDefinition.defaultModeId ?? availableModeIds[0];
      setSelectedMode(fallbackModeId);
    }
  }, [agentDefinition, selectedMode]);

  // Use ref instead of state to survive state resets in onDismiss
  const pendingNavigationAgentIdRef = useRef<string | null>(null);

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

  // Slugify helper function
  const slugifyWorktreeName = useCallback((input: string): string => {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }, []);

  // Validate worktree name
  const validateWorktreeName = useCallback((name: string): { valid: boolean; error?: string } => {
    if (!name) return { valid: true }; // Optional field

    if (name.length > 100) {
      return { valid: false, error: "Worktree name too long (max 100 characters)" };
    }

    const validPattern = /^[a-z0-9-]+$/;
    if (!validPattern.test(name)) {
      return {
        valid: false,
        error: "Must contain only lowercase letters, numbers, and hyphens",
      };
    }

    if (name.startsWith("-") || name.endsWith("-")) {
      return { valid: false, error: "Cannot start or end with a hyphen" };
    }

    if (name.includes("--")) {
      return { valid: false, error: "Cannot have consecutive hyphens" };
    }

    return { valid: true };
  }, []);

  const handleCreate = useCallback(async () => {
    if (!workingDir.trim()) {
      setErrorMessage("Working directory is required");
      return;
    }

    if (isLoading) {
      return;
    }

    const path = workingDir.trim();
    const worktree = worktreeName.trim();

    // Validate worktree name if provided
    if (worktree) {
      const validation = validateWorktreeName(worktree);
      if (!validation.valid) {
        setErrorMessage(`Invalid worktree name: ${validation.error}`);
        return;
      }
    }

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

    const modeId =
      modeOptions.length > 0 && selectedMode !== "" ? selectedMode : undefined;

    // Create the agent
    try {
      createAgent({
        cwd: path,
        agentType: selectedAgentType,
        initialMode: modeId,
        worktreeName: worktree || undefined,
        requestId,
      });
    } catch (error) {
      console.error("[CreateAgentModal] Failed to create agent:", error);
      setErrorMessage("Failed to create agent. Please try again.");
      setIsLoading(false);
      setPendingRequestId(null);
    }
  }, [
    workingDir,
    worktreeName,
    selectedMode,
    selectedAgentType,
    modeOptions,
    isLoading,
    validateWorktreeName,
    addRecentPath,
    createAgent,
  ]);

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
    [insets.bottom, workingDir, animatedFooterStyle, isLoading, handleCreate]
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

        // Store the agent ID in ref for navigation after modal dismisses
        // Using ref instead of state because state gets reset in onDismiss
        pendingNavigationAgentIdRef.current = agentId;

        // Close modal - navigation will happen in handleDismiss
        handleClose();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [pendingRequestId, ws]);

  function handleClose() {
    bottomSheetRef.current?.dismiss();
  }

  function handleDismiss() {
    const agentId = pendingNavigationAgentIdRef.current;

    // Reset all state
    setWorkingDir("");
    setWorktreeName("");
    setSelectedAgentType(DEFAULT_AGENT_TYPE);
    setSelectedMode(DEFAULT_MODE_FOR_DEFAULT_AGENT ?? "");
    setErrorMessage("");
    setIsLoading(false);
    setPendingRequestId(null);
    onClose();

    // Navigate after interactions complete to avoid race with dismiss animation
    if (agentId) {
      InteractionManager.runAfterInteractions(() => {
        router.push(`/agent/${agentId}`);
        pendingNavigationAgentIdRef.current = null;
      });
    }
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
      <BottomSheetScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Create New Agent</Text>
        </View>

        {/* Form */}
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

          {/* Agent Type Selector */}
          <View style={styles.formSection}>
            <Text style={styles.label}>Agent Type</Text>
            <View style={styles.agentTypeContainer}>
              {agentTypeDefinitions.map((definition) => {
                const isSelected = selectedAgentType === definition.id;
                return (
                  <Pressable
                    key={definition.id}
                    onPress={() => setSelectedAgentType(definition.id)}
                    disabled={isLoading}
                    style={[
                      styles.agentTypeOption,
                      isSelected && styles.agentTypeOptionSelected,
                      isLoading && styles.agentTypeOptionDisabled,
                    ]}
                  >
                    <View style={styles.agentTypeOptionContent}>
                      <View
                        style={[
                          styles.radioOuter,
                          isSelected
                            ? styles.radioOuterSelected
                            : styles.radioOuterUnselected,
                        ]}
                      >
                        {isSelected && <View style={styles.radioInner} />}
                      </View>
                      <View style={styles.agentTypeTextContainer}>
                        <Text style={styles.agentTypeLabel}>
                          {definition.label}
                        </Text>
                        {definition.description ? (
                          <Text style={styles.agentTypeDescription}>
                            {definition.description}
                          </Text>
                        ) : null}
                        <Text style={styles.agentTypeMeta}>
                          {definition.availableModes.length > 0
                            ? `Modes: ${definition.availableModes
                                .map((mode) => mode.name)
                                .join(", ")}`
                            : "Modes: none"}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Worktree Name Input (Optional) */}
          <View style={styles.formSection}>
            <Text style={styles.label}>Worktree Name (Optional)</Text>
            <BottomSheetTextInput
              style={[styles.input, isLoading && styles.inputDisabled]}
              placeholder="feature-branch-name"
              placeholderTextColor={defaultTheme.colors.mutedForeground}
              value={worktreeName}
              onChangeText={(text) => {
                // Auto-slugify as user types
                const slugified = slugifyWorktreeName(text);
                setWorktreeName(slugified);
                setErrorMessage("");
              }}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isLoading}
            />
            <Text style={styles.helperText}>
              Create a git worktree for isolated development. Must be lowercase, alphanumeric, and hyphens only.
            </Text>
          </View>

          {/* Mode Selector */}
          <View style={styles.formSection}>
            <Text style={styles.label}>Mode</Text>
            {modeOptions.length === 0 ? (
              <Text style={styles.helperText}>
                This agent type does not expose selectable modes.
              </Text>
            ) : (
              <View style={styles.modeContainer}>
                {modeOptions.map((mode) => {
                  const isSelected = selectedMode === mode.id;
                  return (
                    <Pressable
                      key={mode.id}
                      onPress={() => setSelectedMode(mode.id)}
                      disabled={isLoading}
                      style={[
                        styles.modeOption,
                        isSelected && styles.modeOptionSelected,
                        isLoading && styles.modeOptionDisabled,
                      ]}
                    >
                      <View style={styles.modeOptionContent}>
                        <View
                          style={[
                            styles.radioOuter,
                            isSelected
                              ? styles.radioOuterSelected
                              : styles.radioOuterUnselected,
                          ]}
                        >
                          {isSelected && <View style={styles.radioInner} />}
                        </View>
                        <View style={styles.modeTextContainer}>
                          <Text style={styles.modeLabel}>{mode.name}</Text>
                          {mode.description ? (
                            <Text style={styles.modeDescription}>
                              {mode.description}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
      </BottomSheetScrollView>
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
  scrollContent: {
    padding: theme.spacing[6],
    // Add extra padding at bottom to account for fixed footer button
    // Footer height is roughly: padding (16) + button (48) + margin (16) = 80
    paddingBottom: 100,
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
  agentTypeContainer: {
    gap: theme.spacing[3],
  },
  agentTypeOption: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
  },
  agentTypeOptionSelected: {
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.muted,
  },
  agentTypeOptionDisabled: {
    opacity: theme.opacity[50],
  },
  agentTypeOptionContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  agentTypeTextContainer: {
    flex: 1,
  },
  agentTypeLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[1],
  },
  agentTypeDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[1],
  },
  agentTypeMeta: {
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
