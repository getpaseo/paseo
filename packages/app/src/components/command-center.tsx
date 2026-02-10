import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  Platform,
} from "react-native";
import { Plus, Settings } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useCommandCenter } from "@/hooks/use-command-center";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { Shortcut } from "@/components/ui/shortcut";

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
    items,
    handleClose,
    handleSelectItem,
  } = useCommandCenter();

  if (Platform.OS !== "web") return null;

  const actionItems = items.filter((item) => item.kind === "action");
  const agentItems = items.filter((item) => item.kind === "agent");

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
              placeholder="Type a command or search agents..."
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
            {items.length === 0 ? (
              <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
                No matches
              </Text>
            ) : (
              <>
                {actionItems.length > 0 ? (
                  <>
                    <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>
                      Actions
                    </Text>
                    {actionItems.map((item, index) => {
                      const active = index === activeIndex;
                      const action = item.action;
                      const actionIcon =
                        action.icon === "plus" ? (
                          <Plus
                            size={16}
                            strokeWidth={2.4}
                            color={theme.colors.foregroundMuted}
                          />
                        ) : action.icon === "settings" ? (
                          <Settings
                            size={16}
                            strokeWidth={2.2}
                            color={theme.colors.foregroundMuted}
                          />
                        ) : null;
                      return (
                        <Pressable
                          key={`action:${action.id}`}
                          style={({ hovered, pressed }) => [
                            styles.row,
                            (hovered || pressed || active) && {
                              backgroundColor: theme.colors.surface1,
                            },
                          ]}
                          onPress={() => handleSelectItem(item)}
                        >
                          <View style={styles.rowContent}>
                            <View style={styles.rowMain}>
                              {actionIcon ? (
                                <View style={styles.iconSlot}>{actionIcon}</View>
                              ) : null}
                              <View style={styles.textContent}>
                                <Text
                                  style={[styles.title, { color: theme.colors.foreground }]}
                                  numberOfLines={1}
                                >
                                  {action.title}
                                </Text>
                              </View>
                            </View>
                            {action.shortcutKeys ? (
                              <Shortcut keys={action.shortcutKeys} style={styles.rowShortcut} />
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })}
                  </>
                ) : null}

                {agentItems.length > 0 ? (
                  <>
                    {actionItems.length > 0 ? (
                      <View
                        style={[styles.sectionDivider, { backgroundColor: theme.colors.border }]}
                      />
                    ) : null}
                    <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>
                      Agents
                    </Text>
                    {agentItems.map((item, index) => {
                      const rowIndex = actionItems.length + index;
                      const active = rowIndex === activeIndex;
                      const agent = item.agent;
                      return (
                        <Pressable
                          key={agentKey(agent)}
                          style={({ hovered, pressed }) => [
                            styles.row,
                            (hovered || pressed || active) && {
                              backgroundColor: theme.colors.surface1,
                            },
                          ]}
                          onPress={() => handleSelectItem(item)}
                        >
                          <View style={styles.rowContent}>
                            <View style={styles.rowMain}>
                              <View style={styles.iconSlot}>
                                <AgentStatusDot
                                  status={agent.status}
                                  requiresAttention={agent.requiresAttention}
                                  showInactive
                                />
                              </View>
                              <View style={styles.textContent}>
                                <Text
                                  style={[styles.title, { color: theme.colors.foreground }]}
                                  numberOfLines={1}
                                >
                                  {agent.title || "New agent"}
                                </Text>
                                <Text
                                  style={[styles.subtitle, { color: theme.colors.foregroundMuted }]}
                                  numberOfLines={1}
                                >
                                  {agent.serverLabel} · {shortenPath(agent.cwd)} · {formatTimeAgo(agent.lastActivityAt)}
                                </Text>
                              </View>
                            </View>
                          </View>
                        </Pressable>
                      );
                    })}
                  </>
                ) : null}
              </>
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
  sectionLabel: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: 0,
    paddingBottom: theme.spacing[2],
    fontSize: theme.fontSize.xs,
  },
  sectionDivider: {
    height: 1,
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  rowContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  iconSlot: {
    width: 16,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  textContent: {
    gap: 2,
  },
  rowShortcut: {
    marginLeft: theme.spacing[2],
    flexShrink: 0,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    fontSize: theme.fontSize.base,
  },
}));
