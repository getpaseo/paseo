import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AlertTriangle, ChevronDown } from "lucide-react-native";
import type { AgentProfilePickerRow } from "@/agent-profiles";
import {
  IndependentScrollBoundary,
  ModelBrowserLoadingState,
  ModelBrowserNoProviders,
  ModelBrowserRow,
  ModelProviderGlyph,
  ModelSearchNoMatches,
  ProviderErrorEmptyState,
} from "@/components/model-browser";
import {
  CustomizeProviderButton,
  ModelPickerItemRow,
  type ModelPickerActions,
} from "@/components/model-browser-panes";
import type { ModelPickerListItem } from "@/components/model-browser-panes-view";
import { groupProfilesByProviderModel } from "@/components/model-browser-view";
import {
  createMobileModelPageState,
  projectMobileModelPage,
  reduceMobileModelPage,
  type MobileModelBody,
  type MobileModelPageAction,
  type MobileModelPageInput,
  type MobileModelPageProjection,
  type MobileProviderSection,
} from "@/components/mobile-model-page-view";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  FlatList as SheetFlatList,
  ScrollView as SheetScrollView,
} from "@/components/ui/scroll-view";
import { SettingsCard } from "@/components/settings";
import { SearchField } from "@/components/ui/search-field";
import { useRevealActiveFlatListRow } from "@/components/ui/scroll-reveal";
import { isNative } from "@/constants/platform";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";

/**
 * The open provider lists its models in a box of one fixed height, about five rows, that scrolls
 * on its own. Opening another provider, unfolding older models or loading never moves the
 * providers below it, so they stay where the thumb left them.
 */
export const MOBILE_EXPANDED_PROVIDER_HEIGHT = 220;

/** Theme-free: the sheet scrollers drop a themed contentContainerStyle on web (docs/unistyles.md). */
const LIST_CONTENT = { paddingBottom: 4 };

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// React Native Web blurs the focused input on every scroll in "on-drag" mode.
const KEYBOARD_DISMISS_MODE = isNative ? "on-drag" : "none";
const NO_PROFILES: AgentProfilePickerRow[] = [];

export interface MobileModelPage {
  projection: MobileModelPageProjection;
  query: string;
  /** Changes when the search is cleared from outside the field, so the field remounts empty. */
  searchKey: number;
  setQuery: (query: string) => void;
  clearQuery: () => void;
  dispatch: (action: MobileModelPageAction) => void;
  /** Starts over from the current selection: its provider open, no search. */
  reset: () => void;
}

export function useMobileModelPage(input: {
  providers: readonly ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
}): MobileModelPage {
  const { providers, selectedProvider, selectedModel } = input;
  const pageInput = useMemo<MobileModelPageInput>(
    () => ({ providers, selectedProvider, selectedModel }),
    [providers, selectedModel, selectedProvider],
  );
  const inputRef = useRef(pageInput);
  inputRef.current = pageInput;
  const [state, setState] = useState(() => createMobileModelPageState(pageInput));
  const [searchKey, setSearchKey] = useState(0);
  const projection = useMemo(() => projectMobileModelPage(pageInput, state), [pageInput, state]);
  const dispatch = useCallback((action: MobileModelPageAction) => {
    setState((current) => reduceMobileModelPage(current, action));
  }, []);
  const setQuery = useCallback((query: string) => dispatch({ kind: "query", query }), [dispatch]);
  const clearQuery = useCallback(() => {
    dispatch({ kind: "query", query: "" });
    setSearchKey((key) => key + 1);
  }, [dispatch]);
  const reset = useCallback(() => {
    setState(createMobileModelPageState(inputRef.current));
    setSearchKey((key) => key + 1);
  }, []);
  return useMemo(
    () => ({ projection, query: state.query, searchKey, setQuery, clearQuery, dispatch, reset }),
    [clearQuery, dispatch, projection, reset, searchKey, setQuery, state.query],
  );
}

