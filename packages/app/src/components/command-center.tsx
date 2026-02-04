import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { router, usePathname } from "expo-router";
import { useKeyboardNavStore } from "@/stores/keyboard-nav-store";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { useSessionStore } from "@/stores/session-store";
import { AgentStatusDot } from "@/components/agent-status-dot";

function agentKey(agent: Pick<AggregatedAgent, "serverId" | "id">): string {
  return `${agent.serverId}:${agent.id}`;
}

function isMatch(agent: AggregatedAgent, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const title = (agent.title ?? "New agent").toLowerCase();
  const cwd = agent.cwd.toLowerCase();
  const host = agent.serverLabel.toLowerCase();
  return title.includes(q) || cwd.includes(q) || host.includes(q);
}

function sortAgents(left: AggregatedAgent, right: AggregatedAgent): number {
  const leftAttention = left.requiresAttention ? 1 : 0;
  const rightAttention = right.requiresAttention ? 1 : 0;
  if (leftAttention !== rightAttention) return rightAttention - leftAttention;

  const leftRunning = left.status === "running" ? 1 : 0;
  const rightRunning = right.status === "running" ? 1 : 0;
  if (leftRunning !== rightRunning) return rightRunning - leftRunning;

  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

export function CommandCenter() {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const { agents } = useAggregatedAgents();
  const open = useKeyboardNavStore((s) => s.commandCenterOpen);
  const setOpen = useKeyboardNavStore((s) => s.setCommandCenterOpen);
  const requestFocusChatInput = useKeyboardNavStore((s) => s.requestFocusChatInput);
  const takeFocusRestoreElement = useKeyboardNavStore((s) => s.takeFocusRestoreElement);
  const inputRef = useRef<TextInput>(null);
  const didNavigateRef = useRef(false);
  const prevOpenRef = useRef(open);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const filtered = agents.filter((agent) => isMatch(agent, query));
    filtered.sort(sortAgents);
    return filtered;
  }, [agents, query]);

  useEffect(() => {
    const prevOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (!open) {
      setQuery("");
      setActiveIndex(0);

      if (prevOpen && !didNavigateRef.current) {
        const el = takeFocusRestoreElement();
        if (el && el.isConnected) {
          // Modal unmount can steal focus; restore on next tick.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              try {
                el.focus();
              } catch {
                // ignore
              }
            });
          });
        }
      }

      return;
    }

    didNavigateRef.current = false;

    const id = setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex >= results.length) {
      setActiveIndex(results.length > 0 ? results.length - 1 : 0);
    }
  }, [activeIndex, open, results.length]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleSelect = useCallback(
    (agent: AggregatedAgent) => {
      didNavigateRef.current = true;
      const session = useSessionStore.getState().sessions[agent.serverId];
      session?.client?.clearAgentAttention(agent.id);

      const shouldReplace = pathname.startsWith("/agent/");
      const navigate = shouldReplace ? router.replace : router.push;

      requestFocusChatInput(`${agent.serverId}:${agent.id}`);
      // Don't restore focus back to the prior element after we navigate.
      takeFocusRestoreElement();
      setOpen(false);
      navigate(`/agent/${agent.serverId}/${agent.id}` as any);
    },
    [pathname, requestFocusChatInput, setOpen, takeFocusRestoreElement]
  );

  useEffect(() => {
    if (!open) return;

    const handler = (event: KeyboardEvent) => {
      const key = event.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== "Escape") {
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (key === "Enter") {
        if (results.length === 0) return;
        event.preventDefault();
        const index = Math.max(0, Math.min(activeIndex, results.length - 1));
        handleSelect(results[index]!);
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        if (results.length === 0) return;
        event.preventDefault();
        setActiveIndex((current) => {
          const delta = key === "ArrowDown" ? 1 : -1;
          const next = current + delta;
          if (next < 0) return results.length - 1;
          if (next >= results.length) return 0;
          return next;
        });
      }
    };

    // react-native-web can stop propagation on key events, so listen in capture phase.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeIndex, handleClose, handleSelect, open, results]);

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
