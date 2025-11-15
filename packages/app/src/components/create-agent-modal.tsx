import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { ReactElement } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  FlatList,
  ActivityIndicator,
  InteractionManager,
  TextInput,
  Modal,
  useWindowDimensions,
  type LayoutChangeEvent,
  type ListRenderItem,
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
  AGENT_PROVIDER_DEFINITIONS,
  type AgentProviderDefinition,
} from "@server/server/agent/provider-manifest";
import type { AgentProvider, AgentMode, AgentSessionConfig, AgentPersistenceHandle } from "@server/server/agent/agent-sdk-types";
import type { WSInboundMessage } from "@server/server/messages";

interface CreateAgentModalProps {
  isVisible: boolean;
  onClose: () => void;
}

const providerDefinitions = AGENT_PROVIDER_DEFINITIONS;
const providerDefinitionMap = new Map<AgentProvider, AgentProviderDefinition>(
  providerDefinitions.map((definition) => [definition.id, definition])
);

const fallbackDefinition = providerDefinitions[0];
const DEFAULT_PROVIDER: AgentProvider = fallbackDefinition?.id ?? "claude";
const DEFAULT_MODE_FOR_DEFAULT_PROVIDER = fallbackDefinition?.defaultModeId ?? "";
const BACKDROP_OPACITY = 0.55;
const RESUME_PAGE_SIZE = 20;

type ResumeCandidate = {
  provider: AgentProvider;
  sessionId: string;
  cwd: string;
  title: string;
  lastActivityAt: Date;
  persistence: AgentPersistenceHandle;
};

