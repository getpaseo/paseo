import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb as platformIsWeb } from "@/constants/platform";
import { ArrowLeft, ChevronDown, ChevronRight, Search, Star } from "lucide-react-native";
import type { AgentModelDefinition, AgentProvider } from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
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

function backButtonStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.backButton,
    Boolean(hovered) && styles.backButtonHovered,
    pressed && styles.backButtonPressed,
  ];
}
import { getProviderIcon } from "@/components/provider-icons";
import {
  buildModelRows,
  buildSelectedTriggerLabel,
  matchesSearch,
  resolveProviderLabel,
  type SelectorModelRow,
} from "./combined-model-selector.utils";

// TODO: this should be configured per provider in the provider manifest
const PROVIDERS_WITH_MODEL_DESCRIPTIONS = new Set(["opencode", "pi"]);

type SelectorView =
  | { kind: "all" }
  | { kind: "provider"; providerId: string; providerLabel: string };

interface CombinedModelSelectorProps {
  providerDefinitions: AgentProviderDefinition[];
  allProviderModels: Map<string, AgentModelDefinition[]>;
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: AgentProvider, modelId: string) => void;
  isLoading: boolean;
  canSelectProvider?: (provider: string) => boolean;
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
  providerDefinitions: AgentProviderDefinition[];
  allProviderModels: Map<string, AgentModelDefinition[]>;
  selectedProvider: string;
  selectedModel: string;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  favoriteKeys: Set<string>;
  onSelect: (provider: string, modelId: string) => void;
  canSelectProvider: (provider: string) => boolean;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  onDrillDown: (providerId: string, providerLabel: string) => void;
}

