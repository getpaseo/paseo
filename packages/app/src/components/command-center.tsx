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
import { Folder, Home, Plus, Settings } from "lucide-react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import {
  useCommandCenter,
  type CommandCenterActionItem,
  type CommandCenterAgentItem,
  type CommandCenterItem,
  type CommandCenterWorkspaceItem,
} from "@/hooks/use-command-center";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { Shortcut } from "@/components/ui/shortcut";
import { isNative, isWeb } from "@/constants/platform";
import { AddProjectFlow } from "@/components/add-project-flow";
import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";
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

const ThemedBottomSheetTextInput = withUnistyles(BottomSheetTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ThemedFolder = withUnistyles(Folder, (theme) => ({
  color: theme.colors.foregroundMuted,
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
  item: CommandCenterItem;
  rowIndex: number;
  active: boolean;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onSelect: (item: CommandCenterItem) => void;
  onLayout?: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  children: ReactNode;
}

function CommandCenterRowContainer({
  item,
  rowIndex,
  active,
  rowRefs,
  onSelect,
  onLayout,
  children,
}: CommandCenterRowContainerProps) {
  const handlePress = useCallback(() => onSelect(item), [onSelect, item]);
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
      onPress={handlePress}
      onLayout={onLayout}
    >
      {children}
    </CommandCenterRow>
  );
}

interface CommandCenterActionRowProps {
  item: CommandCenterActionItem;
  rowIndex: number;
  active: boolean;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onLayout?: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  onSelect: (item: CommandCenterItem) => void;
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
  let actionIcon: React.ReactNode = null;
  if (item.icon === "plus") {
    actionIcon = <Plus size={16} strokeWidth={2.4} color={theme.colors.foregroundMuted} />;
  } else if (item.icon === "settings") {
    actionIcon = <Settings size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />;
  } else if (item.icon === "home") {
    actionIcon = <Home size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />;
  }
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  return (
    <CommandCenterRowContainer
      item={item}
      rowIndex={rowIndex}
      active={active}
      rowRefs={rowRefs}
      onSelect={onSelect}
      onLayout={onLayout}
    >
      <View style={styles.rowContent}>
        <View style={styles.rowMain}>
          {actionIcon ? <View style={styles.iconSlot}>{actionIcon}</View> : null}
          <View style={styles.textContent}>
            <Text style={titleStyle} numberOfLines={1}>
              {item.title}
            </Text>
          </View>
        </View>
        {item.shortcutKeys ? (
          <Shortcut chord={item.shortcutKeys} style={styles.rowShortcut} />
        ) : null}
      </View>
    </CommandCenterRowContainer>
  );
}

interface CommandCenterAgentRowContentProps {
  item: CommandCenterAgentItem;
}

function CommandCenterAgentRowContent({ item }: CommandCenterAgentRowContentProps) {
  const { theme } = useUnistyles();
  const agent = item.agent;
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
            {item.title}
          </Text>
          <Text style={subtitleStyle} numberOfLines={1} testID="command-center-agent-subtitle">
            {item.subtitle}
          </Text>
        </View>
      </View>
    </View>
  );
}

interface AgentItemsSectionProps {
  agentItems: CommandCenterAgentItem[];
  startIndex: number;
  activeIndex: number;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onRowLayout: (
    rowIndex: number,
  ) => (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  onSelect: (item: CommandCenterItem) => void;
  sectionDividerStyle: React.ComponentProps<typeof View>["style"];
  sectionLabelStyle: React.ComponentProps<typeof Text>["style"];
}

function AgentItemsSection({
  agentItems,
  startIndex,
  activeIndex,
  rowRefs,
  onRowLayout,
  onSelect,
  sectionDividerStyle,
  sectionLabelStyle,
}: AgentItemsSectionProps) {
  const { t } = useTranslation();

  return (
    <>
      {startIndex > 0 ? <View style={sectionDividerStyle} /> : null}
      <Text style={sectionLabelStyle}>{t("shell.commandCenter.agents")}</Text>
      {agentItems.map((item, index) => {
        const rowIndex = startIndex + index;
        const agent = item.agent;
        return (
          <CommandCenterRowContainer
            key={`${agent.serverId}:${agent.id}`}
            item={item}
            rowIndex={rowIndex}
            active={rowIndex === activeIndex}
            rowRefs={rowRefs}
            onLayout={onRowLayout(rowIndex)}
            onSelect={onSelect}
          >
            <CommandCenterAgentRowContent item={item} />
          </CommandCenterRowContainer>
        );
      })}
    </>
  );
}

interface WorkspaceItemsSectionProps {
  workspaceItems: CommandCenterWorkspaceItem[];
  startIndex: number;
  activeIndex: number;
  rowRefs: React.MutableRefObject<Map<number, View>>;
  onRowLayout: (
    rowIndex: number,
  ) => (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  onSelect: (item: CommandCenterItem) => void;
  sectionDividerStyle: React.ComponentProps<typeof View>["style"];
  sectionLabelStyle: React.ComponentProps<typeof Text>["style"];
}

function WorkspaceItemsSection({
  workspaceItems,
  startIndex,
  activeIndex,
  rowRefs,
  onRowLayout,
  onSelect,
  sectionDividerStyle,
  sectionLabelStyle,
}: WorkspaceItemsSectionProps) {
  const { t } = useTranslation();

  return (
    <>
      {startIndex > 0 ? <View style={sectionDividerStyle} /> : null}
      <Text style={sectionLabelStyle}>{t("shell.commandCenter.workspaces")}</Text>
      {workspaceItems.map((item, index) => {
        const rowIndex = startIndex + index;
        return (
          <CommandCenterRowContainer
            key={`${item.serverId}:${item.workspaceId}`}
            item={item}
            rowIndex={rowIndex}
            active={rowIndex === activeIndex}
            rowRefs={rowRefs}
            onSelect={onSelect}
            onLayout={onRowLayout(rowIndex)}
          >
            <View
              style={styles.rowContent}
              testID={`command-center-workspace-${item.serverId}:${item.workspaceId}`}
            >
              <View style={styles.rowMain}>
                <View style={styles.iconSlot}>
                  <ThemedFolder size={16} strokeWidth={2.2} />
                </View>
                <View style={styles.textContent}>
                  <Text style={styles.title} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {item.subtitle}
                  </Text>
                </View>
              </View>
            </View>
          </CommandCenterRowContainer>
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
  const addProjectRequest = useAddProjectFlowStore((state) => state.request);

  const isCompact = useIsCompactFormFactor();
  const showBottomSheet = isCompact && isNative;
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
  const workspaceItems = useMemo(() => items.filter((item) => item.kind === "workspace"), [items]);
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
  const sheetBackgroundStyle = useMemo(
    () => ({ backgroundColor: theme.colors.surface0 }),
    [theme.colors.surface0],
  );
  const sheetHandleStyle = useMemo(
    () => ({ backgroundColor: theme.colors.palette.zinc[600] }),
    [theme.colors.palette.zinc],
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

  if (open && addProjectRequest) {
    return (
      <AddProjectFlow
        key={addProjectRequest.id}
        request={addProjectRequest}
        onClose={handleClose}
      />
    );
  }

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
                key={`action:${item.id}`}
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

        {workspaceItems.length > 0 ? (
          <WorkspaceItemsSection
            workspaceItems={workspaceItems}
            startIndex={actionItems.length}
            activeIndex={activeIndex}
            rowRefs={rowRefs}
            onRowLayout={handleRowLayout}
            onSelect={handleSelectItem}
            sectionDividerStyle={sectionDividerStyle}
            sectionLabelStyle={sectionLabelStyle}
          />
        ) : null}

        {agentItems.length > 0 ? (
          <AgentItemsSection
            agentItems={agentItems}
            startIndex={actionItems.length + workspaceItems.length}
            activeIndex={activeIndex}
            rowRefs={rowRefs}
            onRowLayout={handleRowLayout}
            onSelect={handleSelectItem}
            sectionDividerStyle={sectionDividerStyle}
            sectionLabelStyle={sectionLabelStyle}
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
        backgroundStyle={sheetBackgroundStyle}
        handleIndicatorStyle={sheetHandleStyle}
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
    fontSize: theme.fontSize.base,
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
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    fontSize: theme.fontSize.base,
  },
}));
