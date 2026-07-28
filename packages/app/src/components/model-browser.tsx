import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Layers,
  Search,
  Settings,
  Star,
} from "lucide-react-native";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { SheetHeader, SheetSearchKeyPressEvent } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getProviderIcon } from "@/components/provider-icons";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import {
  buildSelectedTriggerLabel,
  getAllProviderModelRows,
  getProviderModelRows,
  resolveSelectedModelLabel,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import {
  buildAllModelsListItems,
  buildModelRowDescription,
  buildProviderModelListItems,
  countAllModels,
  normalizeModelSearchQuery,
  type ModelBrowserHeadingStatus,
  type ModelBrowserListItem,
} from "@/components/model-browser-rows";
import { moveModelHighlight, resolveModelSubmitRow } from "@/components/model-browser-keyboard";
import {
  LIST_SEARCH_SELECTOR,
  resolveListSearchKeyAction,
  type ListSearchKeyEvent,
} from "@/keyboard/list-search-keys";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { useCurrentOverlayLayer } from "@/lib/overlay-root";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  resolveInitialModelBrowserView,
  type ModelBrowserView,
} from "@/components/model-browser-view";

const EMPTY_LIST_ITEMS: ModelBrowserListItem[] = [];

const DESKTOP_PROVIDER_VIEW_MIN_HEIGHT = 220;
const DESKTOP_PROVIDER_VIEW_MAX_HEIGHT = 400;
const DESKTOP_PROVIDER_VIEW_BASE_HEIGHT = 80;
const DESKTOP_MODEL_ROW_HEIGHT = 40;

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedCheck = withUnistyles(Check);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLayers = withUnistyles(Layers);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedSearch = withUnistyles(Search);
const ThemedSettings = withUnistyles(Settings);
const ThemedStar = withUnistyles(Star);

function ProviderSettingsAction({
  accessibilityLabel,
  provider,
  serverId,
}: {
  accessibilityLabel: string;
  provider: string;
  serverId: string | null;
}) {
  const overlayParentLayer = useCurrentOverlayLayer();
  const handlePress = useCallback(() => {
    if (!serverId) return;
    useProviderSettingsStore.getState().open({ serverId, provider, overlayParentLayer });
  }, [overlayParentLayer, provider, serverId]);

  return (
    <Pressable
      onPress={handlePress}
      disabled={!serverId}
      hitSlop={8}
      style={iconButtonStyle}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`selector-header-settings-${provider}`}
    >
      <HeaderSettingsIcon disabled={!serverId} />
    </Pressable>
  );
}

const IndependentScrollGestureContext = createContext<ReturnType<typeof Gesture.Native> | null>(
  null,
);

const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const foregroundMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
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
  onSelect: (provider: string, modelId: string) => void;
  serverId?: string | null;
}

export interface ModelBrowserState {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  favoriteKeys: Set<string>;
  view: ModelBrowserView;
  /** Rows of the current model list view; empty in the provider-group view. */
  items: ModelBrowserListItem[];
  highlightedKey: string | null;
  header: SheetHeader;
  selectedModelLabel: string;
  triggerLabel: string;
  desktopFixedHeight: number | undefined;
  isModelListView: boolean;
  onSelect: (provider: string, modelId: string) => void;
  prepareToOpen: () => void;
  reset: () => void;
  drillDown: (providerId: string, providerLabel: string) => void;
  showAllModels: () => void;
  /** Web: keyboard navigation for whichever overlay hosts the browser. */
  handleOverlayKeyDown: (event: KeyboardEvent) => boolean;
}

