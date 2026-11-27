import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
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
  type FocusEvent,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  FlatList as SheetFlatList,
  ScrollView as SheetScrollView,
} from "@/components/ui/scroll-view";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  Settings,
} from "lucide-react-native";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  AgentProfileGlyph,
  type AgentProfile,
  type AgentProfilePicker,
  type AgentProfilePickerRow as AgentProfilePickerRowModel,
  type AgentProfileSeed,
} from "@/agent-profiles";
import {
  SheetHeaderIconButton,
  type SheetHeader,
  type SheetKeyboard,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useRevealActiveFlatListRow, useRevealActiveItem } from "@/components/ui/scroll-reveal";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProviderIcon } from "@/components/provider-icons";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useHardwareKeyboardPresent, type KeyboardInputEvent } from "@/keyboard";
import {
  buildProviderQualifiedDescription,
  buildSelectedTriggerLabel,
  getAllProviderModelRows,
  getProviderModelRows,
  resolveSelectedModelLabel,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { useCurrentOverlayLayer } from "@/lib/overlay-root";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  focusCameFromKeyboard,
  focusedModelBrowserControlOwnsEnter,
} from "@/components/model-browser-focus";
import {
  MODEL_BROWSER_CREATE_PROFILE_KEY,
  MODEL_BROWSER_KEYBOARD_KEYS,
  groupProfilesByProviderModel,
  modelBrowserModelKey,
  modelBrowserProfileKey,
  modelBrowserProviderKey,
  resolveActiveModelBrowserKey,
  resolveInitialModelBrowserView,
  resolveModelBrowserKeyCommand,
  resolveModelBrowserProjection,
  type ModelBrowserNavItem,
  type ModelBrowserProfileSection,
  type ModelBrowserProjection,
  type ModelBrowserView,
} from "@/components/model-browser-view";

const ROW_DATASET = { modelBrowserRow: "true" };
const ACTIVE_ROW_DATASET = { modelBrowserRow: "true", active: "true" };

const DESKTOP_PROVIDER_VIEW_MIN_HEIGHT = 220;
const DESKTOP_PROVIDER_VIEW_MAX_HEIGHT = 400;
const DESKTOP_PROVIDER_VIEW_BASE_HEIGHT = 80;
const DESKTOP_MODEL_ROW_HEIGHT = 40;

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedCheck = withUnistyles(Check);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedPencil = withUnistyles(Pencil);
const ThemedPlus = withUnistyles(Plus);
const ThemedSearch = withUnistyles(Search);

function ProviderSettingsAction({
  label,
  provider,
  serverId,
}: {
  label: string;
  provider: string;
  serverId: string | null;
}) {
  const overlayParentLayer = useCurrentOverlayLayer();
  const handlePress = useCallback(() => {
    if (!serverId) return;
    useProviderSettingsStore.getState().open({ serverId, provider, overlayParentLayer });
  }, [overlayParentLayer, provider, serverId]);

  return (
    <SheetHeaderIconButton
      icon={Settings}
      label={label}
      onPress={handlePress}
      disabled={!serverId}
      testID={`selector-header-settings-${provider}`}
    />
  );
}

/**
 * An icon button that explains itself in a tooltip on desktop hover. Tooltips
 * never open on mobile, so native renders the shared gesture-aware pressable
 * instead of a plain Pressable: inside the model list's independent scroll
 * viewport (Android, wide windows) the native scroll gesture cancels a plain
 * Pressable's touches and the button would never fire.
 */
function IconActionButton({
  accessibilityLabel,
  testID,
  onPress,
  style,
  children,
}: {
  accessibilityLabel: string;
  testID: string;
  onPress: () => void;
  style?:
    | StyleProp<ViewStyle>
    | ((state: PressableStateCallbackType & { hovered?: boolean }) => StyleProp<ViewStyle>);
  children: React.ReactNode;
}) {
  if (isNative) {
    return (
      <ModelBrowserPressable
        onPress={onPress}
        hitSlop={8}
        style={style}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        {children}
      </ModelBrowserPressable>
    );
  }
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={onPress}
          hitSlop={8}
          style={style}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{accessibilityLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function AgentProfilesEditAction({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <IconActionButton
      onPress={onPress}
      style={iconButtonStyle}
      accessibilityLabel={t("modelSelector.editProfilesLabel")}
      testID="model-profiles-edit"
    >
      <ThemedPencil size={ICON_SIZE.xs} uniProps={foregroundExtraMutedMapping} />
    </IconActionButton>
  );
}

const IndependentScrollGestureContext = createContext<ReturnType<typeof Gesture.Native> | null>(
  null,
);

interface ModelBrowserNavContextValue {
  activeKey: string | null;
  onActivateKey: (key: string) => void;
  activeItemRef?: RefObject<View | null>;
  onActiveLayout?: () => void;
}

const ModelBrowserNavContext = createContext<ModelBrowserNavContextValue>({
  activeKey: null,
  onActivateKey: () => {},
});

const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const foregroundExtraMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});

interface ModelBrowserInput {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  isLoading: boolean;
  autoFocusSearch?: boolean;
  /** Pinned above the provider list on the root view. `null` hides the section. */
  profiles?: AgentProfilePicker | null;
  serverId?: string | null;
}

export interface ModelBrowserState {
  serverId: string | null;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  profiles: AgentProfilePicker | null;
  view: ModelBrowserView;
  searchQuery: string;
  isSearchFocused: boolean;
  header: SheetHeader;
  keyboard: SheetKeyboard;
  selectedModelLabel: string;
  triggerLabel: string;
  desktopFixedHeight: number | undefined;
  isProviderView: boolean;
  explicitActiveKey: string | null;
  preferredActiveKey: string | null;
  setActiveKey: (key: string | null) => void;
  focusSearchInput: () => void;
  registerKeyboardHandler: (handler: ((event: KeyboardInputEvent) => boolean) | null) => void;
  prepareToOpen: () => void;
  showAll: (fromProviderId?: string) => void;
  reset: () => void;
  drillDown: (providerId: string, providerLabel: string) => void;
}

interface ModelBrowserProps {
  state: ModelBrowserState;
  onSelect: (provider: string, modelId: string) => void;
  /** Applying a profile resolves the pick and dismisses, exactly like a model row. */
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  scrolling?: "sheet" | "independent";
  /** Empty focused search shows all model rows instead of the browse root. */
  searchAllOnFocus?: boolean;
  /** Replaces provider rows only while the all-provider search is empty. */
  rootBrowseContent?: React.ReactNode;
  /** Hide the pinned Profiles section while still using rows for model matching. */
  showProfilesSection?: boolean;
}

