import { Pin, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentModelDefinition, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import { compareMatchScores, scoreTextFields } from "@getpaseo/protocol/search/text-match";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { SearchField } from "@/components/ui/search-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import {
  resolveProviderDiscoveredModels,
  type ProviderDiscoveredModelsCache,
} from "./discovered-models";
import type { ProviderEntry } from "./provider-config";
import { ProviderRefreshButton, useCheckedLabel, type ProviderRefresh } from "./provider-refresh";

const ThemedTrash = withUnistyles(Trash2);
const ThemedPin = withUnistyles(Pin, (theme) => ({ size: theme.iconSize.sm }));
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const activePinMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
  fill: theme.colors.foregroundMuted,
});
const inactivePinMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
  fill: "none" as const,
});
const ThemedTextInput = withUnistyles(AdaptiveTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

function rankModels<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  if (!query) return items;
  const scored = items
    .map((item) => ({ item, score: scoreTextFields(query, fields(item)) }))
    .filter(
      (entry): entry is { item: T; score: NonNullable<typeof entry.score> } => entry.score !== null,
    );
  scored.sort((a, b) => compareMatchScores(a.score, b.score));
  return scored.map((entry) => entry.item);
}

/**
 * A provider's models: search, the ones it reports, and the ones added by hand. The caller decides
 * whether it appears and whether the provider's own models are listed.
 */
