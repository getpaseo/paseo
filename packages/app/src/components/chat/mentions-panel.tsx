import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { SearchHit } from "@/api/chat";
import { useMyMentionsQuery } from "@/hooks/chat/use-chat-queries";
import { SearchResultRow } from "./search-panel";

interface MentionsPanelProps {
  visible: boolean;
  orgId: string;
  sessionToken: string | null;
  onClose: () => void;
  onPickHit: (hit: SearchHit) => void;
}

export function MentionsPanel({
  visible,
  orgId,
  sessionToken,
  onClose,
  onPickHit,
}: MentionsPanelProps) {
  const query = useMyMentionsQuery(orgId, sessionToken);
  const hits = query.data ?? [];

  return (
    <AdaptiveModalSheet title="Mentions" visible={visible} onClose={onClose}>
      <View style={styles.body}>
        {query.isLoading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : hits.length === 0 ? (
          <Text style={styles.empty}>You have no mentions yet.</Text>
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

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[2] },
  empty: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[2],
  },
  results: { gap: theme.spacing[1] },
}));
