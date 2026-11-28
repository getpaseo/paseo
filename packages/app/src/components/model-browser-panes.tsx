import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { FlatList, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AlertTriangle, ChevronDown, ChevronRight, Layers, Plus } from "lucide-react-native";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  AgentProfileGlyph,
  type AgentProfile,
  type AgentProfilePicker,
  type AgentProfilePickerRow,
  type AgentProfileSeed,
} from "@/agent-profiles";
import {
  InlineHeaderView,
  type SheetHeader,
  type SheetKeyboard,
} from "@/components/adaptive-modal-sheet";
import {
  ModelBrowserLoadingState,
  ModelBrowserRow,
  ModelBrowserSectionHeading,
  ModelProviderGlyph,
  ModelRow,
  ModelSearchNoMatches,
  ProviderErrorEmptyState,
} from "@/components/model-browser";
import { focusedModelBrowserControlOwnsEnter } from "@/components/model-browser-focus";
import {
  createModelPickerState,
  projectModelPicker,
  reduceModelPicker,
  resolveModelPickerHeight,
  resolveModelPickerKey,
  resolveModelPickerLayout,
  type ModelPickerAction,
  type ModelPickerInput,
  type ModelPickerListItem,
  type ModelPickerPane,
  type ModelPickerProjection,
  type ModelPickerRailItem,
} from "@/components/model-browser-panes-view";
import { groupProfilesByProviderModel } from "@/components/model-browser-view";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxDesktopPlacement } from "@/components/ui/combobox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useRevealActiveFlatListRow, useRevealActiveItem } from "@/components/ui/scroll-reveal";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import type { KeyboardInputEvent } from "@/keyboard";
import { useCurrentOverlayLayer } from "@/lib/overlay-root";
import type { ModelFoldKind } from "@/provider-selection/model-curation";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const TWO_PANE_WIDTH = 560;
const SINGLE_PANE_WIDTH = 360;
const RAIL_WIDTH = 192;
const PICKER_KEYS = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"] as const;
const NO_OPTIONS: never[] = [];

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLayers = withUnistyles(Layers);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedPlus = withUnistyles(Plus);

const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function noop() {}

type KeyboardHandler = (event: KeyboardInputEvent) => boolean;

export interface ModelPickerActions {
  onSelect: (provider: string, modelId: string) => void;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}

export interface DesktopModelPickerProps extends ModelPickerActions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<View | null>;
  desktopPlacement?: ComboboxDesktopPlacement;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  profiles: AgentProfilePicker | null;
  serverId: string | null;
}

/**
 * The model picker on wide layouts: a rail of Profiles and providers beside the open entry's
 * models, or one list when there is a single provider and no profiles. The popover keeps one size
 * for as long as it is open.
 */
export function DesktopModelPicker({
  open,
  onOpenChange,
  anchorRef,
  desktopPlacement,
  providers,
  selectedProvider,
  selectedModel,
  profiles,
  serverId,
  ...actions
}: DesktopModelPickerProps) {
  const input = useMemo<ModelPickerInput<AgentProfilePickerRow>>(
    () => ({
      providers,
      profiles: profiles?.rows ?? null,
      canCreateProfile: Boolean(actions.onEditProfiles),
      selectedProvider,
      selectedModel,
    }),
    [actions.onEditProfiles, profiles, providers, selectedModel, selectedProvider],
  );
  const layout = resolveModelPickerLayout(input);
  const height = useMemo(() => resolveModelPickerHeight(input), [input]);
  const keyboardHandlerRef = useRef<KeyboardHandler | null>(null);
  const keyboard = useMemo<SheetKeyboard>(
    () => ({
      keys: PICKER_KEYS,
      onKeyDown: (event) => keyboardHandlerRef.current?.(event) ?? false,
    }),
    [],
  );

  return (
    <Combobox
      options={NO_OPTIONS}
      value=""
      onSelect={noop}
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      desktopPlacement={desktopPlacement}
      desktopMinWidth={layout === "twoPane" ? TWO_PANE_WIDTH : SINGLE_PANE_WIDTH}
      desktopLockWidth
      desktopFixedHeight={height}
      desktopChildrenScrollEnabled={false}
      keyboard={keyboard}
    >
      <ModelPickerBody
        input={input}
        serverId={serverId}
        keyboardHandlerRef={keyboardHandlerRef}
        {...actions}
      />
    </Combobox>
  );
}

