import { useEffect, useRef } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Eye, LogOut, User, Users } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  endSharedSessionAndDisconnect,
  useSharedSessionStore,
  type SharedParticipant,
} from "@/stores/shared-session-store";
import { usePanelStore } from "@/stores/panel-store";

interface ParticipantBarProps {
  participants: Map<string, SharedParticipant>;
}

const MAX_VISIBLE_AVATARS = 5;

export function ParticipantBar({ participants }: ParticipantBarProps) {
  const { theme } = useUnistyles();
  const { currentUser, ownerName, accessLevel } = useSharedSessionStore();
  const list = Array.from(participants.values()).filter((p) => p.isOnline);

  // Collapse the sidebar to its icon rail on entry (not fully hidden — the
  // user still wants to see the org/messages/sessions shortcuts). Restore the
  // previous expanded state on exit. We only revert the state *we* set, so
  // user interactions during the session stick.
  const didAutoCollapseRef = useRef(false);
  useEffect(() => {
    const { agentListCollapsed } = usePanelStore.getState().desktop;
    if (!agentListCollapsed) {
      didAutoCollapseRef.current = true;
      usePanelStore.getState().toggleAgentListCollapsed();
    }
    return () => {
      if (didAutoCollapseRef.current) {
        const latest = usePanelStore.getState().desktop.agentListCollapsed;
        if (latest) usePanelStore.getState().toggleAgentListCollapsed();
      }
    };
    // Run only on mount/unmount — session lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLeave = () => {
    // `endSharedSessionAndDisconnect` handles its own navigation based on
    // mode: recipients get bounced to `/` (the index route picks the next
    // online host); hosts stay exactly where they were — nothing to evict.
    void endSharedSessionAndDisconnect();
  };

  const chipEntries: Array<{
    userId: string;
    username: string;
    avatarUrl: string;
    isMe: boolean;
  }> = [];
  const seen = new Set<string>();
  if (currentUser) {
    chipEntries.push({
      userId: currentUser.userId,
      username: currentUser.username,
      avatarUrl: currentUser.avatarUrl,
      isMe: true,
    });
    seen.add(currentUser.userId);
  }
  for (const p of list) {
    if (seen.has(p.userId)) continue;
    chipEntries.push({
      userId: p.userId,
      username: p.username,
      avatarUrl: p.avatarUrl,
      isMe: false,
    });
    seen.add(p.userId);
  }

  const isFullAccess = accessLevel === "full_access";

  return (
    <View style={styles.bar}>
      <View style={styles.leftGroup}>
        <View style={styles.avatarStack}>
          {chipEntries.slice(0, MAX_VISIBLE_AVATARS).map((p, i) => (
            <Tooltip key={p.userId} delayDuration={200}>
              <TooltipTrigger
                style={[
                  styles.stackAvatar,
                  i > 0 && { marginLeft: -8 },
                  { zIndex: MAX_VISIBLE_AVATARS - i },
                ]}
              >
                {p.avatarUrl ? (
                  <Image source={{ uri: p.avatarUrl }} style={styles.stackAvatarImg} />
                ) : (
                  <View style={[styles.stackAvatarImg, styles.chipAvatarFallback]}>
                    <User size={10} color={theme.colors.foregroundMuted} />
                  </View>
                )}
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center" offset={6}>
                <Text style={styles.tooltipText}>
                  {p.isMe ? `${p.username} (You)` : p.username}
                </Text>
              </TooltipContent>
            </Tooltip>
          ))}
          {chipEntries.length > MAX_VISIBLE_AVATARS ? (
            <Tooltip delayDuration={200}>
              <TooltipTrigger
                style={[styles.stackAvatar, styles.stackOverflow, { marginLeft: -8, zIndex: 0 }]}
              >
                <Text style={styles.stackOverflowText}>
                  +{chipEntries.length - MAX_VISIBLE_AVATARS}
                </Text>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center" offset={6}>
                <Text style={styles.tooltipText}>
                  {chipEntries
                    .slice(MAX_VISIBLE_AVATARS)
                    .map((p) => p.username)
                    .join(", ")}
                </Text>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </View>
        <View style={styles.onlinePill}>
          <View style={styles.onlineDot} />
          <Text style={styles.onlineText}>
            {chipEntries.length} {chipEntries.length === 1 ? "online" : "online"}
          </Text>
        </View>
      </View>

      <View style={styles.centerGroup}>
        <Users size={12} color={theme.colors.foregroundMuted} />
        <Text style={styles.sharedByText} numberOfLines={1}>
          {ownerName ? (
            <>
              Shared by <Text style={styles.sharedByName}>{ownerName}</Text>
            </>
          ) : (
            "Shared session"
          )}
        </Text>
        <View
          style={[
            styles.accessBadge,
            isFullAccess ? styles.accessBadgeInteract : styles.accessBadgeView,
          ]}
        >
          {isFullAccess ? (
            <Users size={10} color={theme.colors.accent} />
          ) : (
            <Eye size={10} color={theme.colors.foregroundMuted} />
          )}
          <Text style={[styles.accessBadgeText, isFullAccess && styles.accessBadgeTextInteract]}>
            {isFullAccess ? "Full access" : "View only"}
          </Text>
        </View>
      </View>

      <View style={styles.rightGroup}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Leave shared session"
          onPress={handleLeave}
          style={({ hovered = false, pressed }) => [
            styles.leaveButton,
            hovered && styles.leaveButtonHovered,
            pressed && styles.leaveButtonPressed,
          ]}
        >
          <LogOut size={12} color={theme.colors.destructive} />
          <Text style={styles.leaveButtonText}>Leave</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  leftGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  avatarStack: {
    flexDirection: "row",
    alignItems: "center",
  },
  stackAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: theme.colors.surface1,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  stackAvatarImg: {
    width: "100%",
    height: "100%",
    borderRadius: 12,
  },
  chipAvatarFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  stackOverflow: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
  },
  stackOverflowText: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  onlinePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: 3,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  onlineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#22c55e",
  },
  onlineText: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  centerGroup: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  sharedByText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  sharedByName: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  accessBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  accessBadgeInteract: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  accessBadgeView: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  accessBadgeText: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  accessBadgeTextInteract: {
    color: theme.colors.accent,
  },
  rightGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  leaveButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1] + 2,
    paddingHorizontal: theme.spacing[2] + 2,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.destructive,
    backgroundColor: theme.colors.surface0,
  },
  leaveButtonHovered: {
    borderColor: theme.colors.destructive,
    backgroundColor: theme.colors.surface2,
  },
  leaveButtonPressed: {
    opacity: 0.8,
  },
  leaveButtonText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
    fontWeight: theme.fontWeight.medium,
  },
}));