/**
 * The search that sits at the bottom of a compact sheet page, in reach of the thumb. It never takes
 * focus by itself, so the keyboard stays down until the user taps it.
 */
export function SheetSearchDock({
  query,
  searchKey,
  onChangeText,
  placeholder,
  testID,
}: {
  query: string;
  searchKey: number;
  onChangeText: (query: string) => void;
  placeholder: string;
  testID?: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.dock}>
      <SearchField
        key={searchKey}
        value={query}
        onChangeText={onChangeText}
        placeholder={placeholder}
        clearAccessibilityLabel={t("providerCatalog.clearSearch")}
        fullWidth
        testID={testID}
        clearTestID={testID ? `${testID}-clear` : undefined}
      />
    </View>
  );
}

export interface MobileModelPageViewProps {
  page: MobileModelPage;
  /** Keep this object stable across renders; the list re-renders its rows when it changes. */
  actions: ModelPickerActions;
  selectedProvider: string;
  selectedModel: string;
  serverId: string | null;
  /** Profiles whose model a row names, for the row's profile action. */
  profiles?: readonly AgentProfilePickerRow[] | null;
}

/** The compact model picker's body; its search is a `SheetSearchDock` in the sheet's footer. */
export function MobileModelPageView({
  page,
  selectedProvider,
  selectedModel,
  serverId,
  profiles,
  actions,
}: MobileModelPageViewProps) {
  const { projection, dispatch } = page;
  const profiledLookup = useMemo(
    () => groupProfilesByProviderModel(profiles ?? NO_PROFILES),
    [profiles],
  );
  const handleToggleFold = useCallback(
    (item: Extract<ModelPickerListItem, { kind: "fold" }>) =>
      dispatch({ kind: "toggleFold", providerId: item.providerId, expanded: !item.expanded }),
    [dispatch],
  );
  const renderItem = useCallback(
    ({ item }: { item: ModelPickerListItem<AgentProfilePickerRow> }) => (
      <ModelPickerItemRow
        item={item}
        active={false}
        selected={
          item.kind === "model" &&
          item.row.provider === selectedProvider &&
          item.row.modelId === selectedModel
        }
        inSearch={projection.kind === "search"}
        serverId={serverId}
        profiledLookup={profiledLookup}
        onToggleFold={handleToggleFold}
        onActivate={noop}
        actions={actions}
      />
    ),
    [
      actions,
      handleToggleFold,
      profiledLookup,
      projection.kind,
      selectedModel,
      selectedProvider,
      serverId,
    ],
  );

  if (projection.kind === "noProviders") {
    return (
      <View style={styles.page}>
        <ModelBrowserNoProviders />
      </View>
    );
  }
  if (projection.kind === "noMatches") {
    return (
      <View style={styles.page}>
        <ModelSearchNoMatches query={projection.query} />
      </View>
    );
  }
  if (projection.kind === "search") {
    return (
      <SheetListCard>
        <SheetFlatList
          data={projection.items}
          renderItem={renderItem}
          keyExtractor={getItemKey}
          style={SHEET_LIST_CARD_LIST}
          contentContainerStyle={LIST_CONTENT}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={KEYBOARD_DISMISS_MODE}
          showsVerticalScrollIndicator={false}
          testID="mobile-model-search-results"
        />
      </SheetListCard>
    );
  }
  if (!projection.showProviderHeaders) {
    const section = projection.sections[0];
    return (
      <View style={styles.page} testID="mobile-model-page">
        {section ? <ExpandedProviderHeader section={section} serverId={serverId} /> : null}
        <ProviderBody
          body={projection.body}
          selectedIndex={projection.selectedIndex}
          renderItem={renderItem}
          fill
          onRetryProvider={actions.onRetryProvider}
          isRetryingProvider={actions.isRetryingProvider}
        />
      </View>
    );
  }
  return (
    <SheetScrollView
      style={styles.page}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={KEYBOARD_DISMISS_MODE}
      showsVerticalScrollIndicator={false}
      testID="mobile-model-page"
    >
      {/* Themed insets sit on a View: the sheet scroller drops a themed contentContainerStyle on web. */}
      <View style={styles.sections}>
        {projection.sections.map((section) =>
          section.expanded ? (
            <SettingsCard key={section.providerId}>
              <ExpandedProviderHeader section={section} serverId={serverId} />
              <ProviderBody
                body={projection.body}
                selectedIndex={projection.selectedIndex}
                renderItem={renderItem}
                fill={false}
                onRetryProvider={actions.onRetryProvider}
                isRetryingProvider={actions.isRetryingProvider}
              />
            </SettingsCard>
          ) : (
            <SettingsCard key={section.providerId}>
              <CollapsedProviderRow section={section} serverId={serverId} onExpand={dispatch} />
            </SettingsCard>
          ),
        )}
      </View>
    </SheetScrollView>
  );
}

