import { Pressable, Text, View } from "react-native";
import { PinOff } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { ChatChannel } from "@/api/chat";
import { usePinsQuery, useUnpinMutation } from "@/hooks/chat/use-chat-queries";

interface PinsModalProps {
  visible: boolean;
  channel: ChatChannel;
  sessionToken: string | null;
  currentUserId: string | null;
  onClose: () => void;
  onOpenMessage?: (messageId: string) => void;
}

export function PinsModal({
  visible,
  channel,
  sessionToken,
  currentUserId,
  onClose,
  onOpenMessage,
}: PinsModalProps) {
  const { theme } = useUnistyles();
  const pinsQuery = usePinsQuery(channel.id, sessionToken);
  const unpin = useUnpinMutation(sessionToken);

  const pins = pinsQuery.data ?? [];

  return (
    <AdaptiveModalSheet
      title={`${pins.length} pinned ${pins.length === 1 ? "item" : "items"}`}
      visible={visible}
      onClose={onClose}
    >
      {pins.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {pinsQuery.isLoading ? "Loading…" : "Nothing pinned in this channel yet."}
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {pins.map((p) => {
            const canUnpin =
              currentUserId !== null && p.pinnedBy === currentUserId;
            return (
              <View key={p.messageId} style={styles.row}>
                <Pressable
                  onPress={() => {
                    onOpenMessage?.(p.messageId);
                    onClose();
                  }}
                  style={styles.rowBody}
                  accessibilityRole="button"
                >
                  <Text style={styles.author} numberOfLines={1}>
                    {p.message.authorName}
                  </Text>
                  <Text style={styles.content} numberOfLines={3}>
                    {p.message.content}
                  </Text>
                  <Text style={styles.meta}>
                    Pinned {new Date(p.pinnedAt).toLocaleDateString()}
                  </Text>
                </Pressable>
                {canUnpin ? (
                  <Pressable
                    onPress={() =>
                      unpin.mutate({
                        channelId: channel.id,
                        messageId: p.messageId,
                      })
                    }
                    style={styles.unpinBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Unpin"
                  >
                    <PinOff size={16} color={theme.colors.foregroundMuted} />
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    paddingVertical: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  list: {
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  author: {
    fontSize: 13,
    color: theme.colors.foreground,
    fontWeight: "600",
  },
  content: {
    fontSize: 13,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  meta: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  unpinBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
}));
