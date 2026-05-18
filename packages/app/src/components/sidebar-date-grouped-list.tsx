import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { usePathname } from "expo-router";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { archiveWorkspaceOptimistically } from "@/workspace/workspace-archive";
import { confirmDialog } from "@/utils/confirm-dialog";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { groupByDate, type DateGroupedItem } from "@/utils/date-grouping";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";

interface SidebarDateGroupedListProps {
  projects: SidebarProjectEntry[];
  serverId: string;
}

interface FlatWorkspaceEntry extends SidebarWorkspaceEntry {
  projectName: string;
}

function flattenWorkspaces(projects: SidebarProjectEntry[]): FlatWorkspaceEntry[] {
  const entries: FlatWorkspaceEntry[] = [];
  for (const project of projects) {
    for (const workspace of project.workspaces) {
      entries.push({ ...workspace, projectName: project.projectName });
    }
  }
  entries.sort((a, b) => {
    const aTime = a.activityAt ? new Date(a.activityAt).getTime() : 0;
    const bTime = b.activityAt ? new Date(b.activityAt).getTime() : 0;
    return bTime - aTime;
  });
  return entries;
}

function truncateTitle(name: string, maxLength = 40): string {
  if (name.length <= maxLength) return name;
  return name.slice(0, maxLength) + "…";
}

const DateGroupHeader = memo(function DateGroupHeader({ label }: { label: string }) {
  return (
    <View style={styles.groupHeader}>
      <Text style={styles.groupHeaderText}>{label}</Text>
    </View>
  );
});

const ConversationRowContent = memo(function ConversationRowContent({
  entry,
  isActive,
  serverId,
  onPress,
}: {
  entry: FlatWorkspaceEntry;
  isActive: boolean;
  serverId: string;
  onPress: (entry: FlatWorkspaceEntry) => void;
}) {
  const toast = useToast();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameText, setRenameText] = useState(entry.name);
  const [isArchiving, setIsArchiving] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const handlePress = useCallback(() => onPress(entry), [entry, onPress]);

  const handleStartRename = useCallback(() => {
    setRenameText(entry.name);
    setIsRenaming(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [entry.name]);

  const handleCommitRename = useCallback(() => {
    setIsRenaming(false);
    const trimmed = renameText.trim();
    if (!trimmed || trimmed === entry.name) return;

    const client = getHostRuntimeStore().getClient(entry.serverId);
    if (!client) {
      toast.error("Host is not connected");
      return;
    }
    void client.renameWorkspace(entry.workspaceId, trimmed);
  }, [renameText, entry.name, entry.serverId, entry.workspaceId, toast]);

  const handleRenameKeyPress = useCallback(
    (e: { nativeEvent: { key: string } }) => {
      if (e.nativeEvent.key === "Enter") {
        handleCommitRename();
      } else if (e.nativeEvent.key === "Escape") {
        setIsRenaming(false);
      }
    },
    [handleCommitRename],
  );

  const handleDelete = useCallback(() => {
    if (isArchiving) return;

    void (async () => {
      const confirmed = await confirmDialog({
        title: "Delete chat?",
        message: `Delete "${entry.name}"? This cannot be undone.`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) return;

      const client = getHostRuntimeStore().getClient(entry.serverId);
      if (!client) {
        toast.error("Host is not connected");
        return;
      }

      setIsArchiving(true);
      try {
        await archiveWorkspaceOptimistically({
          client,
          workspace: entry,
          afterHide: () => {
            redirectIfArchivingActiveWorkspace({
              serverId,
              workspaceId: entry.workspaceId,
              activeWorkspaceSelection,
            });
          },
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to delete");
      } finally {
        setIsArchiving(false);
      }
    })();
  }, [isArchiving, entry, serverId, activeWorkspaceSelection, toast]);

  const rowStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.conversationRow,
      isActive && styles.conversationRowActive,
      pressed && styles.conversationRowPressed,
    ],
    [isActive],
  );

  const titleStyle = useMemo(
    () => [styles.conversationTitle, isActive && styles.conversationTitleActive],
    [isActive],
  );

  return (
    <>
      <ContextMenuTrigger>
        <Pressable onPress={handlePress} style={rowStyle}>
          {isRenaming ? (
            <TextInput
              ref={inputRef}
              value={renameText}
              onChangeText={setRenameText}
              onBlur={handleCommitRename}
              onKeyPress={handleRenameKeyPress}
              style={styles.renameInput}
              selectTextOnFocus
              autoFocus
            />
          ) : (
            <Text style={titleStyle} numberOfLines={1}>
              {truncateTitle(entry.name)}
            </Text>
          )}
        </Pressable>
      </ContextMenuTrigger>
      <ContextMenuContent align="start" width={180} mobileMode="sheet">
        <ContextMenuItem onSelect={handleStartRename}>Rename</ContextMenuItem>
        <ContextMenuItem
          destructive
          status={isArchiving ? "pending" : "idle"}
          pendingLabel="Deleting..."
          onSelect={handleDelete}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </>
  );
});

const ConversationRow = memo(function ConversationRow({
  entry,
  isActive,
  serverId,
  onPress,
}: {
  entry: FlatWorkspaceEntry;
  isActive: boolean;
  serverId: string;
  onPress: (entry: FlatWorkspaceEntry) => void;
}) {
  return (
    <ContextMenu>
      <ConversationRowContent
        entry={entry}
        isActive={isActive}
        serverId={serverId}
        onPress={onPress}
      />
    </ContextMenu>
  );
});

export function SidebarDateGroupedList({ projects, serverId }: SidebarDateGroupedListProps) {
  const pathname = usePathname();

  const activeWorkspaceId = useMemo(() => {
    if (!pathname) return null;
    const parsed = parseHostWorkspaceRouteFromPathname(pathname);
    return parsed?.workspaceId ?? null;
  }, [pathname]);

  const flatWorkspaces = useMemo(() => flattenWorkspaces(projects), [projects]);

  const grouped: DateGroupedItem<FlatWorkspaceEntry>[] = useMemo(
    () => groupByDate(flatWorkspaces, (entry) => entry.activityAt),
    [flatWorkspaces],
  );

  const handlePress = useCallback(
    (entry: FlatWorkspaceEntry) => {
      navigateToWorkspace(serverId, entry.workspaceId);
    },
    [serverId],
  );

  if (grouped.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No conversations yet</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
    >
      {grouped.map((group) => (
        <View key={group.bucket} style={styles.group}>
          <DateGroupHeader label={group.label} />
          {group.items.map((entry) => (
            <ConversationRow
              key={entry.workspaceKey}
              entry={entry}
              isActive={entry.workspaceId === activeWorkspaceId}
              serverId={serverId}
              onPress={handlePress}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  group: {
    marginBottom: theme.spacing[1],
  },
  groupHeader: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  groupHeaderText: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  conversationRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderLeftWidth: 2,
    borderLeftColor: "transparent",
  },
  conversationRowActive: {
    backgroundColor: theme.colors.surface2,
    borderLeftColor: theme.colors.accent,
  },
  conversationRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  conversationTitle: {
    fontSize: 13,
    color: theme.colors.foreground,
  },
  conversationTitleActive: {
    fontWeight: "500",
  },
  renameInput: {
    fontSize: 13,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[0],
    borderWidth: 1,
    borderColor: theme.colors.accent,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: theme.spacing[8],
  },
  emptyText: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
  },
}));