/** The style a list inside `SheetListCard` takes, so the card fits short lists and scrolls long ones. */
export const SHEET_LIST_CARD_LIST = { flexGrow: 0, flexShrink: 1, minHeight: 0 };

/**
 * An inset card holding one sheet list, on the same rail as the browse sections' cards. It grows
 * with the list, then the list scrolls inside it.
 */
export function SheetListCard({ children }: { children: ReactNode }) {
  return (
    <View style={styles.listCardPage}>
      <SettingsCard shrink>{children}</SettingsCard>
    </View>
  );
}

function noop() {}

function getItemKey(item: ModelPickerListItem<AgentProfilePickerRow>): string {
  return item.key;
}

function useSectionSummary(section: MobileProviderSection): string {
  const { t } = useTranslation();
  if (section.folds) {
    return t("modelSelector.shownOfTotal", { shown: section.shown, total: section.total });
  }
  return String(section.total);
}

function ExpandedProviderHeader({
  section,
  serverId,
}: {
  section: MobileProviderSection;
  serverId: string | null;
}) {
  const summary = useSectionSummary(section);
  return (
    <View style={styles.expandedHeader} testID={`model-provider-section-${section.providerId}`}>
      <View style={styles.glyph}>
        <ModelProviderGlyph
          provider={section.providerId}
          serverId={serverId}
          size={ICON_SIZE.sm}
          tone="foreground"
        />
      </View>
      <Text style={styles.expandedTitle} numberOfLines={1}>
        {section.label}
        {section.status === "ready" ? <Text style={styles.summary}>{` · ${summary}`}</Text> : null}
      </Text>
      {serverId ? (
        <CustomizeProviderButton
          serverId={serverId}
          providerId={section.providerId}
          providerLabel={section.label}
        />
      ) : null}
    </View>
  );
}

function CollapsedProviderRow({
  section,
  serverId,
  onExpand,
}: {
  section: MobileProviderSection;
  serverId: string | null;
  onExpand: (action: MobileModelPageAction) => void;
}) {
  const summary = useSectionSummary(section);
  const handlePress = useCallback(
    () => onExpand({ kind: "expand", providerId: section.providerId }),
    [onExpand, section.providerId],
  );
  const leadingSlot = useMemo(
    () => (
      <ModelProviderGlyph provider={section.providerId} serverId={serverId} size={ICON_SIZE.sm} />
    ),
    [section.providerId, serverId],
  );
  const trailingSlot = useMemo(
    () => (
      <View style={styles.collapsedTrailing}>
        <CollapsedStatus section={section} summary={summary} />
        <ThemedChevronDown size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </View>
    ),
    [section, summary],
  );
  return (
    <ModelBrowserRow
      label={section.label}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
      spacing="provider"
      onPress={handlePress}
      testID={`model-provider-${section.providerId}`}
    />
  );
}