/** Mounted only while the popover is open, so every open starts from the current selection. */
function ModelPickerBody({
  input,
  serverId,
  keyboardHandlerRef,
  ...actions
}: ModelPickerActions & {
  input: ModelPickerInput<AgentProfilePickerRow>;
  serverId: string | null;
  keyboardHandlerRef: RefObject<KeyboardHandler | null>;
}) {
  const { t } = useTranslation();
  const { onSelect, onApplyProfile, onEditProfiles, onCreateProfile, onEditProfile } = actions;
  const { onRetryProvider, isRetryingProvider } = actions;
  const stableActions = useMemo<ModelPickerActions>(
    () => ({
      onSelect,
      onApplyProfile,
      onEditProfiles,
      onCreateProfile,
      onEditProfile,
      onRetryProvider,
      isRetryingProvider,
    }),
    [
      isRetryingProvider,
      onApplyProfile,
      onCreateProfile,
      onEditProfile,
      onEditProfiles,
      onRetryProvider,
      onSelect,
    ],
  );
  const [state, setState] = useState(() => createModelPickerState(input));
  const [searchResetKey, bumpSearchResetKey] = useReducer((key: number) => key + 1, 0);
  const searchInputRef = useRef<EditingTextInputHandle | null>(null);
  const projection = useMemo(() => projectModelPicker(input, state), [input, state]);

  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
  }, []);
  const dispatch = useCallback((action: ModelPickerAction) => {
    setState((current) => reduceModelPicker(current, action));
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardInputEvent): boolean => {
      const result = resolveModelPickerKey(input, state, {
        event,
        focusedControlOwnsEnter: focusedModelBrowserControlOwnsEnter(),
      });
      if (!result) return false;
      switch (result.kind) {
        case "state":
          if (result.state.query !== state.query) bumpSearchResetKey();
          setState(result.state);
          focusSearch();
          return true;
        case "selectModel":
          actions.onSelect(result.provider, result.modelId);
          return true;
        case "applyProfile":
          if (!actions.onApplyProfile) return false;
          actions.onApplyProfile(result.profileId);
          return true;
        case "createProfile":
          if (!actions.onEditProfiles) return false;
          actions.onEditProfiles();
          return true;
      }
    },
    [actions, focusSearch, input, state],
  );
  const handleKeyDownRef = useRef(handleKeyDown);
  handleKeyDownRef.current = handleKeyDown;
  useEffect(() => {
    keyboardHandlerRef.current = (event) => handleKeyDownRef.current(event);
    return () => {
      keyboardHandlerRef.current = null;
    };
  }, [keyboardHandlerRef]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("modelSelector.models"),
      search: {
        onChange: (query) => dispatch({ kind: "query", query }),
        placeholder:
          input.profiles && input.profiles.length > 0
            ? t("modelSelector.searchModelsAndProfilesPlaceholder")
            : t("modelSelector.searchPlaceholder"),
        autoFocus: true,
        resetKey: searchResetKey,
        inputRef: searchInputRef,
        testID: "model-search-input",
      },
    }),
    [dispatch, input.profiles, searchResetKey, t],
  );

  const handleSelectRail = useCallback(
    (railKey: string) => {
      setState((current) => ({
        ...reduceModelPicker(current, { kind: "selectRail", railKey }),
        focus: "list",
      }));
      focusSearch();
    },
    [focusSearch],
  );
  const handleToggleFold = useCallback(
    (item: Extract<ModelPickerListItem, { kind: "fold" }>) => {
      setState((current) =>
        reduceModelPicker(reduceModelPicker(current, { kind: "activate", key: item.key }), {
          kind: "toggleFold",
          providerId: item.providerId,
          expanded: !item.expanded,
        }),
      );
      focusSearch();
    },
    [focusSearch],
  );
  const handleActivate = useCallback(
    (key: string) => dispatch({ kind: "activate", key }),
    [dispatch],
  );

  const isSearching = projection.pane.kind === "search" || projection.pane.kind === "noMatches";
  let body: ReactNode;
  if (isSearching || projection.layout === "singlePane") {
    body = (
      <ListPane
        projection={projection}
        query={state.query}
        serverId={serverId}
        input={input}
        onToggleFold={handleToggleFold}
        onActivate={handleActivate}
        actions={stableActions}
      />
    );
  } else {
    body = (
      <View style={styles.panes}>
        <Rail projection={projection} serverId={serverId} onSelectRail={handleSelectRail} />
        <ListPane
          projection={projection}
          query={state.query}
          serverId={serverId}
          input={input}
          onToggleFold={handleToggleFold}
          onActivate={handleActivate}
          actions={stableActions}
        />
      </View>
    );
  }

  return (
    <View style={styles.root} testID="model-picker">
      <InlineHeaderView header={header} />
      {body}
    </View>
  );
}

