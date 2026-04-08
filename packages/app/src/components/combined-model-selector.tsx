import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Platform,
  ActivityIndicator,
  type GestureResponderEvent,
} from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Search,
  Star,
} from "lucide-react-native";
import type {
  AgentModelDefinition,
  AgentProvider,
} from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
const IS_WEB = Platform.OS === "web";

import { Combobox, ComboboxItem } from "@/components/ui/combobox";
import { getProviderIcon } from "@/components/provider-icons";
import type { FavoriteModelRow } from "@/hooks/use-form-preferences";
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
  const grouped = new Map<string, { providerId: string; providerLabel: string; rows: SelectorModelRow[] }>();

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

  const showDescription =
    row.description && PROVIDERS_WITH_MODEL_DESCRIPTIONS.has(row.provider);

  return (
    <ComboboxItem
      label={row.modelLabel}
      description={showDescription ? row.description : undefined}
      selected={isSelected}
      disabled={disabled}
      elevated={elevated}
      onPress={onPress}
      leadingSlot={<ProviderIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />}
      trailingSlot={
        onToggleFavorite && !disabled ? (
          <Pressable
            onPress={handleToggleFavorite}
            hitSlop={8}
            style={({ pressed, hovered }) => [
              styles.favoriteButton,
              hovered && styles.favoriteButtonHovered,
              pressed && styles.favoriteButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={isFavorite ? "Unfavorite model" : "Favorite model"}
            testID={`favorite-model-${row.provider}-${row.modelId}`}
          >
            {({ hovered }) => (
              <Star
                size={16}
                color={
                  isFavorite
                    ? theme.colors.palette.amber[500]
                    : hovered
                      ? theme.colors.foregroundMuted
                      : theme.colors.border
                }
                fill={isFavorite ? theme.colors.palette.amber[500] : "transparent"}
              />
            )}
          </Pressable>
        ) : null
      }
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
  const { theme } = useUnistyles();

  if (favoriteRows.length === 0) {
    return null;
  }

  return (
    <View style={styles.favoritesContainer}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionHeadingText}>Favorites</Text>
      </View>
      {favoriteRows.map((row) => (
        <ModelRow
          key={row.favoriteKey}
          row={row}
          isSelected={row.provider === selectedProvider && row.modelId === selectedModel}
          isFavorite={favoriteKeys.has(row.favoriteKey)}
          disabled={!canSelectProvider(row.provider)}
          elevated
          onPress={() => onSelect(row.provider, row.modelId)}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </View>
  );
}

function GroupedProviderRows({
  providerDefinitions,
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
  providerDefinitions: AgentProviderDefinition[];
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
  const { theme } = useUnistyles();

  return (
    <View>
      {groupedRows.map((group, index) => {
        const providerDefinition = providerDefinitions.find((definition) => definition.id === group.providerId);
        const ProvIcon = getProviderIcon(group.providerId);
        const isInline = viewKind === "provider";

        return (
          <View key={group.providerId}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {isInline ? (
              <>
                {sortFavoritesFirst(group.rows, favoriteKeys).map((row) => (
                  <ModelRow
                    key={row.favoriteKey}
                    row={row}
                    isSelected={row.provider === selectedProvider && row.modelId === selectedModel}
                    isFavorite={favoriteKeys.has(row.favoriteKey)}
                    disabled={!canSelectProvider(row.provider)}
                    onPress={() => onSelect(row.provider, row.modelId)}
                    onToggleFavorite={onToggleFavorite}
                  />
                ))}
              </>
            ) : (
              <Pressable
                onPress={() => onDrillDown(group.providerId, group.providerLabel)}
                style={({ pressed, hovered }) => [
                  styles.drillDownRow,
                  hovered && styles.drillDownRowHovered,
                  pressed && styles.drillDownRowPressed,
                ]}
              >
                <ProvIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                <Text style={styles.drillDownText}>{group.providerLabel}</Text>
                <View style={styles.drillDownTrailing}>
                  <Text style={styles.drillDownCount}>
                    {group.rows.length} {group.rows.length === 1 ? "model" : "models"}
                  </Text>
                  <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                </View>
              </Pressable>
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
  const InputComponent = Platform.OS === "web" ? TextInput : BottomSheetTextInput;

  useEffect(() => {
    if (autoFocus && Platform.OS === "web" && inputRef.current) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [autoFocus]);

  return (
    <View style={styles.providerSearchContainer}>
      <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      <InputComponent
        ref={inputRef as any}
        // @ts-expect-error - outlineStyle is web-only
        style={[styles.providerSearchInput, Platform.OS === "web" && { outlineStyle: "none" }]}
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
  onSearchChange,
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

  const { favoriteRows, regularRows } = useMemo(
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
          providerDefinitions={providerDefinitions}
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
    <Pressable
      onPress={onBack}
      style={({ pressed, hovered }) => [
        styles.backButton,
        hovered && styles.backButtonHovered,
        pressed && styles.backButtonPressed,
      ]}
    >
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
  onClose,
  disabled = false,
}: CombinedModelSelectorProps) {
  const { theme } = useUnistyles();
  const isWeb = Platform.OS === "web";
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isContentReady, setIsContentReady] = useState(isWeb);
  const [view, setView] = useState<SelectorView>({ kind: "all" });
  const [searchQuery, setSearchQuery] = useState("");

  // Single-provider mode: only one provider with models → skip Level 1 entirely
  const singleProviderView = useMemo<SelectorView | null>(() => {
    const providers = Array.from(allProviderModels.keys());
    if (providers.length !== 1) return null;
    const providerId = providers[0]!;
    const label = resolveProviderLabel(providerDefinitions, providerId);
    return { kind: "provider", providerId, providerLabel: label };
  }, [allProviderModels, providerDefinitions]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      setView(singleProviderView ?? { kind: "all" });
      if (!open) {
        setSearchQuery("");
        onClose?.();
      }
    },
    [onClose, singleProviderView],
  );

  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider as AgentProvider, modelId);
      setIsOpen(false);
      setView(singleProviderView ?? { kind: "all" });
      setSearchQuery("");
    },
    [onSelect, singleProviderView],
  );

  const ProviderIcon = getProviderIcon(selectedProvider);
  const selectedProviderLabel = useMemo(
    () => resolveProviderLabel(providerDefinitions, selectedProvider),
    [providerDefinitions, selectedProvider],
  );

  const selectedModelLabel = useMemo(() => {
    const models = allProviderModels.get(selectedProvider);
    if (!models) {
      return isLoading ? "Loading..." : "Select model";
    }
    const model = models.find((entry) => entry.id === selectedModel);
    return model?.label ?? resolveDefaultModelLabel(models);
  }, [allProviderModels, isLoading, selectedModel, selectedProvider]);

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

    return buildSelectedTriggerLabel(selectedProviderLabel, selectedModelLabel);
  }, [selectedModelLabel, selectedProviderLabel]);

  useEffect(() => {
    if (isWeb) {
      return;
    }

    if (!isOpen) {
      setIsContentReady(false);
      return;
    }

    const frame = requestAnimationFrame(() => {
      setIsContentReady(true);
    });

    return () => cancelAnimationFrame(frame);
  }, [isOpen, isWeb]);

  return (
    <>
      <Pressable
        ref={anchorRef}
        collapsable={false}
        disabled={disabled}
        onPress={() => handleOpenChange(!isOpen)}
        style={({ pressed, hovered }) => [
          styles.trigger,
          hovered && styles.triggerHovered,
          (pressed || isOpen) && styles.triggerPressed,
          disabled && styles.triggerDisabled,
          renderTrigger ? styles.customTriggerWrapper : null,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Select model (${selectedModelLabel})`}
        testID="combined-model-selector"
      >
        {renderTrigger ? (
          renderTrigger({
            selectedModelLabel: triggerLabel,
            onPress: () => handleOpenChange(!isOpen),
            disabled,
            isOpen,
          })
        ) : (
          <>
            <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
            <Text style={styles.triggerText}>{triggerLabel}</Text>
            <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </>
        )}
      </Pressable>
      <Combobox
        options={[]}
        value=""
        onSelect={() => {}}
        open={isOpen}
        onOpenChange={handleOpenChange}
        stackBehavior="push"
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={360}
        desktopFixedHeight={desktopFixedHeight}
        title="Select model"
        stickyHeader={
          view.kind === "provider" ? (
            <View style={styles.level2Header}>
              {!singleProviderView ? (
                <ProviderBackButton
                  providerId={view.providerId}
                  providerLabel={view.providerLabel}
                  onBack={() => {
                    setView({ kind: "all" });
                    setSearchQuery("");
                  }}
                />
              ) : null}
              <ProviderSearchInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoFocus={Platform.OS === "web"}
              />
            </View>
          ) : undefined
        }
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
            onDrillDown={(providerId, providerLabel) => {
              setView({ kind: "provider", providerId, providerLabel });
            }}
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
  level2Header: {
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
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
