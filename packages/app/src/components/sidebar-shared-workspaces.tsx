import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Plus,
  Share2,
  Trash2,
  Users,
} from "lucide-react-native";
import { router } from "expo-router";
import { useOrganizations } from "@/desktop/hooks/use-organizations";
import { useActiveOrgId } from "@/stores/active-org-store";
import {
  useSharedWorkspaces,
  useWorkspaceShareMutations,
  useWorkspaceShares,
} from "@/hooks/sharing/use-workspace-share";
import { ShareWorkspaceModal } from "@/components/sharing/share-workspace-modal";
import { PreJoinModal } from "@/components/sharing/pre-join-modal";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import {
  startSharedSessionAsHost,
  useIsSharedRecipient,
  useSharedSessionStore,
} from "@/stores/shared-session-store";
import { isNative, isWeb } from "@/constants/platform";

interface SidebarSharedWorkspacesProps {
  serverId: string | null;
  onWorkspacePress?: () => void;
}

export function SidebarSharedWorkspaces({
  serverId,
  onWorkspacePress,
}: SidebarSharedWorkspacesProps) {
  const { theme } = useUnistyles();
  const { isAuthenticated, session: authSession, user: authUser } = useAuthSession();
  const isInSharedSession = useIsSharedRecipient();
  const { shareToken: activeShareToken } = useSharedSessionStore();
  const { organizations } = useOrganizations();
  const activeOrgId = useActiveOrgId();
  const orgId = activeOrgId ?? organizations[0]?.id ?? null;

  const { shares: mine } = useWorkspaceShares(orgId);
  const { shares: withMe } = useSharedWorkspaces(orgId);
  const { revokeShare, isRevoking } = useWorkspaceShareMutations(orgId);

  const [collapsed, setCollapsed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [pendingJoin, setPendingJoin] = useState<{
    token: string;
    serverId: string;
    workspaceId: string;
    accessLevel: string;
  } | null>(null);

  const totalCount = mine.length + withMe.length;

  const handleCopy = useCallback(async (shareUrl: string, token: string) => {
    await Clipboard.setStringAsync(shareUrl);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2000);
  }, []);

  const handleRevoke = useCallback(
    async (token: string) => {
      await revokeShare(token);
    },
    [revokeShare],
  );

  const handleOpenShared = useCallback(
    (share: { serverId: string; workspaceId: string; shareUrl: string }) => {
      if (isWeb && share.shareUrl && typeof window !== "undefined") {
        window.open(share.shareUrl, "_blank", "noopener,noreferrer");
        return;
      }
      router.push(buildHostWorkspaceRoute(share.serverId, share.workspaceId));
      onWorkspacePress?.();
    },
    [onWorkspacePress],
  );

  const handleJoinShare = useCallback(
    (share: { token: string; serverId: string; workspaceId: string; accessLevel: string }) => {
      setPendingJoin(share);
    },
    [],
  );

  const handleConfirmJoin = useCallback(() => {
    const share = pendingJoin;
    if (!share) return;
    setPendingJoin(null);
    router.push(buildHostWorkspaceRoute(share.serverId, share.workspaceId));
    onWorkspacePress?.();
    const sessionToken = authSession?.sessionToken ?? "";
    if (!sessionToken || !authUser) return;
    void startSharedSessionAsHost({
      shareToken: share.token,
      sessionToken,
      currentUser: {
        userId: authUser.userId,
        username: authUser.username,
        avatarUrl: authUser.avatarUrl,
        isOwner: true,
      },
      ownerName: authUser.username,
      accessLevel: share.accessLevel,
    });
  }, [authSession?.sessionToken, authUser, onWorkspacePress, pendingJoin]);

  const handleOpenShareUrl = useCallback(async (shareUrl: string) => {
    if (!shareUrl) return;
    if (isWeb && typeof window !== "undefined") {
      window.open(shareUrl, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      await Clipboard.setStringAsync(shareUrl);
    } catch {
      // ignore
    }
  }, []);

  const emptyState = useMemo(() => {
    if (!isAuthenticated) return "Sign in to share workspaces.";
    if (!orgId) return "Create an organization to share workspaces.";
    if (totalCount === 0) return "No shared workspaces yet.";
    return null;
  }, [isAuthenticated, orgId, totalCount]);

  // Hide entirely when the user is currently INSIDE a shared workspace session
  // (recipient view) — they shouldn't be managing shares from someone else's
  // scoped window. Shown on all platforms (web, mobile, desktop) otherwise.
  if (isInSharedSession) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={collapsed ? "Expand shared workspaces" : "Collapse shared workspaces"}
          style={({ hovered = false }) => [styles.headerToggle, hovered && styles.headerHovered]}
          onPress={() => setCollapsed((prev) => !prev)}
        >
          {collapsed ? (
            <ChevronRight size={12} color={theme.colors.foregroundMuted} />
          ) : (
            <ChevronDown size={12} color={theme.colors.foregroundMuted} />
          )}
          <Users size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.headerText}>Shared Workspaces</Text>
          {totalCount > 0 && <Text style={styles.countBadge}>{totalCount}</Text>}
        </Pressable>
        {isAuthenticated ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share a workspace"
            style={({ hovered = false }) => [
              styles.addButton,
              hovered && styles.headerHovered,
              !orgId && styles.addButtonDisabled,
            ]}
            onPress={() => setModalOpen(true)}
            disabled={!orgId}
          >
            <Plus size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      {!collapsed && (
        <View style={styles.body}>
          {emptyState && <Text style={styles.emptyHint}>{emptyState}</Text>}

          {mine.length > 0 && (
            <View style={styles.subsection}>
              <Text style={styles.subsectionLabel}>Shared by you</Text>
              {mine.map((share) => {
                const isCopied = copiedToken === share.token;
                const isActive = activeShareToken === share.token;
                return (
                  <Pressable
                    key={share.token}
                    {...(isWeb
                      ? ({ dataSet: { hubcodeRow: "1" } } as unknown as Record<string, unknown>)
                      : {})}
                    style={[styles.row, isActive && styles.rowActive]}
                    accessibilityLabel={`Open shared workspace ${share.workspaceName}`}
                    disabled={isActive}
                    onPress={() => {
                      if (isActive) return;
                      handleJoinShare({
                        token: share.token,
                        serverId: share.serverId,
                        workspaceId: share.workspaceId,
                        accessLevel: share.accessLevel,
                      });
                    }}
                  >
                    {() => (
                      <>
                        <Share2 size={12} color={theme.colors.foregroundMuted} />
                        <Text style={styles.rowTitle} numberOfLines={1}>
                          {share.workspaceName}
                        </Text>
                        <View style={styles.rowActions}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Copy share link"
                            style={({ hovered: btnHover = false }) => [
                              styles.iconButton,
                              btnHover && styles.iconButtonHovered,
                            ]}
                            onPress={(e) => {
                              e.stopPropagation?.();
                              void handleCopy(share.shareUrl, share.token);
                            }}
                          >
                            {isCopied ? (
                              <Check size={12} color={theme.colors.accent} />
                            ) : (
                              <Copy size={12} color={theme.colors.foregroundMuted} />
                            )}
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Revoke share"
                            style={({ hovered: btnHover = false }) => [
                              styles.iconButton,
                              btnHover && styles.iconButtonDestructive,
                            ]}
                            onPress={(e) => {
                              e.stopPropagation?.();
                              void handleRevoke(share.token);
                            }}
                            disabled={isRevoking}
                          >
                            <Trash2 size={12} color={theme.colors.destructive} />
                          </Pressable>
                        </View>
                      </>
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}

          {withMe.length > 0 && (
            <View style={styles.subsection}>
              <Text style={styles.subsectionLabel}>Shared with you</Text>
              {withMe.map((share) => (
                <Pressable
                  key={share.token}
                  {...(isWeb
                    ? ({ dataSet: { hubcodeRow: "1" } } as unknown as Record<string, unknown>)
                    : {})}
                  accessibilityLabel={`Open ${share.workspaceName}`}
                  style={styles.row}
                  onPress={() => handleOpenShared(share)}
                >
                  {() => (
                    <>
                      <Users size={12} color={theme.colors.foregroundMuted} />
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {share.workspaceName}
                      </Text>
                      <Text style={styles.rowOwner} numberOfLines={1}>
                        {share.owner.name}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Open share link in new tab"
                        style={({ hovered: btnHover = false }) => [
                          styles.iconButton,
                          btnHover && styles.iconButtonHovered,
                        ]}
                        onPress={(e) => {
                          e.stopPropagation?.();
                          void handleOpenShareUrl(share.shareUrl);
                        }}
                      >
                        <ExternalLink size={12} color={theme.colors.foregroundMuted} />
                      </Pressable>
                    </>
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}

      <ShareWorkspaceModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        orgId={orgId}
        serverId={serverId}
      />

      <PreJoinModal
        visible={pendingJoin !== null}
        username={authUser?.username ?? "Guest"}
        onCancel={() => setPendingJoin(null)}
        onConfirm={handleConfirmJoin}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1] + 2,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  headerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  headerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  countBadge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  addButton: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
  },
  addButtonDisabled: {
    opacity: 0.4,
  },
  body: {
    paddingTop: theme.spacing[1],
    gap: theme.spacing[2],
  },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  subsection: {
    gap: 1,
  },
  subsectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: 2,
    opacity: 0.6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: 5,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    minHeight: 28,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.accent,
    paddingLeft: theme.spacing[2] - 2,
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rowOwner: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    opacity: 0.65,
    flexShrink: 1,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  iconButton: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonDestructive: {
    backgroundColor: theme.colors.surface2,
  },
}));