function resolveDefaultModelLabel(models: AgentModelDefinition[] | undefined): string {
  if (!models || models.length === 0) {
    return "Select model";
  }
  return (models.find((model) => model.isDefault) ?? models[0])?.label ?? "Select model";
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function partitionRows(
  rows: SelectorModelRow[],
  favoriteKeys: Set<string>,
): { favoriteRows: SelectorModelRow[]; regularRows: SelectorModelRow[] } {
  const favoriteRows: SelectorModelRow[] = [];
  const regularRows: SelectorModelRow[] = [];

  for (const row of rows) {
    if (favoriteKeys.has(row.favoriteKey)) {
      favoriteRows.push(row);
      continue;
    }
    regularRows.push(row);
  }

  return { favoriteRows, regularRows };
}

function sortFavoritesFirst(
  rows: SelectorModelRow[],
  favoriteKeys: Set<string>,
): SelectorModelRow[] {
  const favorites: SelectorModelRow[] = [];
  const rest: SelectorModelRow[] = [];
  for (const row of rows) {
    if (favoriteKeys.has(row.favoriteKey)) {
      favorites.push(row);
    } else {
      rest.push(row);
    }
  }
  return [...favorites, ...rest];
}

function groupRowsByProvider(
  rows: SelectorModelRow[],
): Array<{ providerId: string; providerLabel: string; rows: SelectorModelRow[] }> {
  const grouped = new Map<
    string,
    { providerId: string; providerLabel: string; rows: SelectorModelRow[] }
  >();

  for (const row of rows) {
    const existing = grouped.get(row.provider);
    if (existing) {
      existing.rows.push(row);
      continue;
    }

    grouped.set(row.provider, {
      providerId: row.provider,
      providerLabel: row.providerLabel,
      rows: [row],
    });
  }

  return Array.from(grouped.values());
}

function ModelRow({
  row,
  isSelected,
  isFavorite,
  disabled = false,
  elevated = false,
  onPress,
  onToggleFavorite,
}: {
  row: SelectorModelRow;
  isSelected: boolean;
  isFavorite: boolean;
  disabled?: boolean;
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
      onToggleFavorite && !disabled ? (
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
      disabled,
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
      disabled={disabled}
      elevated={elevated}
      onPress={onPress}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
    />
  );
}

interface SelectableModelRowProps {
  row: SelectorModelRow;
  isSelected: boolean;
  isFavorite: boolean;
  disabled?: boolean;
  elevated?: boolean;
  onSelect: (provider: string, modelId: string) => void;
  onToggleFavorite?: (provider: string, modelId: string) => void;
}

function SelectableModelRow({
  row,
  isSelected,
  isFavorite,
  disabled,
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
      disabled={disabled}
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
  canSelectProvider,
  onToggleFavorite,
}: {
  favoriteRows: SelectorModelRow[];
  selectedProvider: string;
  selectedModel: string;
  favoriteKeys: Set<string>;
  onSelect: (provider: string, modelId: string) => void;
  canSelectProvider: (provider: string) => boolean;
  onToggleFavorite?: (provider: string, modelId: string) => void;
}) {
  const { theme: _theme } = useUnistyles();

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
          disabled={!canSelectProvider(row.provider)}
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
  onDrillDown: (providerId: string, providerLabel: string) => void;
}

function GroupProviderButton({
  providerId,
  providerLabel,
  rowCount,
  onDrillDown,
}: GroupProviderButtonProps) {
  const { theme } = useUnistyles();
  const ProvIcon = getProviderIcon(providerId);
  const handlePress = useCallback(() => {
    onDrillDown(providerId, providerLabel);
  }, [onDrillDown, providerId, providerLabel]);
  return (
    <Pressable onPress={handlePress} style={drillDownRowStyle}>
      <ProvIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      <Text style={styles.drillDownText}>{providerLabel}</Text>
      <View style={styles.drillDownTrailing}>
        <Text style={styles.drillDownCount}>
          {rowCount} {rowCount === 1 ? "model" : "models"}
        </Text>
        <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </View>
    </Pressable>
  );
}

function GroupedProviderRows({
  groupedRows,
  selectedProvider,
  selectedModel,
  favoriteKeys,
  onSelect,
  canSelectProvider,
  onToggleFavorite,
  onDrillDown,
  viewKind,
}: {
  groupedRows: Array<{ providerId: string; providerLabel: string; rows: SelectorModelRow[] }>;
  selectedProvider: string;
  selectedModel: string;
  favoriteKeys: Set<string>;
  onSelect: (provider: string, modelId: string) => void;
  canSelectProvider: (provider: string) => boolean;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  onDrillDown: (providerId: string, providerLabel: string) => void;
  viewKind: SelectorView["kind"];
}) {
  return (
    <View>
      {groupedRows.map((group, index) => {
        const isInline = viewKind === "provider";

        return (
          <View key={group.providerId}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {isInline ? (
              <>
                {sortFavoritesFirst(group.rows, favoriteKeys).map((row) => (
                  <SelectableModelRow
                    key={row.favoriteKey}
                    row={row}
                    isSelected={row.provider === selectedProvider && row.modelId === selectedModel}
                    isFavorite={favoriteKeys.has(row.favoriteKey)}
                    disabled={!canSelectProvider(row.provider)}
                    onSelect={onSelect}
                    onToggleFavorite={onToggleFavorite}
                  />
                ))}
              </>
            ) : (
              <GroupProviderButton
                providerId={group.providerId}
                providerLabel={group.providerLabel}
                rowCount={group.rows.length}
                onDrillDown={onDrillDown}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

function ProviderSearchInput({
  value,
  onChangeText,
  autoFocus = false,
}: {
  value: string;
  onChangeText: (text: string) => void;
  autoFocus?: boolean;
}) {
  const { theme } = useUnistyles();
  const inputRef = useRef<TextInput>(null);
  const isMobile = useIsCompactFormFactor();
  const InputComponent = isMobile ? BottomSheetTextInput : TextInput;

  useEffect(() => {
    if (!autoFocus || !platformIsWeb || !inputRef.current) return () => {};
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [autoFocus]);

  const inputStyle = useMemo(
    () => [styles.providerSearchInput, platformIsWeb && { outlineStyle: "none" }],
    [],
  );

  return (
    <View style={styles.providerSearchContainer}>
      <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      <InputComponent
        ref={inputRef as unknown as Ref<never>}
        // @ts-expect-error - outlineStyle is web-only
        style={inputStyle}
        placeholder="Search models..."
        placeholderTextColor={theme.colors.foregroundMuted}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function SelectorContent({
  view,
  providerDefinitions,
  allProviderModels,
  selectedProvider,
  selectedModel,
  searchQuery,
  onSearchChange: _onSearchChange,
  favoriteKeys,
  onSelect,
  canSelectProvider,
  onToggleFavorite,
  onDrillDown,
}: SelectorContentProps) {
  const { theme } = useUnistyles();
  const allRows = useMemo(
    () => buildModelRows(providerDefinitions, allProviderModels),
    [allProviderModels, providerDefinitions],
  );

  const scopedRows = useMemo(() => {
    if (view.kind === "provider") {
      return allRows.filter((row) => row.provider === view.providerId);
    }
    return allRows;
  }, [allRows, view]);

  const normalizedQuery = useMemo(() => normalizeSearchQuery(searchQuery), [searchQuery]);

  const visibleRows = useMemo(
    () => scopedRows.filter((row) => matchesSearch(row, normalizedQuery)),
    [normalizedQuery, scopedRows],
  );

  const { favoriteRows, regularRows: _regularRows } = useMemo(
    () => partitionRows(visibleRows, favoriteKeys),
    [favoriteKeys, visibleRows],
  );

  // Group ALL visible rows by provider — favorites are a cross-cutting view,
  // not a partition. A model being favorited doesn't remove it from its provider.
  const allGroupedRows = useMemo(() => groupRowsByProvider(visibleRows), [visibleRows]);

  // When searching at Level 1, filter grouped rows to only providers whose name or models match
  const filteredGroupedRows = useMemo(() => {
    if (view.kind === "provider" || !normalizedQuery) {
      return allGroupedRows;
    }
    return allGroupedRows.filter(
      (group) =>
        group.providerLabel.toLowerCase().includes(normalizedQuery) || group.rows.length > 0,
    );
  }, [allGroupedRows, normalizedQuery, view.kind]);

  const hasResults = favoriteRows.length > 0 || filteredGroupedRows.length > 0;

  return (
    <View>
      {view.kind === "all" ? (
        <FavoritesSection
          favoriteRows={favoriteRows}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          favoriteKeys={favoriteKeys}
          onSelect={onSelect}
          canSelectProvider={canSelectProvider}
          onToggleFavorite={onToggleFavorite}
        />
      ) : null}

      {filteredGroupedRows.length > 0 ? (
        <GroupedProviderRows
          groupedRows={filteredGroupedRows}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          favoriteKeys={favoriteKeys}
          onSelect={onSelect}
          canSelectProvider={canSelectProvider}
          onToggleFavorite={onToggleFavorite}
          onDrillDown={onDrillDown}
          viewKind={view.kind}
        />
      ) : null}

      {!hasResults ? (
        <View style={styles.emptyState}>
          <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={styles.emptyStateText}>No models match your search</Text>
        </View>
      ) : null}
    </View>
  );
}

function ProviderBackButton({
  providerId,
  providerLabel,
  onBack,
}: {
  providerId: string;
  providerLabel: string;
  onBack?: () => void;
}) {
  const { theme } = useUnistyles();
  const ProviderIcon = getProviderIcon(providerId);

  if (!onBack) {
    return null;
  }

  return (
    <Pressable onPress={onBack} style={backButtonStyle}>
      <ArrowLeft size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      <ProviderIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      <Text style={styles.backButtonText}>{providerLabel}</Text>
    </Pressable>
  );
}

export function CombinedModelSelector({
  providerDefinitions,
  allProviderModels,
  selectedProvider,
  selectedModel,
  onSelect,
  isLoading,
  canSelectProvider = () => true,
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

  // Single-provider mode: only one provider with models → skip Level 1 entirely
  const singleProviderView = useMemo<SelectorView | null>(() => {
    const providers = Array.from(allProviderModels.keys());
    if (providers.length !== 1) return null;
    const providerId = providers[0];
    const label = resolveProviderLabel(providerDefinitions, providerId);
    return { kind: "provider", providerId, providerLabel: label };
  }, [allProviderModels, providerDefinitions]);

  const computeInitialView = useCallback((): SelectorView => {
    if (singleProviderView) return singleProviderView;

    const selectedFavoriteKey = `${selectedProvider}:${selectedModel}`;
    if (selectedProvider && selectedModel && !favoriteKeys.has(selectedFavoriteKey)) {
      const label = resolveProviderLabel(providerDefinitions, selectedProvider);
      return { kind: "provider", providerId: selectedProvider, providerLabel: label };
    }

    return { kind: "all" };
  }, [singleProviderView, selectedProvider, selectedModel, favoriteKeys, providerDefinitions]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      setView(computeInitialView());
      if (open) {
        onOpen?.();
      } else {
        setSearchQuery("");
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
    },
    [onSelect],
  );

  const hasSelectedProvider = selectedProvider.trim().length > 0;
  const ProviderIcon = hasSelectedProvider ? getProviderIcon(selectedProvider) : null;

  const selectedModelLabel = useMemo(() => {
    if (!selectedModel) {
      if (!hasSelectedProvider) {
        return "Select model";
      }
      return isLoading ? "Loading..." : "Select model";
    }
    const models = allProviderModels.get(selectedProvider);
    if (!models) {
      return isLoading ? "Loading..." : "Select model";
    }
    const model = models.find((entry) => entry.id === selectedModel);
    return model?.label ?? resolveDefaultModelLabel(models);
  }, [allProviderModels, hasSelectedProvider, isLoading, selectedModel, selectedProvider]);

  const desktopFixedHeight = useMemo(() => {
    if (view.kind !== "provider") {
      return undefined;
    }
    const models = allProviderModels.get(view.providerId);
    const modelCount = models?.length ?? 0;
    return Math.min(80 + modelCount * 40, 400);
  }, [allProviderModels, view]);

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
  }, []);

  const handleDrillDown = useCallback((providerId: string, providerLabel: string) => {
    setView({ kind: "provider", providerId, providerLabel });
  }, []);

  const stickyHeader = useMemo(
    () =>
      view.kind === "provider" ? (
        <View style={styles.level2Header}>
          {!singleProviderView ? (
            <ProviderBackButton
              providerId={view.providerId}
              providerLabel={view.providerLabel}
              onBack={handleBackToAll}
            />
          ) : null}
          <ProviderSearchInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus={platformIsWeb}
          />
        </View>
      ) : undefined,
    [view, singleProviderView, handleBackToAll, searchQuery],
  );

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
        title="Select model"
        stickyHeader={stickyHeader}
      >
        {isContentReady ? (
          <SelectorContent
            view={view}
            providerDefinitions={providerDefinitions}
            allProviderModels={allProviderModels}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            favoriteKeys={favoriteKeys}
            onSelect={handleSelect}
            canSelectProvider={canSelectProvider}
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
  level2Header: {},
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    ...(IS_WEB ? {} : { marginHorizontal: theme.spacing[1] }),
  },
  backButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  backButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  backButtonText: {
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
  providerSearchContainer: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[2],
    ...(IS_WEB ? {} : { marginHorizontal: theme.spacing[1] }),
  },
  providerSearchInput: {
    flex: 1,
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
