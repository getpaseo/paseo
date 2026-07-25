import { createContext, useCallback, useContext, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AlertTriangle, Check, ChevronRight, Search, Settings, Star } from "lucide-react-native";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getProviderIcon } from "@/components/provider-icons";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import {
  buildSelectedTriggerLabel,
  filterAndRankModelRows,
  getAllProviderModelRows,
  getProviderModelRows,
  resolveSelectedModelLabel,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  resolveInitialModelBrowserView,
  type ModelBrowserView,
} from "@/components/model-browser-view";

const DESKTOP_PROVIDER_VIEW_MIN_HEIGHT = 220;
const DESKTOP_PROVIDER_VIEW_MAX_HEIGHT = 400;
const DESKTOP_PROVIDER_VIEW_BASE_HEIGHT = 80;
const DESKTOP_MODEL_ROW_HEIGHT = 40;

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedCheck = withUnistyles(Check);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedSearch = withUnistyles(Search);
const ThemedSettings = withUnistyles(Settings);
const ThemedStar = withUnistyles(Star);

const IndependentScrollGestureContext = createContext<ReturnType<typeof Gesture.Native> | null>(
  null,
);

const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const headerSettingsMapping = (disabled: boolean) => (theme: Theme) => ({
  color: disabled ? theme.colors.border : theme.colors.foregroundMuted,
});

const favoriteStarMapping =
  (isFavorite: boolean, hovered: boolean) =>
  (theme: Theme): { color: string; fill: string } => {
    const favoriteColor = theme.colors.palette.amber[500];
    if (isFavorite) {
      return { color: favoriteColor, fill: favoriteColor };
    }
    return {
      color: hovered ? theme.colors.foregroundMuted : theme.colors.border,
      fill: "transparent",
    };
  };

interface ModelBrowserInput {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  isLoading: boolean;
  favoriteKeys: Set<string>;
  serverId?: string | null;
}

export interface ModelBrowserState {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  favoriteKeys: Set<string>;
  view: ModelBrowserView;
  searchQuery: string;
  header: SheetHeader;
  selectedModelLabel: string;
  triggerLabel: string;
  desktopFixedHeight: number | undefined;
  isProviderView: boolean;
  prepareToOpen: () => void;
  reset: () => void;
  drillDown: (providerId: string, providerLabel: string) => void;
}

interface ModelBrowserProps {
  state: ModelBrowserState;
  onSelect: (provider: string, modelId: string) => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  scrolling?: "sheet" | "independent";
}

interface ModelBrowserContentProps extends Omit<ModelBrowserProps, "state" | "scrolling"> {
  view: ModelBrowserView;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  searchQuery: string;
  favoriteKeys: Set<string>;
  onDrillDown: (providerId: string, providerLabel: string) => void;
  scrolling: "sheet" | "independent";
}

type ProviderGlyphTone = "muted" | "foreground";

export function ModelProviderGlyph({
  provider,
  size,
  tone = "muted",
}: {
  provider: string;
  size: number;
  tone?: ProviderGlyphTone;
}) {
  const Icon = getProviderIcon(provider);
  const color =
    tone === "foreground" ? styles.providerIconForeground.color : styles.providerIconMuted.color;
  return <Icon size={size} color={color} />;
}

function HeaderSettingsIcon({ disabled }: { disabled: boolean }) {
  const uniProps = useMemo(() => headerSettingsMapping(disabled), [disabled]);
  return <ThemedSettings size={ICON_SIZE.sm} uniProps={uniProps} />;
}

function FavoriteStar({ isFavorite, hovered }: { isFavorite: boolean; hovered: boolean }) {
  const uniProps = useMemo(() => favoriteStarMapping(isFavorite, hovered), [hovered, isFavorite]);
  return <ThemedStar size={ICON_SIZE.md} uniProps={uniProps} />;
}

function favoriteButtonStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.favoriteButton,
    Boolean(hovered) && styles.favoriteButtonHovered,
    pressed && styles.favoriteButtonPressed,
  ];
}

function iconButtonStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.rowIconButton,
    Boolean(hovered) && styles.rowIconButtonHovered,
    pressed && styles.rowIconButtonPressed,
  ];
}

function resolveDesktopFixedHeight(
  view: ModelBrowserView,
  providers: ProviderSelectorProvider[],
): number | undefined {
  if (view.kind !== "provider") {
    return undefined;
  }
  const provider = providers.find((entry) => entry.id === view.providerId);
  if (!provider || provider.modelSelection.kind !== "models") {
    return DESKTOP_PROVIDER_VIEW_MIN_HEIGHT;
  }
  const modelCount = getProviderModelRows(provider).length;
  return Math.min(
    Math.max(
      DESKTOP_PROVIDER_VIEW_MIN_HEIGHT,
      DESKTOP_PROVIDER_VIEW_BASE_HEIGHT + modelCount * DESKTOP_MODEL_ROW_HEIGHT,
    ),
    DESKTOP_PROVIDER_VIEW_MAX_HEIGHT,
  );
}

export function useModelBrowser({
  providers,
  selectedProvider,
  selectedModel,
  isLoading,
  favoriteKeys,
  serverId = null,
}: ModelBrowserInput): ModelBrowserState {
  const { t } = useTranslation();
  const [view, setView] = useState<ModelBrowserView>({ kind: "all" });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResetKey, bumpSearchResetKey] = useReducer((key: number) => key + 1, 0);

  const initialView = useMemo(
    () =>
      resolveInitialModelBrowserView({
        providers,
        selectedProvider,
        selectedModel,
        favoriteKeys,
      }),
    [favoriteKeys, providers, selectedModel, selectedProvider],
  );

  const prepareToOpen = useCallback(() => {
    setView(initialView);
  }, [initialView]);

  const reset = useCallback(() => {
    setSearchQuery("");
    bumpSearchResetKey();
  }, []);

  const handleBackToAll = useCallback(() => {
    setView({ kind: "all" });
    reset();
  }, [reset]);

  const drillDown = useCallback((providerId: string, providerLabel: string) => {
    setView({ kind: "provider", providerId, providerLabel });
  }, []);

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const openProviderSettings = useCallback(() => {
    if (!serverId || view.kind !== "provider") return;
    useProviderSettingsStore.getState().open({ serverId, provider: view.providerId });
  }, [serverId, view]);

  const singleProviderView = providers.length === 1;
  const header = useMemo<SheetHeader>(() => {
    if (view.kind === "all") {
      return { title: t("modelSelector.title") };
    }
    return {
      title: view.providerLabel,
      leading: (
        <ModelProviderGlyph provider={view.providerId} size={ICON_SIZE.md} tone="foreground" />
      ),
      back: singleProviderView ? undefined : { onPress: handleBackToAll },
      actions: (
        <Pressable
          onPress={openProviderSettings}
          disabled={!serverId}
          hitSlop={8}
          style={iconButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={t("modelSelector.openProviderSettings", {
            provider: view.providerLabel,
          })}
          testID={`selector-header-settings-${view.providerId}`}
        >
          <HeaderSettingsIcon disabled={!serverId} />
        </Pressable>
      ),
      search: {
        onChange: handleSearchQueryChange,
        resetKey: `${view.providerId}:${searchResetKey}`,
        placeholder: t("modelSelector.searchPlaceholder"),
        autoFocus: isWeb,
        testID: "model-search-input",
      },
    };
  }, [
    handleBackToAll,
    handleSearchQueryChange,
    openProviderSettings,
    searchResetKey,
    serverId,
    singleProviderView,
    t,
    view,
  ]);

  const selectedModelLabel = useMemo(
    () =>
      resolveSelectedModelLabel({
        providers,
        selectedProvider,
        selectedModel,
        isLoading,
      }),
    [isLoading, providers, selectedModel, selectedProvider],
  );

  const triggerLabel = useMemo(() => {
    const isPlaceholder =
      selectedModelLabel === t("modelSelector.loading") ||
      selectedModelLabel === t("modelSelector.selectModel");
    return isPlaceholder ? selectedModelLabel : buildSelectedTriggerLabel(selectedModelLabel);
  }, [selectedModelLabel, t]);

  const desktopFixedHeight = useMemo(
    () => resolveDesktopFixedHeight(view, providers),
    [providers, view],
  );

  return {
    providers,
    selectedProvider,
    selectedModel,
    favoriteKeys,
    view,
    searchQuery,
    header,
    selectedModelLabel,
    triggerLabel,
    desktopFixedHeight,
    isProviderView: view.kind === "provider",
    prepareToOpen,
    reset,
    drillDown,
  };
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function sortFavoritesFirst(
  rows: ProviderSelectionModelRow[],
  favoriteKeys: Set<string>,
): ProviderSelectionModelRow[] {
  const favorites: ProviderSelectionModelRow[] = [];
  const rest: ProviderSelectionModelRow[] = [];
  for (const row of rows) {
    if (favoriteKeys.has(row.favoriteKey)) {
      favorites.push(row);
    } else {
      rest.push(row);
    }
  }
  return [...favorites, ...rest];
}

interface ModelBrowserPressableProps {
  children: React.ReactNode | ((state: PressableStateCallbackType) => React.ReactNode);
  style?:
    | StyleProp<ViewStyle>
    | ((state: PressableStateCallbackType & { hovered?: boolean }) => StyleProp<ViewStyle>);
  onPress: () => void;
  hitSlop?: number;
  accessibilityLabel?: string;
  testID?: string;
}

function ModelBrowserPressable({
  children,
  style,
  onPress,
  hitSlop,
  accessibilityLabel,
  testID,
}: ModelBrowserPressableProps) {
  const independentScrollGesture = useContext(IndependentScrollGestureContext);
  const [pressed, setPressed] = useState(false);
  // Android's scroll handler must keep the pointer stream until release so a
  // fling survives leaving the short viewport. A simultaneous Tap keeps rows
  // interactive, while maxDistance makes a real scroll fail instead of select.
  const tapGesture = useMemo(() => {
    const gesture = Gesture.Tap()
      .maxDistance(8)
      .shouldCancelWhenOutside(true)
      .runOnJS(true)
      .onBegin(() => setPressed(true))
      .onEnd((_event, success) => {
        if (success) onPress();
      })
      .onFinalize(() => setPressed(false));
    if (hitSlop !== undefined) gesture.hitSlop(hitSlop);
    if (independentScrollGesture) {
      gesture.simultaneousWithExternalGesture(independentScrollGesture);
    }
    return gesture;
  }, [hitSlop, independentScrollGesture, onPress]);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "activate") onPress();
    },
    [onPress],
  );

  if (!independentScrollGesture) {
    return (
      <Pressable
        onPress={handlePress}
        hitSlop={hitSlop}
        style={style}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        {children}
      </Pressable>
    );
  }

  const state = { pressed };
  const resolvedStyle = typeof style === "function" ? style(state) : style;
  const resolvedChildren = typeof children === "function" ? children(state) : children;
  return (
    <GestureDetector gesture={tapGesture}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={handleAccessibilityAction}
        style={resolvedStyle}
        testID={testID}
      >
        {resolvedChildren}
      </View>
    </GestureDetector>
  );
}

