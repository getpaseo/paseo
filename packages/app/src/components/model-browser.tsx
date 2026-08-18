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
  type AgentProfilePicker,
  type AgentProfilePickerRow as AgentProfilePickerRowModel,
  type AgentProfileSeed,
} from "@/agent-profiles";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getProviderIcon } from "@/components/provider-icons";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import {
  buildProviderQualifiedDescription,
  buildSelectedTriggerLabel,
  filterAndRankModelRows,
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
  groupProfilesByProviderModel,
  resolveInitialModelBrowserView,
  resolveModelBrowserAllView,
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
const ThemedPencil = withUnistyles(Pencil);
const ThemedPlus = withUnistyles(Plus);
const ThemedSearch = withUnistyles(Search);
const ThemedSettings = withUnistyles(Settings);

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

function AgentProfilesEditAction({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={onPress}
          hitSlop={8}
          style={iconButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={t("modelSelector.editProfilesLabel")}
          testID="model-profiles-edit"
        >
          <ThemedPencil size={ICON_SIZE.xs} uniProps={foregroundExtraMutedMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("modelSelector.editProfilesLabel")}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const IndependentScrollGestureContext = createContext<ReturnType<typeof Gesture.Native> | null>(
  null,
);

const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const foregroundExtraMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});

const headerSettingsMapping = (disabled: boolean) => (theme: Theme) => ({
  color: disabled ? theme.colors.border : theme.colors.foregroundMuted,
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
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  profiles: AgentProfilePicker | null;
  view: ModelBrowserView;
  searchQuery: string;
  isSearchFocused: boolean;
  header: SheetHeader;
  selectedModelLabel: string;
  triggerLabel: string;
  desktopFixedHeight: number | undefined;
  isProviderView: boolean;
  prepareToOpen: () => void;
  showAll: () => void;
  reset: () => void;
  drillDown: (providerId: string, providerLabel: string) => void;
}

interface ModelBrowserProps {
  state: ModelBrowserState;
  onSelect: (provider: string, modelId: string) => void;
  /** Applying a profile resolves the pick and dismisses, exactly like a model row. */
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => void;
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
  view: ModelBrowserView;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  searchQuery: string;
  isSearchFocused: boolean;
  profiles: AgentProfilePicker | null;
  onDrillDown: (providerId: string, providerLabel: string) => void;
  scrolling: "sheet" | "independent";
  searchAllOnFocus: boolean;
  rootBrowseContent?: React.ReactNode;
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
  const [searchResetKey, bumpSearchResetKey] = useReducer((key: number) => key + 1, 0);
  const hasProfiles = (profiles?.rows.length ?? 0) > 0;

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
  }, [initialView]);

  const reset = useCallback(() => {
    setSearchQuery("");
    setIsSearchFocused(false);
    bumpSearchResetKey();
  }, []);

  const showAll = useCallback(() => {
    setView({ kind: "all" });
    reset();
  }, [reset]);

  const drillDown = useCallback(
    (providerId: string, providerLabel: string) => {
      setView({ kind: "provider", providerId, providerLabel });
      reset();
    },
    [reset],
  );

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

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
          testID: "model-search-all-input",
        },
      };
    }
    return {
      title: view.providerLabel,
      leading: (
        <ModelProviderGlyph provider={view.providerId} size={ICON_SIZE.md} tone="foreground" />
      ),
      back: singleProviderView ? undefined : { onPress: showAll },
      actions: (
        <View style={styles.headerActionRow}>
          <ProviderSettingsAction
            serverId={serverId}
            provider={view.providerId}
            accessibilityLabel={t("modelSelector.openProviderSettings", {
              provider: view.providerLabel,
            })}
          />
        </View>
      ),
      search: {
        onChange: handleSearchQueryChange,
        onFocus: () => setIsSearchFocused(true),
        onBlur: () => setIsSearchFocused(false),
        resetKey: `${view.providerId}:${searchResetKey}`,
        placeholder: t("modelSelector.searchPlaceholder"),
        autoFocus: autoFocusSearch,
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
    providers,
    selectedProvider,
    selectedModel,
    profiles,
    view,
    searchQuery,
    isSearchFocused,
    header,
    selectedModelLabel,
    triggerLabel,
    desktopFixedHeight,
    isProviderView: view.kind === "provider",
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
  hitSlop?: number;
  accessibilityLabel?: string;
  /** Only rows that can express selection pass this; the rest stay unannotated. */
  accessibilitySelected?: boolean;
  testID?: string;
}

function ModelBrowserPressable({
  children,
  style,
  onPress,
  hitSlop,
  accessibilityLabel,
  accessibilitySelected,
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
  const accessibilityState = useMemo(
    () => (accessibilitySelected === undefined ? undefined : { selected: accessibilitySelected }),
    [accessibilitySelected],
  );

  if (!independentScrollGesture) {
    return (
      <Pressable
        onPress={handlePress}
        hitSlop={hitSlop}
        style={style}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        aria-selected={accessibilitySelected}
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
        accessibilityState={accessibilityState}
        aria-selected={accessibilitySelected}
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
  labelMuted = false,
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
  /** For rows that offer an action rather than name a thing you can pick. */
  labelMuted?: boolean;
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
    <ModelBrowserPressable
      onPress={onPress}
      style={pressableStyle}
      // A profile row is an action, not a selection, so it carries no selection
      // state at all — only rows that draw the checkmark claim one.
      accessibilitySelected={selectionIndicator ? selected : undefined}
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
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );
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
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={handlePress}
          hitSlop={8}
          style={pressableStyle}
          pointerEvents={visible ? "auto" : "none"}
          accessibilityRole="button"
          accessibilityLabel={label}
          testID={testID}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function ModelRow({
  row,
  isSelected,
  showProviderLabel = false,
  onPress,
  profiledRows,
  onCreateProfile,
  onEditProfile,
  onEditProfiles,
}: {
  row: ProviderSelectionModelRow;
  isSelected: boolean;
  showProviderLabel?: boolean;
  onPress: () => void;
  profiledRows: AgentProfilePickerRowModel[];
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const leadingSlot = useMemo(
    () => <ModelProviderGlyph provider={row.provider} size={ICON_SIZE.sm} />,
    [row.provider],
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
          label={t("modelSelector.createProfile")}
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
          <AgentProfileGlyph icon={primary.icon} color={primary.color} size={ICON_SIZE.xs} />
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
        <AgentProfileGlyph icon={primary.icon} color={primary.color} size={ICON_SIZE.xs} />
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
    t,
  ]);

  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.browserRow,
      styles.browserModelRow,
      Boolean(hovered) && styles.browserRowHovered,
      pressed && styles.browserRowPressed,
    ],
    [],
  );

  return (
    <View
      style={styles.modelRowHoverBoundary}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <ModelBrowserPressable
        onPress={onPress}
        style={pressableStyle}
        accessibilitySelected={isSelected}
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
            {profileAction}
          </View>
        </View>
      </ModelBrowserPressable>
    </View>
  );
}

function SelectableModelRow({
  row,
  isSelected,
  showProviderLabel,
  onSelect,
  profiledRows,
  onCreateProfile,
  onEditProfile,
  onEditProfiles,
}: {
  row: ProviderSelectionModelRow;
  isSelected: boolean;
  showProviderLabel?: boolean;
  onSelect: (provider: string, modelId: string) => void;
  profiledRows: AgentProfilePickerRowModel[];
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(row.provider, row.modelId);
  }, [onSelect, row.modelId, row.provider]);
  return (
    <ModelRow
      row={row}
      isSelected={isSelected}
      showProviderLabel={showProviderLabel}
      onPress={handlePress}
      profiledRows={profiledRows}
      onCreateProfile={onCreateProfile}
      onEditProfile={onEditProfile}
      onEditProfiles={onEditProfiles}
    />
  );
}

function AgentProfilePickerRowView({
  row,
  onApply,
}: {
  row: AgentProfilePickerRowModel;
  onApply: (profileId: string) => void;
}) {
  const handlePress = useCallback(() => onApply(row.id), [onApply, row.id]);
  const leadingSlot = useMemo(
    () => <AgentProfileGlyph icon={row.icon} color={row.color} size={ICON_SIZE.sm} />,
    [row.color, row.icon],
  );
  return (
    <ModelBrowserRow
      label={row.name}
      description={row.summary}
      tone="elevated"
      onPress={handlePress}
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
  onApplyProfile,
  onEditProfiles,
}: {
  rows: AgentProfilePickerRowModel[];
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
        <AgentProfilePickerRowView key={row.id} row={row} onApply={handleApply} />
      ))}
    </View>
  );
}