interface ModelBrowserProps {
  state: ModelBrowserState;
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
  items: ModelBrowserListItem[];
  highlightedKey: string | null;
  favoriteKeys: Set<string>;
  onSelect: (provider: string, modelId: string) => void;
  onDrillDown: (providerId: string, providerLabel: string) => void;
  onShowAllModels: () => void;
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

function clampDesktopListHeight(rowCount: number): number {
  return Math.min(
    Math.max(
      DESKTOP_PROVIDER_VIEW_MIN_HEIGHT,
      DESKTOP_PROVIDER_VIEW_BASE_HEIGHT + rowCount * DESKTOP_MODEL_ROW_HEIGHT,
    ),
    DESKTOP_PROVIDER_VIEW_MAX_HEIGHT,
  );
}

function resolveDesktopFixedHeight(
  view: ModelBrowserView,
  providers: ProviderSelectorProvider[],
): number | undefined {
  if (view.kind === "allModels") {
    return clampDesktopListHeight(countAllModels(providers) + providers.length);
  }
  if (view.kind !== "provider") {
    return undefined;
  }
  const provider = providers.find((entry) => entry.id === view.providerId);
  if (!provider || provider.modelSelection.kind !== "models") {
    return DESKTOP_PROVIDER_VIEW_MIN_HEIGHT;
  }
  return clampDesktopListHeight(getProviderModelRows(provider).length);
}

export function useModelBrowser({
  providers,
  selectedProvider,
  selectedModel,
  isLoading,
  favoriteKeys,
  onSelect,
  serverId = null,
}: ModelBrowserInput): ModelBrowserState {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const startWithAllModels = settings.modelPickerStartsWithAllModels;
  const [view, setView] = useState<ModelBrowserView>({ kind: "all" });
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [searchResetKey, bumpSearchResetKey] = useReducer((key: number) => key + 1, 0);

  const initialView = useMemo(
    () =>
      resolveInitialModelBrowserView({
        providers,
        selectedProvider,
        selectedModel,
        favoriteKeys,
        startWithAllModels,
      }),
    [favoriteKeys, providers, selectedModel, selectedProvider, startWithAllModels],
  );

  const prepareToOpen = useCallback(() => {
    setView(initialView);
  }, [initialView]);

  const reset = useCallback(() => {
    setSearchQuery("");
    setHighlightedKey(null);
    bumpSearchResetKey();
  }, []);

  const handleBackToAll = useCallback(() => {
    setView({ kind: "all" });
    reset();
  }, [reset]);

  // Every navigation clears the query: each view owns a differently scoped
  // search, so carrying a stale one across would silently filter the new list.
  const drillDown = useCallback(
    (providerId: string, providerLabel: string) => {
      setView({ kind: "provider", providerId, providerLabel });
      reset();
    },
    [reset],
  );

  const showAllModels = useCallback(() => {
    setView({ kind: "allModels" });
    reset();
  }, [reset]);

  // Retyping re-ranks the list, so the highlight starts over: Enter then commits
  // the top result until the user moves the highlight again.
  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
    setHighlightedKey(null);
  }, []);

  const normalizedQuery = useMemo(() => normalizeModelSearchQuery(searchQuery), [searchQuery]);
  const favoritesLabel = t("modelSelector.favorites");
  const items = useMemo<ModelBrowserListItem[]>(() => {
    if (view.kind === "allModels") {
      return buildAllModelsListItems({ providers, favoriteKeys, favoritesLabel, normalizedQuery });
    }
    if (view.kind !== "provider") return EMPTY_LIST_ITEMS;
    const provider = providers.find((entry) => entry.id === view.providerId);
    if (!provider) return EMPTY_LIST_ITEMS;
    return buildProviderModelListItems({ provider, favoriteKeys, normalizedQuery });
  }, [favoriteKeys, favoritesLabel, normalizedQuery, providers, view]);

  const handleListSearchKey = useCallback(
    (event: ListSearchKeyEvent): boolean => {
      const action = resolveListSearchKeyAction(event);
      if (!action) return false;
      if (action === "submit") {
        const row = resolveModelSubmitRow(items, highlightedKey);
        if (!row) return false;
        onSelect(row.provider, row.modelId);
        return true;
      }
      const nextKey = moveModelHighlight({ items, highlightedKey, direction: action });
      if (!nextKey) return false;
      setHighlightedKey(nextKey);
      return true;
    },
    [highlightedKey, items, onSelect],
  );

  // The overlay hears every key in the sheet, and the composer's sheet also
  // hosts the agent controls below the list — only claim keys typed into the
  // search field itself.
  const handleOverlayKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest(LIST_SEARCH_SELECTOR)) return false;
      if (!handleListSearchKey(event)) return false;
      event.preventDefault();
      return true;
    },
    [handleListSearchKey],
  );

  // Fallback for hosts without a web overlay registration (the compact-width
  // sheet). On native only Enter arrives, and it arrives via onSubmitEditing.
  const handleSearchKeyPress = useCallback(
    (event: SheetSearchKeyPressEvent) => {
      if (handleListSearchKey(event.nativeEvent)) event.preventDefault();
    },
    [handleListSearchKey],
  );

  const handleSearchSubmit = useCallback(() => {
    handleListSearchKey({ key: "Enter" });
  }, [handleListSearchKey]);

  const singleProviderView = providers.length === 1;
  const header = useMemo<SheetHeader>(() => {
    if (view.kind === "all") {
      return { title: t("modelSelector.title") };
    }
    if (view.kind === "allModels") {
      return {
        title: t("modelSelector.allModels"),
        leading: <ThemedLayers size={ICON_SIZE.md} uniProps={foregroundMapping} />,
        back: { onPress: handleBackToAll },
        search: {
          onChange: handleSearchQueryChange,
          resetKey: `all-models:${searchResetKey}`,
          placeholder: t("modelSelector.searchAllModelsPlaceholder"),
          autoFocus: isWeb,
          testID: "model-search-input",
          onKeyPress: handleSearchKeyPress,
          onSubmit: handleSearchSubmit,
          ownsListNavigation: true,
        },
      };
    }
    return {
      title: view.providerLabel,
      leading: (
        <ModelProviderGlyph provider={view.providerId} size={ICON_SIZE.md} tone="foreground" />
      ),
      back: singleProviderView ? undefined : { onPress: handleBackToAll },
      actions: (
        <ProviderSettingsAction
          serverId={serverId}
          provider={view.providerId}
          accessibilityLabel={t("modelSelector.openProviderSettings", {
            provider: view.providerLabel,
          })}
        />
      ),
      search: {
        onChange: handleSearchQueryChange,
        resetKey: `${view.providerId}:${searchResetKey}`,
        placeholder: t("modelSelector.searchPlaceholder"),
        autoFocus: isWeb,
        testID: "model-search-input",
        onKeyPress: handleSearchKeyPress,
        onSubmit: handleSearchSubmit,
        ownsListNavigation: true,
      },
    };
  }, [
    handleBackToAll,
    handleSearchKeyPress,
    handleSearchQueryChange,
    handleSearchSubmit,
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
    items,
    highlightedKey,
    header,
    selectedModelLabel,
    triggerLabel,
    desktopFixedHeight,
    isModelListView: view.kind !== "all",
    onSelect,
    prepareToOpen,
    reset,
    drillDown,
    showAllModels,
    handleOverlayKeyDown,
  };
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

/**
 * Keeps the keyboard-highlighted row visible. Highlight moves are clamped to
 * neighbouring rows (see model-browser-keyboard.ts), so the target row is always
 * mounted and `block: "nearest"` scrolls the smallest amount that reveals it.
 * Web-only: the keys that drive the highlight need a hardware keyboard.
 */
function useScrollHighlightIntoView(highlighted: boolean | undefined) {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (!isWeb || !highlighted) return;
    const node = ref.current as unknown as {
      scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
    } | null;
    node?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);
  return ref;
}

