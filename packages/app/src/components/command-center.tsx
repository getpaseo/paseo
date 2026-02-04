import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  Platform,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useCommandCenter } from "@/hooks/use-command-center";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { AgentStatusDot } from "@/components/agent-status-dot";

function agentKey(agent: Pick<AggregatedAgent, "serverId" | "id">): string {
  return `${agent.serverId}:${agent.id}`;
}

export function CommandCenter() {
  const { theme } = useUnistyles();
  const {
    open,
    inputRef,
    query,
    setQuery,
    activeIndex,
    results,
    handleClose,
    handleSelect,
  } = useCommandCenter();

  if (Platform.OS !== "web") return null;

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />

        <View style={[styles.panel, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }]}>
          <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Search agents…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[
                styles.input,
                { color: theme.colors.foreground },
              ]}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
          </View>

          <ScrollView
            style={styles.results}
            contentContainerStyle={styles.resultsContent}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {results.length === 0 ? (
              <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
                No matches
              </Text>
            ) : (
              results.map((agent, index) => {
                const active = index === activeIndex;
                return (
                  <Pressable
                    key={agentKey(agent)}
                    style={({ hovered, pressed }) => [
                      styles.row,
                      (hovered || pressed || active) && {
                        backgroundColor: theme.colors.surface1,
                      },
                    ]}
                    onPress={() => handleSelect(agent)}
                  >
                    <View style={styles.rowContent}>
                      <View style={styles.rowTitle}>
                        <AgentStatusDot status={agent.status} requiresAttention={agent.requiresAttention} />
                        <Text
                          style={[styles.title, { color: theme.colors.foreground }]}
                          numberOfLines={1}
                        >
                          {agent.title || "New agent"}
                        </Text>
                      </View>
                      <Text
                        style={[styles.subtitle, { color: theme.colors.foregroundMuted }]}
                        numberOfLines={1}
                      >
                        {agent.serverLabel} · {shortenPath(agent.cwd)} · {formatTimeAgo(agent.lastActivityAt)}
                      </Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "flex-start",
    alignItems: "center",
    paddingTop: theme.spacing[12],
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    width: 640,
    maxWidth: "92%",
    maxHeight: "80%",
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
  },
  input: {
    fontSize: theme.fontSize.lg,
    paddingVertical: theme.spacing[1],
    outlineStyle: "none",
  } as any,
  results: {
    flexGrow: 0,
  },
  resultsContent: {
    paddingVertical: theme.spacing[2],
  },
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  rowContent: {
    gap: 2,
  },
  rowTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: "400",
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    fontSize: theme.fontSize.base,
  },
}));
