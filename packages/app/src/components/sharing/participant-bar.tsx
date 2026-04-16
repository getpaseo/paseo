import { Image, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { User, Users } from "lucide-react-native";
import {
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

  return (
    <View style={styles.bar}>
      <Users size={14} color={theme.colors.accent} />

      {currentUser && (
        <View style={styles.userChip}>
          {currentUser.avatarUrl ? (
            <Image source={{ uri: currentUser.avatarUrl }} style={styles.chipAvatar} />
          ) : (
            <View style={[styles.chipAvatar, styles.chipAvatarFallback]}>
              <User size={8} color={theme.colors.foregroundMuted} />
            </View>
          )}
          <Text style={styles.chipName} numberOfLines={1}>
            {currentUser.username}
          </Text>
        </View>
      )}

      <Text style={styles.info} numberOfLines={1}>
        {ownerName ? `Shared by ${ownerName}` : "Shared session"}
        {accessLevel === "full_access" ? " · Full access" : " · View only"}
        {list.length > 0 ? ` · ${list.length} online` : ""}
      </Text>
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
}));
