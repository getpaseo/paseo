import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb as platformIsWeb } from "@/constants/platform";
import { ChevronDown, ChevronRight, Search, Star } from "lucide-react-native";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
const IS_WEB = platformIsWeb;

import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";

const EMPTY_COMBOBOX_OPTIONS: ComboboxOption[] = [];

function noop() {}

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

function drillDownRowStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.drillDownRow,
    Boolean(hovered) && styles.drillDownRowHovered,
    pressed && styles.drillDownRowPressed,
  ];
}
import { getProviderIcon } from "@/components/provider-icons";
import {
  buildSelectedTriggerLabel,
  filterAndRankModelRows,
  getAllProviderModelRows,
  getProviderDefaultLabel,
  getProviderModelRows,
  resolveSelectedModelLabel,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";

// TODO: this should be configured per provider in the provider manifest
const PROVIDERS_WITH_MODEL_DESCRIPTIONS = new Set(["opencode", "pi"]);

type SelectorView =
  | { kind: "all" }
  | { kind: "provider"; providerId: string; providerLabel: string };

interface CombinedModelSelectorProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: AgentProvider, modelId: string) => void;
  isLoading: boolean;
  favoriteKeys?: Set<string>;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  renderTrigger?: (input: {
    selectedModelLabel: string;
    onPress: () => void;
    disabled: boolean;
    isOpen: boolean;
  }) => React.ReactNode;
  onOpen?: () => void;
  onClose?: () => void;
  disabled?: boolean;
}

interface SelectorContentProps {
  view: SelectorView;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  searchQuery: string;
  favoriteKeys: Set<string>;
  onSelect: (provider: string, modelId: string) => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  onDrillDown: (providerId: string, providerLabel: string) => void;
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
  const { theme } = useUnistyles();
  const ProviderIcon = getProviderIcon(row.provider);

  const handleToggleFavorite = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onToggleFavorite?.(row.provider, row.modelId);
    },
    [onToggleFavorite, row.modelId, row.provider],
  );

  const leadingSlot = useMemo(
    () => <ProviderIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [ProviderIcon, theme.iconSize.sm, theme.colors.foregroundMuted],
  );
  const trailingSlot = useMemo(
    () =>
      onToggleFavorite ? (
        <Pressable
          onPress={handleToggleFavorite}
          hitSlop={8}
          style={favoriteButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={isFavorite ? "Unfavorite model" : "Favorite model"}
          testID={`favorite-model-${row.provider}-${row.modelId}`}
        >
          {({ hovered }) => {
            let starColor: string;
            if (isFavorite) starColor = theme.colors.palette.amber[500];
            else if (hovered) starColor = theme.colors.foregroundMuted;
            else starColor = theme.colors.border;
            return (
              <Star
                size={16}
                color={starColor}
                fill={isFavorite ? theme.colors.palette.amber[500] : "transparent"}
              />
            );
          }}
        </Pressable>
      ) : null,
    [
      onToggleFavorite,
      handleToggleFavorite,
      isFavorite,
      row.provider,
      row.modelId,
      theme.colors.palette.amber,
      theme.colors.foregroundMuted,
      theme.colors.border,
    ],
  );

  const showDescription = row.description && PROVIDERS_WITH_MODEL_DESCRIPTIONS.has(row.provider);

  return (
    <ComboboxItem
      label={row.modelLabel}
      description={showDescription ? row.description : undefined}
      selected={isSelected}
      elevated={elevated}
      onPress={onPress}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
    />
  );
}

interface SelectableModelRowProps {
  row: ProviderSelectionModelRow;
  isSelected: boolean;
  isFavorite: boolean;
  elevated?: boolean;
  onSelect: (provider: string, modelId: string) => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
}

