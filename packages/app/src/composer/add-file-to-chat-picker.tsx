import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SvgXml } from "react-native-svg";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { getFileIconSvg } from "@/components/material-file-icons";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { ComboboxItem } from "@/components/ui/combobox";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTab } from "@/stores/workspace-tabs-store";
import { enqueueComposerInsertion } from "@/composer/draft/insertion-queue";
import { formatQuotedFileMentionPath } from "@/utils/file-mention-autocomplete";

interface AddFileToChatPickerProps {
  serverId: string;
  workspaceId: string;
  filePath: string | null;
  onClose: () => void;
}

interface ChatTabOptionProps {
  tab: WorkspaceTab;
  serverId: string;
  workspaceId: string;
  active: boolean;
  onSelect: (tab: WorkspaceTab) => void;
}

function ChatTabRow({
  presentation,
  active,
  onPress,
}: {
  presentation: WorkspaceTabPresentation;
  active: boolean;
  onPress: () => void;
}): ReactElement {
  const leadingSlot = useMemo(
    () => <WorkspaceTabIcon presentation={presentation} active={active} size={16} />,
    [presentation, active],
  );
  return (
    <ComboboxItem
      label={presentation.label}
      description={presentation.subtitle || undefined}
      leadingSlot={leadingSlot}
      active={active}
      elevated
      onPress={onPress}
    />
  );
}

function ChatTabOption({
  tab,
  serverId,
  workspaceId,
  active,
  onSelect,
}: ChatTabOptionProps): ReactElement {
  const descriptor = useMemo<WorkspaceTabDescriptor>(
    () => ({
      key: tab.tabId,
      tabId: tab.tabId,
      kind: tab.target.kind,
      target: tab.target,
    }),
    [tab],
  );
  const handlePress = useCallback(() => onSelect(tab), [onSelect, tab]);
  const renderPresentation = useCallback(
    (presentation: WorkspaceTabPresentation) => (
      <ChatTabRow presentation={presentation} active={active} onPress={handlePress} />
    ),
    [active, handlePress],
  );

  return (
    <WorkspaceTabPresentationResolver
      tab={descriptor}
      serverId={serverId}
      workspaceId={workspaceId}
    >
      {renderPresentation}
    </WorkspaceTabPresentationResolver>
  );
}

function isChatTab(tab: WorkspaceTab): boolean {
  return tab.target.kind === "agent" || tab.target.kind === "draft";
}

function getDraftStoreKey(input: { serverId: string; tab: WorkspaceTab }): string {
  if (input.tab.target.kind === "agent") {
    return buildDraftStoreKey({
      serverId: input.serverId,
      agentId: input.tab.target.agentId,
    });
  }
  if (input.tab.target.kind === "draft") {
    return buildDraftStoreKey({
      serverId: input.serverId,
      agentId: input.tab.tabId,
      draftId: input.tab.target.draftId,
    });
  }
  throw new Error("Add to chat requires an agent or draft tab");
}

function FileIdentity({ filePath }: { filePath: string }): ReactElement {
  const lastSlash = filePath.lastIndexOf("/");
  const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : "";

  return (
    <View style={styles.fileIdentity}>
      <View style={styles.fileIcon}>
        <SvgXml xml={getFileIconSvg(fileName)} width={16} height={16} />
      </View>
      <Text style={styles.fileName} numberOfLines={1}>
        {fileName}
      </Text>
      {dir ? (
        <Text style={styles.fileDir} numberOfLines={1}>
          {` ${dir}`}
        </Text>
      ) : null}
    </View>
  );
}

export function AddFileToChatPicker({
  serverId,
  workspaceId,
  filePath,
  onClose,
}: AddFileToChatPickerProps): ReactElement {
  const { t } = useTranslation();
  const workspaceKey = useMemo(
    () => buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
    [serverId, workspaceId],
  );
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  const focusTab = useWorkspaceLayoutStore((state) => state.focusTab);
  const chatTabs = useMemo(
    () => (layout ? collectAllTabs(layout.root).filter(isChatTab) : []),
    [layout],
  );
  const focusedTabId = useMemo(() => {
    if (!layout) {
      return null;
    }
    return findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null;
  }, [layout]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("workspace.git.diff.addToChatPickerTitle"),
      subtitle: filePath ? <FileIdentity filePath={filePath} /> : undefined,
    }),
    [filePath, t],
  );
  const handleSelect = useCallback(
    (tab: WorkspaceTab) => {
      if (!filePath || !workspaceKey) {
        return;
      }
      enqueueComposerInsertion({
        draftKey: getDraftStoreKey({ serverId, tab }),
        text: formatQuotedFileMentionPath(filePath),
      });
      focusTab(workspaceKey, tab.tabId);
      onClose();
    },
    [filePath, focusTab, onClose, serverId, workspaceKey],
  );

  return (
    <AdaptiveModalSheet
      visible={filePath !== null}
      onClose={onClose}
      header={header}
      desktopMaxWidth={420}
      testID="add-file-to-chat-picker"
    >
      {chatTabs.length === 0 ? (
        <View style={styles.emptyState} testID="add-file-to-chat-empty">
          <Text style={styles.emptyText}>{t("workspace.git.diff.noOpenChats")}</Text>
        </View>
      ) : (
        <View testID="add-file-to-chat-options">
          {chatTabs.map((tab) => (
            <ChatTabOption
              key={tab.tabId}
              tab={tab}
              serverId={serverId}
              workspaceId={workspaceId}
              active={tab.tabId === focusedTabId}
              onSelect={handleSelect}
            />
          ))}
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  fileIdentity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  fileIcon: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  fileName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
  fileDir: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
  },
  emptyState: {
    paddingVertical: theme.spacing[6],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