function Rail({
  projection,
  serverId,
  onSelectRail,
}: {
  projection: ModelPickerProjection<AgentProfilePickerRow>;
  serverId: string | null;
  onSelectRail: (railKey: string) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const reveal = useRevealActiveItem({
    activeIndex: projection.rail.findIndex((item) => item.key === projection.railKey),
    listKey: "rail",
    scrollRef,
  });
  return (
    <View style={styles.rail} testID="model-picker-rail">
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.railContent}
        onLayout={reveal.onViewportLayout}
        onScroll={reveal.onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View ref={reveal.contentRef} collapsable={false}>
          {projection.rail.map((item) => (
            <View key={item.key}>
              {item.kind === "provider" && item.startsErrorGroup ? (
                <View style={styles.railDivider} />
              ) : null}
              <RailRow
                item={item}
                serverId={serverId}
                selected={item.key === projection.railKey}
                focused={projection.focus === "rail"}
                activeItemRef={reveal.activeItemRef}
                onActiveLayout={reveal.onItemLayout}
                onSelect={onSelectRail}
              />
              {item.kind === "profiles" ? <View style={styles.railDivider} /> : null}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function RailRow({
  item,
  serverId,
  selected,
  focused,
  activeItemRef,
  onActiveLayout,
  onSelect,
}: {
  item: ModelPickerRailItem;
  serverId: string | null;
  selected: boolean;
  focused: boolean;
  activeItemRef: RefObject<View | null>;
  onActiveLayout: () => void;
  onSelect: (railKey: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(item.key), [item.key, onSelect]);
  const providerId = item.kind === "provider" ? item.providerId : null;
  const leadingSlot = useMemo(
    () =>
      providerId === null ? (
        <ThemedLayers size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      ) : (
        <ModelProviderGlyph provider={providerId} serverId={serverId} size={ICON_SIZE.sm} />
      ),
    [providerId, serverId],
  );
  const trailingSlot = useMemo(() => <RailRowStatus item={item} />, [item]);
  return (
    <ModelBrowserRow
      label={item.kind === "profiles" ? t("modelSelector.profiles") : item.label}
      labelMuted={item.kind === "provider" && item.status === "error"}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
      // The open entry stays highlighted while the list has focus, like a list+detail sidebar.
      active={selected}
      tone={focused ? "elevated" : "default"}
      spacing="provider"
      activeItemRef={activeItemRef}
      onActiveLayout={onActiveLayout}
      onPress={handlePress}
      testID={
        item.kind === "profiles"
          ? "model-picker-rail-profiles"
          : `model-provider-${item.providerId}`
      }
    />
  );
}

function RailRowStatus({ item }: { item: ModelPickerRailItem }) {
  if (item.kind === "provider" && item.status === "loading") {
    return (
      <View style={styles.railSpinner}>
        <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </View>
    );
  }
  if (item.kind === "provider" && item.status === "error") {
    return <ThemedAlertTriangle size={ICON_SIZE.xs} uniProps={foregroundMutedMapping} />;
  }
  return <Text style={styles.count}>{item.count}</Text>;
}

type ListEntry =
  | { kind: "heading"; key: string; title: string }
  | { kind: "item"; key: string; item: ModelPickerListItem<AgentProfilePickerRow> };

/** Search results carry section headings between their groups; every other pane is a flat list. */
function useListEntries(pane: ModelPickerPane<AgentProfilePickerRow>): ListEntry[] {
  const { t } = useTranslation();
  return useMemo(() => {
    const toEntry = (item: ModelPickerListItem<AgentProfilePickerRow>): ListEntry => ({
      kind: "item",
      key: item.key,
      item,
    });
    if (pane.kind !== "search") return pane.items.map(toEntry);
    const entries: ListEntry[] = [];
    if (pane.profiles.length > 0) {
      entries.push({
        kind: "heading",
        key: "heading:profiles",
        title: t("modelSelector.profiles"),
      });
      entries.push(...pane.profiles.map(toEntry));
      if (pane.models.length > 0) {
        entries.push({ kind: "heading", key: "heading:models", title: t("modelSelector.models") });
      }
    }
    entries.push(...pane.models.map(toEntry));
    return entries;
  }, [pane, t]);
}

/** The first row reveals as the list top, so a section heading above it stays in view. */
function resolveRevealTarget(entries: readonly ListEntry[], activeKey: string | null) {
  if (!activeKey) return null;
  const index = entries.findIndex((entry) => entry.key === activeKey);
  const firstItem = entries.findIndex((entry) => entry.kind === "item");
  return index === firstItem ? "top" : index;
}

function getListEntryKey(entry: ListEntry): string {
  return entry.key;
}

function ListPane({
  projection,
  query,
  input,
  serverId,
  onToggleFold,
  onActivate,
  actions,
}: {
  projection: ModelPickerProjection<AgentProfilePickerRow>;
  /** Each query is a new result list, which opens at its top. */
  query: string;
  input: ModelPickerInput<AgentProfilePickerRow>;
  serverId: string | null;
  onToggleFold: (item: Extract<ModelPickerListItem, { kind: "fold" }>) => void;
  onActivate: (key: string) => void;
  actions: ModelPickerActions;
}) {
  const { pane, activeKey } = projection;
  const entries = useListEntries(pane);
  const listRef = useRef<FlatList<ListEntry>>(null);
  const reveal = useRevealActiveFlatListRow({
    listRef,
    itemCount: entries.length,
    activeIndex: resolveRevealTarget(entries, activeKey),
    listKey: `${pane.kind}:${projection.railKey}:${query}`,
  });
  const profiledLookup = useMemo(
    () => groupProfilesByProviderModel(input.profiles ?? []),
    [input.profiles],
  );
  const inSearch = pane.kind === "search";
  const { selectedProvider, selectedModel } = input;

  const renderEntry = useCallback(
    ({ item: entry }: { item: ListEntry }) => {
      if (entry.kind === "heading") return <ModelBrowserSectionHeading title={entry.title} />;
      const { item } = entry;
      return (
        <ModelPickerItemRow
          item={item}
          active={item.key === activeKey}
          selected={
            item.kind === "model" &&
            item.row.provider === selectedProvider &&
            item.row.modelId === selectedModel
          }
          inSearch={inSearch}
          serverId={serverId}
          profiledLookup={profiledLookup}
          onToggleFold={onToggleFold}
          onActivate={onActivate}
          actions={actions}
        />
      );
    },
    [
      actions,
      activeKey,
      inSearch,
      onActivate,
      onToggleFold,
      profiledLookup,
      selectedModel,
      selectedProvider,
      serverId,
    ],
  );

  return (
    <View style={styles.listPane} testID="model-picker-list">
      <ListPaneHeader pane={pane} serverId={serverId} onEditProfiles={actions.onEditProfiles} />
      <PaneState pane={pane} actions={actions} />
      {entries.length > 0 ? (
        <FlatList
          ref={listRef}
          data={entries}
          extraData={activeKey}
          renderItem={renderEntry}
          keyExtractor={getListEntryKey}
          onScrollToIndexFailed={reveal.onScrollToIndexFailed}
          onViewableItemsChanged={reveal.onViewableItemsChanged}
          viewabilityConfig={reveal.viewabilityConfig}
          onContentSizeChange={reveal.onContentSizeChange}
          onLayout={reveal.onLayout}
          style={styles.scroll}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          testID="model-picker-model-list"
        />
      ) : null}
    </View>
  );
}

function ListPaneHeader({
  pane,
  serverId,
  onEditProfiles,
}: {
  pane: ModelPickerPane<AgentProfilePickerRow>;
  serverId: string | null;
  onEditProfiles?: () => void;
}) {
  const { t } = useTranslation();
  if (pane.kind === "search" || pane.kind === "noMatches") return null;
  if (pane.kind === "profiles") {
    return (
      <View style={styles.paneHeader}>
        <Text style={styles.paneTitle} numberOfLines={1}>
          {t("modelSelector.profiles")}
        </Text>
        {onEditProfiles ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={onEditProfiles}
            accessibilityLabel={t("modelSelector.editProfilesLabel")}
            testID="model-profiles-edit"
          >
            {t("modelSelector.editProfiles")}
          </Button>
        ) : null}
      </View>
    );
  }
  const summary =
    pane.kind === "provider" && pane.foldKind !== null
      ? t("modelSelector.shownOfTotal", { shown: pane.shown, total: pane.total })
      : null;
  return (
    <View style={styles.paneHeader}>
      <Text style={styles.paneTitle} numberOfLines={1}>
        {pane.label}
        {summary ? <Text style={styles.paneSummary}>{` · ${summary}`}</Text> : null}
      </Text>
      {serverId ? (
        <CustomizeProviderButton
          serverId={serverId}
          providerId={pane.providerId}
          providerLabel={pane.label}
        />
      ) : null}
    </View>
  );
}

export function CustomizeProviderButton({
  serverId,
  providerId,
  providerLabel,
}: {
  serverId: string;
  providerId: string;
  providerLabel: string;
}) {
  const { t } = useTranslation();
  const overlayParentLayer = useCurrentOverlayLayer();
  const handlePress = useCallback(() => {
    useProviderSettingsStore
      .getState()
      .open({ serverId, provider: providerId, overlayParentLayer });
  }, [overlayParentLayer, providerId, serverId]);
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={handlePress}
      accessibilityLabel={t("modelSelector.openProviderSettings", { provider: providerLabel })}
      testID={`selector-header-settings-${providerId}`}
    >
      {t("modelSelector.customize")}
    </Button>
  );
}

function PaneState({
  pane,
  actions,
}: {
  pane: ModelPickerPane<AgentProfilePickerRow>;
  actions: ModelPickerActions;
}) {
  const { onRetryProvider, isRetryingProvider } = actions;
  if (pane.kind === "providerLoading") return <ModelBrowserLoadingState />;
  if (pane.kind === "providerError") {
    return (
      <ProviderErrorEmptyState
        providerId={pane.providerId}
        message={pane.message}
        onRetryProvider={onRetryProvider}
        isRetryingProvider={isRetryingProvider}
      />
    );
  }
  if (pane.kind === "noMatches") return <ModelSearchNoMatches query={pane.query} />;
  return null;
}

function useFoldTag(tag: ModelFoldKind): string | undefined {
  const { t } = useTranslation();
  if (tag === "older") return t("modelSelector.olderTag");
  if (tag === "all") return t("modelSelector.allModelsTag");
  return undefined;
}

/** One row of a picker list: a model, a fold, a profile, or the create-profile entry. */
export function ModelPickerItemRow({
  item,
  active,
  selected,
  inSearch,
  serverId,
  profiledLookup,
  onToggleFold,
  onActivate,
  actions,
}: {
  item: ModelPickerListItem<AgentProfilePickerRow>;
  active: boolean;
  selected: boolean;
  inSearch: boolean;
  serverId: string | null;
  profiledLookup: Map<string, AgentProfilePickerRow[]>;
  onToggleFold: (item: Extract<ModelPickerListItem, { kind: "fold" }>) => void;
  onActivate: (key: string) => void;
  actions: ModelPickerActions;
}) {
  const { onSelect, onApplyProfile, onEditProfiles, onCreateProfile, onEditProfile } = actions;
  const { t } = useTranslation();
  const tag = useFoldTag(item.kind === "model" ? item.tag : null);
  const leadingSlot = useMemo(() => {
    switch (item.kind) {
      case "profile":
        return (
          <AgentProfileGlyph
            icon={item.profile.icon}
            color={item.profile.color}
            provider={item.profile.provider}
            serverId={serverId}
            size={ICON_SIZE.sm}
          />
        );
      case "createProfile":
        return <ThemedPlus size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />;
      case "fold": {
        const Chevron = item.expanded ? ThemedChevronDown : ThemedChevronRight;
        return <Chevron size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />;
      }
      case "model":
        return null;
    }
  }, [item, serverId]);
  const handleFocus = useCallback(() => onActivate(item.key), [item.key, onActivate]);
  const handlePress = useCallback(() => {
    switch (item.kind) {
      case "model":
        onSelect(item.row.provider, item.row.modelId);
        return;
      case "profile":
        onApplyProfile?.(item.profile.id);
        return;
      case "createProfile":
        onEditProfiles?.();
        return;
      case "fold":
        onToggleFold(item);
    }
  }, [item, onApplyProfile, onEditProfiles, onSelect, onToggleFold]);

  if (item.kind === "model") {
    return (
      <ModelRow
        row={item.row}
        serverId={serverId}
        isSelected={selected}
        isActive={active}
        showProviderLabel={inSearch}
        tag={tag}
        onPress={handlePress}
        onFocus={handleFocus}
        profiledRows={profiledLookup.get(`${item.row.provider}:${item.row.modelId}`) ?? []}
        onCreateProfile={onCreateProfile}
        onEditProfile={onEditProfile}
        onEditProfiles={onEditProfiles}
      />
    );
  }
  if (item.kind === "profile") {
    return (
      <ModelBrowserRow
        label={item.profile.name}
        description={item.profile.summary}
        active={active}
        onPress={handlePress}
        onFocus={handleFocus}
        leadingSlot={leadingSlot}
        testID={`model-profile-row-${item.profile.id}`}
      />
    );
  }
  if (item.kind === "createProfile") {
    return (
      <ModelBrowserRow
        label={t("modelSelector.createProfile")}
        labelMuted
        active={active}
        onPress={handlePress}
        onFocus={handleFocus}
        leadingSlot={leadingSlot}
        testID="model-profiles-empty"
      />
    );
  }
  return (
    <ModelBrowserRow
      label={t(
        item.foldKind === "older" ? "modelSelector.olderModels" : "modelSelector.allModels",
        {
          count: item.count,
        },
      )}
      labelMuted
      active={active}
      onPress={handlePress}
      onFocus={handleFocus}
      leadingSlot={leadingSlot}
      testID={`model-fold-${item.providerId}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
  },
  panes: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  rail: {
    width: RAIL_WIDTH,
    flexShrink: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  railContent: {
    paddingVertical: theme.spacing[1],
  },
  railDivider: {
    height: 1,
    marginVertical: theme.spacing[1],
    marginHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.border,
  },
  railSpinner: {
    transform: [{ scale: 0.7 }],
  },
  count: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  listPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
  },
  listContent: {
    paddingBottom: theme.spacing[2],
  },
  paneHeader: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
  },
  paneTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  paneSummary: {
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
}));