interface ModelBrowserContentProps extends Omit<ModelBrowserProps, "state" | "scrolling"> {
  serverId: string | null;
  view: ModelBrowserView;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  searchQuery: string;
  isSearchFocused: boolean;
  profiles: AgentProfilePicker | null;
  explicitActiveKey: string | null;
  preferredActiveKey: string | null;
  onActivateKey: (key: string | null) => void;
  onFocusSearchInput: () => void;
  registerKeyboardHandler: (handler: ((event: KeyboardInputEvent) => boolean) | null) => void;
  onShowAll: (fromProviderId?: string) => void;
  onDrillDown: (providerId: string, providerLabel: string) => void;
  scrolling: "sheet" | "independent";
  searchAllOnFocus: boolean;
  rootBrowseContent?: React.ReactNode;
}

type ProviderGlyphTone = "muted" | "foreground";

export function ModelProviderGlyph({
  provider,
  serverId,
  size,
  strokeWidth,
  tone = "muted",
}: {
  provider: string;
  serverId: string | null;
  size: number;
  strokeWidth?: number;
  tone?: ProviderGlyphTone;
}) {
  const Icon = useProviderIcon(provider, serverId);
  const color =
    tone === "foreground" ? styles.providerIconForeground.color : styles.providerIconMuted.color;
  return <Icon size={size} strokeWidth={strokeWidth} color={color} />;
}

function iconButtonStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.rowIconButton,
    Boolean(hovered) && styles.rowIconButtonHovered,
    pressed && styles.rowIconButtonPressed,
  ];
}

function countModelsInView(view: ModelBrowserView, providers: ProviderSelectorProvider[]): number {
  if (view.kind === "all") {
    return getAllProviderModelRows(providers).length;
  }
  const provider = providers.find((entry) => entry.id === view.providerId);
  return provider?.modelSelection.kind === "models" ? getProviderModelRows(provider).length : 0;
}

