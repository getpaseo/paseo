import {
  View,
  Text,
  Pressable,
  Image,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useQueries } from "@tanstack/react-query";
import {
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  type ReactElement,
  type MutableRefObject,
} from "react";
import { router, usePathname } from "expo-router";
import {
  StyleSheet,
  UnistylesRuntime,
  useUnistyles,
} from "react-native-unistyles";
import { type GestureType } from "react-native-gesture-handler";
import { Archive, Check, ChevronDown } from "lucide-react-native";
import {
  DraggableList,
  type DraggableRenderItemInfo,
} from "./draggable-list";
import { useSessionStore } from "@/stores/session-store";
import {
  buildAgentNavigationKey,
  startNavigationTiming,
} from "@/utils/navigation-timing";
import {
  buildHostAgentDetailRoute,
  parseHostAgentRouteFromPathname,
} from "@/utils/host-routes";
import { projectIconQueryKey } from "@/hooks/use-project-icon-query";
import {
  type SidebarAgentListEntry,
  type SidebarProjectOption,
} from "@/hooks/use-sidebar-agents-grouped";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { getIsTauri } from "@/constants/layout";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { Combobox } from "@/components/ui/combobox";
import { parseSidebarAgentKey } from "@/utils/sidebar-shortcuts";
import { parseRepoNameFromRemoteUrl } from "@/utils/agent-grouping";
import { formatTimeAgo } from "@/utils/time";
import { isSidebarActiveAgent } from "@/utils/sidebar-agent-state";
import { useArchiveAgent } from "@/hooks/use-archive-agent";

type EntryData = SidebarAgentListEntry;

interface SidebarAgentListProps {
  entries: SidebarAgentListEntry[];
  projectOptions: SidebarProjectOption[];
  selectedProjectKeys: string[];
  onSelectedProjectKeysChange: (keys: string[]) => void;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: () => void;
  listFooterComponent?: ReactElement | null;
  /** Gesture ref for coordinating with parent gestures (e.g., sidebar close) */
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
}

interface ProjectFilterOptionRowProps {
  option: SidebarProjectOption;
  selected: boolean;
  iconDataUri: string | null;
  displayName: string;
  onToggle: (projectKey: string) => void;
}

