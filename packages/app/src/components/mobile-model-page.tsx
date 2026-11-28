import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AlertTriangle, ChevronDown, ChevronUp, Layers, Pencil } from "lucide-react-native";
import type { AgentProfilePickerRow } from "@/agent-profiles";
import {
  IndependentScrollBoundary,
  ModelBrowserLoadingState,
  ModelBrowserNoProviders,
  ModelBrowserRow,
  ModelBrowserSectionHeading,
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
  type MobileModelSection,
  type MobileProfilesSection,
  type MobileProviderSection,
} from "@/components/mobile-model-page-view";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  FlatList as SheetFlatList,
  ScrollView as SheetScrollView,
} from "@/components/ui/scroll-view";
import { SearchField } from "@/components/ui/search-field";
import { useRevealActiveFlatListRow } from "@/components/ui/scroll-reveal";
import { isNative } from "@/constants/platform";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";

/**
 * The open accordion section lists its rows in a box of one fixed height, about five rows, that
 * scrolls on its own. Opening another section, unfolding older models or loading never moves the
 * sections below it, so they stay where the thumb left them.
 */
export const MOBILE_EXPANDED_PROVIDER_HEIGHT = 220;

/** Theme-free: the sheet scrollers drop a themed contentContainerStyle on web (docs/unistyles.md). */
const LIST_CONTENT = { paddingBottom: 4 };
const SHEET_LIST_CARD_LIST = { flexGrow: 0, flexShrink: 1, minHeight: 0 };
const EXPANDED_A11Y_STATE = { expanded: true };

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedLayers = withUnistyles(Layers);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// React Native Web blurs the focused input on every scroll in "on-drag" mode.
const KEYBOARD_DISMISS_MODE = isNative ? "on-drag" : "none";
const NO_PROFILES: AgentProfilePickerRow[] = [];

