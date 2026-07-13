import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Archive,
  CircleCheck,
  Copy,
  Eye,
  EyeOff,
  FolderInput,
  FolderPlus,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react-native";
import { isNative, isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Shortcut } from "@/components/ui/shortcut";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { hostSupportsFeature } from "@/runtime/host-features";
import {
  normalizeWorkspaceCollection,
  useSessionStore,
  type WorkspaceCollection,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { useSidebarWorkspaceVisibilityStore } from "@/stores/sidebar-workspace-visibility-store";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedCopy = withUnistyles(Copy);
const ThemedArchive = withUnistyles(Archive);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedEye = withUnistyles(Eye);
const ThemedEyeOff = withUnistyles(EyeOff);
const ThemedFolderInput = withUnistyles(FolderInput);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);

const copyLeadingIcon = <ThemedCopy size={14} uniProps={foregroundMutedColorMapping} />;
const renameLeadingIcon = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;
const markAsReadLeadingIcon = (
  <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />
);
const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;
const hideLeadingIcon = <ThemedEyeOff size={14} uniProps={foregroundMutedColorMapping} />;
const unhideLeadingIcon = <ThemedEye size={14} uniProps={foregroundMutedColorMapping} />;
const pinLeadingIcon = <ThemedPin size={14} uniProps={foregroundMutedColorMapping} />;
const unpinLeadingIcon = <ThemedPinOff size={14} uniProps={foregroundMutedColorMapping} />;
const folderLeadingIcon = <ThemedFolderInput size={14} uniProps={foregroundMutedColorMapping} />;
const newFolderLeadingIcon = <ThemedFolderPlus size={14} uniProps={foregroundMutedColorMapping} />;
const EMPTY_COLLECTIONS = new Map<string, WorkspaceCollection>();

interface SidebarWorkspacePinControls {
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}

const SidebarWorkspacePinContext = createContext<SidebarWorkspacePinControls | null>(null);

export function SidebarWorkspacePinProvider({
  supportsPinningByServerId,
  onToggleWorkspacePin,
  children,
}: SidebarWorkspacePinControls & { children: ReactNode }) {
  const value = useMemo(
    () => ({ supportsPinningByServerId, onToggleWorkspacePin }),
    [onToggleWorkspacePin, supportsPinningByServerId],
  );
  return (
    <SidebarWorkspacePinContext.Provider value={value}>
      {children}
    </SidebarWorkspacePinContext.Provider>
  );
}

function renderTriggerIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical
      size={14}
      uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

interface SidebarWorkspaceMenuProps {
  workspace: SidebarWorkspaceEntry;
  onCopyPath?: () => void;
  onCopyBranchName?: () => void;
  onRename?: () => void;
  onMarkAsRead?: () => void;
  onArchive: () => void;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
}