type ResumeTab = "new" | "resume";
type ProviderFilter = "all" | AgentProvider;

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (!Number.isFinite(diffMs)) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

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
  const { ws, createAgent, resumeAgent, agents } = useSession();
  const router = useRouter();

  const [isMounted, setIsMounted] = useState(isVisible);
  const [workingDir, setWorkingDir] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>(
    DEFAULT_PROVIDER
  );
  const [selectedMode, setSelectedMode] = useState(DEFAULT_MODE_FOR_DEFAULT_PROVIDER);
  const [worktreeName, setWorktreeName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ResumeTab>("new");
  const [resumeProviderFilter, setResumeProviderFilter] = useState<ProviderFilter>("all");
  const [resumeSearchQuery, setResumeSearchQuery] = useState("");
  const [resumeCandidates, setResumeCandidates] = useState<ResumeCandidate[]>([]);
  const [isResumeLoading, setIsResumeLoading] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);

  const pendingNavigationAgentIdRef = useRef<string | null>(null);

  const tabOptions = useMemo(
    () => [
      { id: "new" as ResumeTab, label: "New Agent" },
      { id: "resume" as ResumeTab, label: "Resume Agent" },
    ],
    []
  );
  const providerFilterOptions = useMemo(
    () => [
      { id: "all" as ProviderFilter, label: "All" },
      ...providerDefinitions.map((definition) => ({
        id: definition.id as ProviderFilter,
        label: definition.label,
      })),
    ],
    []
  );
  const getProviderLabel = useCallback(
    (provider: AgentProvider) => providerDefinitionMap.get(provider)?.label ?? provider,
    []
  );
  const agentDefinition = providerDefinitionMap.get(selectedProvider);
  const modeOptions = agentDefinition?.modes ?? [];
  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    agents.forEach((agent) => {
      if (agent.sessionId) {
        ids.add(agent.sessionId);
      }
      const persistedSessionId = agent.persistence?.sessionId;
      if (persistedSessionId) {
        ids.add(persistedSessionId);
      }
    });
    return ids;
  }, [agents]);
  const filteredResumeCandidates = useMemo(() => {
    const providerFilter = resumeProviderFilter;
    const query = resumeSearchQuery.trim().toLowerCase();
    return resumeCandidates
      .filter((candidate) => !activeSessionIds.has(candidate.sessionId))
      .filter((candidate) => providerFilter === "all" || candidate.provider === providerFilter)
      .filter((candidate) => {
        if (query.length === 0) {
          return true;
        }
        const titleText = candidate.title.toLowerCase();
        const cwdText = candidate.cwd.toLowerCase();
        return titleText.includes(query) || cwdText.includes(query);
      })
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }, [activeSessionIds, resumeCandidates, resumeProviderFilter, resumeSearchQuery]);

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
    setSelectedProvider(DEFAULT_PROVIDER);
    setSelectedMode(DEFAULT_MODE_FOR_DEFAULT_PROVIDER);
    setErrorMessage("");
    setIsLoading(false);
    pendingRequestIdRef.current = null;
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

  const requestResumeCandidates = useCallback(
    (provider?: AgentProvider) => {
      setIsResumeLoading(true);
      setResumeError(null);
      const msg: WSInboundMessage = {
        type: "session",
        message: {
          type: "list_persisted_agents_request",
          ...(provider ? { provider } : {}),
          limit: RESUME_PAGE_SIZE,
        },
      };
      try {
        ws.send(msg);
      } catch (error) {
        console.error("[CreateAgentModal] Failed to request persisted agents:", error);
        setIsResumeLoading(false);
        setResumeError("Unable to load saved agents. Please try again.");
      }
    },
    [ws]
  );

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

    pendingRequestIdRef.current = requestId;
    setIsLoading(true);
    setErrorMessage("");

    const modeId = modeOptions.length > 0 && selectedMode !== "" ? selectedMode : undefined;

    const config: AgentSessionConfig = {
      provider: selectedProvider,
      cwd: trimmedPath,
      ...(modeId ? { modeId } : {}),
    };

    try {
      createAgent({
        config,
        worktreeName: worktree || undefined,
        requestId,
      });
    } catch (error) {
      console.error("[CreateAgentModal] Failed to create agent:", error);
      setErrorMessage("Failed to create agent. Please try again.");
      setIsLoading(false);
      pendingRequestIdRef.current = null;
    }
  }, [
    workingDir,
    worktreeName,
    selectedMode,
    modeOptions,
    selectedProvider,
    isLoading,
    validateWorktreeName,
    addRecentPath,
    createAgent,
  ]);
  
  const handleResumeCandidatePress = useCallback(
    (candidate: ResumeCandidate) => {
      if (isLoading) {
        return;
      }
      setErrorMessage("");
      const requestId = generateMessageId();
      pendingRequestIdRef.current = requestId;
      setIsLoading(true);
      resumeAgent({
        handle: candidate.persistence,
        requestId,
      });
    },
    [isLoading, resumeAgent]
  );

  const renderResumeItem = useCallback<ListRenderItem<ResumeCandidate>>(
    ({ item }) => (
      <Pressable
        onPress={() => handleResumeCandidatePress(item)}
        disabled={isLoading}
        style={styles.resumeItem}
      >
        <View style={styles.resumeItemHeader}>
          <Text style={styles.resumeItemTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.resumeItemTimestamp}>{formatRelativeTime(item.lastActivityAt)}</Text>
        </View>
        <Text style={styles.resumeItemPath} numberOfLines={1}>
          {item.cwd}
        </Text>
        <View style={styles.resumeItemMetaRow}>
          <View style={styles.resumeProviderBadge}>
            <Text style={styles.resumeProviderBadgeText}>{getProviderLabel(item.provider)}</Text>
          </View>
          <Text style={styles.resumeItemHint}>Tap to resume</Text>
        </View>
      </Pressable>
    ),
    [getProviderLabel, handleResumeCandidatePress, isLoading]
  );

  useEffect(() => {
    const unsubscribe = ws.on("list_persisted_agents_response", (message) => {
      if (message.type !== "list_persisted_agents_response") {
        return;
      }
      const mapped = message.payload.items.map((item) => ({
        provider: item.provider,
        sessionId: item.sessionId,
        cwd: item.cwd,
        title: item.title ?? `Session ${item.sessionId.slice(0, 8)}`,
        lastActivityAt: new Date(item.lastActivityAt),
        persistence: item.persistence,
      })) as ResumeCandidate[];

      setResumeCandidates(mapped);
      setIsResumeLoading(false);
    });

    return () => {
      unsubscribe();
    };
  }, [ws]);

  useEffect(() => {
    const unsubscribe = ws.on("status", (message) => {
      if (message.type !== "status") {
        return;
      }

      const payload = message.payload as { status: string; agentId?: string; requestId?: string };
      if (
        (payload.status !== "agent_created" && payload.status !== "agent_resumed") ||
        !payload.agentId
      ) {
        return;
      }

      const expectedRequestId = pendingRequestIdRef.current;
      if (!expectedRequestId || payload.requestId !== expectedRequestId) {
        return;
      }

      console.log("[CreateAgentModal] Agent created:", payload.agentId);
      pendingRequestIdRef.current = null;
      setIsLoading(false);
      pendingNavigationAgentIdRef.current = payload.agentId;
      handleClose();
    });

    return () => {
      unsubscribe();
    };
  }, [ws, handleClose]);

  useEffect(() => {
    if (!isVisible || activeTab !== "resume") {
      return;
    }
    const provider = resumeProviderFilter === "all" ? undefined : resumeProviderFilter;
    requestResumeCandidates(provider);
  }, [activeTab, isVisible, requestResumeCandidates, resumeProviderFilter]);

  const refreshResumeList = useCallback(() => {
    const provider = resumeProviderFilter === "all" ? undefined : resumeProviderFilter;
    requestResumeCandidates(provider);
  }, [requestResumeCandidates, resumeProviderFilter]);

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
              title={activeTab === "resume" ? "Resume Agent" : "Create New Agent"}
            />
            <View
              style={[
                styles.tabSelector,
                {
                  paddingLeft: horizontalPaddingLeft,
                  paddingRight: horizontalPaddingRight,
                },
              ]}
            >
              {tabOptions.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <Pressable
                    key={tab.id}
                    onPress={() => setActiveTab(tab.id)}
                    style={[styles.tabButton, isActive && styles.tabButtonActive]}
                  >
                    <Text style={[styles.tabButtonText, isActive && styles.tabButtonTextActive]}>{tab.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {activeTab === "new" ? (
              <>
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
                      providerDefinitions={providerDefinitions}
                      disabled={isLoading}
                      isStacked={isCompactLayout}
                      selectedProvider={selectedProvider}
                      onSelect={setSelectedProvider}
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
              </>
            ) : (
              <View
                style={[
                  styles.resumeContainer,
                  {
                    paddingLeft: horizontalPaddingLeft,
                    paddingRight: horizontalPaddingRight,
                    paddingBottom: insets.bottom + defaultTheme.spacing[4],
                  },
                ]}
              >
                <View style={styles.resumeFilters}>
                  <View style={styles.providerFilterRow}>
                    {providerFilterOptions.map((option) => {
                      const isActive = resumeProviderFilter === option.id;
                      return (
                        <Pressable
                          key={option.id}
                          onPress={() => setResumeProviderFilter(option.id)}
                          style={[styles.providerFilterButton, isActive && styles.providerFilterButtonActive]}
                        >
                          <Text
                            style={[
                              styles.providerFilterText,
                              isActive && styles.providerFilterTextActive,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={styles.resumeSearchRow}>
                    <TextInput
                      style={styles.resumeSearchInput}
                      placeholder="Search by title or path"
                      placeholderTextColor={defaultTheme.colors.mutedForeground}
                      value={resumeSearchQuery}
                      onChangeText={setResumeSearchQuery}
                    />
                    <Pressable style={styles.refreshButton} onPress={refreshResumeList} disabled={isResumeLoading}>
                      <Text style={styles.refreshButtonText}>Refresh</Text>
                    </Pressable>
                  </View>
                </View>
                {resumeError ? <Text style={styles.resumeErrorText}>{resumeError}</Text> : null}
                {isResumeLoading ? (
                  <View style={styles.resumeLoading}>
                    <ActivityIndicator color={defaultTheme.colors.mutedForeground} />
                    <Text style={styles.resumeLoadingText}>Loading saved agents...</Text>
                  </View>
                ) : filteredResumeCandidates.length === 0 ? (
                  <View style={styles.resumeEmptyState}>
                    <Text style={styles.resumeEmptyTitle}>No agents found</Text>
                    <Text style={styles.resumeEmptySubtitle}>
                      We'll load the latest Claude and Codex sessions from your local history.
                    </Text>
                    <Pressable style={styles.refreshButtonAlt} onPress={refreshResumeList}>
                      <Text style={styles.refreshButtonAltText}>Try Again</Text>
                    </Pressable>
                  </View>
                ) : (
                  <FlatList
                    data={filteredResumeCandidates}
                    renderItem={renderResumeItem}
                    keyExtractor={(item) => `${item.provider}:${item.sessionId}`}
                    ItemSeparatorComponent={() => <View style={styles.resumeItemSeparator} />}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.resumeListContent}
                  />
                )}
              </View>
            )}
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
  title: string;
}

function ModalHeader({ paddingTop, paddingLeft, paddingRight, onClose, title }: ModalHeaderProps): ReactElement {
  return (
    <View style={[styles.header, { paddingTop, paddingLeft, paddingRight }]}>
      <Text style={styles.headerTitle}>{title}</Text>
      <Pressable onPress={onClose} style={styles.closeButton} hitSlop={8}>
        <X size={20} color={defaultTheme.colors.mutedForeground} />
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
}: WorkingDirectorySectionProps): ReactElement {
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
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider;
  disabled: boolean;
  isStacked: boolean;
  onSelect: (provider: AgentProvider) => void;
}

function AssistantSelector({
  providerDefinitions,
  selectedProvider,
  disabled,
  isStacked,
  onSelect,
}: AssistantSelectorProps): ReactElement {
  return (
    <View style={[styles.selectorColumn, isStacked && styles.selectorColumnFull]}>
      <Text style={styles.label}>Assistant</Text>
      <View style={styles.optionGroup}>
        {providerDefinitions.map((definition) => {
          const isSelected = selectedProvider === definition.id;
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
  modeOptions: AgentMode[];
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
}: ModeSelectorProps): ReactElement {
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
                    <Text style={styles.optionLabel}>{mode.label}</Text>
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

function WorktreeSection({ value, isLoading, onChange }: WorktreeSectionProps): ReactElement {
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
  tabSelector: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  tabButton: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
  },
  tabButtonActive: {
    backgroundColor: theme.colors.muted,
    borderColor: theme.colors.palette.blue[500],
  },
  tabButtonText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  tabButtonTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
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
  resumeContainer: {
    flex: 1,
    gap: theme.spacing[4],
  },
  resumeFilters: {
    gap: theme.spacing[3],
  },
  providerFilterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  providerFilterButton: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  providerFilterButtonActive: {
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.muted,
  },
  providerFilterText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  providerFilterTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  resumeSearchRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    alignItems: "center",
  },
  resumeSearchInput: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
  },
  refreshButton: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  refreshButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  resumeErrorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
  resumeLoading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  resumeLoadingText: {
    color: theme.colors.mutedForeground,
  },
  resumeEmptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
    textAlign: "center",
  },
  resumeEmptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  resumeEmptySubtitle: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  refreshButtonAlt: {
    marginTop: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.blue[500],
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
  },
  refreshButtonAltText: {
    color: theme.colors.palette.white,
    fontWeight: theme.fontWeight.semibold,
  },
  resumeListContent: {
    paddingBottom: theme.spacing[8],
    gap: theme.spacing[2],
  },
  resumeItem: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    backgroundColor: theme.colors.background,
    gap: theme.spacing[2],
  },
  resumeItemHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  resumeItemTitle: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    flex: 1,
  },
  resumeItemTimestamp: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  resumeItemPath: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  resumeItemMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  resumeProviderBadge: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.muted,
  },
  resumeProviderBadgeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  resumeItemHint: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  resumeItemSeparator: {
    height: theme.spacing[2],
  },
}));