export interface MobileModelPage {
  projection: MobileModelPageProjection<AgentProfilePickerRow>;
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
  profiles?: readonly AgentProfilePickerRow[] | null;
  canCreateProfile?: boolean;
  selectedProvider: string;
  selectedModel: string;
}): MobileModelPage {
  const {
    providers,
    profiles = null,
    canCreateProfile = false,
    selectedProvider,
    selectedModel,
  } = input;
  const pageInput = useMemo<MobileModelPageInput<AgentProfilePickerRow>>(
    () => ({ providers, profiles, canCreateProfile, selectedProvider, selectedModel }),
    [canCreateProfile, profiles, providers, selectedModel, selectedProvider],
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

type SearchEntry =
  | { kind: "heading"; key: string; title: string }
  | { kind: "item"; key: string; item: ModelPickerListItem<AgentProfilePickerRow> };

/** The compact model picker's body; its search is a `SheetSearchDock` in the sheet's footer. */
export function MobileModelPageView({
  page,
  selectedProvider,
  selectedModel,
  serverId,
  profiles,
  actions,
}: MobileModelPageViewProps) {
  const { t } = useTranslation();
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
  const searchEntries = useMemo<SearchEntry[]>(() => {
    if (projection.kind !== "search") return [];
    const toEntry = (item: ModelPickerListItem<AgentProfilePickerRow>): SearchEntry => ({
      kind: "item",
      key: item.key,
      item,
    });
    const entries: SearchEntry[] = [];
    if (projection.profiles.length > 0) {
      entries.push({
        kind: "heading",
        key: "heading:profiles",
        title: t("modelSelector.profiles"),
      });
      entries.push(...projection.profiles.map(toEntry));
      if (projection.models.length > 0) {
        entries.push({
          kind: "heading",
          key: "heading:models",
          title: t("modelSelector.models"),
        });
      }
    }
    entries.push(...projection.models.map(toEntry));
    return entries;
  }, [projection, t]);
  const renderSearchEntry = useCallback(
    ({ item }: { item: SearchEntry }) =>
      item.kind === "heading" ? (
        <ModelBrowserSectionHeading title={item.title} />
      ) : (
        renderItem({ item: item.item })
      ),
    [renderItem],
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
          data={searchEntries}
          renderItem={renderSearchEntry}
          keyExtractor={getSearchEntryKey}
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
  if (!projection.showSectionHeaders) {
    const section = projection.sections[0];
    return (
      <View style={styles.page} testID="mobile-model-page">
        {section?.kind === "provider" ? (
          <ExpandedProviderHeader section={section} serverId={serverId} />
        ) : null}
        {projection.body ? (
          <SectionBody
            body={projection.body}
            selectedIndex={projection.selectedIndex}
            renderItem={renderItem}
            fill
            onRetryProvider={actions.onRetryProvider}
            isRetryingProvider={actions.isRetryingProvider}
          />
        ) : null}
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
        {projection.sections.map((section) => (
          <AccordionSectionCard
            key={section.key}
            section={section}
            body={projection.body}
            selectedIndex={projection.selectedIndex}
            serverId={serverId}
            actions={actions}
            renderItem={renderItem}
            onToggle={dispatch}
          />
        ))}
      </View>
    </SheetScrollView>
  );
}

function AccordionSectionCard({
  section,
  body,
  selectedIndex,
  serverId,
  actions,
  renderItem,
  onToggle,
}: {
  section: MobileModelSection;
  body: MobileModelBody<AgentProfilePickerRow> | null;
  selectedIndex: number | null;
  serverId: string | null;
  actions: ModelPickerActions;
  renderItem: ModelItemRenderer;
  onToggle: (action: MobileModelPageAction) => void;
}) {
  if (!section.expanded) {
    return (
      <SettingsCard>
        {section.kind === "profiles" ? (
          <CollapsedProfilesRow section={section} onToggle={onToggle} />
        ) : (
          <CollapsedProviderRow section={section} serverId={serverId} onToggle={onToggle} />
        )}
      </SettingsCard>
    );
  }
  return (
    <SettingsCard>
      {section.kind === "profiles" ? (
        <ExpandedProfilesHeader
          section={section}
          onEditProfiles={actions.onEditProfiles}
          onToggle={onToggle}
        />
      ) : (
        <ExpandedProviderHeader section={section} serverId={serverId} onToggle={onToggle} />
      )}
      {body ? (
        <SectionBody
          body={body}
          selectedIndex={selectedIndex}
          renderItem={renderItem}
          fill={false}
          onRetryProvider={actions.onRetryProvider}
          isRetryingProvider={actions.isRetryingProvider}
        />
      ) : null}
    </SettingsCard>
  );
}

/**
 * An inset card holding one sheet list, on the same rail as the browse sections' cards. It grows
 * with the list, then the list scrolls inside it.
 */
function SheetListCard({ children }: { children: ReactNode }) {
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

function getSearchEntryKey(entry: SearchEntry): string {
  return entry.key;
}

function useSectionSummary(section: MobileProviderSection): string {
  const { t } = useTranslation();
  if (section.folds) {
    return t("modelSelector.shownOfTotal", { shown: section.shown, total: section.total });
  }
  return String(section.total);
}

function ExpandedSectionHeader({
  leading,
  title,
  summary,
  trailing,
  onCollapse,
  testID,
}: {
  leading: ReactNode;
  title: string;
  summary: string | null;
  trailing?: ReactNode;
  onCollapse?: () => void;
  testID: string;
}) {
  const titleContent = (
    <>
      <View style={styles.glyph}>{leading}</View>
      <Text style={styles.expandedTitle} numberOfLines={1}>
        {title}
        {summary !== null ? <Text style={styles.summary}>{` · ${summary}`}</Text> : null}
      </Text>
    </>
  );
  if (!onCollapse) {
    return (
      <View style={styles.expandedHeader} testID={testID}>
        <View style={styles.expandedTrigger}>{titleContent}</View>
        {trailing}
      </View>
    );
  }
  return (
    <View style={styles.expandedHeader}>
      <PressHighlight
        onPress={onCollapse}
        accessibilityRole="button"
        accessibilityState={EXPANDED_A11Y_STATE}
        style={styles.expandedTrigger}
        testID={testID}
      >
        {titleContent}
      </PressHighlight>
      <View style={styles.expandedTrailing}>
        {trailing}
        <PressHighlight
          onPress={onCollapse}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={EXPANDED_A11Y_STATE}
          style={styles.collapseChevron}
        >
          <ThemedChevronUp size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
        </PressHighlight>
      </View>
    </View>
  );
}

function ExpandedProfilesHeader({
  section,
  onEditProfiles,
  onToggle,
}: {
  section: MobileProfilesSection;
  onEditProfiles?: () => void;
  onToggle: (action: MobileModelPageAction) => void;
}) {
  const { t } = useTranslation();
  const handleCollapse = useCallback(
    () => onToggle({ kind: "toggleSection", key: section.key }),
    [onToggle, section.key],
  );
  const leading = useMemo(
    () => <ThemedLayers size={ICON_SIZE.sm} uniProps={foregroundMapping} />,
    [],
  );
  const trailing = useMemo(
    () =>
      onEditProfiles ? (
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Pencil}
          onPress={onEditProfiles}
          accessibilityLabel={t("modelSelector.editProfilesLabel")}
          testID="model-profiles-edit"
        />
      ) : null,
    [onEditProfiles, t],
  );
  return (
    <ExpandedSectionHeader
      leading={leading}
      title={t("modelSelector.profiles")}
      summary={String(section.count)}
      trailing={trailing}
      onCollapse={handleCollapse}
      testID="model-profiles-section"
    />
  );
}

function CollapsedProfilesRow({
  section,
  onToggle,
}: {
  section: MobileProfilesSection;
  onToggle: (action: MobileModelPageAction) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => onToggle({ kind: "toggleSection", key: section.key }),
    [onToggle, section.key],
  );
  const leadingSlot = useMemo(
    () => <ThemedLayers size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />,
    [],
  );
  const trailingSlot = useMemo(
    () => (
      <View style={styles.collapsedTrailing}>
        <Text style={styles.summary}>{section.count}</Text>
        <ThemedChevronDown size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </View>
    ),
    [section.count],
  );
  return (
    <ModelBrowserRow
      label={t("modelSelector.profiles")}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
      spacing="provider"
      onPress={handlePress}
      testID="model-picker-rail-profiles"
    />
  );
}

function ExpandedProviderHeader({
  section,
  serverId,
  onToggle,
}: {
  section: MobileProviderSection;
  serverId: string | null;
  onToggle?: (action: MobileModelPageAction) => void;
}) {
  const summary = useSectionSummary(section);
  const handleCollapse = useCallback(
    () => onToggle?.({ kind: "toggleSection", key: section.key }),
    [onToggle, section.key],
  );
  const leading = useMemo(
    () => (
      <ModelProviderGlyph
        provider={section.providerId}
        serverId={serverId}
        size={ICON_SIZE.sm}
        tone="foreground"
      />
    ),
    [section.providerId, serverId],
  );
  const trailing = useMemo(
    () =>
      serverId ? (
        <CustomizeProviderButton
          serverId={serverId}
          providerId={section.providerId}
          providerLabel={section.label}
        />
      ) : null,
    [section.label, section.providerId, serverId],
  );
  return (
    <ExpandedSectionHeader
      leading={leading}
      title={section.label}
      summary={section.status === "ready" ? summary : null}
      trailing={trailing}
      onCollapse={onToggle ? handleCollapse : undefined}
      testID={`model-provider-section-${section.providerId}`}
    />
  );
}

function CollapsedProviderRow({
  section,
  serverId,
  onToggle,
}: {
  section: MobileProviderSection;
  serverId: string | null;
  onToggle: (action: MobileModelPageAction) => void;
}) {
  const summary = useSectionSummary(section);
  const handlePress = useCallback(
    () => onToggle({ kind: "toggleSection", key: section.key }),
    [onToggle, section.key],
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

function SectionBody({
  body,
  selectedIndex,
  renderItem,
  fill,
  onRetryProvider,
  isRetryingProvider,
}: {
  body: MobileModelBody<AgentProfilePickerRow>;
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
  const listKey = body.kind === "profiles" ? "profiles" : body.providerId;
  const list = (
    <SectionItemList
      // Each section is a new list, which opens at its top or at the selected model.
      key={listKey}
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
function SectionItemList({
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
    // The model rows' leading rail (ModelBrowserRow), so the section glyph sits above theirs.
    paddingLeft: isNative ? theme.spacing[6] : theme.spacing[3],
    paddingRight: isNative ? theme.spacing[6] : theme.spacing[3],
  },
  expandedTrigger: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  expandedTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  collapseChevron: {
    minWidth: 24,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
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
    flexDirection: "row",
  },
}));