function ProjectFilterOptionRow({
  option,
  selected,
  iconDataUri,
  displayName,
  onToggle,
}: ProjectFilterOptionRowProps) {
  const { theme } = useUnistyles();

  return (
    <Pressable
      style={({ pressed, hovered = false }) => [
        styles.filterOption,
        hovered && styles.filterOptionHovered,
        pressed && styles.filterOptionPressed,
      ]}
      onPress={() => onToggle(option.projectKey)}
    >
      <View style={styles.filterOptionLeft}>
        {iconDataUri ? (
          <Image
            source={{ uri: iconDataUri }}
            style={styles.projectIcon}
          />
        ) : (
          <View style={styles.projectIconFallback}>
            <Text style={styles.projectIconFallbackText}>
              {displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <Text style={styles.filterOptionLabel} numberOfLines={1}>
          {displayName}
        </Text>
      </View>

      <View style={styles.filterOptionRight}>
        {option.activeCount > 0 ? (
          <Text style={styles.filterOptionCount}>{option.activeCount}</Text>
        ) : null}
        {selected ? <Check size={14} color={theme.colors.foregroundMuted} /> : null}
      </View>
    </Pressable>
  );
}

interface SidebarAgentRowProps {
  entry: SidebarAgentListEntry;
  projectDisplayName: string;
  projectIconDataUri: string | null;
  isSelected: boolean;
  isInSelectionMode: boolean;
  isBatchSelected: boolean;
  isArchiving: boolean;
  shortcutNumber: number | null;
  onPress: () => void;
  onLongPress: () => void;
  onArchive: () => Promise<void>;
  onToggleBatch: () => void;
}

function resolveBranchLabel(entry: SidebarAgentListEntry): string | null {
  const checkout = entry.project.checkout;
  if (!checkout.isGit) {
    return null;
  }
  const branch = checkout.currentBranch;
  if (!branch || branch === "HEAD" || branch === "main") {
    return null;
  }
  return branch;
}

function SidebarAgentRow({
  entry,
  projectDisplayName,
  projectIconDataUri,
  isSelected,
  isInSelectionMode,
  isBatchSelected,
  isArchiving,
  shortcutNumber,
  onPress,
  onLongPress,
  onArchive,
  onToggleBatch,
}: SidebarAgentRowProps) {
  const { theme } = useUnistyles();
  const [isHovered, setIsHovered] = useState(false);
  const [isArchiveHovered, setIsArchiveHovered] = useState(false);
  const [isArchiveConfirmVisible, setIsArchiveConfirmVisible] = useState(false);
  const hoverOutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const branchLabel = resolveBranchLabel(entry);
  const relativeCreatedAt = formatTimeAgo(entry.agent.createdAt);
  const isActive = isSidebarActiveAgent({
    status: entry.agent.status,
    requiresAttention: entry.agent.requiresAttention,
    attentionReason: entry.agent.attentionReason,
  });
  const shouldApplyInactiveStyles = !isActive && !isSelected;
  const showArchive =
    !isInSelectionMode &&
    shortcutNumber === null &&
    (isHovered || isArchiveHovered || isArchiveConfirmVisible || isArchiving);

  const clearHoverOutTimeout = useCallback(() => {
    if (!hoverOutTimeoutRef.current) {
      return;
    }
    clearTimeout(hoverOutTimeoutRef.current);
    hoverOutTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    return () => clearHoverOutTimeout();
  }, [clearHoverOutTimeout]);

  useEffect(() => {
    if (!isArchiving) {
      setIsArchiveConfirmVisible(false);
    }
  }, [isArchiving]);

  const handleHoverIn = useCallback(() => {
    clearHoverOutTimeout();
    setIsHovered(true);
  }, [clearHoverOutTimeout]);

  const handleHoverOut = useCallback(() => {
    clearHoverOutTimeout();
    hoverOutTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
      setIsArchiveHovered(false);
      setIsArchiveConfirmVisible(false);
    }, 50);
  }, [clearHoverOutTimeout]);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.agentItem,
        isSelected && styles.agentItemSelected,
        isHovered && styles.agentItemHovered,
        pressed && styles.agentItemPressed,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => {
        if (Platform.OS !== "web") {
          return;
        }
        handleHoverIn();
      }}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      testID={`agent-row-${entry.agent.serverId}-${entry.agent.id}`}
    >
      <View style={styles.agentRowTop}>
        {isInSelectionMode ? (
          <Pressable
            onPress={(event) => {
              event.stopPropagation();
              onToggleBatch();
            }}
            style={[
              styles.checkbox,
              isBatchSelected && styles.checkboxSelected,
            ]}
          >
            {isBatchSelected ? (
              <Check size={12} color={theme.colors.primaryForeground} />
            ) : null}
          </Pressable>
        ) : (
          <AgentStatusDot
            status={entry.agent.status}
            requiresAttention={entry.agent.requiresAttention}
          />
        )}

        <Text
          style={[
            styles.agentTitle,
            shouldApplyInactiveStyles && styles.agentTitleInactive,
            isSelected && styles.agentTitleSelected,
          ]}
          numberOfLines={1}
        >
          {entry.agent.title || "New agent"}
        </Text>

        {showArchive ? (
          <Pressable
            onHoverIn={() => {
              clearHoverOutTimeout();
              setIsHovered(true);
              setIsArchiveHovered(true);
            }}
            onHoverOut={() => {
              setIsArchiveHovered(false);
            }}
            onPress={(event) => {
              event.stopPropagation();
              if (isArchiving) {
                return;
              }
              if (!isArchiveConfirmVisible) {
                setIsArchiveConfirmVisible(true);
                return;
              }
              void onArchive();
            }}
            style={styles.archiveButton}
            disabled={isArchiving}
            testID={
              isArchiveConfirmVisible || isArchiving
                ? `agent-archive-confirm-${entry.agent.serverId}-${entry.agent.id}`
                : `agent-archive-${entry.agent.serverId}-${entry.agent.id}`
            }
          >
            {({ hovered: archiveHovered }) =>
              isArchiving ? (
                <ActivityIndicator size="small" color={theme.colors.foreground} />
              ) : isArchiveConfirmVisible ? (
                <Check size={12} color={theme.colors.foreground} />
              ) : (
                <Archive
                  size={12}
                  color={
                    archiveHovered
                      ? theme.colors.foreground
                      : theme.colors.foregroundMuted
                  }
                />
              )
            }
          </Pressable>
        ) : (
          <Text style={styles.relativeTimeText}>{relativeCreatedAt}</Text>
        )}

        {shortcutNumber !== null && !isInSelectionMode ? (
          <View style={styles.shortcutBadge}>
            <Text style={styles.shortcutBadgeText}>{shortcutNumber}</Text>
          </View>
        ) : null}

      </View>

      <View style={styles.agentMetaRow}>
        {projectIconDataUri ? (
          <Image
            source={{ uri: projectIconDataUri }}
            style={[
              styles.agentMetaProjectIcon,
              shouldApplyInactiveStyles && styles.agentMetaProjectIconInactive,
            ]}
          />
        ) : (
          <View
            style={[
              styles.projectIconFallback,
              shouldApplyInactiveStyles && styles.projectIconFallbackInactive,
            ]}
          >
            <Text style={styles.projectIconFallbackText}>
              {projectDisplayName.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <Text style={styles.agentMetaProjectName} numberOfLines={1}>
          {projectDisplayName}
        </Text>
        {branchLabel ? (
          <View
            style={[
              styles.agentMetaBranchBadge,
              isSelected && styles.agentMetaBranchBadgeSelected,
            ]}
          >
            <Text style={styles.agentMetaBranchText} numberOfLines={1}>
              {branchLabel}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function deriveShortcutIndexByAgentKey(sidebarShortcutAgentKeys: string[]) {
  const map = new Map<string, number>();
  for (let i = 0; i < sidebarShortcutAgentKeys.length; i += 1) {
    const key = sidebarShortcutAgentKeys[i];
    if (!key) continue;
    map.set(key, i + 1);
  }
  return map;
}

function resolveSelectedProjectLabel(input: {
  selectedProjectKeys: string[];
  projectOptions: SidebarProjectOption[];
}): string {
  if (input.selectedProjectKeys.length === 0) {
    return "Project";
  }
  if (input.selectedProjectKeys.length === 1) {
    const selected = input.projectOptions.find(
      (option) => option.projectKey === input.selectedProjectKeys[0]
    );
    if (selected) {
      return deriveProjectDisplayName({
        projectKey: selected.projectKey,
        projectName: selected.projectName,
        remoteUrl: null,
      });
    }
    return deriveProjectDisplayName({
      projectKey: input.selectedProjectKeys[0] ?? "",
      projectName: "",
      remoteUrl: null,
    });
  }
  return "Projects";
}

function deriveProjectDisplayName(input: {
  projectKey: string;
  projectName: string;
  remoteUrl: string | null;
}): string {
  const remoteRepoName = parseRepoNameFromRemoteUrl(input.remoteUrl);
  if (remoteRepoName) {
    return remoteRepoName;
  }

  const githubPrefix = "remote:github.com/";
  if (input.projectKey.startsWith(githubPrefix)) {
    return input.projectKey.slice(githubPrefix.length);
  }

  if (input.projectKey.startsWith("remote:")) {
    const withoutPrefix = input.projectKey.slice("remote:".length);
    const slashIdx = withoutPrefix.indexOf("/");
    if (slashIdx >= 0) {
      const remotePath = withoutPrefix.slice(slashIdx + 1).trim();
      if (remotePath.length > 0) {
        return remotePath;
      }
    }
    return withoutPrefix;
  }

  const trimmedProjectName = input.projectName.trim();
  if (trimmedProjectName.length > 0) {
    return trimmedProjectName;
  }

  return input.projectKey;
}

export function SidebarAgentList({
  entries,
  projectOptions,
  selectedProjectKeys,
  onSelectedProjectKeysChange,
  isRefreshing = false,
  onRefresh,
  selectedAgentId,
  onAgentSelect,
  listFooterComponent,
  parentGestureRef,
}: SidebarAgentListProps) {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const showDesktopWebScrollbar = Platform.OS === "web" && !isMobile;
  const [isProjectFilterOpen, setIsProjectFilterOpen] = useState(false);
  const projectFilterAnchorRef = useRef<View>(null);

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedBatchKeys, setSelectedBatchKeys] = useState<Set<string>>(new Set());
  const { archiveAgent, isArchivingAgent } = useArchiveAgent();

  const altDown = useKeyboardShortcutsStore((s) => s.altDown);
  const cmdOrCtrlDown = useKeyboardShortcutsStore((s) => s.cmdOrCtrlDown);
  const sidebarShortcutAgentKeys = useKeyboardShortcutsStore(
    (s) => s.sidebarShortcutAgentKeys
  );
  const isTauri = getIsTauri();
  const showShortcutBadges = !isSelectionMode && (altDown || (isTauri && cmdOrCtrlDown));
  const shortcutIndexByAgentKey = useMemo(
    () => deriveShortcutIndexByAgentKey(sidebarShortcutAgentKeys),
    [sidebarShortcutAgentKeys]
  );

  const selectedProjectLabel = useMemo(
    () => resolveSelectedProjectLabel({ selectedProjectKeys, projectOptions }),
    [projectOptions, selectedProjectKeys]
  );

  const selectedProjectOption = useMemo(() => {
    if (selectedProjectKeys.length !== 1) {
      return null;
    }
    return (
      projectOptions.find((option) => option.projectKey === selectedProjectKeys[0]) ?? null
    );
  }, [projectOptions, selectedProjectKeys]);

  const sessions = useSessionStore((state) => state.sessions);
  const projectIconRequests = useMemo(() => {
    const unique = new Map<string, { serverId: string; cwd: string }>();
    for (const option of projectOptions) {
      if (!option.serverId || !option.workingDir) {
        continue;
      }
      unique.set(`${option.serverId}:${option.workingDir}`, {
        serverId: option.serverId,
        cwd: option.workingDir,
      });
    }
    for (const entry of entries) {
      const serverId = entry.agent.serverId;
      const cwd = entry.project.checkout.cwd;
      if (!serverId || !cwd) {
        continue;
      }
      unique.set(`${serverId}:${cwd}`, { serverId, cwd });
    }
    return Array.from(unique.values());
  }, [entries, projectOptions]);

  const projectIconQueries = useQueries({
    queries: projectIconRequests.map((request) => ({
      queryKey: projectIconQueryKey(request.serverId, request.cwd),
      queryFn: async () => {
        const client =
          useSessionStore.getState().sessions[request.serverId]?.client ?? null;
        if (!client) {
          return null;
        }
        const result = await client.requestProjectIcon(request.cwd);
        return result.icon;
      },
      enabled: Boolean(
        sessions[request.serverId]?.client &&
          sessions[request.serverId]?.connection.isConnected &&
          request.cwd
      ),
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  });

  const projectIconByQueryKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (let i = 0; i < projectIconRequests.length; i += 1) {
      const request = projectIconRequests[i];
      if (!request) {
        continue;
      }
      const icon = projectIconQueries[i]?.data ?? null;
      const dataUri = icon
        ? `data:${icon.mimeType};base64,${icon.data}`
        : null;
      map.set(`${request.serverId}:${request.cwd}`, dataUri);
    }
    return map;
  }, [projectIconQueries, projectIconRequests]);

  const projectIconByProjectKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const option of projectOptions) {
      map.set(
        option.projectKey,
        projectIconByQueryKey.get(`${option.serverId}:${option.workingDir}`) ?? null
      );
    }
    for (const entry of entries) {
      if (map.has(entry.project.projectKey)) {
        continue;
      }
      map.set(
        entry.project.projectKey,
        projectIconByQueryKey.get(
          `${entry.agent.serverId}:${entry.project.checkout.cwd}`
        ) ?? null
      );
    }
    return map;
  }, [entries, projectIconByQueryKey, projectOptions]);

  const selectedProjectIconUri = useMemo(() => {
    if (!selectedProjectOption) {
      return null;
    }
    return projectIconByProjectKey.get(selectedProjectOption.projectKey) ?? null;
  }, [projectIconByProjectKey, selectedProjectOption]);

  const handleToggleProject = useCallback(
    (projectKey: string) => {
      const next = new Set(selectedProjectKeys);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      onSelectedProjectKeysChange(Array.from(next));
    },
    [onSelectedProjectKeysChange, selectedProjectKeys]
  );

  const handleClearProjectFilter = useCallback(() => {
    onSelectedProjectKeysChange([]);
  }, [onSelectedProjectKeysChange]);

  const handleAgentPress = useCallback(
    (entry: SidebarAgentListEntry) => {
      const key = `${entry.agent.serverId}:${entry.agent.id}`;
      if (isSelectionMode) {
        setSelectedBatchKeys((prev) => {
          const next = new Set(prev);
          if (next.has(key)) {
            next.delete(key);
          } else {
            next.add(key);
          }
          return next;
        });
        return;
      }

      const navigationKey = buildAgentNavigationKey(entry.agent.serverId, entry.agent.id);
      startNavigationTiming(navigationKey, {
        from: "home",
        to: "agent",
        params: { serverId: entry.agent.serverId, agentId: entry.agent.id },
      });

      const shouldReplace = Boolean(parseHostAgentRouteFromPathname(pathname));
      const navigate = shouldReplace ? router.replace : router.push;

      onAgentSelect?.();
      navigate(buildHostAgentDetailRoute(entry.agent.serverId, entry.agent.id) as any);
    },
    [isSelectionMode, onAgentSelect, pathname]
  );

  const handleAgentLongPress = useCallback((entry: SidebarAgentListEntry) => {
    const key = `${entry.agent.serverId}:${entry.agent.id}`;
    setIsSelectionMode(true);
    setSelectedBatchKeys(new Set([key]));
  }, []);

  const handleArchiveSingle = useCallback(
    async (entry: SidebarAgentListEntry): Promise<void> => {
      await archiveAgent({
        serverId: entry.agent.serverId,
        agentId: entry.agent.id,
      }).catch((error) => {
        console.warn("[archive_agent] failed", error);
      });
    },
    [archiveAgent]
  );

  const handleArchiveBatch = useCallback(() => {
    if (selectedBatchKeys.size === 0) {
      setIsSelectionMode(false);
      return;
    }

    const requests: Promise<void>[] = [];
    for (const key of selectedBatchKeys) {
      const parsed = parseSidebarAgentKey(key);
      if (!parsed) {
        continue;
      }
      requests.push(
        archiveAgent({
          serverId: parsed.serverId,
          agentId: parsed.agentId,
        }).catch((error) => {
          console.warn("[archive_agent_batch] failed", { key, error });
        })
      );
    }

    void Promise.all(requests).finally(() => {
      setSelectedBatchKeys(new Set());
      setIsSelectionMode(false);
    });
  }, [archiveAgent, selectedBatchKeys]);

  const handleSelectionBack = useCallback(() => {
    setSelectedBatchKeys(new Set());
    setIsSelectionMode(false);
  }, []);

  const renderRow = useCallback(
    ({ item }: DraggableRenderItemInfo<EntryData>) => {
      const key = `${item.agent.serverId}:${item.agent.id}`;
      const projectDisplayName = deriveProjectDisplayName({
        projectKey: item.project.projectKey,
        projectName: item.project.projectName,
        remoteUrl: item.project.checkout.remoteUrl,
      });
      return (
        <SidebarAgentRow
          entry={item}
          projectDisplayName={projectDisplayName}
          projectIconDataUri={
            projectIconByProjectKey.get(item.project.projectKey) ?? null
          }
          isSelected={selectedAgentId === key}
          isInSelectionMode={isSelectionMode}
          isBatchSelected={selectedBatchKeys.has(key)}
          isArchiving={isArchivingAgent({
            serverId: item.agent.serverId,
            agentId: item.agent.id,
          })}
          shortcutNumber={
            showShortcutBadges ? (shortcutIndexByAgentKey.get(key) ?? null) : null
          }
          onPress={() => handleAgentPress(item)}
          onLongPress={() => handleAgentLongPress(item)}
          onArchive={() => handleArchiveSingle(item)}
          onToggleBatch={() => {
            setSelectedBatchKeys((prev) => {
              const next = new Set(prev);
              if (next.has(key)) {
                next.delete(key);
              } else {
                next.add(key);
              }
              return next;
            });
          }}
        />
      );
    },
    [
      handleAgentLongPress,
      handleAgentPress,
      handleArchiveSingle,
      isArchivingAgent,
      isSelectionMode,
      selectedAgentId,
      selectedBatchKeys,
      shortcutIndexByAgentKey,
      showShortcutBadges,
      projectIconByProjectKey,
    ]
  );

  const keyExtractor = useCallback(
    (entry: EntryData) => `${entry.agent.serverId}:${entry.agent.id}`,
    []
  );

  return (
    <View style={styles.container}>
      <View style={styles.filtersRow}>
        <Pressable
          ref={projectFilterAnchorRef}
          style={({ hovered = false, pressed }) => [
            styles.filterTrigger,
            (selectedProjectKeys.length > 0 || hovered || pressed) &&
              styles.filterTriggerActive,
          ]}
          onPress={() => setIsProjectFilterOpen(true)}
        >
          {({ hovered = false, pressed }) => {
            const isInteracting = hovered || pressed;
            const showActiveForeground =
              selectedProjectKeys.length > 0 || isInteracting;
            return (
              <>
                {selectedProjectKeys.length === 1 && selectedProjectIconUri ? (
                  <Image
                    source={{
                      uri: selectedProjectIconUri,
                    }}
                    style={styles.selectedProjectIcon}
                  />
                ) : selectedProjectKeys.length > 1 ? (
                  <View style={styles.projectCountBadge}>
                    <Text style={styles.projectCountBadgeText}>
                      {selectedProjectKeys.length}
                    </Text>
                  </View>
                ) : null}
                <Text
                  style={[
                    styles.filterTriggerText,
                    !showActiveForeground && styles.filterTriggerTextMuted,
                  ]}
                  numberOfLines={1}
                >
                  {selectedProjectLabel}
                </Text>
                <ChevronDown
                  size={14}
                  color={
                    showActiveForeground
                      ? theme.colors.foreground
                      : theme.colors.foregroundMuted
                  }
                />
              </>
            );
          }}
        </Pressable>

        {selectedProjectKeys.length > 0 ? (
          <Pressable style={styles.clearFilterButton} onPress={handleClearProjectFilter}>
            <Text style={styles.clearFilterText}>Clear</Text>
          </Pressable>
        ) : null}

        <Combobox
          options={[]}
          value=""
          onSelect={() => {}}
          title="Filter by project"
          placeholder="Search projects"
          searchPlaceholder="Search projects"
          desktopPlacement="bottom-start"
          open={isProjectFilterOpen}
          onOpenChange={setIsProjectFilterOpen}
          anchorRef={projectFilterAnchorRef}
        >
          <View style={styles.filterOptionsList}>
            {projectOptions.length === 0 ? (
              <Text style={styles.filterEmptyText}>No projects</Text>
            ) : (
              projectOptions.map((option) => (
                <ProjectFilterOptionRow
                  key={option.projectKey}
                  option={option}
                  selected={selectedProjectKeys.includes(option.projectKey)}
                  iconDataUri={projectIconByProjectKey.get(option.projectKey) ?? null}
                  displayName={deriveProjectDisplayName({
                    projectKey: option.projectKey,
                    projectName: option.projectName,
                    remoteUrl: null,
                  })}
                  onToggle={handleToggleProject}
                />
              ))
            )}
          </View>
        </Combobox>
      </View>

      <DraggableList
        data={entries}
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          isSelectionMode ? styles.listContentSelectionMode : null,
        ]}
        testID="sidebar-agent-list-scroll"
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        onDragEnd={() => {}}
        showsVerticalScrollIndicator={false}
        enableDesktopWebScrollbar={showDesktopWebScrollbar}
        ListFooterComponent={listFooterComponent}
        refreshing={isRefreshing}
        onRefresh={onRefresh}
        simultaneousGestureRef={parentGestureRef}
      />

      {isSelectionMode ? (
        <View style={styles.selectionBar}>
          <Pressable style={styles.selectionAction} onPress={handleSelectionBack}>
            <Text style={styles.selectionActionText}>Back</Text>
          </Pressable>
          <Pressable
            style={[
              styles.selectionAction,
              styles.selectionArchiveAction,
              selectedBatchKeys.size === 0 && styles.selectionArchiveActionDisabled,
            ]}
            disabled={selectedBatchKeys.size === 0}
            onPress={handleArchiveBatch}
          >
            <Text style={styles.selectionArchiveActionText}>Archive</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  filtersRow: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    alignSelf: "flex-start",
    maxWidth: 260,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  filterTriggerActive: {
    borderColor: theme.colors.borderAccent,
  },
  filterTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    maxWidth: 180,
  },
  filterTriggerTextMuted: {
    color: theme.colors.foregroundMuted,
  },
  selectedProjectIcon: {
    width: 14,
    height: 14,
    borderRadius: theme.borderRadius.sm,
  },
  projectCountBadge: {
    minWidth: 16,
    height: 16,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    backgroundColor: theme.colors.surface2,
  },
  projectCountBadgeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  clearFilterButton: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  clearFilterText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  filterOptionsList: {
    gap: theme.spacing[1],
  },
  filterEmptyText: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
  filterOption: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  filterOptionHovered: {
    backgroundColor: theme.colors.surface1,
  },
  filterOptionPressed: {
    backgroundColor: theme.colors.surface2,
  },
  filterOptionLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  filterOptionRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  filterOptionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
  },
  filterOptionCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  projectIcon: {
    width: 14,
    height: 14,
    borderRadius: theme.borderRadius.sm,
  },
  projectIconFallback: {
    width: 14,
    height: 14,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconFallbackInactive: {
    opacity: 0.5,
  },
  projectIconFallbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: 9,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  listContentSelectionMode: {
    paddingBottom: theme.spacing[16],
  },
  agentItem: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
  },
  agentItemSelected: {
    backgroundColor: theme.colors.surface2,
  },
  agentItemHovered: {
    backgroundColor: theme.colors.surface1,
  },
  agentItemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  agentRowTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 20,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSelected: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  agentTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    opacity: 1,
  },
  agentTitleInactive: {
    opacity: 0.8,
  },
  agentTitleSelected: {
    opacity: 1,
  },
  relativeTimeText: {
    color: theme.colors.foregroundMuted,
    opacity: 0.78,
    fontSize: theme.fontSize.xs,
  },
  shortcutBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
  },
  shortcutBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  archiveButton: {
    minWidth: 24,
    height: 20,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
  },
  agentMetaRow: {
    marginTop: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  agentMetaProjectIcon: {
    width: 14,
    height: 14,
    borderRadius: theme.borderRadius.sm,
  },
  agentMetaProjectIconInactive: {
    opacity: 0.5,
  },
  agentMetaProjectName: {
    color: theme.colors.foreground,
    opacity: 0.78,
    fontSize: theme.fontSize.xs,
    flexShrink: 0,
  },
  agentMetaBranchBadge: {
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  agentMetaBranchBadgeSelected: {
    borderColor: theme.colors.borderAccent,
  },
  agentMetaBranchText: {
    color: theme.colors.foreground,
    opacity: 0.76,
    fontSize: theme.fontSize.xs,
    flexShrink: 1,
    minWidth: 0,
  },
  selectionBar: {
    position: "absolute",
    left: theme.spacing[2],
    right: theme.spacing[2],
    bottom: theme.spacing[2],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[2],
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  selectionAction: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  selectionActionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  selectionArchiveAction: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  selectionArchiveActionDisabled: {
    opacity: 0.5,
  },
  selectionArchiveActionText: {
    color: theme.colors.primaryForeground,
    fontSize: theme.fontSize.sm,
  },
}));
