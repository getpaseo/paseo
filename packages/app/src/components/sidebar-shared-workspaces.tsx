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
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useIsInSharedSession } from "@/stores/shared-session-store";

interface SidebarSharedWorkspacesProps {
  serverId: string | null;
  onWorkspacePress?: () => void;
}

export function SidebarSharedWorkspaces({
  serverId,
  onWorkspacePress,
}: SidebarSharedWorkspacesProps) {
  const { theme } = useUnistyles();
  const { isAuthenticated } = useAuthSession();
  const isInSharedSession = useIsInSharedSession();
  const { organizations } = useOrganizations();
  const activeOrgId = useActiveOrgId();
  const orgId = activeOrgId ?? organizations[0]?.id ?? null;

  const { shares: mine } = useWorkspaceShares(orgId);
  const { shares: withMe } = useSharedWorkspaces(orgId);
  const { revokeShare, isRevoking } = useWorkspaceShareMutations(orgId);

  const [collapsed, setCollapsed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

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
    (share: { serverId: string; workspaceId: string }) => {
      router.push(buildHostWorkspaceRoute(share.serverId, share.workspaceId));
      onWorkspacePress?.();
    },
    [onWorkspacePress],
  );

  const handleOpenShareUrl = useCallback(async (shareUrl: string) => {
    if (!shareUrl) return;
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Share a workspace"
          style={({ hovered = false }) => [styles.addButton, hovered && styles.headerHovered]}
          onPress={() => setModalOpen(true)}
          disabled={!orgId}
        >
          <Plus size={12} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>

      {!collapsed && (
        <View style={styles.body}>
          {emptyState && <Text style={styles.emptyHint}>{emptyState}</Text>}

          {mine.length > 0 && (
            <View style={styles.subsection}>
              <Text style={styles.subsectionLabel}>Shared by you</Text>
              {mine.map((share) => {
                const isCopied = copiedToken === share.token;
                const access = share.accessLevel === "full_access" ? "Can interact" : "Can view";
                const audience =
                  share.allowedUsers.length === 0
                    ? "Anyone in org"
                    : `${share.allowedUsers.length} member${share.allowedUsers.length === 1 ? "" : "s"}`;
                return (
                  <View key={share.token} style={styles.row}>
                    <Share2 size={11} color={theme.colors.foregroundMuted} />
                    <View style={styles.rowInfo}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {share.workspaceName}
                      </Text>
                      <Text style={styles.rowSubtitle} numberOfLines={1}>
                        {access} · {audience}
                      </Text>
                    </View>
                    <View style={styles.rowActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Copy share link"
                        style={({ hovered = false }) => [
                          styles.iconButton,
                          hovered && styles.iconButtonHovered,
                        ]}
                        onPress={() => void handleCopy(share.shareUrl, share.token)}
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
                        style={({ hovered = false }) => [
                          styles.iconButton,
                          hovered && styles.iconButtonDestructive,
                        ]}
                        onPress={() => void handleRevoke(share.token)}
                        disabled={isRevoking}
                      >
                        <Trash2 size={12} color={theme.colors.destructive} />
                      </Pressable>
                    </View>
                  </View>
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
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${share.workspaceName}`}
                  style={({ hovered = false }) => [styles.row, hovered && styles.rowHovered]}
                  onPress={() => handleOpenShared(share)}
                >
                  <Users size={11} color={theme.colors.foregroundMuted} />
                  <View style={styles.rowInfo}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {share.workspaceName}
                    </Text>
                    <Text style={styles.rowSubtitle} numberOfLines={1}>
                      by {share.owner.name} ·{" "}
                      {share.accessLevel === "full_access" ? "Can interact" : "Can view"}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Copy share link"
                    style={({ hovered = false }) => [
                      styles.iconButton,
                      hovered && styles.iconButtonHovered,
                    ]}
                    onPress={() => void handleOpenShareUrl(share.shareUrl)}
                  >
                    <ExternalLink size={12} color={theme.colors.foregroundMuted} />
                  </Pressable>
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
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowInfo: {
    flex: 1,
    minWidth: 0,
    gap: 0,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  rowSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    opacity: 0.75,
    marginTop: 1,
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