type ModelBrowserRowTone = "default" | "elevated" | "drillDown";

function ModelBrowserRow({
  label,
  description,
  leadingSlot,
  trailingSlot,
  selected = false,
  selectionIndicator = false,
  tone = "default",
  spacing = "model",
  onPress,
  testID,
}: {
  label: string;
  description?: string;
  leadingSlot: React.ReactNode;
  trailingSlot?: React.ReactNode;
  selected?: boolean;
  selectionIndicator?: boolean;
  tone?: ModelBrowserRowTone;
  spacing?: "model" | "provider";
  onPress: () => void;
  testID?: string;
}) {
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.browserRow,
      spacing === "model" && styles.browserModelRow,
      Boolean(hovered) &&
        (tone === "elevated" ? styles.browserRowHoveredElevated : styles.browserRowHovered),
      pressed && (tone === "default" ? styles.browserRowPressed : styles.browserRowPressedElevated),
    ],
    [spacing, tone],
  );
  const contentStyle = useMemo(
    () => [styles.browserRowText, description && styles.browserRowTextInline],
    [description],
  );
  const hasTrailing = selected || trailingSlot;

  return (
    <ModelBrowserPressable onPress={onPress} style={pressableStyle} testID={testID}>
      <View style={styles.browserRowContent}>
        <View style={styles.browserRowLeading}>{leadingSlot}</View>
        <View style={contentStyle}>
          <Text numberOfLines={1} style={styles.browserRowLabel}>
            {label}
          </Text>
          {description ? (
            <Text numberOfLines={1} style={styles.browserRowDescription}>
              {description}
            </Text>
          ) : null}
        </View>
        {hasTrailing ? (
          <View style={styles.browserRowTrailing}>
            {selectionIndicator ? (
              <View style={styles.browserRowSelection}>
                {selected ? (
                  <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
                ) : null}
              </View>
            ) : null}
            {trailingSlot}
          </View>
        ) : null}
      </View>
    </ModelBrowserPressable>
  );
}

