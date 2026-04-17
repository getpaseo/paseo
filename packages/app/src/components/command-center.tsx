import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { memo, useEffect, useRef, type ReactNode } from "react";
import { Plus, Settings } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useCommandCenter } from "@/hooks/use-command-center";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { Shortcut } from "@/components/ui/shortcut";
import { isNative } from "@/constants/platform";
import { getFileIconSvg } from "@/components/material-file-icons";
import { SvgXml } from "react-native-svg";

function agentKey(agent: Pick<AggregatedAgent, "serverId" | "id">): string {
  return `${agent.serverId}:${agent.id}`;
}

type CommandCenterRowProps = {
  active: boolean;
  children: ReactNode;
  onPress: () => void;
  registerRow: (el: View | null) => void;
};

const CommandCenterRow = memo(function CommandCenterRow({
  active,
  children,
  onPress,
  registerRow,
}: CommandCenterRowProps) {
  const { theme } = useUnistyles();

  return (
    <Pressable
      ref={registerRow}
      style={({ hovered, pressed }) => [
        styles.row,
        (hovered || pressed || active) && {
          backgroundColor: theme.colors.surface1,
        },
      ]}
      onPress={onPress}
    >
      {children}
    </Pressable>
  );
});

export function CommandCenter() {
  const { theme } = useUnistyles();
  const { open, inputRef, query, setQuery, activeIndex, items, handleClose, handleSelectItem } =
    useCommandCenter();

  const rowRefs = useRef<Map<number, View>>(new Map());
  const resultsRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const row = rowRefs.current.get(activeIndex);
    if (!row || typeof document === "undefined") {
      return;
    }
    const scrollNode =
      (
        resultsRef.current as
          | (ScrollView & {
              getScrollableNode?: () => HTMLElement | null;
            })
          | null
      )?.getScrollableNode?.() ?? null;
    const rowEl = row as unknown as HTMLElement;

    if (!scrollNode) {
      rowEl.scrollIntoView?.({ block: "nearest" });
      return;
    }

    const rowTop = rowEl.offsetTop;
    const rowBottom = rowTop + rowEl.offsetHeight;
    const visibleTop = scrollNode.scrollTop;
    const visibleBottom = visibleTop + scrollNode.clientHeight;

    if (rowTop < visibleTop) {
      scrollNode.scrollTop = rowTop;
      return;
    }

    if (rowBottom > visibleBottom) {
      scrollNode.scrollTop = rowBottom - scrollNode.clientHeight;
    }
  }, [activeIndex, open]);

  if (isNative || !open) return null;

  const actionItems = items.filter((item) => item.kind === "action");
  const fileItems = items.filter((item) => item.kind === "file");
  const agentItems = items.filter((item) => item.kind === "agent");

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />

        <View
          testID="command-center-panel"
          style={[
            styles.panel,
            { borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
            <TextInput
              testID="command-center-input"
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Type a command or search agents and files..."
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[styles.input, { color: theme.colors.foreground }]}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
          </View>

          <ScrollView
            ref={resultsRef}
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
                          <Plus size={16} strokeWidth={2.4} color={theme.colors.foregroundMuted} />
                        ) : action.icon === "settings" ? (
                          <Settings
                            size={16}
                            strokeWidth={2.2}
                            color={theme.colors.foregroundMuted}
                          />
                        ) : null;
                      return (
                        <CommandCenterRow
                          key={`action:${action.id}`}
                          registerRow={(el: View | null) => {
                            if (el) rowRefs.current.set(index, el);
                            else rowRefs.current.delete(index);
                          }}
                          active={active}
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
                              <Shortcut chord={action.shortcutKeys} style={styles.rowShortcut} />
                            ) : null}
                          </View>
                        </CommandCenterRow>
                      );
                    })}
                  </>
                ) : null}

                {fileItems.length > 0 ? (
                  <>
                    {actionItems.length > 0 ? (
                      <View
                        style={[styles.sectionDivider, { backgroundColor: theme.colors.border }]}
                      />
                    ) : null}
                    <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>
                      Files
                    </Text>
                    {fileItems.map((item, index) => {
                      const rowIndex = actionItems.length + index;
                      const active = rowIndex === activeIndex;
                      const iconSvg = getFileIconSvg(item.file.name);
                      return (
                        <CommandCenterRow
                          key={`file:${item.file.workspaceId}:${item.file.path}`}
                          registerRow={(el: View | null) => {
                            if (el) rowRefs.current.set(rowIndex, el);
                            else rowRefs.current.delete(rowIndex);
                          }}
                          active={active}
                          onPress={() => handleSelectItem(item)}
                        >
                          <View style={styles.rowContent}>
                            <View style={styles.rowMain}>
                              <View style={styles.iconSlot}>
                                <SvgXml
                                  xml={iconSvg}
                                  width={16}
                                  height={16}
                                  color={theme.colors.foregroundMuted}
                                />
                              </View>
                              <View style={styles.textContent}>
                                <Text
                                  style={[styles.title, { color: theme.colors.foreground }]}
                                  numberOfLines={1}
                                >
                                  {item.file.name}
                                </Text>
                                <Text
                                  style={[styles.subtitle, { color: theme.colors.foregroundMuted }]}
                                  numberOfLines={1}
                                >
                                  {item.file.directory === "."
                                    ? "Workspace root"
                                    : item.file.directory}
                                </Text>
                              </View>
                            </View>
                          </View>
                        </CommandCenterRow>
                      );
                    })}
                  </>
                ) : null}

                {agentItems.length > 0 ? (
                  <>
                    {actionItems.length > 0 || fileItems.length > 0 ? (
                      <View
                        style={[styles.sectionDivider, { backgroundColor: theme.colors.border }]}
                      />
                    ) : null}
                    <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>
                      Agents
                    </Text>
                    {agentItems.map((item, index) => {
                      const rowIndex = actionItems.length + fileItems.length + index;
                      const active = rowIndex === activeIndex;
                      const agent = item.agent;
                      return (
                        <CommandCenterRow
                          key={agentKey(agent)}
                          registerRow={(el: View | null) => {
                            if (el) rowRefs.current.set(rowIndex, el);
                            else rowRefs.current.delete(rowIndex);
                          }}
                          active={active}
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
                                  {shortenPath(agent.cwd)} · {formatTimeAgo(agent.lastActivityAt)}
                                </Text>
                              </View>
                            </View>
                          </View>
                        </CommandCenterRow>
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
    ...theme.shadow.lg,
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
    flex: 1,
    minWidth: 0,
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
