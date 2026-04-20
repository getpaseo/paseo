import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Hash, Lock, Search, User } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import type { SearchHit } from "@/api/chat";
import { useSearchMessagesQuery } from "@/hooks/chat/use-chat-queries";

interface SearchPanelProps {
  visible: boolean;
  orgId: string;
  sessionToken: string | null;
  onClose: () => void;
  onPickHit: (hit: SearchHit) => void;
}

export function SearchPanel({
  visible,
  orgId,
  sessionToken,
  onClose,
  onPickHit,
}: SearchPanelProps) {
  const { theme } = useUnistyles();
  const [q, setQ] = useState("");
  const query = useSearchMessagesQuery(orgId, q, sessionToken);
  const hits = query.data ?? [];

  return (
    <AdaptiveModalSheet title="Search" visible={visible} onClose={onClose}>
      <View style={styles.body}>
        <View style={styles.searchRow}>
          <Search size={14} color={theme.colors.foregroundMuted} />
          <AdaptiveTextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search messages in this org…"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        {q.trim().length < 2 ? (
          <Text style={styles.empty}>Type at least 2 characters to search.</Text>
        ) : query.isLoading ? (
          <Text style={styles.empty}>Searching…</Text>
        ) : hits.length === 0 ? (
          <Text style={styles.empty}>No matches.</Text>
        ) : (
          <View style={styles.results}>
            {hits.map((h) => (
              <SearchResultRow
                key={h.messageId}
                hit={h}
                onPress={() => {
                  onPickHit(h);
                  onClose();
                }}
              />
            ))}
          </View>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

export function SearchResultRow({ hit, onPress }: { hit: SearchHit; onPress: () => void }) {
  const { theme } = useUnistyles();
  const Icon = hit.channelKind === "private" ? Lock : hit.channelKind === "dm" ? User : Hash;
  return (
    <Pressable onPress={onPress} style={styles.row} accessibilityRole="button">
      <View style={styles.rowHeader}>
        <Icon size={12} color={theme.colors.foregroundMuted} />
        <Text style={styles.rowChannel} numberOfLines={1}>
          {hit.channelName ?? "Direct message"}
        </Text>
        <Text style={styles.rowDate}>{new Date(hit.createdAt).toLocaleDateString()}</Text>
      </View>
      <Text style={styles.rowAuthor} numberOfLines={1}>
        {hit.authorName}
      </Text>
      <Text style={styles.rowContent} numberOfLines={3}>
        {hit.content}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3] },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: 8,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  input: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 14,
    padding: 0,
  },
  empty: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    paddingVertical: theme.spacing[2],
  },
  results: { gap: theme.spacing[1] },
  row: {
    paddingVertical: 8,
    paddingHorizontal: theme.spacing[1],
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  rowChannel: {
    flex: 1,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontWeight: "500",
  },
  rowDate: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  rowAuthor: {
    fontSize: 13,
    color: theme.colors.foreground,
    fontWeight: "600",
  },
  rowContent: {
    fontSize: 13,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
}));
