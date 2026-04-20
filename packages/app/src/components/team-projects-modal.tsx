/**
 * TeamProjectsModal — Browses the online project registry for the active org
 * and lets the user either open a project already present on their daemon or
 * clone one locally via `git clone` on the daemon. Owners can remove entries
 * they registered.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { createPortal } from "react-dom";
import { FolderGit2, GitBranch, Users, Trash2, X, RefreshCcw } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, router } from "expo-router";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useHosts, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { parseServerIdFromPathname } from "@/utils/host-routes";
import { pickDirectory } from "@/desktop/pick-directory";
import { getIsElectron, isWeb } from "@/constants/platform";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import { useOnlineProjects } from "@/hooks/use-online-projects";
import { deleteOnlineProject, type ProjectRegistryEntry } from "@/api/project-registry";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useActiveOrgId } from "@/stores/active-org-store";
import {
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import { useToast } from "@/contexts/toast-context";

function normalizeRemoteKey(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const sshMatch = remoteUrl.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `remote:${sshMatch[1]}/${sshMatch[2]}`;
  try {
    const url = new URL(remoteUrl);
    const host = url.host;
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    if (host && path) return `remote:${host}/${path}`;
  } catch {
    /* ignore */
  }
  return null;
}

function findLocalWorkspaceForProject(
  sessions: ReturnType<typeof useSessionStore.getState>["sessions"],
  entry: ProjectRegistryEntry,
): { serverId: string; workspace: WorkspaceDescriptor } | null {
  for (const [serverId, session] of Object.entries(sessions)) {
    if (!session?.workspaces) continue;
    for (const ws of session.workspaces.values()) {
      if (ws.projectId === entry.projectKey) return { serverId, workspace: ws };
      const remoteKey = normalizeRemoteKey(ws.gitRemoteUrl ?? null);
      if (remoteKey && remoteKey === entry.projectKey) return { serverId, workspace: ws };
    }
  }
  return null;
}