function ModelBrowserRow({
  label,
  description,
  leadingSlot,
  trailingSlot,
  accessory,
  selected = false,
  selectionIndicator = false,
  highlighted,
  tone = "default",
  spacing = "model",
  onPress,
  testID,
}: {
  label: string;
  description?: string;
  leadingSlot: React.ReactNode;
  trailingSlot?: React.ReactNode;
  accessory?: React.ReactNode;
  selected?: boolean;
  selectionIndicator?: boolean;
  /** Undefined for rows the keyboard never highlights (provider drill-downs). */
  highlighted?: boolean;
  tone?: ModelBrowserRowTone;
  spacing?: "model" | "provider";
  onPress: () => void;
  testID?: string;
}) {
  const highlightRef = useScrollHighlightIntoView(highlighted);
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.browserRow,
      Boolean(accessory) && styles.browserRowWithAccessory,
      spacing === "model" && styles.browserModelRow,
      Boolean(hovered) &&
        (tone === "elevated" ? styles.browserRowHoveredElevated : styles.browserRowHovered),
      // Painted after hover so the keyboard highlight wins when the pointer
      // happens to rest on a different row than the one being navigated.
      highlighted && styles.browserRowHighlighted,
      pressed && (tone === "default" ? styles.browserRowPressed : styles.browserRowPressedElevated),
    ],
    [accessory, highlighted, spacing, tone],
  );
  const contentStyle = useMemo(
    () => [styles.browserRowText, description && styles.browserRowTextInline],
    [description],
  );
  const hasTrailing = selected || trailingSlot;

  const row = (
    <ModelBrowserPressable onPress={onPress} style={pressableStyle} testID={testID}>
      <View
        style={[styles.browserRowContent, accessory ? styles.browserRowContentWithAccessory : null]}
      >
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

  const rowWithAccessory = accessory ? (
    <View style={styles.browserRowContainer}>
      {row}
      <View style={styles.browserRowAccessory}>{accessory}</View>
    </View>
  ) : (
    row
  );

  if (highlighted === undefined) return rowWithAccessory;
  // Anchor for scroll-into-view: ModelBrowserPressable renders a Pressable or a
  // GestureDetector depending on platform, neither of which forwards a ref.
  return (
    <View ref={highlightRef} collapsable={false}>
      {rowWithAccessory}
    </View>
  );
}

