import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  Check,
  ChevronLeft,
  Copy,
  FolderGit2,
  Link2,
  Search,
  Trash2,
  User,
} from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useOrgMembers } from "@/desktop/hooks/use-org-members";
import {
  useWorkspaceShareMutations,
  useWorkspaceShares,
} from "@/hooks/sharing/use-workspace-share";
import { useSessionStore } from "@/stores/session-store";
import { getDesktopDaemonPairing } from "@/desktop/daemon/desktop-daemon";
import { getIsElectron } from "@/constants/platform";
import type { WorkspaceShareAccessLevel, WorkspaceShareRecord } from "@/desktop/auth/desktop-auth";

export interface ShareWorkspaceTarget {
  serverId: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
}

export interface ShareWorkspaceModalProps {
  visible: boolean;
  onClose: () => void;
  orgId: string | null;
  /** When provided, the modal skips the workspace picker step. */
  workspace?: ShareWorkspaceTarget | null;
  /** When the modal acts as a picker, this restricts the picker list. */
  serverId?: string | null;
}

export function ShareWorkspaceModal({
  visible,
  onClose,
  orgId,
  workspace: providedWorkspace = null,
  serverId = null,
}: ShareWorkspaceModalProps) {
  const { theme } = useUnistyles();
  const { members } = useOrgMembers(orgId);
  const { user: currentUser } = useAuthSession();
  // Exclude self — the share is implicitly for you, so you're always authorized.
  const otherMembers = useMemo(
    () => members.filter((m) => m.userId !== currentUser?.userId),
    [members, currentUser?.userId],
  );
  const { shares } = useWorkspaceShares(orgId);
  const { createShare, isCreating, createError, revokeShare, isRevoking } =
    useWorkspaceShareMutations(orgId);

  const [pickedWorkspace, setPickedWorkspace] = useState<ShareWorkspaceTarget | null>(null);
  const [accessLevel, setAccessLevel] = useState<WorkspaceShareAccessLevel>("read_only");
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");

  const workspace = providedWorkspace ?? pickedWorkspace;

  const pickerWorkspaces = usePickerWorkspaces(
    providedWorkspace ? null : (serverId ?? null),
    orgId,
  );
  const pickerGroups = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const filtered = q
      ? pickerWorkspaces.filter(
          (ws) =>
            ws.workspaceName.toLowerCase().includes(q) || ws.projectName.toLowerCase().includes(q),
        )
      : pickerWorkspaces;
    const groups = new Map<string, { projectName: string; workspaces: ShareWorkspaceTarget[] }>();
    for (const ws of filtered) {
      const key = `${ws.projectId}:${ws.projectName}`;
      const entry = groups.get(key);
      if (entry) {
        entry.workspaces.push(ws);
      } else {
        groups.set(key, { projectName: ws.projectName, workspaces: [ws] });
      }
    }
    return Array.from(groups.values());
  }, [pickerWorkspaces, pickerQuery]);

  useEffect(() => {
    if (visible) {
      setAccessLevel("read_only");
      setSelectedUserIds(new Set());
      setCopiedToken(null);
      setPickerQuery("");
      if (!providedWorkspace) {
        setPickedWorkspace(null);
      }
    }
  }, [visible, providedWorkspace]);

  const existingShares = useMemo(() => {
    if (!workspace) return [];
    return shares.filter(
      (s) => s.workspaceId === workspace.workspaceId && s.serverId === workspace.serverId,
    );
  }, [shares, workspace]);

  const toggleUser = useCallback((userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    if (!workspace || !orgId) return;
    let pairingUrl: string | undefined;
    if (getIsElectron()) {
      try {
        const pairing = await getDesktopDaemonPairing();
        if (pairing.url) pairingUrl = pairing.url;
      } catch {
        // Non-critical — share still works, joiner will have to enter host manually
      }
    }
    await createShare({
      workspaceId: workspace.workspaceId,
      serverId: workspace.serverId,
      projectId: workspace.projectId,
      projectName: workspace.projectName,
      workspaceName: workspace.workspaceName,
      orgId,
      accessLevel,
      pairingUrl,
      allowedUserIds: Array.from(selectedUserIds),
    });
    setSelectedUserIds(new Set());
  }, [workspace, orgId, createShare, accessLevel, selectedUserIds]);

  const handleCopy = useCallback(async (share: WorkspaceShareRecord) => {
    await Clipboard.setStringAsync(share.shareUrl);
    setCopiedToken(share.token);
    setTimeout(() => setCopiedToken(null), 2000);
  }, []);

  const handleRevoke = useCallback(
    async (token: string) => {
      await revokeShare(token);
    },
    [revokeShare],
  );

  const title = workspace ? `Share "${workspace.workspaceName}"` : "Share workspace";
  const showPicker = !providedWorkspace && !workspace;

  return (
    <AdaptiveModalSheet visible={visible} onClose={onClose} title={title}>
      <View style={styles.content}>
        {!orgId ? (
          <Text style={styles.emptyHint}>
            Select an organization to share workspaces with its members.
          </Text>
        ) : showPicker ? (
          <View style={styles.pickerWrapper}>
            <Text style={styles.label}>Pick a workspace to share</Text>
            <View style={styles.searchRow}>
              <Search size={14} color={theme.colors.foregroundMuted} />
              <TextInput
                value={pickerQuery}
                onChangeText={setPickerQuery}
                placeholder="Search project or workspace..."
                placeholderTextColor={theme.colors.foregroundMuted}
                style={[styles.searchInput, { color: theme.colors.foreground }]}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <ScrollView style={styles.pickerList}>
              {pickerGroups.map((group) => (
                <View key={group.projectName} style={styles.pickerGroup}>
                  <View style={styles.pickerGroupHeader}>
                    <FolderGit2 size={12} color={theme.colors.foregroundMuted} />
                    <Text style={styles.pickerGroupTitle} numberOfLines={1}>
                      {group.projectName}
                    </Text>
                    <Text style={styles.pickerGroupCount}>{group.workspaces.length}</Text>
                  </View>
                  {group.workspaces.map((ws) => (
                    <Pressable
                      key={`${ws.serverId}:${ws.workspaceId}`}
                      style={({ hovered = false, pressed }) => [
                        styles.pickerRow,
                        hovered && styles.pickerRowHovered,
                        pressed && styles.pickerRowPressed,
                      ]}
                      onPress={() => setPickedWorkspace(ws)}
                    >
                      <Text style={styles.pickerWorkspace} numberOfLines={1}>
                        {ws.workspaceName}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ))}
              {pickerGroups.length === 0 && (
                <Text style={styles.emptyHint}>
                  {pickerQuery.trim()
                    ? `No matches for "${pickerQuery.trim()}".`
                    : "No workspaces available on this host."}
                </Text>
              )}
            </ScrollView>
          </View>
        ) : !workspace ? (
          <Text style={styles.emptyHint}>No workspace selected.</Text>
        ) : (
          <>
            {!providedWorkspace && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to workspace picker"
                style={styles.backButton}
                onPress={() => setPickedWorkspace(null)}
              >
                <ChevronLeft size={14} color={theme.colors.foregroundMuted} />
                <Text style={styles.backButtonText}>Change workspace</Text>
              </Pressable>
            )}
            <Text style={styles.label}>Access level</Text>
            <View style={styles.accessRow}>
              <Pressable
                style={[
                  styles.accessOption,
                  accessLevel === "read_only" && styles.accessOptionSelected,
                ]}
                onPress={() => setAccessLevel("read_only")}
              >
                <Text
                  style={[
                    styles.accessOptionText,
                    accessLevel === "read_only" && styles.accessOptionTextSelected,
                  ]}
                >
                  Can view
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.accessOption,
                  accessLevel === "full_access" && styles.accessOptionSelected,
                ]}
                onPress={() => setAccessLevel("full_access")}
              >
                <Text
                  style={[
                    styles.accessOptionText,
                    accessLevel === "full_access" && styles.accessOptionTextSelected,
                  ]}
                >
                  Can interact
                </Text>
              </Pressable>
            </View>

            <View style={styles.memberHeader}>
              <Text style={styles.label}>Members</Text>
              <Text style={styles.memberHint}>
                {selectedUserIds.size === 0
                  ? "Leave empty to share with anyone in the org"
                  : `${selectedUserIds.size} selected`}
              </Text>
            </View>
            <ScrollView style={styles.memberList}>
              {otherMembers.map((m) => {
                const selected = selectedUserIds.has(m.userId);
                return (
                  <Pressable
                    key={m.userId}
                    style={({ hovered = false, pressed }) => [
                      styles.memberRow,
                      hovered && styles.memberRowHovered,
                      pressed && styles.memberRowPressed,
                    ]}
                    onPress={() => toggleUser(m.userId)}
                  >
                    <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                      {selected && <Check size={12} color={theme.colors.accentForeground} />}
                    </View>
                    {m.user?.image ? (
                      <Image source={{ uri: m.user.image }} style={styles.memberAvatar} />
                    ) : (
                      <View style={[styles.memberAvatar, styles.memberAvatarFallback]}>
                        <User size={12} color={theme.colors.foregroundMuted} />
                      </View>
                    )}
                    <View style={styles.memberInfo}>
                      <Text style={styles.memberName} numberOfLines={1}>
                        {m.user?.name ?? "Unknown"}
                      </Text>
                      <Text style={styles.memberEmail} numberOfLines={1}>
                        {m.user?.email ?? ""}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
              {otherMembers.length === 0 && (
                <Text style={styles.emptyHint}>No other members in this organization.</Text>
              )}
            </ScrollView>

            {createError && <Text style={styles.error}>{createError}</Text>}

            <Button
              variant="default"
              size="md"
              leftIcon={<Link2 size={14} color={theme.colors.accentForeground} />}
              onPress={() => void handleCreate()}
              disabled={isCreating}
            >
              {isCreating ? "Creating..." : "Create share link"}
            </Button>

            {existingShares.length > 0 && (
              <View style={styles.existingShares}>
                <Text style={styles.label}>Active shares</Text>
                {existingShares.map((share) => {
                  const isCopied = copiedToken === share.token;
                  return (
                    <View key={share.token} style={styles.shareRow}>
                      <View style={styles.shareRowInfo}>
                        <Text style={styles.shareAccess}>
                          {share.accessLevel === "full_access" ? "Can interact" : "Can view"}
                        </Text>
                        <Text style={styles.shareMembers} numberOfLines={1}>
                          {share.allowedUsers.length === 0
                            ? "Anyone in org"
                            : share.allowedUsers.map((u) => u.name).join(", ")}
                        </Text>
                        <TextInput
                          style={[styles.linkInput, { color: theme.colors.foregroundMuted }]}
                          value={share.shareUrl}
                          readOnly
                          selectTextOnFocus
                        />
                      </View>
                      <View style={styles.shareActions}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Copy share link"
                          style={styles.iconButton}
                          onPress={() => void handleCopy(share)}
                        >
                          {isCopied ? (
                            <Check size={14} color={theme.colors.accent} />
                          ) : (
                            <Copy size={14} color={theme.colors.foregroundMuted} />
                          )}
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Revoke share"
                          style={styles.iconButton}
                          onPress={() => void handleRevoke(share.token)}
                          disabled={isRevoking}
                        >
                          <Trash2 size={14} color={theme.colors.destructive} />
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[4],
    padding: theme.spacing[4],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  accessRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  accessOption: {
    flex: 1,
    paddingVertical: theme.spacing[3],
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  accessOptionSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  accessOptionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  accessOptionTextSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  memberHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  memberHint: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    opacity: 0.7,
  },
  memberList: {
    maxHeight: 240,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  memberRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  memberRowPressed: {
    opacity: 0.7,
  },
  memberAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  memberAvatarFallback: {
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  memberInfo: {
    flex: 1,
    minWidth: 0,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSelected: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  memberName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  memberEmail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: 1,
  },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
  existingShares: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[3],
    gap: theme.spacing[2],
  },
  shareRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  shareRowInfo: {
    flex: 1,
    gap: theme.spacing[1],
  },
  shareAccess: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  shareMembers: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  shareActions: {
    flexDirection: "row",
    gap: theme.spacing[1],
    alignItems: "center",
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
  },
  linkInput: {
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    fontSize: theme.fontSize.xs,
    outlineStyle: "none",
  } as any,
  pickerWrapper: {
    gap: theme.spacing[2],
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing[2] + 2,
    fontSize: theme.fontSize.sm,
    outlineStyle: "none",
  } as any,
  pickerList: {
    maxHeight: 360,
  },
  pickerGroup: {
    marginBottom: theme.spacing[2],
  },
  pickerGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
  pickerGroupTitle: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  pickerGroupCount: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    opacity: 0.6,
  },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2] + 1,
    paddingHorizontal: theme.spacing[3],
    marginLeft: theme.spacing[4],
    borderRadius: theme.borderRadius.base,
  },
  pickerRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  pickerRowPressed: {
    opacity: 0.7,
  },
  pickerWorkspace: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  backButton: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  backButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

interface PickerWorkspace extends ShareWorkspaceTarget {}

function usePickerWorkspaces(
  serverId: string | null,
  orgId: string | null,
): PickerWorkspace[] {
  const workspaces = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.workspaces ?? null) : null,
  );

  return useMemo(() => {
    if (!serverId || !workspaces) return [] as PickerWorkspace[];
    const entries: PickerWorkspace[] = [];
    for (const ws of workspaces.values()) {
      // Only surface workspaces that belong to the active org. Workspaces with
      // no orgId (legacy / created before org scoping) remain picker-able under
      // any org so existing data isn't stranded.
      if (orgId && ws.orgId && ws.orgId !== orgId) continue;
      entries.push({
        serverId,
        workspaceId: ws.id,
        workspaceName: ws.name,
        projectId: ws.projectId,
        projectName:
          ws.projectDisplayName && ws.projectDisplayName.length > 0
            ? ws.projectDisplayName
            : ws.projectId,
      });
    }
    entries.sort((a, b) => {
      const pd = a.projectName.localeCompare(b.projectName, undefined, {
        sensitivity: "base",
      });
      if (pd !== 0) return pd;
      return a.workspaceName.localeCompare(b.workspaceName, undefined, { sensitivity: "base" });
    });
    return entries;
  }, [serverId, workspaces, orgId]);
}