export function TeamProjectsModal() {
  const { theme } = useUnistyles();
  const open = useKeyboardShortcutsStore((s) => s.teamProjectsModalOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setTeamProjectsModalOpen);

  const pathname = usePathname();
  const daemons = useHosts();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session: authSession } = useAuthSession();
  const sessionToken = authSession?.sessionToken ?? "";
  const activeOrgId = useActiveOrgId();

  const serverId = useMemo(() => {
    const fromPath = parseServerIdFromPathname(pathname);
    if (fromPath) return fromPath;
    return daemons[0]?.serverId ?? null;
  }, [pathname, daemons]);
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const { data: projects, isLoading, error, refetch } = useOnlineProjects();
  const sessions = useSessionStore((s) => s.sessions);
  const mergeWorkspaces = useSessionStore((s) => s.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((s) => s.setHasHydratedWorkspaces);

  const [cloneTarget, setCloneTarget] = useState<ProjectRegistryEntry | null>(null);
  const [cloneParentDir, setCloneParentDir] = useState("");
  const [cloneBusy, setCloneBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    if (cloneBusy) return;
    setOpen(false);
    setCloneTarget(null);
    setCloneParentDir("");
  }, [cloneBusy, setOpen]);

  useEffect(() => {
    if (!open || !isWeb) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (cloneTarget) {
          setCloneTarget(null);
          setCloneParentDir("");
        } else {
          handleClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleClose, cloneTarget]);

  const handlePickDirectory = useCallback(async () => {
    try {
      const picked = await pickDirectory();
      if (picked) setCloneParentDir(picked);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open picker");
    }
  }, [toast]);

  const handleStartClone = useCallback(
    (entry: ProjectRegistryEntry) => {
      if (!entry.gitRemoteUrl) {
        toast.error("This project has no git remote — cannot clone");
        return;
      }
      setCloneTarget(entry);
      setCloneParentDir("");
    },
    [toast],
  );

  const handleConfirmClone = useCallback(async () => {
    if (!cloneTarget || !cloneTarget.gitRemoteUrl) return;
    if (!serverId || !client || !isConnected) {
      toast.error("Host is not connected");
      return;
    }
    const parent = cloneParentDir.trim();
    if (!parent) {
      toast.error("Choose a target folder");
      return;
    }
    setCloneBusy(true);
    try {
      const cloneResult = await client.cloneRepository({
        remoteUrl: cloneTarget.gitRemoteUrl,
        parentDir: parent,
      });
      if (cloneResult.error || !cloneResult.cwd) {
        throw new Error(cloneResult.error ?? "Clone failed");
      }
      const openResult = await client.openProject(cloneResult.cwd, {
        orgId: activeOrgId ?? undefined,
      });
      if (openResult.error || !openResult.workspace) {
        throw new Error(openResult.error ?? "Failed to register cloned project");
      }
      mergeWorkspaces(serverId, [normalizeWorkspaceDescriptor(openResult.workspace)]);
      setHasHydratedWorkspaces(serverId, true);
      toast.show(`Cloned ${cloneTarget.name}`);
      setCloneTarget(null);
      setCloneParentDir("");
      setOpen(false);
      router.replace(
        prepareWorkspaceTab({
          serverId,
          workspaceId: openResult.workspace.id,
          target: { kind: "draft", draftId: "new" },
        }) as any,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clone failed");
    } finally {
      setCloneBusy(false);
    }
  }, [
    activeOrgId,
    cloneParentDir,
    cloneTarget,
    client,
    isConnected,
    mergeWorkspaces,
    serverId,
    setHasHydratedWorkspaces,
    setOpen,
    toast,
  ]);

  const handleOpenExisting = useCallback(
    (match: { serverId: string; workspace: WorkspaceDescriptor }) => {
      setOpen(false);
      router.push(
        prepareWorkspaceTab({
          serverId: match.serverId,
          workspaceId: match.workspace.id,
          target: { kind: "draft", draftId: "new" },
        }) as any,
      );
    },
    [setOpen],
  );

  const handleDelete = useCallback(
    async (entry: ProjectRegistryEntry) => {
      setDeletingId(entry.id);
      try {
        await deleteOnlineProject(entry.id, sessionToken || null);
        await queryClient.invalidateQueries({ queryKey: ["onlineProjects"] });
        toast.show(`Removed ${entry.name} from org registry`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Delete failed");
      } finally {
        setDeletingId(null);
      }
    },
    [queryClient, sessionToken, toast],
  );

  const currentUserId = authSession?.user?.userId ?? null;

  if (!open) return null;

  const overlayRoot = isWeb ? getOverlayRoot() : null;

  const content = (
    <View style={styles.backdrop}>
      <Pressable style={styles.backdropClickable} onPress={handleClose} />
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.headerTitleGroup}>
            <Users size={18} color={theme.colors.foreground} />
            <Text style={styles.title}>Team projects</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              style={styles.headerIconBtn}
              onPress={() => void refetch()}
              disabled={isLoading}
            >
              <RefreshCcw size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
            <Pressable style={styles.headerIconBtn} onPress={handleClose}>
              <X size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
        </View>

        {cloneTarget ? (
          <CloneForm
            entry={cloneTarget}
            parentDir={cloneParentDir}
            onChangeParentDir={setCloneParentDir}
            onPickDirectory={handlePickDirectory}
            onBack={() => {
              setCloneTarget(null);
              setCloneParentDir("");
            }}
            onConfirm={handleConfirmClone}
            busy={cloneBusy}
          />
        ) : (
          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 12 }}>
            {isLoading ? (
              <View style={styles.emptyWrap}>
                <ActivityIndicator color={theme.colors.foregroundMuted} />
              </View>
            ) : error ? (
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyText}>Failed to load: {error}</Text>
              </View>
            ) : projects.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyText}>
                  No projects registered yet. Open a project from any device and it appears here.
                </Text>
              </View>
            ) : (
              projects.map((entry) => {
                const match = findLocalWorkspaceForProject(sessions, entry);
                const canClone = !match && !!entry.gitRemoteUrl;
                const canOpen = !!match;
                const isOwner = currentUserId === entry.owner.userId;
                return (
                  <View key={entry.id} style={styles.row}>
                    <View style={styles.rowMain}>
                      <View style={styles.rowIcon}>
                        <FolderGit2 size={16} color={theme.colors.foregroundMuted} />
                      </View>
                      <View style={styles.rowText}>
                        <Text style={styles.rowName}>{entry.name}</Text>
                        <Text style={styles.rowMeta} numberOfLines={1}>
                          {entry.gitRemoteUrl ?? "no git remote"} · by {entry.owner.name}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.rowActions}>
                      {canOpen ? (
                        <Pressable
                          style={styles.primaryBtn}
                          onPress={() => handleOpenExisting(match)}
                        >
                          <Text style={styles.primaryBtnText}>Open</Text>
                        </Pressable>
                      ) : canClone ? (
                        <Pressable
                          style={styles.primaryBtn}
                          onPress={() => handleStartClone(entry)}
                        >
                          <GitBranch size={13} color={theme.colors.surface0} />
                          <Text style={styles.primaryBtnText}>Clone</Text>
                        </Pressable>
                      ) : (
                        <Text style={styles.unavailable}>no remote</Text>
                      )}
                      {isOwner ? (
                        <Pressable
                          style={styles.deleteBtn}
                          onPress={() => void handleDelete(entry)}
                          disabled={deletingId === entry.id}
                        >
                          <Trash2
                            size={14}
                            color={
                              deletingId === entry.id
                                ? theme.colors.foregroundMuted
                                : theme.colors.destructive
                            }
                          />
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );

  if (isWeb && overlayRoot) {
    return createPortal(content, overlayRoot);
  }
  return (
    <Modal transparent visible onRequestClose={handleClose}>
      {content}
    </Modal>
  );
}

interface CloneFormProps {
  entry: ProjectRegistryEntry;
  parentDir: string;
  onChangeParentDir: (value: string) => void;
  onPickDirectory: () => void;
  onBack: () => void;
  onConfirm: () => void;
  busy: boolean;
}

function CloneForm({
  entry,
  parentDir,
  onChangeParentDir,
  onPickDirectory,
  onBack,
  onConfirm,
  busy,
}: CloneFormProps) {
  const { theme } = useUnistyles();
  const hasPicker = getIsElectron();
  return (
    <View style={styles.cloneForm}>
      <Text style={styles.cloneTitle}>Clone {entry.name}</Text>
      <Text style={styles.cloneRemote} numberOfLines={1}>
        {entry.gitRemoteUrl}
      </Text>
      <Text style={styles.cloneLabel}>Target folder (parent)</Text>
      <View style={styles.clonePickerRow}>
        <TextInput
          style={styles.cloneInput}
          value={parentDir}
          onChangeText={onChangeParentDir}
          placeholder={"/absolute/path/to/parent"}
          placeholderTextColor={theme.colors.foregroundMuted}
          editable={!busy}
        />
        {hasPicker ? (
          <Pressable style={styles.cloneBrowseBtn} onPress={onPickDirectory} disabled={busy}>
            <Text style={styles.cloneBrowseText}>Browse…</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.cloneHint}>
        Daemon will create a sub-folder for the repo inside this parent and register it as a
        project.
      </Text>
      <View style={styles.cloneFooter}>
        <Pressable style={styles.secondaryBtn} onPress={onBack} disabled={busy}>
          <Text style={styles.secondaryBtnText}>Back</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, !parentDir.trim() || busy ? styles.primaryBtnDisabled : null]}
          onPress={onConfirm}
          disabled={!parentDir.trim() || busy}
        >
          {busy ? (
            <ActivityIndicator color={theme.colors.surface0} size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>Clone here</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: OVERLAY_Z.modal,
    // The overlay-root portal container has `pointer-events: none` so it
    // doesn't block clicks behind it when empty. Re-enable pointer events
    // on the modal backdrop so its buttons actually receive clicks.
    pointerEvents: "auto" as const,
  },
  backdropClickable: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  card: {
    width: "90%",
    maxWidth: 640,
    maxHeight: "80%",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    // The card must render above the full-screen `backdropClickable` Pressable
    // so its buttons receive clicks. Without an explicit z-index the RN-Web
    // stacking order can place the absolute-positioned backdrop on top.
    zIndex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  headerIconBtn: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  list: { paddingHorizontal: theme.spacing[2] },
  emptyWrap: {
    padding: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    lineHeight: theme.fontSize.sm * 1.4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.base,
    gap: theme.spacing[3],
  },
  rowMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  rowIcon: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 2 },
  rowName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rowMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  rowActions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.foreground,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: {
    color: theme.colors.surface0,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  deleteBtn: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  unavailable: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic",
  },
  cloneForm: { padding: theme.spacing[4], gap: theme.spacing[3] },
  cloneTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  cloneRemote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "monospace" as const,
  },
  cloneLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  clonePickerRow: { flexDirection: "row", gap: theme.spacing[2], alignItems: "stretch" },
  cloneInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface0,
  },
  cloneBrowseBtn: {
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  cloneBrowseText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  cloneHint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  cloneFooter: { flexDirection: "row", gap: theme.spacing[2], justifyContent: "flex-end" },
  secondaryBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  secondaryBtnText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
}));