function ModelRow({
  row,
  isSelected,
  isHighlighted = false,
  isFavorite,
  elevated = false,
  showProvider = false,
  onPress,
  onToggleFavorite,
}: {
  row: ProviderSelectionModelRow;
  isSelected: boolean;
  isHighlighted?: boolean;
  isFavorite: boolean;
  elevated?: boolean;
  showProvider?: boolean;
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
      description={buildModelRowDescription(row, showProvider)}
      selected={isSelected}
      selectionIndicator
      highlighted={isHighlighted}
      tone={elevated ? "elevated" : "default"}
      onPress={onPress}
      leadingSlot={leadingSlot}
      accessory={trailingSlot}
    />
  );
}

function SelectableModelRow({
  row,
  isSelected,
  isHighlighted,
  isFavorite,
  elevated,
  showProvider,
  onSelect,
  onToggleFavorite,
}: {
  row: ProviderSelectionModelRow;
  isSelected: boolean;
  isHighlighted?: boolean;
  isFavorite: boolean;
  elevated?: boolean;
  showProvider?: boolean;
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
      isHighlighted={isHighlighted}
      isFavorite={isFavorite}
      elevated={elevated}
      showProvider={showProvider}
      onPress={handlePress}
      onToggleFavorite={onToggleFavorite}
    />
  );
}

function headingPressableStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.sectionHeading,
    Boolean(hovered) && styles.browserRowHovered,
    pressed && styles.browserRowPressed,
  ];
}