export function ProviderModels({
  serverId,
  entry,
  refresh,
}: {
  serverId: string;
  entry: ProviderEntry;
  /**
   * Lists the models the provider reports, with search and the way to ask for them again. Null for
   * a provider that is not running, which reports none.
   */
  refresh: ProviderRefresh | null;
}) {
  const { t } = useTranslation();
  const provider = entry.provider;
  const discovered = refresh !== null;
  const { config, isLoading: configLoading, patchConfig } = useDaemonConfig(serverId);
  const { preferences, updatePreferences } = useFormPreferences();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const configReady = config !== null && !configLoading;

  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider],
  );
  const loading = entry.status === "loading";
  // A refresh briefly empties the snapshot's models; keep the last list on screen meanwhile.
  const discoveredCacheRef = useRef<ProviderDiscoveredModelsCache | null>(null);
  const { models: discoveredModels, cache } = resolveProviderDiscoveredModels({
    serverId,
    provider,
    currentModels: entry.models,
    providerSnapshotRefreshing: loading,
    previousCache: discoveredCacheRef.current,
  });
  discoveredCacheRef.current = cache;

  const defaultModelId = useMemo(
    () =>
      preferences.providerPreferences?.[provider]?.pinnedModel ??
      additionalModels.find((model) => model.isDefault === true)?.id ??
      null,
    [additionalModels, preferences, provider],
  );
  const handleToggleDefaultModel = useCallback(
    async (modelId: string) => {
      if (!configReady) {
        return;
      }
      const previousPreferences = preferences;
      const alreadyDefault =
        preferences.providerPreferences?.[provider]?.pinnedModel === modelId ||
        additionalModels.some((model) => model.id === modelId && model.isDefault === true);
      try {
        // The pin lives in its own preference field (chat model switches write
        // `model`, and a switch must never override the pin) and is mirrored
        // into the daemon config so the default also holds for headless
        // clients: the agent manager's catalog resolution reads isDefault
        // from the provider's additionalModels.
        await updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: provider as AgentProvider,
            updates: { pinnedModel: alreadyDefault ? null : modelId },
          }),
        );
        // Compute the next list before patching: the daemon replaces the
        // additionalModels array wholesale, so the patch must carry every
        // existing entry, not just the changed one.
        const cleared = additionalModels.map((model) =>
          model.isDefault ? { ...model, isDefault: false } : model,
        );
        let nextModels = cleared;
        if (!alreadyDefault) {
          const existing = cleared.find((model) => model.id === modelId);
          const label =
            existing?.label ??
            discoveredModels.find((model) => model.id === modelId)?.label ??
            modelId;
          nextModels = [
            ...cleared.filter((model) => model.id !== modelId),
            { id: modelId, label, isDefault: true },
          ];
        }
        await patchConfig({
          providers: {
            [provider]: {
              additionalModels: nextModels,
            },
          },
        });
      } catch (error) {
        console.warn("[ProviderModels] toggle default model failed", error);
        // Roll the preference back so the app-side pin cannot disagree with
        // the daemon-side default after a failed save.
        await updatePreferences(() => previousPreferences).catch(() => undefined);
        toast.error(t("settings.providers.models.setDefaultFailed"));
      }
    },
    [
      additionalModels,
      configReady,
      discoveredModels,
      patchConfig,
      preferences,
      provider,
      t,
      toast,
      updatePreferences,
    ],
  );

  // Search shows only beside the provider's own models; a query typed then must not hide custom ones.
  const q = discovered ? query.trim() : "";
  const filteredDiscovered = useMemo(
    () => rankModels(discoveredModels, q, (m) => [m.label, m.id, m.description ?? ""]),
    [discoveredModels, q],
  );
  const filteredCustom = useMemo(
    () => rankModels(additionalModels, q, (m) => [m.label, m.id]),
    [additionalModels, q],
  );

  const handleOpenAddSheet = useCallback(() => setAddSheetOpen(true), []);
  const handleCloseAddSheet = useCallback(() => setAddSheetOpen(false), []);
  const handleDeleteCustom = useCallback(
    (modelId: string) => {
      setDeletingModelId(modelId);
      void patchConfig({
        providers: {
          [provider]: {
            additionalModels: additionalModels.filter((model) => model.id !== modelId),
          },
        },
      }).finally(() => {
        setDeletingModelId((current) => (current === modelId ? null : current));
      });
    },
    [additionalModels, patchConfig, provider],
  );

  const customTrailing = useMemo(
    () => (
      <View style={styles.headerTrailing}>
        {additionalModels.length > 0 ? (
          <Text style={settingsStyles.sectionHeaderTitle}>{additionalModels.length}</Text>
        ) : null}
        <Button
          variant="ghost"
          leftIcon={Plus}
          onPress={handleOpenAddSheet}
          accessibilityLabel={t("settings.providers.models.addModel")}
          testID="provider-add-model"
        />
      </View>
    ),
    [additionalModels.length, handleOpenAddSheet, t],
  );

  const discoveredTrailing = useMemo(
    () =>
      refresh ? <DiscoveredTrailing count={discoveredModels.length} refresh={refresh} /> : null,
    [discoveredModels.length, refresh],
  );

  let discoveredBody: React.ReactNode;
  if (discoveredModels.length === 0) {
    discoveredBody = (
      <MutedRow>
        {loading
          ? t("settings.providers.models.loading")
          : t("settings.providers.models.noneDetected")}
      </MutedRow>
    );
  } else if (filteredDiscovered.length === 0) {
    discoveredBody = <MutedRow>{t("settings.providers.models.noSearchMatches")}</MutedRow>;
  } else {
    discoveredBody = filteredDiscovered.map((model, index) => (
      <DiscoveredModelRow
        key={model.id}
        model={model}
        first={index === 0}
        isDefault={model.id === defaultModelId}
        onToggleDefault={handleToggleDefaultModel}
        disableToggle={!configReady}
      />
    ));
  }

  let customBody: React.ReactNode;
  if (additionalModels.length === 0) {
    customBody = <MutedRow>{t("settings.providers.models.noCustom")}</MutedRow>;
  } else if (filteredCustom.length === 0) {
    customBody = <MutedRow>{t("settings.providers.models.noSearchMatches")}</MutedRow>;
  } else {
    customBody = filteredCustom.map((model, index) => (
      <CustomModelRow
        key={model.id}
        model={model}
        first={index === 0}
        deleting={deletingModelId === model.id}
        onDelete={handleDeleteCustom}
      />
    ));
  }

  return (
    <View testID="provider-models">
      {discovered ? (
        <SettingsSection title={t("settings.providers.models.title")} trailing={discoveredTrailing}>
          <View style={styles.searchRow}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder={t("settings.providers.models.searchPlaceholder")}
              clearAccessibilityLabel={t("sessions.actions.clearSearch")}
              fullWidth
              testID="provider-settings-search"
            />
          </View>
          <View style={settingsStyles.card}>
            {/* A provider can report hundreds of models; the rest of the page stays in reach. */}
            <ScrollView
              style={styles.discoveredList}
              // Android scrolls a ScrollView nested in the page or the sheet only with this flag.
              nestedScrollEnabled
              testID="provider-discovered-models"
            >
              {discoveredBody}
            </ScrollView>
          </View>
        </SettingsSection>
      ) : null}
      <SettingsSection title={t("settings.providers.models.custom")} trailing={customTrailing}>
        <View style={settingsStyles.card}>{customBody}</View>
      </SettingsSection>
      <AddCustomModelSheet
        serverId={serverId}
        provider={provider}
        additionalModels={additionalModels}
        visible={addSheetOpen}
        onClose={handleCloseAddSheet}
      />
    </View>
  );
}

/** How many models the provider reports, when it last reported them, and the way to ask again. */
function DiscoveredTrailing({ count, refresh }: { count: number; refresh: ProviderRefresh }) {
  const checked = useCheckedLabel(refresh);
  const facts = [count > 0 ? String(count) : null, checked].filter(Boolean).join(" · ");
  return (
    <View style={styles.headerTrailing}>
      {facts ? (
        <Text style={[settingsStyles.sectionHeaderTitle, styles.headerFacts]} numberOfLines={1}>
          {facts}
        </Text>
      ) : null}
      <ProviderRefreshButton refresh={refresh} form="icon" />
    </View>
  );
}

function MutedRow({ children }: { children: string }) {
  return (
    <View style={styles.modelRow}>
      <Text style={settingsStyles.sectionHeaderTitle}>{children}</Text>
    </View>
  );
}

