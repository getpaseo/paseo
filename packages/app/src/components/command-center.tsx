import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Plus, Settings } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useCommandCenter } from "@/hooks/use-command-center";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { Shortcut } from "@/components/ui/shortcut";
import { isNative } from "@/constants/platform";

function agentKey(agent: Pick<AggregatedAgent, "serverId" | "id">): string {
  return `${agent.serverId}:${agent.id}`;
}

interface CommandCenterRowProps {
  active: boolean;
  children: ReactNode;
  onPress: () => void;
  registerRow: (el: View | null) => void;
}

const CommandCenterRow = memo(function CommandCenterRow({
  active,
  children,
  onPress,
  registerRow,
}: CommandCenterRowProps) {
  const { theme } = useUnistyles();

  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || pressed || active) && {
        backgroundColor: theme.colors.surface1,
      },
    ],
    [active, theme.colors.surface1],
  );

  return (
    <Pressable ref={registerRow} style={pressableStyle} onPress={onPress}>
      {children}
    </Pressable>
  );
});

interface CommandCenterRowContainerProps {
  rowIndex: number;
  active: boolean;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onPress: () => void;
  children: ReactNode;
}

function CommandCenterRowContainer({
  rowIndex,
  active,
  rowRefs,
  onPress,
  children,
}: CommandCenterRowContainerProps) {
  const registerRow = useCallback(
    (el: View | null) => {
      if (el) rowRefs.current.set(rowIndex, el);
      else rowRefs.current.delete(rowIndex);
    },
    [rowRefs, rowIndex],
  );
  return (
    <CommandCenterRow active={active} registerRow={registerRow} onPress={onPress}>
      {children}
    </CommandCenterRow>
  );
}

interface CommandCenterActionRowProps {
  item: Extract<ReturnType<typeof useCommandCenter>["items"][number], { kind: "action" }>;
  rowIndex: number;
  active: boolean;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onSelect: (item: ReturnType<typeof useCommandCenter>["items"][number]) => void;
}

function CommandCenterActionRow({
  item,
  rowIndex,
  active,
  rowRefs,
  onSelect,
}: CommandCenterActionRowProps) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => onSelect(item), [onSelect, item]);
  const action = item.action;
  let actionIcon: React.ReactNode = null;
  if (action.icon === "plus") {
    actionIcon = <Plus size={16} strokeWidth={2.4} color={theme.colors.foregroundMuted} />;
  } else if (action.icon === "settings") {
    actionIcon = <Settings size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />;
  }
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  return (
    <CommandCenterRowContainer
      rowIndex={rowIndex}
      active={active}
      rowRefs={rowRefs}
      onPress={handlePress}
    >
      <View style={styles.rowContent}>
        <View style={styles.rowMain}>
          {actionIcon ? <View style={styles.iconSlot}>{actionIcon}</View> : null}
          <View style={styles.textContent}>
            <Text style={titleStyle} numberOfLines={1}>
              {action.title}
            </Text>
          </View>
        </View>
        {action.shortcutKeys ? (
          <Shortcut chord={action.shortcutKeys} style={styles.rowShortcut} />
        ) : null}
      </View>
    </CommandCenterRowContainer>
  );
}

interface CommandCenterAgentRowProps {
  item: Extract<ReturnType<typeof useCommandCenter>["items"][number], { kind: "agent" }>;
  rowIndex: number;
  active: boolean;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onSelect: (item: ReturnType<typeof useCommandCenter>["items"][number]) => void;
  children: ReactNode;
}

function CommandCenterAgentRow({
  rowIndex,
  active,
  rowRefs,
  onSelect,
  item,
  children,
}: CommandCenterAgentRowProps) {
  const handlePress = useCallback(() => onSelect(item), [onSelect, item]);
  return (
    <CommandCenterRowContainer
      rowIndex={rowIndex}
      active={active}
      rowRefs={rowRefs}
      onPress={handlePress}
    >
      {children}
    </CommandCenterRowContainer>
  );
}

interface CommandCenterAgentRowContentProps {
  agent: AggregatedAgent;
}

function CommandCenterAgentRowContent({ agent }: CommandCenterAgentRowContentProps) {
  const { theme } = useUnistyles();
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const subtitleStyle = useMemo(
    () => [styles.subtitle, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  return (
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
          <Text style={titleStyle} numberOfLines={1}>
            {agent.title || "New agent"}
          </Text>
          <Text style={subtitleStyle} numberOfLines={1}>
            {shortenPath(agent.cwd)} · {formatTimeAgo(agent.lastActivityAt)}
          </Text>
        </View>
      </View>
    </View>
  );
}

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

  const actionItems = items.filter((item) => item.kind === "action");
  const agentItems = items.filter((item) => item.kind === "agent");

  const panelStyle = useMemo(
    () => [
      styles.panel,
      { borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 },
    ],
    [theme.colors.border, theme.colors.surface0],
  );
  const headerStyle = useMemo(
    () => [styles.header, { borderBottomColor: theme.colors.border }],
    [theme.colors.border],
  );
  const inputStyle = useMemo(
    () => [styles.input, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const emptyTextStyle = useMemo(
    () => [styles.emptyText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const sectionLabelStyle = useMemo(
    () => [styles.sectionLabel, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const sectionDividerStyle = useMemo(
    () => [styles.sectionDivider, { backgroundColor: theme.colors.border }],
    [theme.colors.border],
  );

  if (isNative || !open) return null;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />

        <View testID="command-center-panel" style={panelStyle}>
          <View style={headerStyle}>
            <TextInput
              testID="command-center-input"
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Type a command or search agents..."
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle}
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
              <Text style={emptyTextStyle}>No matches</Text>
            ) : (
              <>
                {actionItems.length > 0 ? (
                  <>
                    <Text style={sectionLabelStyle}>Actions</Text>
                    {actionItems.map((item, index) => (
                      <CommandCenterActionRow
                        key={`action:${item.action.id}`}
                        item={item}
                        rowIndex={index}
                        active={index === activeIndex}
                        rowRefs={rowRefs}
                        onSelect={handleSelectItem}
                      />
                    ))}
                  </>
                ) : null}

                {agentItems.length > 0 ? (
                  <>
                    {actionItems.length > 0 ? <View style={sectionDividerStyle} /> : null}
                    <Text style={sectionLabelStyle}>Agents</Text>
                    {agentItems.map((item, index) => {
                      const rowIndex = actionItems.length + index;
                      const agent = item.agent;
                      return (
                        <CommandCenterAgentRow
                          key={agentKey(agent)}
                          item={item}
                          rowIndex={rowIndex}
                          active={rowIndex === activeIndex}
                          rowRefs={rowRefs}
                          onSelect={handleSelectItem}
                        >
                          <CommandCenterAgentRowContent agent={agent} />
                        </CommandCenterAgentRow>
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