function CreateAgentProfileRow({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
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
      leadingSlot={leadingSlot}
      onPress={onPress}
      testID="model-profiles-empty"
    />
  );
}

function AgentProfilesPickerContent({
  rows,
  onApplyProfile,
  onEditProfiles,
}: {
  rows: AgentProfilePickerRowModel[];
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  if (rows.length === 0) {
    return onEditProfiles ? <CreateAgentProfileRow onPress={onEditProfiles} /> : null;
  }
  return (
    <AgentProfilesPickerSection
      rows={rows}
      onApplyProfile={onApplyProfile}
      onEditProfiles={onEditProfiles}
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
  rows,
  renderItem,
  header,
}: {
  rows: ProviderSelectionModelRow[];
  renderItem: ({ item }: { item: ProviderSelectionModelRow }) => React.ReactElement;
  header?: React.ReactElement;
}) {
  return (
    <IndependentScrollBoundary>
      <FlatList
        data={rows}
        renderItem={renderItem}
        ListHeaderComponent={header}
        keyExtractor={getModelRowKey}
        style={styles.virtualizedModelList}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
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
        keyboardDismissMode="on-drag"
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
  selectedProvider,
  selectedModel,
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
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: string, modelId: string) => void;
  showProviderLabel?: boolean;
  header?: React.ReactElement;
  scrolling: "sheet" | "independent";
  profiledLookup: Map<string, AgentProfilePickerRowModel[]>;
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const renderItem = useCallback(
    ({ item }: { item: ProviderSelectionModelRow }) => (
      <SelectableModelRow
        row={item}
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
      showProviderLabel,
    ],
  );
  const keyExtractor = useCallback((row: ProviderSelectionModelRow) => row.favoriteKey, []);

  if (scrolling === "independent") {
    return <IndependentModelList rows={rows} renderItem={renderItem} header={header} />;
  }

  if (isCompact && isNative) {
    return (
      <BottomSheetFlatList
        data={rows}
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
        <Button variant="default" size="sm" onPress={handleRetry} disabled={isRetryingProvider}>
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

function ProviderModelBrowserContent({
  view,
  provider,
  profiles,
  selectedProvider,
  selectedModel,
  normalizedQuery,
  onSelect,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  profiledLookup,
  showProfilesSection = true,
  onRetryProvider,
  isRetryingProvider,
  scrolling,
}: {
  view: Extract<ModelBrowserView, { kind: "provider" }>;
  provider: ProviderSelectorProvider | null;
  profiles: AgentProfilePicker | null;
  selectedProvider: string;
  selectedModel: string;
  normalizedQuery: string;
  onSelect: (provider: string, modelId: string) => void;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  profiledLookup: Map<string, AgentProfilePickerRowModel[]>;
  showProfilesSection?: boolean;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
  scrolling: "sheet" | "independent";
}) {
  const { t } = useTranslation();
  const visibleRows = useMemo(
    () => (provider ? filterAndRankModelRows(getProviderModelRows(provider), normalizedQuery) : []),
    [normalizedQuery, provider],
  );
  const providerProfileRows = useMemo(
    () => profiles?.rows.filter((row) => row.provider === view.providerId) ?? [],
    [profiles, view.providerId],
  );
  const profileHeader = useMemo(
    () =>
      normalizedQuery.length === 0 && showProfilesSection && profiles ? (
        <AgentProfilesPickerContent
          rows={providerProfileRows}
          onApplyProfile={onApplyProfile}
          onEditProfiles={onEditProfiles}
        />
      ) : undefined,
    [
      normalizedQuery,
      onApplyProfile,
      onEditProfiles,
      profiles,
      providerProfileRows,
      showProfilesSection,
    ],
  );

  if (!provider) return <ModelSearchEmptyState />;
  const selection = provider.modelSelection;
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
  if (visibleRows.length === 0) {
    return profileHeader ?? <ModelSearchEmptyState />;
  }
  return (
    <ModelRowList
      rows={visibleRows}
      selectedProvider={selectedProvider}
      selectedModel={selectedModel}
      onSelect={onSelect}
      header={profileHeader}
      scrolling={scrolling}
      profiledLookup={profiledLookup}
      onCreateProfile={onCreateProfile}
      onEditProfile={onEditProfile}
      onEditProfiles={onEditProfiles}
    />
  );
}

function ModelBrowserContent({
  view,
  providers,
  selectedProvider,
  selectedModel,
  searchQuery,
  isSearchFocused,
  profiles,
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
  const normalizedQuery = useMemo(() => normalizeSearchQuery(searchQuery), [searchQuery]);
  const profiledLookup = useMemo(
    () => groupProfilesByProviderModel(profiles?.rows ?? []),
    [profiles],
  );
  const selectedViewProvider = useMemo(
    () =>
      view.kind === "provider"
        ? (providers.find((provider) => provider.id === view.providerId) ?? null)
        : null,
    [providers, view],
  );
  const allView = useMemo(
    () =>
      resolveModelBrowserAllView({
        providers,
        normalizedQuery,
        isSearchFocused: searchAllOnFocus && isSearchFocused,
      }),
    [isSearchFocused, normalizedQuery, providers, searchAllOnFocus],
  );
  const hasResults = profiles !== null || providers.length > 0 || rootBrowseContent != null;

  if (view.kind === "provider") {
    return (
      <ProviderModelBrowserContent
        view={view}
        provider={selectedViewProvider}
        profiles={profiles}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        normalizedQuery={normalizedQuery}
        onSelect={onSelect}
        onApplyProfile={onApplyProfile}
        onEditProfiles={onEditProfiles}
        onCreateProfile={onCreateProfile}
        onEditProfile={onEditProfile}
        profiledLookup={profiledLookup}
        showProfilesSection={showProfilesSection}
        onRetryProvider={onRetryProvider}
        isRetryingProvider={isRetryingProvider}
        scrolling={scrolling}
      />
    );
  }

  if (allView.kind === "noSearchMatches") {
    return (
      <View style={styles.emptyState} testID="model-search-empty">
        <ThemedSearch size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
        <Text style={styles.emptyStateText}>
          {t("modelSelector.noMatchesForQuery", { query: searchQuery.trim() })}
        </Text>
      </View>
    );
  }

  if (allView.kind === "searchResults") {
    return (
      <ModelRowList
        rows={allView.rows}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        onSelect={onSelect}
        showProviderLabel
        scrolling={scrolling}
        profiledLookup={profiledLookup}
        onCreateProfile={onCreateProfile}
        onEditProfile={onEditProfile}
        onEditProfiles={onEditProfiles}
      />
    );
  }

  const allProvidersContent = (
    <View>
      {showProfilesSection && profiles ? (
        <AgentProfilesPickerContent
          rows={profiles.rows}
          onApplyProfile={onApplyProfile}
          onEditProfiles={onEditProfiles}
        />
      ) : null}
      {rootBrowseContent ??
        (providers.length > 0 ? (
          <View>
            {showProfilesSection && profiles ? (
              <View style={styles.sectionHeading}>
                <Text style={styles.sectionHeadingText}>{t("modelSelector.providers")}</Text>
              </View>
            ) : null}
            <GroupedProviderRows providers={providers} onDrillDown={onDrillDown} />
          </View>
        ) : null)}
      {!hasResults ? <ModelSearchEmptyState /> : null}
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
      view={state.view}
      providers={state.providers}
      selectedProvider={state.selectedProvider}
      selectedModel={state.selectedModel}
      searchQuery={state.searchQuery}
      isSearchFocused={state.isSearchFocused}
      profiles={state.profiles}
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
  headerActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
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
  profileActionHidden: {
    opacity: 0,
  },
  emptyState: {
    paddingVertical: theme.spacing[4],
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