function ModelGroupHeading({
  label,
  status,
  providerId,
  onDrillDown,
}: {
  label: string;
  status?: ModelBrowserHeadingStatus;
  providerId?: string;
  onDrillDown: (providerId: string, providerLabel: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (providerId) onDrillDown(providerId, label);
  }, [label, onDrillDown, providerId]);
  const statusNode = status ? (
    <Text style={styles.sectionHeadingStatus}>
      {t(status === "loading" ? "modelSelector.loadingShort" : "modelSelector.error")}
    </Text>
  ) : null;

  // A failed provider's retry lives in its own view, so the flat catalog would
  // otherwise dead-end on "Error" with no way to act on it.
  if (status === "error" && providerId) {
    return (
      <ModelBrowserPressable
        onPress={handlePress}
        style={headingPressableStyle}
        accessibilityLabel={`${label} — ${t("modelSelector.error")}`}
        testID={`model-group-heading-${label}`}
      >
        <Text style={styles.sectionHeadingText} numberOfLines={1}>
          {label}
        </Text>
        {statusNode}
        <ThemedChevronRight size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </ModelBrowserPressable>
    );
  }

  return (
    <View style={styles.sectionHeading} accessibilityRole="header">
      <Text style={styles.sectionHeadingText} numberOfLines={1}>
        {label}
      </Text>
      {statusNode}
    </View>
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

function AllModelsButton({ count, onPress }: { count: number; onPress: () => void }) {
  const { t } = useTranslation();
  const leadingSlot = useMemo(
    () => <ThemedLayers size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />,
    [],
  );
  const trailingSlot = useMemo(
    () => (
      <View style={styles.drillDownTrailing}>
        <Text style={styles.drillDownCount}>
          {t(count === 1 ? "modelSelector.modelCount" : "modelSelector.modelCountPlural", {
            count,
          })}
        </Text>
        <ThemedChevronRight size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </View>
    ),
    [count, t],
  );

  return (
    <ModelBrowserRow
      label={t("modelSelector.allModels")}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
      tone="drillDown"
      spacing="provider"
      onPress={onPress}
      testID="model-all-models"
    />
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
  items,
  renderItem,
}: {
  items: ModelBrowserListItem[];
  renderItem: ({ item }: { item: ModelBrowserListItem }) => React.ReactElement;
}) {
  return (
    <IndependentScrollBoundary>
      <FlatList
        data={items}
        renderItem={renderItem}
        keyExtractor={getModelListItemKey}
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

function getModelListItemKey(item: ModelBrowserListItem): string {
  return item.key;
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

function ModelListBody({
  items,
  selectedProvider,
  selectedModel,
  highlightedKey,
  favoriteKeys,
  onSelect,
  onToggleFavorite,
  onDrillDown,
  scrolling,
}: {
  items: ModelBrowserListItem[];
  selectedProvider: string;
  selectedModel: string;
  highlightedKey: string | null;
  favoriteKeys: Set<string>;
  onSelect: (provider: string, modelId: string) => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  onDrillDown: (providerId: string, providerLabel: string) => void;
  scrolling: "sheet" | "independent";
}) {
  const isCompact = useIsCompactFormFactor();
  const renderItem = useCallback(
    ({ item }: { item: ModelBrowserListItem }) => {
      if (item.kind === "heading") {
        return (
          <ModelGroupHeading
            label={item.label}
            status={item.status}
            providerId={item.providerId}
            onDrillDown={onDrillDown}
          />
        );
      }
      return (
        <SelectableModelRow
          row={item.row}
          isSelected={item.row.provider === selectedProvider && item.row.modelId === selectedModel}
          isHighlighted={item.key === highlightedKey}
          isFavorite={favoriteKeys.has(item.row.favoriteKey)}
          showProvider={item.showProvider}
          onSelect={onSelect}
          onToggleFavorite={onToggleFavorite}
        />
      );
    },
    [
      favoriteKeys,
      highlightedKey,
      onDrillDown,
      onSelect,
      onToggleFavorite,
      selectedModel,
      selectedProvider,
    ],
  );

  if (scrolling === "independent") {
    return <IndependentModelList items={items} renderItem={renderItem} />;
  }

  if (isCompact && isNative) {
    return (
      <BottomSheetFlatList
        data={items}
        renderItem={renderItem}
        keyExtractor={getModelListItemKey}
        style={styles.virtualizedModelList}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.virtualizedModelListContent}
      />
    );
  }

  return (
    <View>
      {items.map((item) => (
        <View key={item.key}>{renderItem({ item })}</View>
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
  items,
  highlightedKey,
  favoriteKeys,
  onSelect,
  onToggleFavorite,
  onDrillDown,
  onShowAllModels,
  onRetryProvider,
  isRetryingProvider = false,
  scrolling,
}: ModelBrowserContentProps) {
  const { t } = useTranslation();
  const selectedViewProvider = useMemo(
    () =>
      view.kind === "provider"
        ? providers.find((provider) => provider.id === view.providerId)
        : null,
    [providers, view],
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

  if (view.kind === "allModels") {
    if (items.length === 0) return emptyState;
    return (
      <ModelListBody
        items={items}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        highlightedKey={highlightedKey}
        favoriteKeys={favoriteKeys}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
        onDrillDown={onDrillDown}
        scrolling={scrolling}
      />
    );
  }

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
    if (items.length === 0) return emptyState;
    return (
      <ModelListBody
        items={items}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        highlightedKey={highlightedKey}
        favoriteKeys={favoriteKeys}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
        onDrillDown={onDrillDown}
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
      {providers.length > 1 ? (
        <>
          <AllModelsButton count={countAllModels(providers)} onPress={onShowAllModels} />
          <View style={styles.separator} />
        </>
      ) : null}
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
      items={state.items}
      highlightedKey={state.highlightedKey}
      favoriteKeys={state.favoriteKeys}
      onSelect={state.onSelect}
      onToggleFavorite={onToggleFavorite}
      onDrillDown={state.drillDown}
      onShowAllModels={state.showAllModels}
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
    flexShrink: 1,
  },
  sectionHeadingStatus: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginLeft: "auto",
  },
  browserRow: {
    flexDirection: "row",
    paddingVertical: theme.spacing[2],
    minHeight: 36,
  },
  browserRowWithAccessory: {
    flex: 1,
  },
  browserRowContainer: {
    flexDirection: "row",
  },
  browserModelRow: isWeb ? {} : { marginBottom: theme.spacing[1] },
  browserRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  browserRowHoveredElevated: {
    backgroundColor: theme.colors.surface2,
  },
  browserRowHighlighted: {
    backgroundColor: theme.colors.surface3,
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
  browserRowContentWithAccessory: {
    paddingRight: 0,
  },
  browserRowAccessory: {
    alignItems: "center",
    justifyContent: "center",
    marginRight: isWeb ? theme.spacing[3] : theme.spacing[6],
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