export function SidebarWorkspaceMenu({
  workspace,
  onCopyPath,
  onCopyBranchName,
  onRename,
  onMarkAsRead,
  onArchive,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
}: SidebarWorkspaceMenuProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const pinControls = useContext(SidebarWorkspacePinContext);
  const [isCreateCollectionOpen, setIsCreateCollectionOpen] = useState(false);
  const setWorkspaceHidden = useSidebarWorkspaceVisibilityStore(
    (state) => state.setWorkspaceHidden,
  );
  const isHidden = useSidebarWorkspaceVisibilityStore((state) =>
    state.hiddenWorkspaceKeys.includes(workspace.workspaceKey),
  );
  const serverInfo = useSessionStore(
    (state) => state.sessions[workspace.serverId]?.serverInfo ?? null,
  );
  const workspaceCollections = useSessionStore(
    (state) => state.sessions[workspace.serverId]?.workspaceCollections ?? EMPTY_COLLECTIONS,
  );
  const supportsOrganization = hostSupportsFeature(serverInfo, "workspaceOrganization");
  const canTogglePin =
    onTogglePin !== undefined ||
    pinControls?.supportsPinningByServerId.get(workspace.serverId) === true;
  const resolvedIsPinned = isPinned ?? workspace.pinnedAt != null;
  const collections = useMemo(
    () =>
      Array.from(workspaceCollections.values()).sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
      ),
    [workspaceCollections],
  );

  const assignCollectionMutation = useMutation({
    mutationFn: async (collectionId: string | null) => {
      const client = requireOrganizationClient(workspace.serverId);
      const result = await client.assignWorkspaceCollection(workspace.workspaceId, collectionId);
      updateWorkspaceDescriptor(workspace.serverId, workspace.workspaceId, (descriptor) => ({
        ...descriptor,
        collectionId: result.collectionId,
      }));
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to move workspace"),
  });
  const createCollectionMutation = useMutation({
    mutationFn: async (name: string) => {
      const client = requireOrganizationClient(workspace.serverId);
      const collection = await client.createWorkspaceCollection(name);
      const currentCollections =
        useSessionStore.getState().sessions[workspace.serverId]?.workspaceCollections.values() ??
        [];
      useSessionStore
        .getState()
        .setWorkspaceCollections(workspace.serverId, [
          ...currentCollections,
          normalizeWorkspaceCollection(collection),
        ]);
      try {
        const result = await client.assignWorkspaceCollection(workspace.workspaceId, collection.id);
        updateWorkspaceDescriptor(workspace.serverId, workspace.workspaceId, (descriptor) => ({
          ...descriptor,
          collectionId: result.collectionId,
        }));
        return { moveError: null };
      } catch (moveError) {
        // Creation already succeeded and is daemon-persisted. Treat the move as
        // a partial failure so retrying the modal cannot create duplicate collections.
        return { moveError };
      }
    },
    onSuccess: ({ moveError }) => {
      setIsCreateCollectionOpen(false);
      if (moveError) {
        toast.error(
          moveError instanceof Error
            ? `Collection created, but the workspace was not moved: ${moveError.message}`
            : "Collection created, but the workspace was not moved",
        );
      }
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to create collection"),
  });
  const handleAssignCollection = useCallback(
    (collectionId: string | null) => assignCollectionMutation.mutate(collectionId),
    [assignCollectionMutation],
  );
  const handleClearCollection = useCallback(
    () => handleAssignCollection(null),
    [handleAssignCollection],
  );
  const handleToggleHidden = useCallback(
    () => setWorkspaceHidden(workspace.workspaceKey, !isHidden),
    [isHidden, setWorkspaceHidden, workspace.workspaceKey],
  );
  const handleTogglePin = useCallback(() => {
    if (onTogglePin) {
      onTogglePin();
      return;
    }
    pinControls?.onToggleWorkspacePin(workspace);
  }, [onTogglePin, pinControls, workspace]);
  const handleOpenCreateCollection = useCallback(() => setIsCreateCollectionOpen(true), []);
  const handleCloseCreateCollection = useCallback(() => setIsCreateCollectionOpen(false), []);
  const handleCreateCollection = useCallback(
    async (name: string) => {
      await createCollectionMutation.mutateAsync(name.trim());
    },
    [createCollectionMutation],
  );
  const archiveTrailing = useMemo(
    () => (archiveShortcutKeys && !isNative ? <Shortcut chord={archiveShortcutKeys} /> : null),
    [archiveShortcutKeys],
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          hitSlop={8}
          style={triggerStyle}
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={t("sidebar.workspace.actions.menu")}
          testID={`sidebar-workspace-kebab-${workspace.workspaceKey}`}
        >
          {renderTriggerIcon}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={260} maxHeight={480} scrollable>
          {canTogglePin ? (
            <DropdownMenuItem
              testID={`sidebar-workspace-menu-pin-${workspace.workspaceKey}`}
              leading={resolvedIsPinned ? unpinLeadingIcon : pinLeadingIcon}
              onSelect={handleTogglePin}
            >
              {resolvedIsPinned
                ? t("sidebar.workspace.actions.unpin")
                : t("sidebar.workspace.actions.pin")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            testID={`sidebar-workspace-menu-hide-${workspace.workspaceKey}`}
            leading={isHidden ? unhideLeadingIcon : hideLeadingIcon}
            onSelect={handleToggleHidden}
          >
            {isHidden ? "Unhide workspace" : "Hide from sidebar"}
          </DropdownMenuItem>
          {supportsOrganization ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Workspace label</DropdownMenuLabel>
              <DropdownMenuItem
                testID={`sidebar-workspace-menu-collection-none-${workspace.workspaceKey}`}
                leading={folderLeadingIcon}
                selected={!workspace.collectionId}
                status={assignCollectionMutation.isPending ? "pending" : "idle"}
                onSelect={handleClearCollection}
              >
                No label
              </DropdownMenuItem>
              {collections.map((collection) => (
                <CollectionAssignmentItem
                  key={collection.id}
                  workspaceKey={workspace.workspaceKey}
                  collectionId={collection.id}
                  label={collection.name}
                  selected={workspace.collectionId === collection.id}
                  pending={assignCollectionMutation.isPending}
                  onAssign={handleAssignCollection}
                />
              ))}
              <DropdownMenuItem
                leading={newFolderLeadingIcon}
                onSelect={handleOpenCreateCollection}
              >
                New workspace label…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {onCopyPath ? (
            <DropdownMenuItem
              testID={`sidebar-workspace-menu-copy-path-${workspace.workspaceKey}`}
              leading={copyLeadingIcon}
              onSelect={onCopyPath}
            >
              {t("sidebar.workspace.actions.copyPath")}
            </DropdownMenuItem>
          ) : null}
          {onCopyBranchName ? (
            <DropdownMenuItem
              testID={`sidebar-workspace-menu-copy-branch-name-${workspace.workspaceKey}`}
              leading={copyLeadingIcon}
              onSelect={onCopyBranchName}
            >
              {t("sidebar.workspace.actions.copyBranchName")}
            </DropdownMenuItem>
          ) : null}
          {onRename ? (
            <DropdownMenuItem
              testID={`sidebar-workspace-menu-rename-${workspace.workspaceKey}`}
              leading={renameLeadingIcon}
              onSelect={onRename}
            >
              {t("sidebar.workspace.actions.rename")}
            </DropdownMenuItem>
          ) : null}
          {onMarkAsRead ? (
            <DropdownMenuItem
              testID={`sidebar-workspace-menu-mark-as-read-${workspace.workspaceKey}`}
              leading={markAsReadLeadingIcon}
              onSelect={onMarkAsRead}
            >
              Mark as read
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            testID={`sidebar-workspace-menu-archive-${workspace.workspaceKey}`}
            leading={archiveLeadingIcon}
            trailing={archiveTrailing}
            status={archiveStatus}
            pendingLabel={archivePendingLabel}
            onSelect={onArchive}
          >
            {archiveLabel ?? t("sidebar.workspace.actions.archive")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AdaptiveRenameModal
        visible={isCreateCollectionOpen}
        title="New workspace label"
        initialValue=""
        placeholder="Label name"
        submitLabel="Create"
        onClose={handleCloseCreateCollection}
        onSubmit={handleCreateCollection}
        testID={`sidebar-workspace-create-collection-${workspace.workspaceKey}`}
      />
    </>
  );
}

function CollectionAssignmentItem({
  workspaceKey,
  collectionId,
  label,
  selected,
  pending,
  onAssign,
}: {
  workspaceKey: string;
  collectionId: string;
  label: string;
  selected: boolean;
  pending: boolean;
  onAssign: (collectionId: string | null) => void;
}) {
  const handleSelect = useCallback(() => onAssign(collectionId), [collectionId, onAssign]);
  return (
    <DropdownMenuItem
      testID={`sidebar-workspace-menu-collection-${workspaceKey}-${collectionId}`}
      leading={folderLeadingIcon}
      selected={selected}
      status={pending ? "pending" : "idle"}
      onSelect={handleSelect}
    >
      {label}
    </DropdownMenuItem>
  );
}

function requireOrganizationClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("Host disconnected");
  return client;
}

function updateWorkspaceDescriptor(
  serverId: string,
  workspaceId: string,
  update: (workspace: WorkspaceDescriptor) => WorkspaceDescriptor,
): void {
  useSessionStore.getState().setWorkspaces(serverId, (current) => {
    const workspace = current.get(workspaceId);
    if (!workspace) return current;
    const next = new Map(current);
    next.set(workspaceId, update(workspace));
    return next;
  });
}

function triggerStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.trigger, hovered && styles.triggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: 2,
    borderRadius: 4,
    marginLeft: 2,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
