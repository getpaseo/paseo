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
import { useTranslation } from "react-i18next";
import { Home, Plus, Settings } from "lucide-react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useCommandCenter } from "@/hooks/use-command-center";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useHosts } from "@/runtime/host-runtime";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { Shortcut } from "@/components/ui/shortcut";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from "@gorhom/bottom-sheet";

function agentKey(agent: Pick<AggregatedAgent, "serverId" | "id">): string {
  return `${agent.serverId}:${agent.id}`;
}

const ThemedBottomSheetTextInput = withUnistyles(BottomSheetTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

interface CommandCenterRowProps {
  active: boolean;
  children: ReactNode;
  onPress: () => void;
  registerRow: (el: View | null) => void;
  onLayout?: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
}

const CommandCenterRow = memo(function CommandCenterRow({
  active,
  children,
  onPress,
  registerRow,
  onLayout,
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
    <Pressable ref={registerRow} style={pressableStyle} onPress={onPress} onLayout={onLayout}>
      {children}
    </Pressable>
  );
});

interface CommandCenterRowContainerProps {
  rowIndex: number;
  active: boolean;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onPress: () => void;
  onLayout?: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  children: ReactNode;
}

function CommandCenterRowContainer({
  rowIndex,
  active,
  rowRefs,
  onPress,
  onLayout,
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
    <CommandCenterRow
      active={active}
      registerRow={registerRow}
      onPress={onPress}
      onLayout={onLayout}
    >
      {children}
    </CommandCenterRow>
  );
}

interface CommandCenterActionRowProps {
  item: Extract<ReturnType<typeof useCommandCenter>["items"][number], { kind: "action" }>;
  rowIndex: number;
  active: boolean;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onLayout?: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  onSelect: (item: ReturnType<typeof useCommandCenter>["items"][number]) => void;
}

function CommandCenterActionRow({
  item,
  rowIndex,
  active,
  rowRefs,
  onLayout,
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
  } else if (action.icon === "home") {
    actionIcon = <Home size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />;
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
      onLayout={onLayout}
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
  onLayout?: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  onSelect: (item: ReturnType<typeof useCommandCenter>["items"][number]) => void;
  children: ReactNode;
}

function CommandCenterAgentRow({
  rowIndex,
  active,
  rowRefs,
  onLayout,
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
      onLayout={onLayout}
    >
      {children}
    </CommandCenterRowContainer>
  );
}

interface CommandCenterAgentRowContentProps {
  agent: AggregatedAgent;
  showHost: boolean;
}

function CommandCenterAgentRowContent({ agent, showHost }: CommandCenterAgentRowContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const subtitleStyle = useMemo(
    () => [styles.subtitle, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  return (
    <View style={styles.rowContent} testID={`command-center-agent-${agent.serverId}:${agent.id}`}>
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
            {agent.title || t("shell.commandCenter.newAgent")}
          </Text>
          <Text style={subtitleStyle} numberOfLines={1} testID="command-center-agent-subtitle">
            {showHost ? `${agent.serverLabel} · ` : ""}
            {shortenPath(agent.cwd)} · {formatTimeAgo(agent.lastActivityAt)}
          </Text>
        </View>
      </View>
    </View>
  );
}

interface AgentItemsSectionProps {
  agentItems: Extract<ReturnType<typeof useCommandCenter>["items"][number], { kind: "agent" }>[];
  actionItemsLength: number;
  activeIndex: number;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onRowLayout: (
    rowIndex: number,
  ) => (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  onSelect: (item: ReturnType<typeof useCommandCenter>["items"][number]) => void;
  sectionDividerStyle: React.ComponentProps<typeof View>["style"];
  sectionLabelStyle: React.ComponentProps<typeof Text>["style"];
  showHost: boolean;
}

function AgentItemsSection({
  agentItems,
  actionItemsLength,
  activeIndex,
  rowRefs,
  onRowLayout,
  onSelect,
  sectionDividerStyle,
  sectionLabelStyle,
  showHost,
}: AgentItemsSectionProps) {
  const { t } = useTranslation();

  return (
    <>
      {actionItemsLength > 0 ? <View style={sectionDividerStyle} /> : null}
      <Text style={sectionLabelStyle}>{t("shell.commandCenter.agents")}</Text>
      {agentItems.map((item, index) => {
        const rowIndex = actionItemsLength + index;
        const agent = item.agent;
        return (
          <CommandCenterAgentRow
            key={agentKey(agent)}
            item={item}
            rowIndex={rowIndex}
            active={rowIndex === activeIndex}
            rowRefs={rowRefs}
            onLayout={onRowLayout(rowIndex)}
            onSelect={onSelect}
          >
            <CommandCenterAgentRowContent agent={agent} showHost={showHost} />
          </CommandCenterAgentRow>
        );
      })}
    </>
  );
}

export function CommandCenter() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const {
    open,
    inputRef,
    query,
    setQuery,
    activeIndex,
    items,
    handleClose,
    handleSelectItem,
    handleKeyEvent,
  } = useCommandCenter();

  const isCompact = useIsCompactFormFactor();
  const showBottomSheet = isCompact && isNative;
  // Host names only earn their space once results can span more than one host.
  const showHost = useHosts().length > 1;

  const rowRefs = useRef<Map<number, View>>(new Map());
  const rowLayouts = useRef<Map<number, { y: number; height: number }>>(new Map());
  const resultsRef = useRef<ScrollView>(null);
  const nativeScrollY = useRef(0);
  const nativeViewHeight = useRef(0);
  // BottomSheetTextInput wraps a different TextInput type (from react-native-gesture-handler).
  // Use a loose ref to avoid the type mismatch — same pattern as AdaptiveTextInput.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bottomSheetInputRef = useRef<any>(null);

  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible: open,
    isEnabled: showBottomSheet,
    onClose: handleClose,
  });

  // Focus the bottom sheet input when the sheet opens on mobile
  useEffect(() => {
    if (showBottomSheet && open) {
      const id = setTimeout(() => bottomSheetInputRef.current?.focus(), 300);
      return () => clearTimeout(id);
    }
  }, [showBottomSheet, open]);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.45} />
    ),
    [],
  );

  // Scroll active row into view
  useEffect(() => {
    if (!open) return;

    if (isWeb) {
      const row = rowRefs.current.get(activeIndex);
      if (!row || typeof document === "undefined") return;
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
      return;
    }

    // Native: use onLayout-measured positions
    const layout = rowLayouts.current.get(activeIndex);
    if (!layout || !resultsRef.current) return;

    const rowTop = layout.y;
    const rowBottom = rowTop + layout.height;
    const visibleTop = nativeScrollY.current;
    const visibleBottom = visibleTop + nativeViewHeight.current;

    if (rowTop < visibleTop) {
      resultsRef.current.scrollTo?.({ y: rowTop, animated: true });
    } else if (rowBottom > visibleBottom) {
      resultsRef.current.scrollTo?.({
        y: rowBottom - nativeViewHeight.current,
        animated: true,
      });
    }
  }, [activeIndex, open]);

  const handleRowLayout = useCallback(
    (rowIndex: number) => (event: { nativeEvent: { layout: { y: number; height: number } } }) => {
      rowLayouts.current.set(rowIndex, {
        y: event.nativeEvent.layout.y,
        height: event.nativeEvent.layout.height,
      });
    },
    [],
  );

  const actionItems = useMemo(() => items.filter((item) => item.kind === "action"), [items]);
  const agentItems = useMemo(() => items.filter((item) => item.kind === "agent"), [items]);

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

  const handleKeyPress = useCallback(
    ({ nativeEvent: { key } }: { nativeEvent: { key: string } }) => {
      handleKeyEvent(key);
    },
    [handleKeyEvent],
  );

  const handleSubmitEditing = useCallback(() => {
    handleKeyEvent("Enter");
  }, [handleKeyEvent]);

  const snapPoints = useMemo(() => ["60%", "90%"], []);

  const resultList =
    items.length === 0 ? (
      <Text style={emptyTextStyle}>{t("shell.commandCenter.noMatches")}</Text>
    ) : (
      <>
        {actionItems.length > 0 ? (
          <>
            <Text style={sectionLabelStyle}>{t("shell.commandCenter.actions")}</Text>
            {actionItems.map((item, index) => (
              <CommandCenterActionRow
                key={`action:${item.action.id}`}
                item={item}
                rowIndex={index}
                active={index === activeIndex}
                rowRefs={rowRefs}
                onLayout={handleRowLayout(index)}
                onSelect={handleSelectItem}
              />
            ))}
          </>
        ) : null}

        {agentItems.length > 0 ? (
          <AgentItemsSection
            agentItems={agentItems}
            actionItemsLength={actionItems.length}
            activeIndex={activeIndex}
            rowRefs={rowRefs}
            onRowLayout={handleRowLayout}
            onSelect={handleSelectItem}
            sectionDividerStyle={sectionDividerStyle}
            sectionLabelStyle={sectionLabelStyle}
            showHost={showHost}
          />
        ) : null}
      </>
    );

  // Mobile: bottom sheet
  if (showBottomSheet) {
    return (
      <IsolatedBottomSheetModal
        ref={sheetRef}
        snapPoints={snapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        onDismiss={handleSheetDismiss}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        accessible={false}
      >
        <View style={styles.bottomSheetHeader}>
          <ThemedBottomSheetTextInput
            testID="command-center-input"
            ref={bottomSheetInputRef as unknown as React.Ref<never>}
            value={query}
            onChangeText={setQuery}
            onKeyPress={handleKeyPress}
            onSubmitEditing={handleSubmitEditing}
            placeholder={t("shell.commandCenter.placeholder")}
            style={inputStyle}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
        </View>
        <BottomSheetScrollView
          contentContainerStyle={styles.resultsContent}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
        >
          {resultList}
        </BottomSheetScrollView>
      </IsolatedBottomSheetModal>
    );
  }

  if (!open) return null;

  // Desktop web: centered overlay panel
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
              placeholder={t("shell.commandCenter.placeholder")}
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
            {resultList}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  bottomSheetHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
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
  } as object,
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