function ModelRow({
  row,
  isSelected,
  isFavorite,
  elevated = false,
  onPress,
  onToggleFavorite,
}: {
  row: ProviderSelectionModelRow;
  isSelected: boolean;
  isFavorite: boolean;
  elevated?: boolean;
  onPress: () => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
}) {
  const { t } = useTranslation();
  const handleToggleFavorite = useCallback(
    () => onToggleFavorite?.(row.provider, row.modelId),
    [onToggleFavorite, row.modelId, row.provider],
  );
  const leadingSlot = useMemo(
    () => <ModelProviderGlyph provider={row.provider} size={ICON_SIZE.sm} />,
    [row.provider],
  );
  const trailingSlot = useMemo(
    () =>
      onToggleFavorite ? (
        <ModelBrowserPressable
          onPress={handleToggleFavorite}
          hitSlop={8}
          style={favoriteButtonStyle}
          accessibilityLabel={
            isFavorite ? t("modelSelector.unfavoriteModel") : t("modelSelector.favoriteModel")
          }
          testID={`favorite-model-${row.provider}-${row.modelId}`}
        >
          {({ hovered }) => <FavoriteStar isFavorite={isFavorite} hovered={Boolean(hovered)} />}
        </ModelBrowserPressable>
      ) : null,
    [handleToggleFavorite, isFavorite, onToggleFavorite, row.modelId, row.provider, t],
  );

  return (
    <ModelBrowserRow
      label={row.modelLabel}
      description={row.description}
      selected={isSelected}
      selectionIndicator
      tone={elevated ? "elevated" : "default"}
      onPress={onPress}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
    />
  );
}

function SelectableModelRow({
  row,
  isSelected,
  isFavorite,
  elevated,
  onSelect,
  onToggleFavorite,
}: {
  row: ProviderSelectionModelRow;
  isSelected: boolean;
  isFavorite: boolean;
  elevated?: boolean;
  onSelect: (provider: string, modelId: string) => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(row.provider, row.modelId);
  }, [onSelect, row.modelId, row.provider]);
  return (
    <ModelRow
      row={row}
      isSelected={isSelected}
      isFavorite={isFavorite}
      elevated={elevated}
      onPress={handlePress}
      onToggleFavorite={onToggleFavorite}
    />
  );
}