function DiscoveredModelRow({
  model,
  first,
  isDefault,
  onToggleDefault,
  disableToggle,
}: {
  model: AgentModelDefinition;
  first: boolean;
  isDefault: boolean;
  onToggleDefault?: (modelId: string) => void;
  disableToggle?: boolean;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onToggleDefault?.(model.id), [model.id, onToggleDefault]);
  return (
    <View style={[styles.modelRow, !first && settingsStyles.rowBorder]}>
      <ToolbarButton
        label={
          isDefault
            ? t("settings.providers.models.clearDefault")
            : t("settings.providers.models.setDefault")
        }
        onPress={handlePress}
        disabled={disableToggle}
        round
        testID={`provider-model-default-${model.id}`}
      >
        <ThemedPin uniProps={isDefault ? activePinMapping : inactivePinMapping} />
      </ToolbarButton>
      <Text style={styles.modelTitle} numberOfLines={1}>
        {model.label}
        {isDefault ? (
          <Text style={styles.defaultBadgeText}>
            {" "}
            {t("settings.providers.models.defaultBadge")}
          </Text>
        ) : null}
      </Text>
      <Text style={styles.monoHint} numberOfLines={1} selectable dataSet={CODE_SURFACE_DATASET}>
        {model.id}
      </Text>
      {model.description ? (
        <Text style={styles.descriptionInline} numberOfLines={1}>
          {model.description}
        </Text>
      ) : null}
    </View>
  );
}

function CustomModelRow({
  model,
  first,
  deleting,
  onDelete,
}: {
  model: ProviderProfileModel;
  first: boolean;
  deleting: boolean;
  onDelete: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const handleDelete = useCallback(() => onDelete(model.id), [model.id, onDelete]);

  return (
    <View style={[styles.modelRow, !first && settingsStyles.rowBorder]}>
      <Text style={[styles.modelTitle, styles.customModelText]} numberOfLines={1}>
        {model.label}
      </Text>
      <Text
        style={[styles.monoHint, styles.customModelText]}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {model.id}
      </Text>
      <View style={styles.modelRowFiller} />
      <ToolbarButton
        label={t("settings.providers.models.removeModel", { id: model.id })}
        onPress={handleDelete}
        disabled={deleting}
        compact={compact}
      >
        <ThemedTrash
          size={paneContentToolbarIconSize(compact)}
          uniProps={destructiveColorMapping}
        />
      </ToolbarButton>
    </View>
  );
}

function AddCustomModelSheet({
  serverId,
  provider,
  additionalModels,
  visible,
  onClose,
}: {
  serverId: string;
  provider: string;
  additionalModels: ProviderProfileModel[];
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { patchConfig } = useDaemonConfig(serverId);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const trimmed = input.trim();
  const canAdd = trimmed.length > 0 && !additionalModels.some((model) => model.id === trimmed);

  useEffect(() => {
    if (!visible) {
      setInput("");
      setError(null);
    }
  }, [visible]);

  const handleAdd = useCallback(() => {
    if (!canAdd) return;
    setError(null);
    setSaving(true);
    void patchConfig({
      providers: {
        [provider]: {
          additionalModels: [...additionalModels, { id: trimmed, label: trimmed }],
        },
      },
    })
      .then(() => onClose())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : t("settings.providers.models.failedToSave"));
      })
      .finally(() => setSaving(false));
  }, [additionalModels, canAdd, onClose, patchConfig, provider, t, trimmed]);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.providers.models.addCustomTitle") }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={420}
      snapPoints={ADD_SNAP_POINTS}
      testID="add-custom-model-sheet"
    >
      <View style={styles.formGroup}>
        <Text style={styles.formLabel}>{t("settings.providers.models.modelId")}</Text>
        <ThemedTextInput
          initialValue={input}
          resetKey={`add-custom-${visible}`}
          onChangeText={setInput}
          onSubmitEditing={handleAdd}
          placeholder={t("settings.providers.models.modelIdPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          // @ts-expect-error - outlineStyle is web-only
          style={[styles.formInput, isWeb && { outlineStyle: "none" }]}
        />
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.formActions}>
          <Button variant="secondary" onPress={onClose} disabled={saving}>
            {t("common.actions.cancel")}
          </Button>
          <Button variant="default" onPress={handleAdd} disabled={!canAdd} loading={saving}>
            {saving ? t("settings.providers.models.adding") : t("settings.providers.models.add")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const ADD_SNAP_POINTS = ["40%"];

const styles = StyleSheet.create((theme) => ({
  // The search field sizes itself along a row.
  searchRow: {
    flexDirection: "row",
  },
  // Nine rows and part of a tenth, so a longer list visibly continues.
  discoveredList: {
    maxHeight: 320,
  },
  headerTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // The facts give way before the button does.
  headerFacts: {
    flexShrink: 1,
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 0,
  },
  defaultBadgeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  monoHint: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  descriptionInline: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  customModelText: {
    flexShrink: 1,
    minWidth: 0,
  },
  modelRowFiller: {
    flex: 1,
  },
  formGroup: {
    gap: theme.spacing[3],
  },
  formLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  formInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
