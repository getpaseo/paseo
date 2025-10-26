import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  InteractionManager,
  TextInput,
  Modal,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
  runOnJS,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { theme as defaultTheme } from "@/styles/theme";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useSession } from "@/contexts/session-context";
import { useRouter } from "expo-router";
import { generateMessageId } from "@/types/stream";
import {
  listAgentTypeDefinitions,
  type AgentType,
  type AgentTypeDefinition,
  type AgentModeDefinition,
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
const DEFAULT_MODE_FOR_DEFAULT_AGENT = fallbackDefinition?.defaultModeId ?? "";
const BACKDROP_OPACITY = 0.55;

export function CreateAgentModal({
  isVisible,
  onClose,
}: CreateAgentModalProps) {
  const insets = useSafeAreaInsets();
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const slideOffset = useSharedValue(screenHeight);
  const backdropOpacity = useSharedValue(0);
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const isCompactLayout = screenWidth < 720;

  const { recentPaths, addRecentPath } = useRecentPaths();
  const { ws, createAgent } = useSession();
  const router = useRouter();

  const [isMounted, setIsMounted] = useState(isVisible);
  const [workingDir, setWorkingDir] = useState("");
  const [selectedAgentType, setSelectedAgentType] = useState<AgentType>(
    DEFAULT_AGENT_TYPE
  );
  const [selectedMode, setSelectedMode] = useState(DEFAULT_MODE_FOR_DEFAULT_AGENT);
  const [worktreeName, setWorktreeName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);

  const pendingNavigationAgentIdRef = useRef<string | null>(null);

  const agentDefinition = agentTypeDefinitionMap[selectedAgentType];
  const modeOptions = agentDefinition?.availableModes ?? [];

  useEffect(() => {
    if (!agentDefinition) {
      return;
    }

    if (modeOptions.length === 0) {
      if (selectedMode !== "") {
        setSelectedMode("");
      }
      return;
    }

    const availableModeIds = modeOptions.map((mode) => mode.id);

    if (!availableModeIds.includes(selectedMode)) {
      const fallbackModeId =
        agentDefinition.defaultModeId ?? availableModeIds[0];
      setSelectedMode(fallbackModeId);
    }
  }, [agentDefinition, selectedMode, modeOptions]);

  const resetFormState = useCallback(() => {
    setWorkingDir("");
    setWorktreeName("");
    setSelectedAgentType(DEFAULT_AGENT_TYPE);
    setSelectedMode(DEFAULT_MODE_FOR_DEFAULT_AGENT);
    setErrorMessage("");
    setIsLoading(false);
    setPendingRequestId(null);
  }, []);

  const navigateToAgentIfNeeded = useCallback(() => {
    const agentId = pendingNavigationAgentIdRef.current;
    if (!agentId) {
      return;
    }

    pendingNavigationAgentIdRef.current = null;
    InteractionManager.runAfterInteractions(() => {
      router.push(`/agent/${agentId}`);
    });
  }, [router]);

  const handleCloseAnimationComplete = useCallback(() => {
    console.log("[CreateAgentModal] close animation complete – resetting form");
    resetFormState();
    setIsMounted(false);
    navigateToAgentIfNeeded();
  }, [navigateToAgentIfNeeded, resetFormState]);

  useEffect(() => {
    if (!isVisible) {
      console.log("[CreateAgentModal] visibility effect skipped (isVisible is false)", {
        isMounted,
      });
      return;
    }

    console.log("[CreateAgentModal] visibility effect triggered", {
      wasMounted: isMounted,
      screenHeight,
    });
    setIsMounted(true);
    slideOffset.value = screenHeight;
    backdropOpacity.value = 0;

    backdropOpacity.value = withTiming(BACKDROP_OPACITY, {
      duration: 200,
      easing: Easing.out(Easing.cubic),
    });
    slideOffset.value = withTiming(0, {
      duration: 240,
      easing: Easing.out(Easing.cubic),
    });
  }, [isVisible, slideOffset, backdropOpacity, screenHeight]);

  useEffect(() => {
    if (!isMounted || isVisible) {
      console.log("[CreateAgentModal] close animation skipped", {
        isMounted,
        isVisible,
      });
      return;
    }

    console.log("[CreateAgentModal] close animation starting", {
      screenHeight,
    });
    backdropOpacity.value = withTiming(0, {
      duration: 160,
      easing: Easing.out(Easing.cubic),
    });
    slideOffset.value = withTiming(
      screenHeight,
      {
        duration: 220,
        easing: Easing.in(Easing.cubic),
      },
      (finished) => {
        if (finished) {
          console.log("[CreateAgentModal] slide animation finished");
          runOnJS(handleCloseAnimationComplete)();
        }
      }
    );
  }, [
    isMounted,
    isVisible,
    slideOffset,
    backdropOpacity,
    screenHeight,
    handleCloseAnimationComplete,
  ]);

  const footerAnimatedStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const shift = Math.max(0, absoluteHeight - insets.bottom);
    return {
      transform: [{ translateY: -shift }],
    };
  }, [insets.bottom, keyboardHeight]);

  const containerAnimatedStyle = useAnimatedStyle(() => {
    "worklet";
    return {
      transform: [{ translateY: slideOffset.value }],
    };
  }, [slideOffset]);

  const backdropAnimatedStyle = useAnimatedStyle(() => {
    "worklet";
    return {
      opacity: backdropOpacity.value,
    };
  }, [backdropOpacity]);

  const slugifyWorktreeName = useCallback((input: string): string => {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }, []);

  const validateWorktreeName = useCallback((name: string): { valid: boolean; error?: string } => {
    if (!name) {
      return { valid: true };
    }

    if (name.length > 100) {
      return { valid: false, error: "Worktree name too long (max 100 characters)" };
    }

    if (!/^[a-z0-9-]+$/.test(name)) {
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

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleCreate = useCallback(async () => {
    const trimmedPath = workingDir.trim();
    if (!trimmedPath) {
      setErrorMessage("Working directory is required");
      return;
    }

    if (isLoading) {
      return;
    }

    const worktree = worktreeName.trim();

    if (worktree) {
      const validation = validateWorktreeName(worktree);
      if (!validation.valid) {
        setErrorMessage(`Invalid worktree name: ${validation.error}`);
        return;
      }
    }

    try {
      await addRecentPath(trimmedPath);
    } catch (error) {
      console.error("[CreateAgentModal] Failed to save recent path:", error);
    }

    const requestId = generateMessageId();

    setIsLoading(true);
    setPendingRequestId(requestId);
    setErrorMessage("");

    const modeId =
      modeOptions.length > 0 && selectedMode !== "" ? selectedMode : undefined;

    try {
      createAgent({
        cwd: trimmedPath,
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

  useEffect(() => {
    if (!pendingRequestId) {
      return;
    }

    const unsubscribe = ws.on("agent_created", (message) => {
      if (message.type !== "agent_created") {
        return;
      }

      const { agentId, requestId } = message.payload;

      if (requestId === pendingRequestId) {
        console.log("[CreateAgentModal] Agent created:", agentId);
        setIsLoading(false);
        setPendingRequestId(null);
        pendingNavigationAgentIdRef.current = agentId;
        handleClose();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [pendingRequestId, ws, handleClose]);

  const shouldRender = isVisible || isMounted;

  const workingDirIsEmpty = !workingDir.trim();
  const headerPaddingTop = useMemo(() => insets.top + defaultTheme.spacing[4], [insets.top]);
  const horizontalPaddingLeft = useMemo(() => defaultTheme.spacing[6] + insets.left, [insets.left]);
  const horizontalPaddingRight = useMemo(() => defaultTheme.spacing[6] + insets.right, [insets.right]);

  const handleSheetLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, y } = event.nativeEvent.layout;
    console.log("[CreateAgentModal] sheet layout", { height, y });
  }, []);

  if (!shouldRender) {
    console.log("[CreateAgentModal] render skipped", {
      isVisible,
      isMounted,
    });
    return null;
  }

  console.log("[CreateAgentModal] rendering modal", {
    isVisible,
    isMounted,
  });

  return (
    <Modal
      transparent
      statusBarTranslucent
      animationType="none"
      visible={shouldRender}
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, backdropAnimatedStyle]}>
          <Pressable style={styles.backdropPressable} onPress={handleClose} />
        </Animated.View>
        <Animated.View
          style={[styles.sheet, containerAnimatedStyle]}
          onLayout={handleSheetLayout}
        >
          <View style={styles.content}>
            <ModalHeader
              paddingTop={headerPaddingTop}
              paddingLeft={horizontalPaddingLeft}
              paddingRight={horizontalPaddingRight}
              onClose={handleClose}
            />
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={[
                styles.scrollContent,
                {
                  paddingBottom: insets.bottom + defaultTheme.spacing[16],
                  paddingLeft: horizontalPaddingLeft,
                  paddingRight: horizontalPaddingRight,
                },
              ]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <WorkingDirectorySection
                errorMessage={errorMessage}
                isLoading={isLoading}
                recentPaths={recentPaths}
                workingDir={workingDir}
                onChangeWorkingDir={(value) => {
                  setWorkingDir(value);
                  setErrorMessage("");
                }}
              />

              <View
                style={[
                  styles.selectorRow,
                  isCompactLayout && styles.selectorRowStacked,
                ]}
              >
                <AssistantSelector
                  agentTypeDefinitions={agentTypeDefinitions}
                  disabled={isLoading}
                  isStacked={isCompactLayout}
                  selectedAgentType={selectedAgentType}
                  onSelect={setSelectedAgentType}
                />
                <ModeSelector
                  disabled={isLoading}
                  isStacked={isCompactLayout}
                  modeOptions={modeOptions}
                  selectedMode={selectedMode}
                  onSelect={setSelectedMode}
                />
              </View>

              <WorktreeSection
                isLoading={isLoading}
                value={worktreeName}
                onChange={(text) => {
                  const slugified = slugifyWorktreeName(text);
                  setWorktreeName(slugified);
                  setErrorMessage("");
                }}
              />
            </ScrollView>

            <Animated.View
              style={[
                styles.footer,
                {
                  paddingBottom: insets.bottom + defaultTheme.spacing[4],
                  paddingLeft: horizontalPaddingLeft,
                  paddingRight: horizontalPaddingRight,
                },
                footerAnimatedStyle,
              ]}
            >
              <Pressable
                style={[
                  styles.createButton,
                  (workingDirIsEmpty || isLoading) && styles.createButtonDisabled,
                ]}
                onPress={handleCreate}
                disabled={workingDirIsEmpty || isLoading}
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
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

interface ModalHeaderProps {
  paddingTop: number;
  paddingLeft: number;
  paddingRight: number;
  onClose: () => void;
}

function ModalHeader({ paddingTop, paddingLeft, paddingRight, onClose }: ModalHeaderProps): JSX.Element {
  return (
    <View style={[styles.header, { paddingTop, paddingLeft, paddingRight }]}>
      <Text style={styles.headerTitle}>Create New Agent</Text>
      <Pressable onPress={onClose} style={styles.closeButton} hitSlop={8}>
        <X size={20} style={styles.closeIcon} />
      </Pressable>
    </View>
  );
}

interface WorkingDirectorySectionProps {
  workingDir: string;
  isLoading: boolean;
  errorMessage: string;
  recentPaths: string[];
  onChangeWorkingDir: (value: string) => void;
}

function WorkingDirectorySection({
  workingDir,
  isLoading,
  errorMessage,
  recentPaths,
  onChangeWorkingDir,
}: WorkingDirectorySectionProps): JSX.Element {
  return (
    <View style={styles.formSection}>
      <Text style={styles.label}>Working Directory</Text>
      <TextInput
        style={[styles.input, isLoading && styles.inputDisabled]}
        placeholder="/path/to/project"
        placeholderTextColor={defaultTheme.colors.mutedForeground}
        value={workingDir}
        onChangeText={onChangeWorkingDir}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!isLoading}
      />
      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      {recentPaths.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.recentPathsContainer}
          keyboardShouldPersistTaps="handled"
        >
          {recentPaths.map((path) => (
            <Pressable key={path} style={styles.recentPathChip} onPress={() => onChangeWorkingDir(path)}>
              <Text style={styles.recentPathChipText} numberOfLines={1}>
                {path}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

interface AssistantSelectorProps {
  agentTypeDefinitions: AgentTypeDefinition[];
  selectedAgentType: AgentType;
  disabled: boolean;
  isStacked: boolean;
  onSelect: (agentType: AgentType) => void;
}

function AssistantSelector({
  agentTypeDefinitions,
  selectedAgentType,
  disabled,
  isStacked,
  onSelect,
}: AssistantSelectorProps): JSX.Element {
  return (
    <View style={[styles.selectorColumn, isStacked && styles.selectorColumnFull]}>
      <Text style={styles.label}>Assistant</Text>
      <View style={styles.optionGroup}>
        {agentTypeDefinitions.map((definition) => {
          const isSelected = selectedAgentType === definition.id;
          return (
            <Pressable
              key={definition.id}
              onPress={() => onSelect(definition.id)}
              disabled={disabled}
              style={[
                styles.optionCard,
                isSelected && styles.optionCardSelected,
                disabled && styles.optionCardDisabled,
              ]}
            >
              <View style={styles.optionContent}>
                <View
                  style={[
                    styles.radioOuter,
                    isSelected ? styles.radioOuterSelected : styles.radioOuterUnselected,
                  ]}
                >
                  {isSelected ? <View style={styles.radioInner} /> : null}
                </View>
                <Text style={styles.optionLabel}>{definition.label}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

interface ModeSelectorProps {
  modeOptions: AgentModeDefinition[];
  selectedMode: string;
  disabled: boolean;
  isStacked: boolean;
  onSelect: (modeId: string) => void;
}

function ModeSelector({
  modeOptions,
  selectedMode,
  disabled,
  isStacked,
  onSelect,
}: ModeSelectorProps): JSX.Element {
  return (
    <View style={[styles.selectorColumn, isStacked && styles.selectorColumnFull]}>
      <Text style={styles.label}>Permissions</Text>
      {modeOptions.length === 0 ? (
        <Text style={styles.helperText}>This assistant does not expose selectable permissions.</Text>
      ) : (
        <View style={styles.optionGroup}>
          {modeOptions.map((mode) => {
            const isSelected = selectedMode === mode.id;
            return (
              <Pressable
                key={mode.id}
                onPress={() => onSelect(mode.id)}
                disabled={disabled}
                style={[
                  styles.optionCard,
                  isSelected && styles.optionCardSelected,
                  disabled && styles.optionCardDisabled,
                ]}
              >
                <View style={styles.optionContent}>
                  <View
                    style={[
                      styles.radioOuter,
                      isSelected ? styles.radioOuterSelected : styles.radioOuterUnselected,
                    ]}
                  >
                    {isSelected ? <View style={styles.radioInner} /> : null}
                  </View>
                  <View style={styles.modeTextContainer}>
                    <Text style={styles.optionLabel}>{mode.name}</Text>
                    {mode.description ? <Text style={styles.modeDescription}>{mode.description}</Text> : null}
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

interface WorktreeSectionProps {
  value: string;
  isLoading: boolean;
  onChange: (value: string) => void;
}

function WorktreeSection({ value, isLoading, onChange }: WorktreeSectionProps): JSX.Element {
  return (
    <View style={styles.formSection}>
      <Text style={styles.label}>Worktree Name (Optional)</Text>
      <TextInput
        style={[styles.input, isLoading && styles.inputDisabled]}
        placeholder="feature-branch-name"
        placeholderTextColor={defaultTheme.colors.mutedForeground}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!isLoading}
      />
      <Text style={styles.helperText}>
        Create a git worktree for isolated development. Must be lowercase, alphanumeric, and hyphens only.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.palette.gray[900],
    zIndex: 1,
  },
  backdropPressable: {
    flex: 1,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 2,
    width: "100%",
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  content: {
    flex: 1,
  },
  header: {
    paddingBottom: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  closeButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  closeIcon: {
    color: theme.colors.mutedForeground,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[8],
    gap: theme.spacing[6],
  },
  formSection: {
    gap: theme.spacing[3],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  input: {
    backgroundColor: theme.colors.background,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  inputDisabled: {
    opacity: theme.opacity[50],
  },
  errorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
  helperText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  recentPathsContainer: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
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
  selectorRow: {
    flexDirection: "row",
    gap: theme.spacing[4],
  },
  selectorRowStacked: {
    flexDirection: "column",
  },
  selectorColumn: {
    flex: 1,
    gap: theme.spacing[3],
  },
  selectorColumnFull: {
    width: "100%",
  },
  optionGroup: {
    gap: theme.spacing[3],
  },
  optionCard: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  optionCardSelected: {
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.muted,
  },
  optionCardDisabled: {
    opacity: theme.opacity[50],
  },
  optionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  optionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[2],
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
    gap: theme.spacing[1],
  },
  modeDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[4],
    backgroundColor: theme.colors.card,
  },
  createButton: {
    backgroundColor: theme.colors.palette.blue[500],
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
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
}));
