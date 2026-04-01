import { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, Platform, type GestureResponderEvent } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Search,
  Star,
} from "lucide-react-native";
import type { AgentModelDefinition, AgentProvider } from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import { Combobox, ComboboxItem, SearchInput } from "@/components/ui/combobox";
import { getProviderIcon } from "@/components/provider-icons";
import type { FavoriteModelRow } from "@/hooks/use-form-preferences";
import {
  buildModelRows,
  buildSelectedTriggerLabel,
  matchesSearch,
  resolveProviderLabel,
  type SelectorModelRow,
} from "./combined-model-selector.utils";

const INLINE_MODEL_THRESHOLD = Number.POSITIVE_INFINITY;

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
  onBack?: () => void;
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
  onPress,
  onToggleFavorite,
}: {
  row: SelectorModelRow;
  isSelected: boolean;
  isFavorite: boolean;
  disabled?: boolean;
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

  return (
    <ComboboxItem
      label={row.modelLabel}
      description={
        disabled
          ? `${row.providerLabel} · Available when creating a ${row.providerLabel} agent`
          : row.description
            ? `${row.providerLabel} · ${row.description}`
            : row.providerLabel
      }
      selected={isSelected}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={<ProviderIcon size={14} color={theme.colors.foregroundMuted} />}
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
            <Star
              size={16}
              color={isFavorite ? theme.colors.palette.amber[500] : theme.colors.foregroundMuted}
              fill={isFavorite ? theme.colors.palette.amber[500] : "transparent"}
            />
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
    <View>
      <View style={styles.sectionHeading}>
        <Star size={14} color={theme.colors.palette.amber[500]} fill={theme.colors.palette.amber[500]} />
        <Text style={styles.sectionHeadingText}>Favorites</Text>
      </View>
      {favoriteRows.map((row) => (
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
      <View style={styles.separator} />
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
}) {
  const { theme } = useUnistyles();

  return (
    <View>
      {groupedRows.map((group, index) => {
        const providerDefinition = providerDefinitions.find((definition) => definition.id === group.providerId);
        const ProvIcon = getProviderIcon(group.providerId);
        const isInline = group.rows.length <= INLINE_MODEL_THRESHOLD;

        return (
          <View key={group.providerId}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {isInline ? (
              <>
                <View style={styles.sectionHeading}>
                  <ProvIcon size={14} color={theme.colors.foregroundMuted} />
                  <Text style={styles.sectionHeadingText}>
                    {providerDefinition?.label ?? group.providerLabel}
                  </Text>
                </View>
                {group.rows.map((row) => (
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
                <ProvIcon size={14} color={theme.colors.foregroundMuted} />
                <Text style={styles.drillDownText}>{group.providerLabel}</Text>
                <View style={styles.drillDownTrailing}>
                  <Text style={styles.drillDownCount}>{group.rows.length}</Text>
                  <ChevronRight size={14} color={theme.colors.foregroundMuted} />
                </View>
              </Pressable>
            )}
          </View>
        );
      })}
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
  onBack,
}: SelectorContentProps) {
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

  const groupedRegularRows = useMemo(() => groupRowsByProvider(regularRows), [regularRows]);

  return (
    <View>
      {view.kind === "provider" ? (
        <ProviderBackButton providerId={view.providerId} providerLabel={view.providerLabel} onBack={onBack} />
      ) : null}

      <SearchInput
        placeholder={view.kind === "provider" ? "Search models..." : "Search models or providers..."}
        value={searchQuery}
        onChangeText={onSearchChange}
        autoFocus={Platform.OS === "web"}
      />

      <FavoritesSection
        favoriteRows={favoriteRows}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        favoriteKeys={favoriteKeys}
        onSelect={onSelect}
        canSelectProvider={canSelectProvider}
        onToggleFavorite={onToggleFavorite}
      />

      {groupedRegularRows.length > 0 ? (
        <GroupedProviderRows
          providerDefinitions={providerDefinitions}
          groupedRows={groupedRegularRows}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          favoriteKeys={favoriteKeys}
          onSelect={onSelect}
          canSelectProvider={canSelectProvider}
          onToggleFavorite={onToggleFavorite}
          onDrillDown={onDrillDown}
        />
      ) : null}

      {favoriteRows.length === 0 && groupedRegularRows.length === 0 ? (
        <View style={styles.emptyState}>
          <Search size={16} color="#777" />
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
      <ArrowLeft size={14} color={theme.colors.foregroundMuted} />
      <ProviderIcon size={14} color={theme.colors.foregroundMuted} />
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
  disabled = false,
}: CombinedModelSelectorProps) {
  const { theme } = useUnistyles();
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<SelectorView>({ kind: "all" });
  const [searchQuery, setSearchQuery] = useState("");

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      setView({ kind: "all" });
      if (!open) {
        setSearchQuery("");
      }
    },
    [],
  );

  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider as AgentProvider, modelId);
      setIsOpen(false);
      setView({ kind: "all" });
      setSearchQuery("");
    },
    [onSelect],
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

  const triggerLabel = useMemo(() => {
    if (selectedModelLabel === "Loading..." || selectedModelLabel === "Select model") {
      return selectedModelLabel;
    }

    return buildSelectedTriggerLabel(selectedProviderLabel, selectedModelLabel);
  }, [selectedModelLabel, selectedProviderLabel]);

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
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        title="Select model"
      >
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
          onBack={
            view.kind === "provider"
              ? () => {
                  setView({ kind: "all" });
                }
              : undefined
          }
        />
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
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
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
  },
  drillDownRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  drillDownRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  drillDownText: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
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
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButtonHovered: {
    backgroundColor: theme.colors.surface1,
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
}));
