import { Image, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { LogOut, User, Users } from "lucide-react-native";
import { router } from "expo-router";
import {
  endSharedSessionAndDisconnect,
  useSharedSessionStore,
  type SharedParticipant,
} from "@/stores/shared-session-store";

interface ParticipantBarProps {
  participants: Map<string, SharedParticipant>;
}

export function ParticipantBar({ participants }: ParticipantBarProps) {
  const { theme } = useUnistyles();
  const { currentUser, ownerName, accessLevel } = useSharedSessionStore();
  const list = Array.from(participants.values()).filter((p) => p.isOnline);

  const handleLeave = () => {
    void endSharedSessionAndDisconnect();
  };

  // Merge Colyseus participants with the local currentUser so the viewer
  // always sees themselves in the chip list even before the room state syncs.
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

  return (
    <View style={styles.bar}>
      <Users size={14} color={theme.colors.accent} />

      <View style={styles.chipRow}>
        {chipEntries.map((p) => (
          <View key={p.userId} style={styles.userChip}>
            {p.avatarUrl ? (
              <Image source={{ uri: p.avatarUrl }} style={styles.chipAvatar} />
            ) : (
              <View style={[styles.chipAvatar, styles.chipAvatarFallback]}>
                <User size={8} color={theme.colors.foregroundMuted} />
              </View>
            )}
            <Text style={styles.chipName} numberOfLines={1}>
              {p.isMe ? `${p.username} (you)` : p.username}
            </Text>
          </View>
        ))}
      </View>

      <Text style={styles.info} numberOfLines={1}>
        {ownerName ? `Shared by ${ownerName}` : "Shared session"}
        {accessLevel === "full_access" ? " · Full access" : " · View only"}
        {chipEntries.length > 1 ? ` · ${chipEntries.length} online` : ""}
      </Text>

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
        <LogOut size={12} color={theme.colors.foregroundMuted} />
        <Text style={styles.leaveButtonText}>Sair</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1] + 2,
    flexShrink: 1,
    flexWrap: "wrap",
  },
  userChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: 2,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  chipAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  chipAvatarFallback: {
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  chipName: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    maxWidth: 100,
  },
  info: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  leaveButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexShrink: 0,
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
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
}));