function CollapsedStatus({
  section,
  summary,
}: {
  section: MobileProviderSection;
  summary: string;
}) {
  if (section.status === "loading") {
    return (
      <View style={styles.spinner}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedMapping} />
      </View>
    );
  }
  if (section.status === "error") {
    return <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />;
  }
  return <Text style={styles.summary}>{summary}</Text>;
}

type ModelItemRenderer = ({
  item,
}: {
  item: ModelPickerListItem<AgentProfilePickerRow>;
}) => React.ReactElement;

function ProviderBody({
  body,
  selectedIndex,
  renderItem,
  fill,
  onRetryProvider,
  isRetryingProvider,
}: {
  body: MobileModelBody;
  selectedIndex: number | null;
  renderItem: ModelItemRenderer;
  /** A lone provider's list fills the page; an open section keeps its fixed height. */
  fill: boolean;
  onRetryProvider: ModelPickerActions["onRetryProvider"];
  isRetryingProvider: boolean;
}) {
  const frameStyle = fill ? styles.page : styles.fixedViewport;
  if (body.kind === "providerLoading") {
    return (
      <View style={[frameStyle, styles.centered]}>
        <ModelBrowserLoadingState />
      </View>
    );
  }
  if (body.kind === "providerError") {
    return (
      <View style={[frameStyle, styles.centered]}>
        <ProviderErrorEmptyState
          providerId={body.providerId}
          message={body.message}
          onRetryProvider={onRetryProvider}
          isRetryingProvider={isRetryingProvider}
        />
      </View>
    );
  }
  const list = (
    <ProviderModelList
      // A new provider is a new list, which opens at its top or at the selected model.
      key={body.providerId}
      items={body.items}
      selectedIndex={selectedIndex}
      renderItem={renderItem}
      fill={fill}
    />
  );
  // The lone provider's list is the page's only scroller; a fixed box scrolls inside the page's.
  return fill ? list : <IndependentScrollBoundary>{list}</IndependentScrollBoundary>;
}

/** Opens with the selected model in view, such as an older model behind the opened fold. */
function ProviderModelList({
  items,
  selectedIndex,
  renderItem,
  fill,
}: {
  items: ModelPickerListItem<AgentProfilePickerRow>[];
  selectedIndex: number | null;
  renderItem: ModelItemRenderer;
  fill: boolean;
}) {
  const listRef = useRef<FlatList<ModelPickerListItem<AgentProfilePickerRow>>>(null);
  // Waits for the first visible rows, so a selection already in view never scrolls the list.
  const reveal = useRevealActiveFlatListRow({
    listRef,
    itemCount: items.length,
    activeIndex: selectedIndex,
    waitForViewable: true,
  });
  return (
    <FlatList
      ref={listRef}
      data={items}
      renderItem={renderItem}
      keyExtractor={getItemKey}
      style={fill ? styles.page : styles.fixedViewport}
      contentContainerStyle={LIST_CONTENT}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={KEYBOARD_DISMISS_MODE}
      showsVerticalScrollIndicator
      nestedScrollEnabled
      onScrollToIndexFailed={reveal.onScrollToIndexFailed}
      onViewableItemsChanged={reveal.onViewableItemsChanged}
      viewabilityConfig={reveal.viewabilityConfig}
      onContentSizeChange={reveal.onContentSizeChange}
      onLayout={reveal.onLayout}
      testID="compact-model-list"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    minHeight: 0,
  },
  listCardPage: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  sections: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
  },
  expandedHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // The model rows' leading rail (ModelBrowserRow), so the provider glyph sits above theirs.
    paddingLeft: isNative ? theme.spacing[6] : theme.spacing[3],
    paddingRight: theme.spacing[4],
  },
  glyph: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  expandedTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  summary: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  collapsedTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  spinner: {
    transform: [{ scale: 0.7 }],
  },
  fixedViewport: {
    height: MOBILE_EXPANDED_PROVIDER_HEIGHT,
    flexGrow: 0,
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
  },
  dock: {
    flex: 1,
  },
}));