function FavoritesSection({
  favoriteRows,
  selectedProvider,
  selectedModel,
  favoriteKeys,
  onSelect,
  onToggleFavorite,
}: {
  favoriteRows: ProviderSelectionModelRow[];
  selectedProvider: string;
  selectedModel: string;
  favoriteKeys: Set<string>;
  onSelect: (provider: string, modelId: string) => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
}) {
  const { t } = useTranslation();
  if (favoriteRows.length === 0) return null;
  return (
    <View style={styles.favoritesContainer}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionHeadingText}>{t("modelSelector.favorites")}</Text>
      </View>
      {favoriteRows.map((row) => (
        <SelectableModelRow
          key={row.favoriteKey}
          row={row}
          isSelected={row.provider === selectedProvider && row.modelId === selectedModel}
          isFavorite={favoriteKeys.has(row.favoriteKey)}
          elevated
          onSelect={onSelect}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </View>
  );
}

function GroupProviderButton({
  provider,
  onDrillDown,
}: {
  provider: ProviderSelectorProvider;
  onDrillDown: (providerId: string, providerLabel: string) => void;
}) {
  const { t } = useTranslation();
  const selection = provider.modelSelection;
  const handlePress = useCallback(() => {
    onDrillDown(provider.id, provider.label);
  }, [onDrillDown, provider.id, provider.label]);

  const stateNode = useMemo(() => {
    if (selection.kind === "models") {
      const count = selection.rows.length;
      return (
        <Text style={styles.drillDownCount}>
          {t(count === 1 ? "modelSelector.modelCount" : "modelSelector.modelCountPlural", {
            count,
          })}
        </Text>
      );
    }
    if (selection.kind === "loading") {
      return (
        <View style={styles.rowStateInline}>
          <View style={styles.rowSpinner}>
            <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
          </View>
          <Text style={styles.drillDownCount}>{t("modelSelector.loadingShort")}</Text>
        </View>
      );
    }
    return (
      <View style={styles.rowStateInline}>
        <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
        <Text style={styles.drillDownCount}>{t("modelSelector.error")}</Text>
      </View>
    );
  }, [selection, t]);
  const leadingSlot = useMemo(
    () => <ModelProviderGlyph provider={provider.id} size={ICON_SIZE.sm} />,
    [provider.id],
  );
  const trailingSlot = useMemo(
    () => (
      <View style={styles.drillDownTrailing}>
        {stateNode}
        <ThemedChevronRight size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </View>
    ),
    [stateNode],
  );

  return (
    <ModelBrowserRow
      label={provider.label}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
      tone="drillDown"
      spacing="provider"
      onPress={handlePress}
      testID={`model-provider-${provider.id}`}
    />
  );
}

function GroupedProviderRows({
  providers,
  onDrillDown,
}: {
  providers: ProviderSelectorProvider[];
  onDrillDown: (providerId: string, providerLabel: string) => void;
}) {
  return (
    <View>
      {providers.map((provider, index) => (
        <View key={provider.id}>
          {index > 0 ? <View style={styles.separator} /> : null}
          <GroupProviderButton provider={provider} onDrillDown={onDrillDown} />
        </View>
      ))}
    </View>
  );
}

function IndependentScrollBoundary({ children }: { children: React.ReactElement }) {
  // Prevent the parent sheet from cancelling Android's native scroll when the
  // finger crosses this viewport; receiving ACTION_UP is what preserves fling.
  const nativeScrollGesture = useMemo(
    () =>
      Gesture.Native()
        .shouldActivateOnStart(true)
        .shouldCancelWhenOutside(false)
        .disallowInterruption(true),
    [],
  );

  if (Platform.OS !== "android") {
    return children;
  }

  return (
    <IndependentScrollGestureContext.Provider value={nativeScrollGesture}>
      <GestureDetector gesture={nativeScrollGesture}>{children}</GestureDetector>
    </IndependentScrollGestureContext.Provider>
  );
}

function IndependentModelList({
  rows,
  renderItem,
}: {
  rows: ProviderSelectionModelRow[];
  renderItem: ({ item }: { item: ProviderSelectionModelRow }) => React.ReactElement;
}) {
  return (
    <IndependentScrollBoundary>
      <FlatList
        data={rows}
        renderItem={renderItem}
        keyExtractor={getModelRowKey}
        style={styles.virtualizedModelList}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.virtualizedModelListContent}
        nestedScrollEnabled
        testID="compact-model-list"
      />
    </IndependentScrollBoundary>
  );
}

function getModelRowKey(row: ProviderSelectionModelRow): string {
  return row.favoriteKey;
}

function IndependentProviderList({ children }: { children: React.ReactNode }) {
  return (
    <IndependentScrollBoundary>
      <ScrollView
        style={styles.virtualizedModelList}
        contentContainerStyle={[
          styles.virtualizedModelListContent,
          styles.virtualizedProviderListContent,
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        testID="compact-provider-list"
      >
        {children}
      </ScrollView>
    </IndependentScrollBoundary>
  );
}

function ProviderModelRows({
  rows,
  selectedProvider,
  selectedModel,
  favoriteKeys,
  onSelect,
  onToggleFavorite,
  normalizedQuery,
  scrolling,
}: {
  rows: ProviderSelectionModelRow[];
  selectedProvider: string;
  selectedModel: string;
  favoriteKeys: Set<string>;
  onSelect: (provider: string, modelId: string) => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  normalizedQuery: string;
  scrolling: "sheet" | "independent";
}) {
  const isCompact = useIsCompactFormFactor();
  const displayRows = useMemo(
    () => (normalizedQuery ? rows : sortFavoritesFirst(rows, favoriteKeys)),
    [favoriteKeys, normalizedQuery, rows],
  );
  const renderItem = useCallback(
    ({ item }: { item: ProviderSelectionModelRow }) => (
      <SelectableModelRow
        row={item}
        isSelected={item.provider === selectedProvider && item.modelId === selectedModel}
        isFavorite={favoriteKeys.has(item.favoriteKey)}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
      />
    ),
    [favoriteKeys, onSelect, onToggleFavorite, selectedModel, selectedProvider],
  );
  const keyExtractor = useCallback((row: ProviderSelectionModelRow) => row.favoriteKey, []);

  if (scrolling === "independent") {
    return <IndependentModelList rows={displayRows} renderItem={renderItem} />;
  }

  if (isCompact && isNative) {
    return (
      <BottomSheetFlatList
        data={displayRows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        style={styles.virtualizedModelList}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.virtualizedModelListContent}
      />
    );
  }

  return (
    <View>
      {displayRows.map((row) => (
        <View key={row.favoriteKey}>{renderItem({ item: row })}</View>
      ))}
    </View>
  );
}

function ProviderErrorEmptyState({
  providerId,
  message,
  onRetryProvider,
  isRetryingProvider,
}: {
  providerId: string;
  message: string;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => {
    onRetryProvider?.(providerId);
  }, [onRetryProvider, providerId]);
  return (
    <View style={styles.emptyState}>
      <ThemedAlertTriangle size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
      <Text style={styles.emptyStateText}>{message}</Text>
      {onRetryProvider ? (
        <Button variant="default" size="sm" onPress={handleRetry} disabled={isRetryingProvider}>
          {isRetryingProvider ? t("modelSelector.retrying") : t("modelSelector.retry")}
        </Button>
      ) : null}
    </View>
  );
}

function ModelBrowserContent({
  view,
  providers,
  selectedProvider,
  selectedModel,
  searchQuery,
  favoriteKeys,
  onSelect,
  onToggleFavorite,
  onDrillDown,
  onRetryProvider,
  isRetryingProvider = false,
  scrolling,
}: ModelBrowserContentProps) {
  const { t } = useTranslation();
  const normalizedQuery = useMemo(() => normalizeSearchQuery(searchQuery), [searchQuery]);
  const selectedViewProvider = useMemo(
    () =>
      view.kind === "provider"
        ? providers.find((provider) => provider.id === view.providerId)
        : null,
    [providers, view],
  );
  const visibleRows = useMemo(
    () =>
      selectedViewProvider
        ? filterAndRankModelRows(getProviderModelRows(selectedViewProvider), normalizedQuery)
        : [],
    [normalizedQuery, selectedViewProvider],
  );
  const favoriteRows = useMemo(
    () => getAllProviderModelRows(providers).filter((row) => favoriteKeys.has(row.favoriteKey)),
    [favoriteKeys, providers],
  );
  const hasResults = favoriteRows.length > 0 || providers.length > 0;
  const emptyState = (
    <View style={styles.emptyState}>
      <ThemedSearch size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
      <Text style={styles.emptyStateText}>{t("modelSelector.noMatches")}</Text>
    </View>
  );

  if (view.kind === "provider") {
    if (!selectedViewProvider) return emptyState;
    const selection = selectedViewProvider.modelSelection;
    if (selection.kind === "loading") {
      return (
        <View style={styles.emptyState}>
          <View style={styles.rowSpinner}>
            <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
          </View>
          <Text style={styles.emptyStateText}>{t("modelSelector.loadingShort")}</Text>
        </View>
      );
    }
    if (selection.kind === "error") {
      return (
        <ProviderErrorEmptyState
          providerId={view.providerId}
          message={selection.message}
          onRetryProvider={onRetryProvider}
          isRetryingProvider={isRetryingProvider}
        />
      );
    }
    if (visibleRows.length === 0) return emptyState;
    return (
      <ProviderModelRows
        rows={visibleRows}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        favoriteKeys={favoriteKeys}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
        normalizedQuery={normalizedQuery}
        scrolling={scrolling}
      />
    );
  }

  const allProvidersContent = (
    <View>
      <FavoritesSection
        favoriteRows={favoriteRows}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        favoriteKeys={favoriteKeys}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
      />
      {providers.length > 0 ? (
        <GroupedProviderRows providers={providers} onDrillDown={onDrillDown} />
      ) : null}
      {!hasResults ? emptyState : null}
    </View>
  );

  return scrolling === "independent" ? (
    <IndependentProviderList>{allProvidersContent}</IndependentProviderList>
  ) : (
    allProvidersContent
  );
}

export function ModelBrowser({
  state,
  onSelect,
  onToggleFavorite,
  onRetryProvider,
  isRetryingProvider = false,
  scrolling = "sheet",
}: ModelBrowserProps) {
  return (
    <ModelBrowserContent
      view={state.view}
      providers={state.providers}
      selectedProvider={state.selectedProvider}
      selectedModel={state.selectedModel}
      searchQuery={state.searchQuery}
      favoriteKeys={state.favoriteKeys}
      onSelect={onSelect}
      onToggleFavorite={onToggleFavorite}
      onDrillDown={state.drillDown}
      onRetryProvider={onRetryProvider}
      isRetryingProvider={isRetryingProvider}
      scrolling={scrolling}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  favoritesContainer: {
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  sectionHeadingText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  browserRow: {
    flexDirection: "row",
    paddingVertical: theme.spacing[2],
    minHeight: 36,
  },
  browserModelRow: isWeb ? {} : { marginBottom: theme.spacing[1] },
  browserRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  browserRowHoveredElevated: {
    backgroundColor: theme.colors.surface2,
  },
  browserRowPressed: {
    backgroundColor: theme.colors.surface1,
  },
  browserRowPressedElevated: {
    backgroundColor: theme.colors.surface2,
  },
  browserRowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
  },
  browserRowLeading: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  browserRowText: {
    flex: 1,
    flexShrink: 1,
  },
  browserRowTextInline: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  browserRowLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  browserRowDescription: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  browserRowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: "auto",
  },
  browserRowSelection: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  drillDownTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  drillDownCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowStateInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
  },
  rowIconButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  rowSpinner: {
    transform: [{ scale: 0.7 }],
  },
  rowIconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowIconButtonPressed: {
    backgroundColor: theme.colors.surface1,
  },
  emptyState: {
    paddingVertical: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyStateText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  virtualizedModelList: {
    flex: 1,
  },
  virtualizedModelListContent: {
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[8],
  },
  virtualizedProviderListContent: {
    paddingTop: 0,
  },
  favoriteButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  favoriteButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  favoriteButtonPressed: {
    backgroundColor: theme.colors.surface1,
  },
  providerIconMuted: {
    color: theme.colors.foregroundMuted,
  },
  providerIconForeground: {
    color: theme.colors.foreground,
  },
}));