function resolveDesktopFixedHeight(
  view: ModelBrowserView,
  providers: ProviderSelectorProvider[],
): number {
  const modelCount = countModelsInView(view, providers);
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
  autoFocusSearch = isWeb,
  profiles = null,
  serverId = null,
}: ModelBrowserInput): ModelBrowserState {
  const { t } = useTranslation();
  const [view, setView] = useState<ModelBrowserView>({ kind: "all" });
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [explicitActiveKey, setExplicitActiveKey] = useState<string | null>(null);
  const [preferredActiveKey, setPreferredActiveKey] = useState<string | null>(null);
  const [searchResetKey, bumpSearchResetKey] = useReducer((key: number) => key + 1, 0);
  const searchInputRef = useRef<EditingTextInputHandle | null>(null);
  const keyboardHandlerRef = useRef<((event: KeyboardInputEvent) => boolean) | null>(null);
  const hasProfiles = (profiles?.rows.length ?? 0) > 0;

  const focusSearchInput = useCallback(() => {
    if (!autoFocusSearch) return;
    searchInputRef.current?.focus();
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [autoFocusSearch]);

  const initialView = useMemo(
    () =>
      resolveInitialModelBrowserView({
        providers,
        selectedProvider,
        selectedModel,
        hasProfiles,
      }),
    [hasProfiles, providers, selectedModel, selectedProvider],
  );

  const prepareToOpen = useCallback(() => {
    setView(initialView);
    setExplicitActiveKey(null);
    setPreferredActiveKey(null);
    focusSearchInput();
  }, [focusSearchInput, initialView]);

  const reset = useCallback(() => {
    setSearchQuery("");
    setIsSearchFocused(false);
    setExplicitActiveKey(null);
    setPreferredActiveKey(null);
    bumpSearchResetKey();
  }, []);

  const showAll = useCallback(
    (fromProviderId?: string) => {
      setView({ kind: "all" });
      setSearchQuery("");
      setIsSearchFocused(false);
      setExplicitActiveKey(null);
      setPreferredActiveKey(fromProviderId ? modelBrowserProviderKey(fromProviderId) : null);
      bumpSearchResetKey();
      focusSearchInput();
    },
    [focusSearchInput],
  );

  const drillDown = useCallback(
    (providerId: string, providerLabel: string) => {
      setView({ kind: "provider", providerId, providerLabel });
      reset();
      focusSearchInput();
    },
    [focusSearchInput, reset],
  );

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
    setExplicitActiveKey(null);
    setPreferredActiveKey(null);
  }, []);

  const setActiveKey = useCallback((key: string | null) => {
    setExplicitActiveKey(key);
    setPreferredActiveKey(null);
  }, []);

  const registerKeyboardHandler = useCallback(
    (handler: ((event: KeyboardInputEvent) => boolean) | null) => {
      keyboardHandlerRef.current = handler;
    },
    [],
  );

  const keyboard = useMemo<SheetKeyboard>(
    () => ({
      keys: MODEL_BROWSER_KEYBOARD_KEYS,
      onKeyDown: (event) => keyboardHandlerRef.current?.(event) ?? false,
    }),
    [],
  );

  const singleProviderView = providers.length === 1;
  const header = useMemo<SheetHeader>(() => {
    if (view.kind === "all") {
      return {
        title: t("modelSelector.title"),
        search: {
          onChange: handleSearchQueryChange,
          onFocus: () => setIsSearchFocused(true),
          onBlur: () => setIsSearchFocused(false),
          resetKey: `all:${searchResetKey}`,
          placeholder: t("modelSelector.searchAllPlaceholder"),
          autoFocus: autoFocusSearch,
          inputRef: searchInputRef,
          testID: "model-search-all-input",
        },
      };
    }
    return {
      title: view.providerLabel,
      leading: (
        <ModelProviderGlyph
          provider={view.providerId}
          serverId={serverId}
          size={ICON_SIZE.md}
          tone="foreground"
        />
      ),
      back: singleProviderView ? undefined : { onPress: () => showAll(view.providerId) },
      actions: (
        <ProviderSettingsAction
          serverId={serverId}
          provider={view.providerId}
          label={t("modelSelector.openProviderSettings", { provider: view.providerLabel })}
        />
      ),
      search: {
        onChange: handleSearchQueryChange,
        onFocus: () => setIsSearchFocused(true),
        onBlur: () => setIsSearchFocused(false),
        resetKey: `${view.providerId}:${searchResetKey}`,
        placeholder: t("modelSelector.searchPlaceholder"),
        autoFocus: autoFocusSearch,
        inputRef: searchInputRef,
        testID: "model-search-input",
      },
    };
  }, [
    autoFocusSearch,
    handleSearchQueryChange,
    searchResetKey,
    serverId,
    singleProviderView,
    showAll,
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
    serverId,
    providers,
    selectedProvider,
    selectedModel,
    profiles,
    view,
    searchQuery,
    isSearchFocused,
    header,
    keyboard,
    selectedModelLabel,
    triggerLabel,
    desktopFixedHeight,
    isProviderView: view.kind === "provider",
    explicitActiveKey,
    preferredActiveKey,
    setActiveKey,
    focusSearchInput,
    registerKeyboardHandler,
    prepareToOpen,
    showAll,
    reset,
    drillDown,
  };
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

interface ModelBrowserPressableProps {
  children: React.ReactNode | ((state: PressableStateCallbackType) => React.ReactNode);
  style?:
    | StyleProp<ViewStyle>
    | ((state: PressableStateCallbackType & { hovered?: boolean }) => StyleProp<ViewStyle>);
  onPress: () => void;
  onFocus?: () => void;
  hitSlop?: number;
  accessibilityLabel?: string;
  /** Only rows that can express selection pass this; the rest stay unannotated. */
  accessibilitySelected?: boolean;
  navRow?: boolean;
  active?: boolean;
  rowRef?: RefObject<View | null>;
  onLayout?: () => void;
  testID?: string;
}

function ModelBrowserPressable({
  children,
  style,
  onPress,
  onFocus,
  hitSlop,
  accessibilityLabel,
  accessibilitySelected,
  navRow = false,
  active = false,
  rowRef,
  onLayout,
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
  const handleFocus = useCallback(
    (event: FocusEvent) => {
      if (onFocus && focusCameFromKeyboard(event.target)) onFocus();
    },
    [onFocus],
  );
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "activate") onPress();
    },
    [onPress],
  );
  const accessibilityState = useMemo(
    () => (accessibilitySelected === undefined ? undefined : { selected: accessibilitySelected }),
    [accessibilitySelected],
  );
  let dataSet: typeof ROW_DATASET | typeof ACTIVE_ROW_DATASET | undefined;
  if (navRow) {
    dataSet = active ? ACTIVE_ROW_DATASET : ROW_DATASET;
  }

  if (!independentScrollGesture) {
    return (
      <Pressable
        ref={rowRef}
        onLayout={onLayout}
        onPress={handlePress}
        onFocus={handleFocus}
        hitSlop={hitSlop}
        style={style}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        aria-selected={accessibilitySelected}
        dataSet={dataSet}
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
        ref={rowRef}
        onLayout={onLayout}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        aria-selected={accessibilitySelected}
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={handleAccessibilityAction}
        style={resolvedStyle}
        dataSet={dataSet}
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
  active = false,
  selectionIndicator = false,
  tone = "default",
  labelMuted = false,
  spacing = "model",
  onPress,
  onFocus,
  activeItemRef,
  onActiveLayout,
  testID,
}: {
  label: string;
  description?: string;
  leadingSlot: React.ReactNode;
  trailingSlot?: React.ReactNode;
  selected?: boolean;
  active?: boolean;
  selectionIndicator?: boolean;
  tone?: ModelBrowserRowTone;
  /** For rows that offer an action rather than name a thing you can pick. */
  labelMuted?: boolean;
  spacing?: "model" | "provider";
  onPress: () => void;
  onFocus?: () => void;
  activeItemRef?: RefObject<View | null>;
  onActiveLayout?: () => void;
  testID?: string;
}) {
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.browserRow,
      spacing === "model" && styles.browserModelRow,
      (Boolean(hovered) || active) &&
        (tone === "elevated" ? styles.browserRowHoveredElevated : styles.browserRowHovered),
      pressed && (tone === "default" ? styles.browserRowPressed : styles.browserRowPressedElevated),
    ],
    [active, spacing, tone],
  );
  const contentStyle = useMemo(
    () => [styles.browserRowText, description && styles.browserRowTextInline],
    [description],
  );
  const hasTrailing = selected || trailingSlot;

  return (
    <ModelBrowserPressable
      onPress={onPress}
      onFocus={onFocus}
      style={pressableStyle}
      // A profile row is an action, not a selection, so it carries no selection
      // state at all — only rows that draw the checkmark claim one.
      accessibilitySelected={selectionIndicator ? selected : undefined}
      navRow
      active={active}
      rowRef={active ? activeItemRef : undefined}
      onLayout={active ? onActiveLayout : undefined}
      testID={testID}
    >
      <View style={styles.browserRowContent}>
        <View style={styles.browserRowLeading}>{leadingSlot}</View>
        <View style={contentStyle}>
          <Text
            numberOfLines={1}
            style={labelMuted ? styles.browserRowLabelMuted : styles.browserRowLabel}
          >
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

function ModelRowProfileAction({
  hovered,
  onPress,
  label,
  testID,
  children,
}: {
  hovered: boolean;
  onPress: () => void;
  label: string;
  testID: string;
  children: React.ReactNode;
}) {
  const isCompact = useIsCompactFormFactor();
  const visible = hovered || isNative || isCompact;
  const pressableStyle = useCallback(
    ({ hovered: buttonHovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.rowIconButton,
      Boolean(buttonHovered) && styles.rowIconButtonHovered,
      pressed && styles.rowIconButtonPressed,
      !visible && styles.profileActionHidden,
    ],
    [visible],
  );
  return (
    <IconActionButton
      onPress={onPress}
      style={pressableStyle}
      accessibilityLabel={label}
      testID={testID}
    >
      {children}
    </IconActionButton>
  );
}

function ModelRow({
  row,
  serverId,
  isSelected,
  isActive = false,
  showProviderLabel = false,
  onPress,
  onFocus,
  profiledRows,
  onCreateProfile,
  onEditProfile,
  onEditProfiles,
}: {
  row: ProviderSelectionModelRow;
  serverId: string | null;
  isSelected: boolean;
  isActive?: boolean;
  showProviderLabel?: boolean;
  onPress: () => void;
  onFocus?: () => void;
  profiledRows: AgentProfilePickerRowModel[];
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const leadingSlot = useMemo(
    () => <ModelProviderGlyph provider={row.provider} serverId={serverId} size={ICON_SIZE.sm} />,
    [row.provider, serverId],
  );

  const description = showProviderLabel ? buildProviderQualifiedDescription(row) : row.description;
  const primary = profiledRows[profiledRows.length - 1];

  const handleCreateProfile = useCallback(() => {
    onCreateProfile?.({
      provider: row.provider,
      modelId: row.modelId,
      name: row.modelLabel,
    });
  }, [onCreateProfile, row.modelId, row.modelLabel, row.provider]);

  const handleEditProfile = useCallback(() => {
    onEditProfile?.(primary.id);
  }, [onEditProfile, primary]);

  const handleEditProfiles = useCallback(() => {
    onEditProfiles?.();
  }, [onEditProfiles]);

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const profileAction = useMemo(() => {
    if (row.modelId.length === 0) {
      return null;
    }
    if (profiledRows.length === 0) {
      if (!onCreateProfile) {
        return null;
      }
      return (
        <ModelRowProfileAction
          hovered={isHovered}
          onPress={handleCreateProfile}
          label={t("modelSelector.createProfileFromModel")}
          testID={`model-create-profile-${row.provider}-${row.modelId}`}
        >
          <ThemedPlus size={ICON_SIZE.xs} uniProps={foregroundMutedMapping} />
        </ModelRowProfileAction>
      );
    }
    if (profiledRows.length === 1) {
      if (!onEditProfile) {
        return null;
      }
      return (
        <ModelRowProfileAction
          hovered={isHovered}
          onPress={handleEditProfile}
          label={t("modelSelector.editProfileLabel", { name: primary.name })}
          testID={`model-edit-profile-${row.provider}-${row.modelId}`}
        >
          <AgentProfileGlyph
            icon={primary.icon}
            color={primary.color}
            provider={primary.provider}
            serverId={serverId}
            size={ICON_SIZE.xs}
          />
        </ModelRowProfileAction>
      );
    }
    if (!onEditProfiles) {
      return null;
    }
    return (
      <ModelRowProfileAction
        hovered={isHovered}
        onPress={handleEditProfiles}
        label={t("modelSelector.editProfilesCount", { count: profiledRows.length })}
        testID={`model-edit-profiles-${row.provider}-${row.modelId}`}
      >
        <AgentProfileGlyph
          icon={primary.icon}
          color={primary.color}
          provider={primary.provider}
          serverId={serverId}
          size={ICON_SIZE.xs}
        />
      </ModelRowProfileAction>
    );
  }, [
    handleCreateProfile,
    handleEditProfile,
    handleEditProfiles,
    isHovered,
    onCreateProfile,
    onEditProfile,
    onEditProfiles,
    primary,
    profiledRows,
    row.modelId,
    row.provider,
    serverId,
    t,
  ]);

  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.browserRow,
      (Boolean(hovered) || isActive) && styles.browserRowHovered,
      pressed && styles.browserRowPressed,
    ],
    [isActive],
  );

  return (
    <View
      style={[styles.modelRowHoverBoundary, styles.browserModelRow]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <ModelBrowserPressable
        onPress={onPress}
        onFocus={onFocus}
        style={pressableStyle}
        accessibilitySelected={isSelected}
        navRow
        active={isActive}
        testID={`model-row-${row.provider}-${row.modelId}`}
      >
        <View style={styles.browserRowContent}>
          <View style={styles.browserRowLeading}>{leadingSlot}</View>
          <View style={[styles.browserRowText, description && styles.browserRowTextInline]}>
            <Text numberOfLines={1} style={styles.browserRowLabel}>
              {row.modelLabel}
            </Text>
            {description ? (
              <Text numberOfLines={1} style={styles.browserRowDescription}>
                {description}
              </Text>
            ) : null}
          </View>
          <View style={styles.browserRowTrailing}>
            <View style={styles.browserRowSelection}>
              {isSelected ? (
                <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
              ) : null}
            </View>
            {profileAction ? <View style={styles.rowIconButton} /> : null}
          </View>
        </View>
      </ModelBrowserPressable>
      {/* The row renders a <button> on web, so its profile action sits beside it,
          over the slot reserved above, rather than inside it. */}
      {profileAction ? (
        <View style={styles.modelRowProfileActionSlot} pointerEvents="box-none">
          {profileAction}
        </View>
      ) : null}
    </View>
  );
}

function SelectableModelRow({
  row,
  serverId,
  isSelected,
  showProviderLabel,
  onSelect,
  profiledRows,
  onCreateProfile,
  onEditProfile,
  onEditProfiles,
}: {
  row: ProviderSelectionModelRow;
  serverId: string | null;
  isSelected: boolean;
  showProviderLabel?: boolean;
  onSelect: (provider: string, modelId: string) => void;
  profiledRows: AgentProfilePickerRowModel[];
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const { activeKey, onActivateKey } = useContext(ModelBrowserNavContext);
  const rowKey = modelBrowserModelKey(row.favoriteKey);
  const handlePress = useCallback(() => {
    onSelect(row.provider, row.modelId);
  }, [onSelect, row.modelId, row.provider]);
  const handleFocus = useCallback(() => {
    onActivateKey(rowKey);
  }, [onActivateKey, rowKey]);
  return (
    <ModelRow
      row={row}
      serverId={serverId}
      isSelected={isSelected}
      isActive={activeKey === rowKey}
      showProviderLabel={showProviderLabel}
      onPress={handlePress}
      onFocus={handleFocus}
      profiledRows={profiledRows}
      onCreateProfile={onCreateProfile}
      onEditProfile={onEditProfile}
      onEditProfiles={onEditProfiles}
    />
  );
}

function AgentProfilePickerRowView({
  row,
  serverId,
  onApply,
}: {
  row: AgentProfilePickerRowModel;
  serverId: string | null;
  onApply: (profileId: string) => void;
}) {
  const { activeKey, onActivateKey, activeItemRef, onActiveLayout } =
    useContext(ModelBrowserNavContext);
  const rowKey = modelBrowserProfileKey(row.id);
  const handlePress = useCallback(() => onApply(row.id), [onApply, row.id]);
  const handleFocus = useCallback(() => onActivateKey(rowKey), [onActivateKey, rowKey]);
  const leadingSlot = useMemo(
    () => (
      <AgentProfileGlyph
        icon={row.icon}
        color={row.color}
        provider={row.provider}
        serverId={serverId}
        size={ICON_SIZE.sm}
      />
    ),
    [row.color, row.icon, row.provider, serverId],
  );
  return (
    <ModelBrowserRow
      label={row.name}
      description={row.summary}
      tone="elevated"
      active={activeKey === rowKey}
      activeItemRef={activeItemRef}
      onActiveLayout={onActiveLayout}
      onPress={handlePress}
      onFocus={handleFocus}
      leadingSlot={leadingSlot}
      testID={`model-profile-row-${row.id}`}
    />
  );
}

/**
 * Pinned above the provider list. Rows are actions, not selections: applying a
 * profile writes its values into the composer and nothing stays bound to it, so
 * there is no checkmark and no active row to show.
 */
function AgentProfilesPickerSection({
  rows,
  serverId,
  onApplyProfile,
  onEditProfiles,
}: {
  rows: AgentProfilePickerRowModel[];
  serverId: string | null;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const { t } = useTranslation();
  const handleApply = useCallback(
    (profileId: string) => onApplyProfile?.(profileId),
    [onApplyProfile],
  );
  return (
    <View style={styles.profilesContainer}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionHeadingText}>{t("modelSelector.profiles")}</Text>
        {onEditProfiles ? (
          <View style={styles.sectionHeadingAction}>
            <AgentProfilesEditAction onPress={onEditProfiles} />
          </View>
        ) : null}
      </View>
      {rows.map((row) => (
        <AgentProfilePickerRowView
          key={row.id}
          row={row}
          serverId={serverId}
          onApply={handleApply}
        />
      ))}
    </View>
  );
}

function CreateAgentProfileRow({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const { activeKey, onActivateKey, activeItemRef, onActiveLayout } =
    useContext(ModelBrowserNavContext);
  const handleFocus = useCallback(
    () => onActivateKey(MODEL_BROWSER_CREATE_PROFILE_KEY),
    [onActivateKey],
  );
  const leadingSlot = useMemo(
    () => (
      <View testID="model-profiles-create-icon">
        <ThemedPlus size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </View>
    ),
    [],
  );
  return (
    <ModelBrowserRow
      label={t("modelSelector.createProfile")}
      labelMuted
      active={activeKey === MODEL_BROWSER_CREATE_PROFILE_KEY}
      activeItemRef={activeItemRef}
      onActiveLayout={onActiveLayout}
      leadingSlot={leadingSlot}
      onPress={onPress}
      onFocus={handleFocus}
      testID="model-profiles-empty"
    />
  );
}

/**
 * Profiles that match a search, above the matching models. The models get their
 * own heading so they don't read as part of the profiles section.
 */
function ProfileSearchResultsHeader({
  rows,
  serverId,
  hasModelRows,
  onApplyProfile,
  onEditProfiles,
}: {
  rows: AgentProfilePickerRowModel[];
  serverId: string | null;
  hasModelRows: boolean;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View>
      <AgentProfilesPickerSection
        rows={rows}
        serverId={serverId}
        onApplyProfile={onApplyProfile}
        onEditProfiles={onEditProfiles}
      />
      {hasModelRows ? (
        <View style={styles.sectionHeading}>
          <Text style={styles.sectionHeadingText}>{t("modelSelector.models")}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ModelBrowserProfileSectionView({
  section,
  serverId,
  onApplyProfile,
  onEditProfiles,
}: {
  section: ModelBrowserProfileSection<AgentProfilePickerRowModel>;
  serverId: string | null;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  if (section.kind === "none") return null;
  if (section.kind === "createProfile") {
    return onEditProfiles ? <CreateAgentProfileRow onPress={onEditProfiles} /> : null;
  }
  if (section.kind === "searchProfiles") {
    return (
      <ProfileSearchResultsHeader
        rows={section.rows}
        serverId={serverId}
        hasModelRows={section.showModelsHeading}
        onApplyProfile={onApplyProfile}
        onEditProfiles={onEditProfiles}
      />
    );
  }
  return (
    <AgentProfilesPickerSection
      rows={section.rows}
      serverId={serverId}
      onApplyProfile={onApplyProfile}
      onEditProfiles={onEditProfiles}
    />
  );
}

function GroupProviderButton({
  provider,
  serverId,
  onDrillDown,
}: {
  provider: ProviderSelectorProvider;
  serverId: string | null;
  onDrillDown: (providerId: string, providerLabel: string) => void;
}) {
  const { t } = useTranslation();
  const { activeKey, onActivateKey, activeItemRef, onActiveLayout } =
    useContext(ModelBrowserNavContext);
  const rowKey = modelBrowserProviderKey(provider.id);
  const selection = provider.modelSelection;
  const handlePress = useCallback(() => {
    onDrillDown(provider.id, provider.label);
  }, [onDrillDown, provider.id, provider.label]);
  const handleFocus = useCallback(() => {
    onActivateKey(rowKey);
  }, [onActivateKey, rowKey]);

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
    () => <ModelProviderGlyph provider={provider.id} serverId={serverId} size={ICON_SIZE.sm} />,
    [provider.id, serverId],
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
      active={activeKey === rowKey}
      activeItemRef={activeItemRef}
      onActiveLayout={onActiveLayout}
      onPress={handlePress}
      onFocus={handleFocus}
      testID={`model-provider-${provider.id}`}
    />
  );
}

function GroupedProviderRows({
  providers,
  serverId,
  onDrillDown,
}: {
  providers: ProviderSelectorProvider[];
  serverId: string | null;
  onDrillDown: (providerId: string, providerLabel: string) => void;
}) {
  return (
    <View>
      {providers.map((provider, index) => (
        <View key={provider.id}>
          {index > 0 ? <View style={styles.separator} /> : null}
          <GroupProviderButton provider={provider} serverId={serverId} onDrillDown={onDrillDown} />
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

function resolveModelListRevealTarget({
  shouldRevealActive,
  hasActiveHeaderItem,
  activeModelIndex,
}: {
  shouldRevealActive: boolean;
  hasActiveHeaderItem: boolean;
  activeModelIndex: number;
}): number | "top" | null {
  if (!shouldRevealActive) return null;
  if (hasActiveHeaderItem) return "top";
  return activeModelIndex >= 0 ? activeModelIndex : null;
}

function IndependentModelList({
  rows,
  renderItem,
  header,
  activeKey,
  activeModelIndex,
  hasActiveHeaderItem,
  shouldRevealActive,
}: {
  rows: ProviderSelectionModelRow[];
  renderItem: ({ item }: { item: ProviderSelectionModelRow }) => React.ReactElement;
  header?: React.ReactElement;
  activeKey: string | null;
  activeModelIndex: number;
  hasActiveHeaderItem: boolean;
  shouldRevealActive: boolean;
}) {
  const listRef = useRef<FlatList<ProviderSelectionModelRow>>(null);
  // Only scroll-reveal after explicit keyboard navigation so initial open rests at the top
  // and keeps the pinned Profiles header and its actions unclipped.
  const reveal = useRevealActiveFlatListRow({
    listRef,
    itemCount: rows.length,
    activeIndex: resolveModelListRevealTarget({
      shouldRevealActive,
      hasActiveHeaderItem,
      activeModelIndex,
    }),
    hasHeader: Boolean(header),
    listKey: rows,
  });

  return (
    <IndependentScrollBoundary>
      <FlatList
        ref={listRef}
        data={rows}
        extraData={activeKey}
        renderItem={renderItem}
        ListHeaderComponent={header}
        keyExtractor={getModelRowKey}
        onScrollToIndexFailed={reveal.onScrollToIndexFailed}
        onViewableItemsChanged={reveal.onViewableItemsChanged}
        viewabilityConfig={reveal.viewabilityConfig}
        style={styles.virtualizedModelList}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={MODEL_LIST_KEYBOARD_DISMISS_MODE}
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

function IndependentProviderList({
  scrollRef,
  onLayout,
  onScroll,
  children,
}: {
  scrollRef?: RefObject<ScrollView | null>;
  onLayout?: (event: LayoutChangeEvent) => void;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  children: React.ReactNode;
}) {
  return (
    <IndependentScrollBoundary>
      <ScrollView
        ref={scrollRef}
        style={styles.virtualizedModelList}
        contentContainerStyle={[
          styles.virtualizedModelListContent,
          styles.virtualizedProviderListContent,
        ]}
        onLayout={onLayout}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={MODEL_LIST_KEYBOARD_DISMISS_MODE}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        testID="compact-provider-list"
      >
        {children}
      </ScrollView>
    </IndependentScrollBoundary>
  );
}

function ModelRowList({
  rows,
  serverId,
  selectedProvider,
  selectedModel,
  activeModelIndex,
  hasActiveHeaderItem,
  shouldRevealActive,
  onSelect,
  showProviderLabel = false,
  header,
  scrolling,
  profiledLookup,
  onCreateProfile,
  onEditProfile,
  onEditProfiles,
}: {
  rows: ProviderSelectionModelRow[];
  serverId: string | null;
  selectedProvider: string;
  selectedModel: string;
  activeModelIndex: number;
  hasActiveHeaderItem: boolean;
  shouldRevealActive: boolean;
  onSelect: (provider: string, modelId: string) => void;
  showProviderLabel?: boolean;
  header?: React.ReactElement;
  scrolling: "sheet" | "independent";
  profiledLookup: Map<string, AgentProfilePickerRowModel[]>;
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const { activeKey } = useContext(ModelBrowserNavContext);
  const renderItem = useCallback(
    ({ item }: { item: ProviderSelectionModelRow }) => (
      <SelectableModelRow
        row={item}
        serverId={serverId}
        isSelected={item.provider === selectedProvider && item.modelId === selectedModel}
        showProviderLabel={showProviderLabel}
        onSelect={onSelect}
        profiledRows={profiledLookup.get(`${item.provider}:${item.modelId}`) ?? []}
        onCreateProfile={onCreateProfile}
        onEditProfile={onEditProfile}
        onEditProfiles={onEditProfiles}
      />
    ),
    [
      onEditProfile,
      onEditProfiles,
      onCreateProfile,
      onSelect,
      profiledLookup,
      selectedModel,
      selectedProvider,
      serverId,
      showProviderLabel,
    ],
  );
  const keyExtractor = useCallback((row: ProviderSelectionModelRow) => row.favoriteKey, []);

  if (scrolling === "independent") {
    return (
      <IndependentModelList
        rows={rows}
        renderItem={renderItem}
        header={header}
        activeKey={activeKey}
        activeModelIndex={activeModelIndex}
        hasActiveHeaderItem={hasActiveHeaderItem}
        shouldRevealActive={shouldRevealActive}
      />
    );
  }

  if (isCompact && isNative) {
    return (
      <SheetFlatList
        data={rows}
        extraData={activeKey}
        renderItem={renderItem}
        ListHeaderComponent={header}
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
      {header}
      {rows.map((row) => (
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
        <Button variant="default" onPress={handleRetry} disabled={isRetryingProvider}>
          {isRetryingProvider ? t("modelSelector.retrying") : t("modelSelector.retry")}
        </Button>
      ) : null}
    </View>
  );
}

function ModelSearchEmptyState() {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState}>
      <ThemedSearch size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
      <Text style={styles.emptyStateText}>{t("modelSelector.noMatches")}</Text>
    </View>
  );
}

// React Native Web blurs the focused input on every scroll in "on-drag" mode, including wheel
// scrolls and the scroll that reveals an arrowed-to row. That moves focus out of search, so
// typing stops and Enter lands on the header's Back button. Only a native keyboard needs it.
const MODEL_LIST_KEYBOARD_DISMISS_MODE = isNative ? "on-drag" : "none";

interface ModelBrowserKeyboardBinding {
  view: ModelBrowserView;
  navItems: readonly ModelBrowserNavItem[];
  activeKey: string | null;
  searchQuery: string;
  canGoBack: boolean;
  onActivateKey: (key: string | null) => void;
  onFocusSearchInput: () => void;
  onDrillDown: (providerId: string, providerLabel: string) => void;
  onShowAll: (fromProviderId?: string) => void;
  onSelect: (provider: string, modelId: string) => void;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}

function dispatchModelBrowserKeyEvent(
  event: KeyboardInputEvent,
  current: ModelBrowserKeyboardBinding,
): boolean {
  const focusedOwnsEnter = focusedModelBrowserControlOwnsEnter();
  const command = resolveModelBrowserKeyCommand({
    event,
    view: current.view,
    items: current.navItems,
    activeKey: current.activeKey,
    searchQuery: current.searchQuery,
    canGoBack: current.canGoBack,
    focusedControlOwnsEnter: focusedOwnsEnter,
  });
  if (!command) return false;
  if (command.kind === "move") {
    // Moving through rows with arrows reclaims Enter from a secondary button such as Back.
    if (focusedOwnsEnter) current.onFocusSearchInput();
    current.onActivateKey(command.nextKey);
    return true;
  }
  if (command.kind === "drillDown") {
    current.onDrillDown(command.providerId, command.providerLabel);
    return true;
  }
  if (command.kind === "back") {
    current.onShowAll(command.providerId);
    return true;
  }
  const { item } = command;
  if (item.kind === "profile") {
    if (!current.onApplyProfile) return false;
    current.onApplyProfile(item.profileId);
    return true;
  }
  if (item.kind === "createProfile") {
    if (!current.onEditProfiles) return false;
    current.onEditProfiles();
    return true;
  }
  if (item.kind === "provider") {
    current.onDrillDown(item.providerId, item.providerLabel);
    return true;
  }
  current.onSelect(item.provider, item.modelId);
  return true;
}

function useModelBrowserKeyboard(
  registerKeyboardHandler: (handler: ((event: KeyboardInputEvent) => boolean) | null) => void,
  binding: ModelBrowserKeyboardBinding,
) {
  const bindingRef = useRef(binding);
  bindingRef.current = binding;

  useEffect(() => {
    registerKeyboardHandler((event) => dispatchModelBrowserKeyEvent(event, bindingRef.current));
    return () => registerKeyboardHandler(null);
  }, [registerKeyboardHandler]);
}

function ModelBrowserBrowseView({
  serverId,
  projection,
  activeNavIndex,
  listKey,
  rootBrowseContent,
  scrolling,
  onApplyProfile,
  onEditProfiles,
  onDrillDown,
}: {
  serverId: string | null;
  projection: Extract<ModelBrowserProjection<AgentProfilePickerRowModel>, { kind: "browse" }>;
  activeNavIndex: number;
  listKey: string;
  rootBrowseContent?: React.ReactNode;
  scrolling: "sheet" | "independent";
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onDrillDown: (providerId: string, providerLabel: string) => void;
}) {
  const { t } = useTranslation();
  const nav = useContext(ModelBrowserNavContext);
  const browseScrollRef = useRef<ScrollView>(null);
  const browseReveal = useRevealActiveItem({
    activeIndex: activeNavIndex,
    listKey,
    scrollRef: browseScrollRef,
  });
  const browseNav = useMemo<ModelBrowserNavContextValue>(
    () => ({
      activeKey: nav.activeKey,
      onActivateKey: nav.onActivateKey,
      activeItemRef: browseReveal.activeItemRef,
      onActiveLayout: browseReveal.onItemLayout,
    }),
    [browseReveal.activeItemRef, browseReveal.onItemLayout, nav.activeKey, nav.onActivateKey],
  );

  const allProvidersContent = (
    <ModelBrowserNavContext.Provider value={browseNav}>
      <View ref={browseReveal.contentRef} collapsable={false}>
        <ModelBrowserProfileSectionView
          section={projection.profileSection}
          serverId={serverId}
          onApplyProfile={onApplyProfile}
          onEditProfiles={onEditProfiles}
        />
        {rootBrowseContent ??
          (projection.providers.length > 0 ? (
            <View>
              {projection.showProvidersHeading ? (
                <View style={styles.sectionHeading}>
                  <Text style={styles.sectionHeadingText}>{t("modelSelector.providers")}</Text>
                </View>
              ) : null}
              <GroupedProviderRows
                providers={projection.providers}
                serverId={serverId}
                onDrillDown={onDrillDown}
              />
            </View>
          ) : null)}
        {projection.isEmpty ? <ModelSearchEmptyState /> : null}
      </View>
    </ModelBrowserNavContext.Provider>
  );

  return scrolling === "independent" ? (
    <IndependentProviderList
      scrollRef={browseScrollRef}
      onLayout={browseReveal.onViewportLayout}
      onScroll={browseReveal.onScroll}
    >
      {allProvidersContent}
    </IndependentProviderList>
  ) : (
    <SheetScrollView
      ref={browseScrollRef}
      style={styles.virtualizedModelList}
      contentContainerStyle={[
        styles.virtualizedModelListContent,
        styles.virtualizedProviderListContent,
      ]}
      onLayout={browseReveal.onViewportLayout}
      onScroll={browseReveal.onScroll}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={MODEL_LIST_KEYBOARD_DISMISS_MODE}
      showsVerticalScrollIndicator={false}
      testID="compact-provider-list"
    >
      {allProvidersContent}
    </SheetScrollView>
  );
}

function ModelBrowserContent({
  serverId,
  view,
  providers,
  selectedProvider,
  selectedModel,
  searchQuery,
  isSearchFocused,
  profiles,
  explicitActiveKey,
  preferredActiveKey,
  onActivateKey,
  onFocusSearchInput,
  registerKeyboardHandler,
  onShowAll,
  onSelect,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onDrillDown,
  onRetryProvider,
  isRetryingProvider = false,
  scrolling,
  searchAllOnFocus,
  rootBrowseContent,
  showProfilesSection = true,
}: ModelBrowserContentProps) {
  const { t } = useTranslation();
  const hasHardwareKeyboard = useHardwareKeyboardPresent();
  const normalizedQuery = useMemo(() => normalizeSearchQuery(searchQuery), [searchQuery]);
  const profiledLookup = useMemo(
    () => groupProfilesByProviderModel(profiles?.rows ?? []),
    [profiles],
  );
  const projection = useMemo(
    () =>
      resolveModelBrowserProjection({
        view,
        providers,
        profiles: profiles?.rows ?? null,
        showProfilesSection,
        canCreateProfileRow: Boolean(onEditProfiles),
        normalizedQuery,
        isSearchFocused: searchAllOnFocus && isSearchFocused,
        hasCustomRootBrowseContent: rootBrowseContent != null,
      }),
    [
      isSearchFocused,
      normalizedQuery,
      onEditProfiles,
      profiles,
      providers,
      rootBrowseContent,
      searchAllOnFocus,
      showProfilesSection,
      view,
    ],
  );
  const { navItems } = projection;
  const activeKey = useMemo(
    () =>
      resolveActiveModelBrowserKey({
        explicitActiveKey,
        items: navItems,
        view,
        normalizedQuery,
        selectedProvider,
        selectedModel,
        preferredKey: preferredActiveKey,
        suppressInitialActive: isNative && !hasHardwareKeyboard,
      }),
    [
      explicitActiveKey,
      hasHardwareKeyboard,
      navItems,
      normalizedQuery,
      preferredActiveKey,
      selectedModel,
      selectedProvider,
      view,
    ],
  );
  const activeNavIndex = useMemo(
    () => (activeKey ? navItems.findIndex((item) => item.key === activeKey) : -1),
    [activeKey, navItems],
  );
  const activeItem = activeNavIndex >= 0 ? (navItems[activeNavIndex] ?? null) : null;
  const activeModelIndex = activeItem?.kind === "model" ? activeItem.modelIndex : -1;
  const hasActiveHeaderItem = activeItem !== null && activeItem.kind !== "model";
  const shouldRevealActive = explicitActiveKey !== null;
  const browseListKey = useMemo(() => navItems.map((item) => item.key).join("\u0000"), [navItems]);

  const handleActivateRowKey = useCallback(
    (key: string) => {
      onActivateKey(key);
    },
    [onActivateKey],
  );
  const navContext = useMemo<ModelBrowserNavContextValue>(
    () => ({ activeKey, onActivateKey: handleActivateRowKey }),
    [activeKey, handleActivateRowKey],
  );

  useModelBrowserKeyboard(registerKeyboardHandler, {
    view,
    navItems,
    activeKey,
    searchQuery,
    canGoBack: providers.length > 1,
    onActivateKey,
    onFocusSearchInput,
    onDrillDown,
    onShowAll,
    onSelect,
    onApplyProfile,
    onEditProfiles,
  });

  const listHeader = useMemo(
    () =>
      projection.kind === "modelList" && projection.profileSection.kind !== "none" ? (
        <ModelBrowserProfileSectionView
          section={projection.profileSection}
          serverId={serverId}
          onApplyProfile={onApplyProfile}
          onEditProfiles={onEditProfiles}
        />
      ) : undefined,
    [onApplyProfile, onEditProfiles, projection, serverId],
  );

  let content: React.ReactNode;
  if (projection.kind === "providerLoading") {
    content = (
      <View style={styles.emptyState}>
        <View style={styles.rowSpinner}>
          <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
        </View>
        <Text style={styles.emptyStateText}>{t("modelSelector.loadingShort")}</Text>
      </View>
    );
  } else if (projection.kind === "providerError") {
    content = (
      <ProviderErrorEmptyState
        providerId={projection.providerId}
        message={projection.message}
        onRetryProvider={onRetryProvider}
        isRetryingProvider={isRetryingProvider}
      />
    );
  } else if (projection.kind === "empty") {
    content = <ModelSearchEmptyState />;
  } else if (projection.kind === "noSearchMatches") {
    content = (
      <View style={styles.emptyState} testID="model-search-empty">
        <ThemedSearch size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
        <Text style={styles.emptyStateText}>
          {t("modelSelector.noMatchesForQuery", { query: searchQuery.trim() })}
        </Text>
      </View>
    );
  } else if (projection.kind === "modelList") {
    content = (
      <ModelRowList
        serverId={serverId}
        rows={projection.modelRows}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        activeModelIndex={activeModelIndex}
        hasActiveHeaderItem={hasActiveHeaderItem}
        shouldRevealActive={shouldRevealActive}
        onSelect={onSelect}
        showProviderLabel={projection.showProviderLabel}
        header={listHeader}
        scrolling={scrolling}
        profiledLookup={profiledLookup}
        onCreateProfile={onCreateProfile}
        onEditProfile={onEditProfile}
        onEditProfiles={onEditProfiles}
      />
    );
  } else {
    content = (
      <ModelBrowserBrowseView
        serverId={serverId}
        projection={projection}
        activeNavIndex={activeNavIndex}
        listKey={browseListKey}
        rootBrowseContent={rootBrowseContent}
        scrolling={scrolling}
        onApplyProfile={onApplyProfile}
        onEditProfiles={onEditProfiles}
        onDrillDown={onDrillDown}
      />
    );
  }

  return (
    <ModelBrowserNavContext.Provider value={navContext}>{content}</ModelBrowserNavContext.Provider>
  );
}

export function ModelBrowser({
  state,
  onSelect,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onRetryProvider,
  isRetryingProvider = false,
  scrolling = "sheet",
  searchAllOnFocus = false,
  rootBrowseContent,
  showProfilesSection,
}: ModelBrowserProps) {
  return (
    <ModelBrowserContent
      serverId={state.serverId}
      view={state.view}
      providers={state.providers}
      selectedProvider={state.selectedProvider}
      selectedModel={state.selectedModel}
      searchQuery={state.searchQuery}
      isSearchFocused={state.isSearchFocused}
      profiles={state.profiles}
      explicitActiveKey={state.explicitActiveKey}
      preferredActiveKey={state.preferredActiveKey}
      onActivateKey={state.setActiveKey}
      onFocusSearchInput={state.focusSearchInput}
      registerKeyboardHandler={state.registerKeyboardHandler}
      onShowAll={state.showAll}
      onSelect={onSelect}
      onApplyProfile={onApplyProfile}
      onEditProfiles={onEditProfiles}
      onCreateProfile={onCreateProfile}
      onEditProfile={onEditProfile}
      onDrillDown={state.drillDown}
      onRetryProvider={onRetryProvider}
      isRetryingProvider={isRetryingProvider}
      scrolling={scrolling}
      searchAllOnFocus={searchAllOnFocus}
      rootBrowseContent={rootBrowseContent}
      showProfilesSection={showProfilesSection}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  profilesContainer: {
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  sectionHeading: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  sectionHeadingAction: {
    position: "absolute",
    top: theme.spacing[1],
    right: isWeb ? theme.spacing[3] : theme.spacing[6],
  },
  sectionHeadingText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  browserRow: {
    flexDirection: "row",
    paddingVertical: theme.spacing[2],
    minHeight: 36,
  },
  modelRowHoverBoundary: {
    position: "relative",
  },
  modelRowProfileActionSlot: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: isWeb ? theme.spacing[3] : theme.spacing[6],
    justifyContent: "center",
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
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  browserRowLabelMuted: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  browserRowDescription: {
    fontSize: theme.fontSize.sm,
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
    fontSize: theme.fontSize.sm,
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
  // Hidden in style so every pressable branch that applies the style also stops taking taps.
  profileActionHidden: {
    opacity: 0,
    pointerEvents: "none",
  },
  emptyState: {
    padding: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyStateText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
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
  providerIconMuted: {
    color: theme.colors.foregroundMuted,
  },
  providerIconForeground: {
    color: theme.colors.foreground,
  },
}));