function SelectableModelRow({
  row,
  isSelected,
  isFavorite,
  elevated,
  onSelect,
  onToggleFavorite,
}: SelectableModelRowProps) {
  const handlePress = useCallback(() => {
    onSelect(row.provider, row.modelId);
  }, [onSelect, row.provider, row.modelId]);
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
  if (favoriteRows.length === 0) {
    return null;
  }

  return (
    <View style={styles.favoritesContainer}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionHeadingText}>Favorites</Text>
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

interface GroupProviderButtonProps {
  providerId: string;
  providerLabel: string;
  rowCount: number;
  defaultLabel: string | null;
  onDrillDown: (providerId: string, providerLabel: string) => void;
  onSelectDefault: (providerId: string) => void;
}

function GroupProviderButton({
  providerId,
  providerLabel,
  rowCount,
  defaultLabel,
  onDrillDown,
  onSelectDefault,
}: GroupProviderButtonProps) {
  const { theme } = useUnistyles();
  const ProvIcon = getProviderIcon(providerId);
  const handlePress = useCallback(() => {
    if (defaultLabel) {
      onSelectDefault(providerId);
      return;
    }
    onDrillDown(providerId, providerLabel);
  }, [defaultLabel, onDrillDown, onSelectDefault, providerId, providerLabel]);
  return (
    <Pressable onPress={handlePress} style={drillDownRowStyle}>
      <ProvIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      <Text style={styles.drillDownText}>{providerLabel}</Text>
      <View style={styles.drillDownTrailing}>
        <Text style={styles.drillDownCount}>
          {defaultLabel ?? `${rowCount} ${rowCount === 1 ? "model" : "models"}`}
        </Text>
        {defaultLabel ? null : (
          <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        )}
      </View>
    </Pressable>
  );
}

function GroupedProviderRows({
  providers,
  onDrillDown,
  onSelectDefault,
}: {
  providers: ProviderSelectorProvider[];
  onDrillDown: (providerId: string, providerLabel: string) => void;
  onSelectDefault: (providerId: string) => void;
}) {
  return (
    <View>
      {providers.map((provider, index) => {
        const rows = getProviderModelRows(provider);
        const defaultLabel = getProviderDefaultLabel(provider);
        return (
          <View key={provider.id}>
            {index > 0 ? <View style={styles.separator} /> : null}
            <GroupProviderButton
              providerId={provider.id}
              providerLabel={provider.label}
              rowCount={rows.length}
              defaultLabel={defaultLabel}
              onDrillDown={onDrillDown}
              onSelectDefault={onSelectDefault}
            />
          </View>
        );
      })}
    </View>
  );
}

function DefaultProviderRow({
  providerId,
  isSelected,
  onSelect,
}: {
  providerId: string;
  isSelected: boolean;
  onSelect: (provider: string, modelId: string) => void;
}) {
  const { theme } = useUnistyles();
  const ProviderIcon = getProviderIcon(providerId);
  const handlePress = useCallback(() => {
    onSelect(providerId, "");
  }, [onSelect, providerId]);
  const leadingSlot = useMemo(
    () => <ProviderIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [ProviderIcon, theme.iconSize.sm, theme.colors.foregroundMuted],
  );

  return (
    <ComboboxItem
      label="Default"
      selected={isSelected}
      onPress={handlePress}
      leadingSlot={leadingSlot}
    />
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
}: {
  rows: ProviderSelectionModelRow[];
  selectedProvider: string;
  selectedModel: string;
  favoriteKeys: Set<string>;
  onSelect: (provider: string, modelId: string) => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  normalizedQuery: string;
}) {
  const isMobile = useIsCompactFormFactor();
  const useVirtualizedList = isMobile && isNative;
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

  if (useVirtualizedList) {
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

function SelectorContent({
  view,
  providers,
  selectedProvider,
  selectedModel,
  searchQuery,
  favoriteKeys,
  onSelect,
  onToggleFavorite,
  onDrillDown,
}: SelectorContentProps) {
  const { theme } = useUnistyles();
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
  const handleSelectDefaultProvider = useCallback(
    (providerId: string) => {
      onSelect(providerId, "");
    },
    [onSelect],
  );
  const hasResults = favoriteRows.length > 0 || providers.length > 0;
  const emptyState = (
    <View style={styles.emptyState}>
      <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      <Text style={styles.emptyStateText}>No models match your search</Text>
    </View>
  );

  if (view.kind === "provider") {
    if (!selectedViewProvider) {
      return emptyState;
    }

    if (getProviderDefaultLabel(selectedViewProvider) && !normalizedQuery) {
      return (
        <DefaultProviderRow
          providerId={view.providerId}
          isSelected={view.providerId === selectedProvider && !selectedModel}
          onSelect={onSelect}
        />
      );
    }

    if (visibleRows.length === 0) {
      return emptyState;
    }

    return (
      <ProviderModelRows
        rows={visibleRows}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        favoriteKeys={favoriteKeys}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
        normalizedQuery={normalizedQuery}
      />
    );
  }

  return (
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
        <GroupedProviderRows
          providers={providers}
          onDrillDown={onDrillDown}
          onSelectDefault={handleSelectDefaultProvider}
        />
      ) : null}

      {!hasResults ? emptyState : null}
    </View>
  );
}

export function CombinedModelSelector({
  providers,
  selectedProvider,
  selectedModel,
  onSelect,
  isLoading,
  favoriteKeys = new Set<string>(),
  onToggleFavorite,
  renderTrigger,
  onOpen,
  onClose,
  disabled = false,
}: CombinedModelSelectorProps) {
  const { theme } = useUnistyles();
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isContentReady, setIsContentReady] = useState(platformIsWeb);
  const [view, setView] = useState<SelectorView>({ kind: "all" });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResetKey, bumpSearchResetKey] = useReducer((key: number) => key + 1, 0);

  // Single-provider mode: only one provider → skip Level 1 entirely
  const singleProviderView = useMemo<SelectorView | null>(() => {
    if (providers.length !== 1) return null;
    const provider = providers[0];
    if (!provider) return null;
    return { kind: "provider", providerId: provider.id, providerLabel: provider.label };
  }, [providers]);

  const computeInitialView = useCallback((): SelectorView => {
    if (singleProviderView) return singleProviderView;

    const selectedFavoriteKey = `${selectedProvider}:${selectedModel}`;
    if (selectedProvider && selectedModel && !favoriteKeys.has(selectedFavoriteKey)) {
      const provider = providers.find((entry) => entry.id === selectedProvider);
      if (provider)
        return { kind: "provider", providerId: provider.id, providerLabel: provider.label };
    }

    return { kind: "all" };
  }, [singleProviderView, selectedProvider, selectedModel, favoriteKeys, providers]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      setView(computeInitialView());
      if (open) {
        onOpen?.();
      } else {
        setSearchQuery("");
        bumpSearchResetKey();
        onClose?.();
      }
    },
    [onOpen, onClose, computeInitialView],
  );

  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      setIsOpen(false);
      setSearchQuery("");
      bumpSearchResetKey();
    },
    [onSelect],
  );

  const hasSelectedProvider = selectedProvider.trim().length > 0;
  const ProviderIcon = hasSelectedProvider ? getProviderIcon(selectedProvider) : null;

  const selectedModelLabel = useMemo(() => {
    return resolveSelectedModelLabel({
      providers,
      selectedProvider,
      selectedModel,
      isLoading,
    });
  }, [isLoading, providers, selectedModel, selectedProvider]);

  const desktopFixedHeight = useMemo(() => {
    if (view.kind !== "provider") {
      return undefined;
    }
    const provider = providers.find((entry) => entry.id === view.providerId);
    const modelCount = provider ? getProviderModelRows(provider).length : 0;
    return Math.min(80 + modelCount * 40, 400);
  }, [providers, view]);

  const triggerLabel = useMemo(() => {
    if (selectedModelLabel === "Loading..." || selectedModelLabel === "Select model") {
      return selectedModelLabel;
    }

    return buildSelectedTriggerLabel(selectedModelLabel);
  }, [selectedModelLabel]);

  useEffect(() => {
    if (platformIsWeb) {
      return () => {};
    }

    if (!isOpen) {
      setIsContentReady(false);
      return () => {};
    }

    const frame = requestAnimationFrame(() => {
      setIsContentReady(true);
    });

    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const handleTriggerPress = useCallback(() => {
    handleOpenChange(!isOpen);
  }, [handleOpenChange, isOpen]);

  const triggerStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      Boolean(hovered) && styles.triggerHovered,
      (pressed || isOpen) && styles.triggerPressed,
      disabled && styles.triggerDisabled,
      renderTrigger ? styles.customTriggerWrapper : null,
    ],
    [disabled, isOpen, renderTrigger],
  );

  const handleBackToAll = useCallback(() => {
    setView({ kind: "all" });
    setSearchQuery("");
    bumpSearchResetKey();
  }, []);

  const handleDrillDown = useCallback((providerId: string, providerLabel: string) => {
    setView({ kind: "provider", providerId, providerLabel });
  }, []);

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const sheetHeader = useMemo<SheetHeader>(() => {
    if (view.kind === "all") {
      return { title: "Select provider" };
    }
    const ProviderIconForView = getProviderIcon(view.providerId);
    return {
      title: view.providerLabel,
      leading: ProviderIconForView ? (
        <ProviderIconForView size={theme.iconSize.md} color={theme.colors.foreground} />
      ) : undefined,
      back: singleProviderView ? undefined : { onPress: handleBackToAll },
      search: {
        value: searchQuery,
        onChange: handleSearchQueryChange,
        initialValue: searchQuery,
        resetKey: `${view.providerId}:${searchResetKey}`,
        placeholder: "Search models...",
        autoFocus: platformIsWeb,
        testID: "model-search-input",
      },
    };
  }, [
    view,
    singleProviderView,
    handleBackToAll,
    handleSearchQueryChange,
    searchQuery,
    searchResetKey,
    theme.iconSize.md,
    theme.colors.foreground,
  ]);

  return (
    <>
      <Pressable
        ref={anchorRef}
        collapsable={false}
        disabled={disabled}
        onPress={handleTriggerPress}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={`Select model (${selectedModelLabel})`}
        testID="combined-model-selector"
      >
        {renderTrigger ? (
          renderTrigger({
            selectedModelLabel: triggerLabel,
            onPress: handleTriggerPress,
            disabled,
            isOpen,
          })
        ) : (
          <>
            {ProviderIcon ? (
              <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
            ) : null}
            <Text style={styles.triggerText} numberOfLines={1} ellipsizeMode="tail">
              {triggerLabel}
            </Text>
            <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </>
        )}
      </Pressable>
      <Combobox
        options={EMPTY_COMBOBOX_OPTIONS}
        value=""
        onSelect={noop}
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={360}
        desktopFixedHeight={desktopFixedHeight}
        header={sheetHeader}
        mobileChildrenScrollEnabled={view.kind !== "provider" || !isNative}
      >
        {isContentReady ? (
          <SelectorContent
            view={view}
            providers={providers}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            searchQuery={searchQuery}
            favoriteKeys={favoriteKeys}
            onSelect={handleSelect}
            onToggleFavorite={onToggleFavorite}
            onDrillDown={handleDrillDown}
          />
        ) : (
          <View style={styles.sheetLoadingState}>
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            <Text style={styles.sheetLoadingText}>Loading model selector…</Text>
          </View>
        )}
      </Combobox>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  triggerText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  customTriggerWrapper: {
    paddingHorizontal: 0,
    paddingVertical: 0,
    height: "auto",
  },
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
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    ...(IS_WEB ? {} : { marginHorizontal: theme.spacing[1] }),
  },
  sectionHeadingText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  drillDownRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    minHeight: 36,
    ...(IS_WEB ? {} : { marginHorizontal: theme.spacing[1] }),
  },
  drillDownRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  drillDownRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  drillDownText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
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
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[8],
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
  sheetLoadingState: {
    minHeight: 160,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sheetLoadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
