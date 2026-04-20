import { memo, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { UserPlus } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ChatMember } from "@/api/chat";
import type { ChatPresence } from "@/stores/chat-store";
import { Avatar } from "./avatar";

interface ChannelHeaderMembersProps {
  members: ChatMember[];
  presenceByUser: Record<string, ChatPresence>;
  maxVisible?: number;
  onOpenMembers?: () => void;
  onAddPeople?: () => void;
  canAdd?: boolean;
}

export const ChannelHeaderMembers = memo(function ChannelHeaderMembers({
  members,
  presenceByUser,
  maxVisible = 5,
  onOpenMembers,
  onAddPeople,
  canAdd,
}: ChannelHeaderMembersProps) {
  const { theme } = useUnistyles();
  const ordered = useMemo(() => {
    return [...members].sort((a, b) => {
      const aOnline = !!presenceByUser[a.userId];
      const bOnline = !!presenceByUser[b.userId];
      if (aOnline !== bOnline) return aOnline ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [members, presenceByUser]);
  const visible = ordered.slice(0, maxVisible);
  const overflow = Math.max(0, ordered.length - visible.length);

  return (
    <View style={styles.container}>
      <Pressable
        onPress={onOpenMembers}
        style={styles.stack}
        accessibilityRole="button"
        accessibilityLabel={`${ordered.length} members`}
      >
        {visible.map((m, idx) => (
          <View key={m.userId} style={[styles.avatarWrap, { marginLeft: idx === 0 ? 0 : -8 }]}>
            <Avatar
              name={m.name}
              imageUrl={m.image}
              size={24}
              online={!!presenceByUser[m.userId]}
            />
          </View>
        ))}
        {overflow > 0 ? (
          <View style={[styles.overflow, { marginLeft: -8 }]}>
            <Text style={styles.overflowText}>+{overflow}</Text>
          </View>
        ) : null}
      </Pressable>
      {canAdd && onAddPeople ? (
        <Pressable
          onPress={onAddPeople}
          style={styles.addBtn}
          accessibilityRole="button"
          accessibilityLabel="Add people"
        >
          <UserPlus size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  stack: {
    flexDirection: "row",
    alignItems: "center",
  },
  avatarWrap: {
    borderRadius: 6,
    borderWidth: 2,
    borderColor: theme.colors.surface0,
  },
  overflow: {
    width: 24,
    height: 24,
    borderRadius: 5,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: theme.colors.surface0,
  },
  overflowText: {
    fontSize: 10,
    color: theme.colors.foreground,
    fontWeight: "600",
  },
  addBtn: {
    width: 24,
    height: 24,
    borderRadius: 4,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
}));
