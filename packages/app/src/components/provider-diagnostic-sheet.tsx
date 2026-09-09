import * as Clipboard from "expo-clipboard";
import { AlertTriangle, Copy, FileText, Plus, RotateCw, Trash2 } from "lucide-react-native";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScrollableCodeSurface, SurfaceCard } from "@/components/ui/scrollable-code-surface";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { retryModelSelection, useModelVisibility } from "@/hooks/use-model-visibility";
import { isModelVisible } from "@/provider-selection/model-visibility";
import { switchGeometry } from "@/components/ui/control-geometry";
import { Switch } from "@/components/ui/switch";
import { toErrorMessage } from "@/utils/error-messages";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { formatTimeAgo } from "@/utils/time";
import { compareMatchScores, scoreTextFields } from "@getpaseo/protocol/search/text-match";
import type { AgentModelDefinition, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import {
  resolveProviderDiscoveredModels,
  type ProviderDiscoveredModelsCache,
} from "./provider-diagnostic-models";

const MODEL_ROW_ICON_BUTTON_SIZE = 28;

interface ProviderDiagnosticSheetProps {
  provider: string;
  visible: boolean;
  onClose: () => void;
  serverId: string;
}

function rankModels<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  if (!query.trim()) return items;
  const scored = items
    .map((item) => ({ item, score: scoreTextFields(query, fields(item)) }))
    .filter(
      (entry): entry is { item: T; score: NonNullable<typeof entry.score> } => entry.score !== null,
    );
  scored.sort((a, b) => compareMatchScores(a.score, b.score));
  return scored.map((entry) => entry.item);
}

interface ModelVisibilityToggleProps {
  modelId: string;
  visible: boolean;
  disabled: boolean;
  onToggle: (modelId: string, visible: boolean) => void;
}

function ModelVisibilityToggle({
  modelId,
  visible,
  disabled,
  onToggle,
}: ModelVisibilityToggleProps) {
  const { t } = useTranslation();
  const handleValueChange = useCallback(
    (next: boolean) => onToggle(modelId, next),
    [modelId, onToggle],
  );
  return (
    <Switch
      value={visible}
      onValueChange={handleValueChange}
      disabled={disabled}
      accessibilityLabel={t("settings.providers.models.visibilityToggle", { id: modelId })}
      testID={`provider-model-visibility-${modelId}`}
    />
  );
}

function DiscoveredModelRow({
  model,
  visibility,
}: {
  model: AgentModelDefinition;
  visibility: ModelRowVisibility | null;
}) {
  return (
    <View style={sheetStyles.modelRow}>
      <Text style={sheetStyles.modelTitle} numberOfLines={1}>
        {model.label}
      </Text>
      <Text
        style={sheetStyles.monoHint}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {model.id}
      </Text>
      {model.description ? (
        <Text style={sheetStyles.descriptionInline} numberOfLines={1}>
          {model.description}
        </Text>
      ) : (
        // The description already flexes. Only a row without one needs a filler
        // to keep the switch on the right edge.
        <View style={sheetStyles.modelRowFiller} />
      )}
      {visibility ? (
        <View style={sheetStyles.modelRowControls} testID={`provider-model-controls-${model.id}`}>
          <ModelVisibilityToggle
            modelId={model.id}
            visible={visibility.isVisible(model.id)}
            disabled={visibility.disabled}
            onToggle={visibility.onToggle}
          />
        </View>
      ) : null}
    </View>
  );
}

function CustomModelRow({
  model,
  deleting,
  onDelete,
  visibility,
}: {
  model: ProviderProfileModel;
  deleting: boolean;
  onDelete: (modelId: string) => void;
  visibility: ModelRowVisibility | null;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const handleDelete = useCallback(() => onDelete(model.id), [model.id, onDelete]);
  const deleteButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      deleting ? sheetStyles.disabled : null,
    ],
    [deleting],
  );

  return (
    <View style={sheetStyles.modelRow}>
      <Text style={sheetStyles.modelTitle} numberOfLines={1}>
        {model.label}
      </Text>
      <Text
        style={sheetStyles.monoHint}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {model.id}
      </Text>
      <View style={sheetStyles.modelRowFiller} />
      {/* Delete sits before the switch so the switch keeps the same right edge as discovered rows. */}
      <View style={sheetStyles.modelRowControls} testID={`provider-model-controls-${model.id}`}>
        <Pressable
          onPress={handleDelete}
          disabled={deleting}
          hitSlop={8}
          style={deleteButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={t("settings.providers.models.removeModel", { id: model.id })}
          testID={`provider-model-remove-${model.id}`}
        >
          <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />
        </Pressable>
        {visibility ? (
          <ModelVisibilityToggle
            modelId={model.id}
            visible={visibility.isVisible(model.id)}
            disabled={visibility.disabled}
            onToggle={visibility.onToggle}
          />
        ) : null}
      </View>
    </View>
  );
}

function SectionHeader({ title, count, hint }: { title: string; count?: number; hint?: string }) {
  return (
    <View style={sheetStyles.sectionHeader}>
      <Text style={settingsStyles.sectionHeaderTitle}>{title}</Text>
      <View style={sheetStyles.sectionHeaderMeta}>
        {count !== undefined ? (
          <Text style={settingsStyles.sectionHeaderTitle}>{count}</Text>
        ) : null}
        {count !== undefined && hint ? (
          <Text style={settingsStyles.sectionHeaderTitle}>·</Text>
        ) : null}
        {hint ? <Text style={settingsStyles.sectionHeaderTitle}>{hint}</Text> : null}
      </View>
    </View>
  );
}

function AddCustomModelSubSheet({
  provider,
  serverId,
  visible,
  onClose,
  refresh,
}: {
  provider: string;
  serverId: string;
  visible: boolean;
  onClose: () => void;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider],
  );
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
      .then(() => refresh([provider]))
      .then(() => onClose())
      .catch((err) => {
        setError(err instanceof Error ? err.message : t("settings.providers.models.failedToSave"));
      })
      .finally(() => setSaving(false));
  }, [additionalModels, canAdd, onClose, patchConfig, provider, refresh, t, trimmed]);

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
      <View style={sheetStyles.formGroup}>
        <Text style={sheetStyles.formLabel}>{t("settings.providers.models.modelId")}</Text>
        <AdaptiveTextInput
          initialValue={input}
          resetKey={`add-custom-${visible}`}
          onChangeText={setInput}
          onSubmitEditing={handleAdd}
          placeholder={t("settings.providers.models.modelIdPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          // @ts-expect-error - outlineStyle is web-only
          style={[sheetStyles.formInput, isWeb && { outlineStyle: "none" }]}
        />
        {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
        <View style={sheetStyles.formActions}>
          <Button variant="secondary" size="sm" onPress={onClose} disabled={saving}>
            {t("common.actions.cancel")}
          </Button>
          <Button variant="default" size="sm" onPress={handleAdd} disabled={!canAdd || saving}>
            {saving ? t("settings.providers.models.adding") : t("settings.providers.models.add")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function DiagnosticSubSheet({
  provider,
  serverId,
  visible,
  onClose,
}: {
  provider: string;
  serverId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchDiagnostic = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.getProviderDiagnostic(provider);
      setDiagnostic(result.diagnostic);
    } catch (err) {
      setDiagnostic(
        err instanceof Error ? err.message : t("settings.providers.diagnostic.failedToFetch"),
      );
    } finally {
      setLoading(false);
    }
  }, [client, provider, t]);

  useEffect(() => {
    if (visible) {
      void fetchDiagnostic();
    } else {
      setDiagnostic(null);
    }
  }, [visible, fetchDiagnostic]);

  const refreshButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      loading ? sheetStyles.disabled : null,
    ],
    [loading],
  );

  const handleRefreshPress = useCallback(() => {
    void fetchDiagnostic();
  }, [fetchDiagnostic]);

  const copyButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && Boolean(diagnostic) && sheetStyles.iconButtonHovered,
      diagnostic ? null : sheetStyles.disabled,
    ],
    [diagnostic],
  );

  const handleCopyPress = useCallback(() => {
    if (!diagnostic) return;
    void Clipboard.setStringAsync(diagnostic)
      .then(() => toast.copied(t("settings.providers.diagnostic.copyLabel")))
      .catch(() => toast.error(t("settings.providers.diagnostic.copyFailed")));
  }, [diagnostic, t, toast]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.providers.diagnostic.title"),
      actions: (
        <View style={sheetStyles.headerActions}>
          <Pressable
            onPress={handleCopyPress}
            disabled={!diagnostic}
            hitSlop={8}
            style={copyButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={t("settings.providers.diagnostic.copyAccessibility")}
          >
            <Copy size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            onPress={handleRefreshPress}
            disabled={loading}
            hitSlop={8}
            style={refreshButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={
              loading
                ? t("settings.providers.diagnostic.refreshingAccessibility")
                : t("settings.providers.diagnostic.refreshAccessibility")
            }
          >
            {loading ? (
              <LoadingSpinner size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            ) : (
              <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
        </View>
      ),
    }),
    [
      copyButtonStyle,
      diagnostic,
      handleCopyPress,
      handleRefreshPress,
      loading,
      refreshButtonStyle,
      t,
      theme.colors.foregroundMuted,
      theme.iconSize.sm,
    ],
  );

  let body: React.ReactNode;
  if (loading && !diagnostic) {
    body = (
      <SurfaceCard key={visible ? "visible" : "hidden"}>
        <View style={sheetStyles.codeBlockLoading}>
          <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>{t("settings.providers.diagnostic.running")}</Text>
        </View>
      </SurfaceCard>
    );
  } else if (diagnostic) {
    body = (
      <ScrollableCodeSurface key={visible ? "visible" : "hidden"} maxHeight={480}>
        {diagnostic}
      </ScrollableCodeSurface>
    );
  } else {
    body = (
      <SurfaceCard key={visible ? "visible" : "hidden"}>
        <View style={sheetStyles.codeBlockLoading}>
          <Text style={sheetStyles.mutedText}>{t("settings.providers.diagnostic.none")}</Text>
        </View>
      </SurfaceCard>
    );
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={DIAGNOSTIC_SNAP_POINTS}
      scrollable={false}
      testID="provider-diagnostic-sheet"
    >
      {body}
    </AdaptiveModalSheet>
  );
}

interface ProviderModalBodyProps {
  discoveredCount: number;
  additionalCount: number;
  providerSnapshotRefreshing: boolean;
  providerErrorMessage: string | null;
  modelsRefreshing: boolean;
  searchActive: boolean;
  filteredDiscovered: AgentModelDefinition[];
  filteredCustom: ProviderProfileModel[];
  deletingModelId: string | null;
  onRefresh: () => void;
  onDeleteCustom: (modelId: string) => void;
  visibility: ModelRowVisibility | null;
  visibilityStatus: "unavailable" | "loading" | "error";
  onRetryVisibility: (() => void) | null;
  visibilityError: string | null;
  theme: { iconSize: { md: number }; colors: { foregroundMuted: string } };
}

/** Everything a model row needs to render and drive its visibility switch. */
export interface ModelRowVisibility {
  isVisible: (modelId: string) => boolean;
  disabled: boolean;
  onToggle: (modelId: string, visible: boolean) => void;
}

interface ProviderSheetFooterInput {
  fetchedAtLabel: string | null;
  isCompact: boolean;
  modelsRefreshing: boolean;
  t: TFunction;
  onOpenAddSheet: () => void;
  onOpenDiagSheet: () => void;
  onRefreshModels: () => void;
}

function renderProviderSheetFooter({
  fetchedAtLabel,
  isCompact,
  modelsRefreshing,
  t,
  onOpenAddSheet,
  onOpenDiagSheet,
  onRefreshModels,
}: ProviderSheetFooterInput) {
  const contentStyle = isCompact ? sheetStyles.compactFooterContent : sheetStyles.footerContent;
  const actionsStyle = isCompact ? sheetStyles.compactFooterActions : sheetStyles.footerActions;
  const buttonStyle = isCompact ? sheetStyles.compactFooterButton : null;
  const metaStyle = isCompact
    ? [sheetStyles.footerMeta, sheetStyles.compactFooterMeta]
    : sheetStyles.footerMeta;

  return (
    <View style={contentStyle}>
      {fetchedAtLabel || !isCompact ? (
        <Text style={metaStyle} numberOfLines={1}>
          {fetchedAtLabel ? t("settings.providers.models.updated", { time: fetchedAtLabel }) : ""}
        </Text>
      ) : null}
      <View style={actionsStyle}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={Plus}
          onPress={onOpenAddSheet}
          style={buttonStyle}
        >
          {t("settings.providers.models.addModel")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={FileText}
          onPress={onOpenDiagSheet}
          style={buttonStyle}
        >
          {t("settings.providers.diagnostic.button")}
        </Button>
        <Button
          variant="default"
          size="sm"
          leftIcon={modelsRefreshing ? undefined : RotateCw}
          onPress={onRefreshModels}
          disabled={modelsRefreshing}
          style={buttonStyle}
        >
          {modelsRefreshing
            ? t("settings.providers.diagnostic.refreshing")
            : t("settings.providers.diagnostic.refresh")}
        </Button>
      </View>
    </View>
  );
}

function ProviderModalBody(props: ProviderModalBodyProps) {
  const { t } = useTranslation();
  const {
    discoveredCount,
    additionalCount,
    providerSnapshotRefreshing,
    providerErrorMessage,
    modelsRefreshing,
    searchActive,
    filteredDiscovered,
    filteredCustom,
    deletingModelId,
    onRefresh,
    onDeleteCustom,
    visibility,
    visibilityStatus,
    onRetryVisibility,
    visibilityError,
    theme,
  } = props;

  if (discoveredCount === 0 && additionalCount === 0 && providerSnapshotRefreshing) {
    return (
      <View style={sheetStyles.emptyState}>
        <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.loading")}</Text>
      </View>
    );
  }
  if (discoveredCount === 0 && additionalCount === 0 && providerErrorMessage) {
    return (
      <View style={sheetStyles.emptyState}>
        <AlertTriangle size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        <Text style={sheetStyles.mutedText}>{providerErrorMessage}</Text>
        <Button variant="default" size="sm" onPress={onRefresh} disabled={modelsRefreshing}>
          {modelsRefreshing
            ? t("settings.providers.models.retrying")
            : t("settings.providers.models.retry")}
        </Button>
      </View>
    );
  }
  if (filteredDiscovered.length === 0 && filteredCustom.length === 0 && searchActive) {
    return (
      <View style={sheetStyles.emptyState}>
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.noSearchMatches")}</Text>
      </View>
    );
  }
  if (discoveredCount === 0 && additionalCount === 0) {
    return (
      <View style={sheetStyles.emptyState}>
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.noneDetected")}</Text>
      </View>
    );
  }
  return (
    <>
      <Text style={sheetStyles.visibilityHint}>
        {visibility
          ? t("settings.providers.models.visibilityHint")
          : t(`settings.providers.models.visibility.${visibilityStatus}`)}
      </Text>
      {visibilityStatus === "error" && onRetryVisibility ? (
        // This screen is where the user is sent to recover, so it has to be able
        // to recover itself rather than only naming the problem.
        <View style={sheetStyles.visibilityRetryRow}>
          <Button
            variant="secondary"
            size="sm"
            onPress={onRetryVisibility}
            testID="provider-model-visibility-retry"
          >
            {t("settings.providers.models.retry")}
          </Button>
        </View>
      ) : null}
      {visibilityError ? <Text style={sheetStyles.visibilityError}>{visibilityError}</Text> : null}
      {filteredDiscovered.length > 0 ? (
        <View style={sheetStyles.section}>
          <SectionHeader
            title={t("settings.providers.models.discovered")}
            count={filteredDiscovered.length}
          />
          <View style={settingsStyles.card}>
            {filteredDiscovered.map((model) => (
              <DiscoveredModelRow key={model.id} model={model} visibility={visibility} />
            ))}
          </View>
        </View>
      ) : null}
      {filteredCustom.length > 0 ? (
        <View style={sheetStyles.section}>
          <SectionHeader
            title={t("settings.providers.models.custom")}
            count={filteredCustom.length}
          />
          <View style={settingsStyles.card}>
            {filteredCustom.map((model) => (
              <CustomModelRow
                key={model.id}
                model={model}
                deleting={deletingModelId === model.id}
                onDelete={onDeleteCustom}
                visibility={visibility}
              />
            ))}
          </View>
        </View>
      ) : null}
    </>
  );
}

export function ProviderDiagnosticSheet({
  provider,
  visible,
  onClose,
  serverId,
}: ProviderDiagnosticSheetProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const { entries: snapshotEntries, refresh, isRefreshing } = useProvidersSnapshot(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [query, setQuery] = useState("");
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [diagSheetOpen, setDiagSheetOpen] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);

  const providerLabel = resolveProviderLabel(provider, snapshotEntries);
  const providerEntry = useMemo(
    () => snapshotEntries?.find((entry) => entry.provider === provider),
    [snapshotEntries, provider],
  );
  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider],
  );
  const providerSnapshotRefreshing = providerEntry?.status === "loading";
  const providerErrorMessage =
    providerEntry?.status === "error"
      ? (providerEntry.error ?? t("settings.providers.diagnostic.unknownError"))
      : null;
  const modelsRefreshing = isRefreshing || providerSnapshotRefreshing;

  const stableDiscoveredRef = useRef<ProviderDiscoveredModelsCache | null>(null);
  const currentModels = providerEntry?.models;
  const { models: discoveredModels, cache: nextDiscoveredCache } = resolveProviderDiscoveredModels({
    serverId,
    provider,
    currentModels,
    providerSnapshotRefreshing,
    previousCache: stableDiscoveredRef.current,
  });
  stableDiscoveredRef.current = nextDiscoveredCache;

  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setClockTick((tick) => tick + 1), 10_000);
    return () => clearInterval(id);
  }, [visible]);
  const fetchedAtLabel = useMemo(() => {
    if (!providerEntry?.fetchedAt) return null;
    void clockTick;
    return formatTimeAgo(new Date(providerEntry.fetchedAt));
  }, [providerEntry?.fetchedAt, clockTick]);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setAddSheetOpen(false);
      setDiagSheetOpen(false);
      setVisibilityError(null);
    }
  }, [visible]);

  const q = query.trim();
  const filteredDiscovered = useMemo(
    () => rankModels(discoveredModels, q, (m) => [m.label, m.id, m.description ?? ""]),
    [discoveredModels, q],
  );
  const filteredCustom = useMemo(
    () => rankModels(additionalModels, q, (m) => [m.label, m.id]),
    [additionalModels, q],
  );

  const handleRefreshModels = useCallback(() => {
    void refresh([provider]);
  }, [provider, refresh]);

  const modelVisibility = useModelVisibility(serverId);
  const [pendingVisibilityModelId, setPendingVisibilityModelId] = useState<string | null>(null);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const providerVisibility = modelVisibility.visibilityByProvider?.[provider];

  const handleToggleVisibility = useCallback(
    (modelId: string, nextVisible: boolean) => {
      setPendingVisibilityModelId(modelId);
      setVisibilityError(null);
      // Only one toggle is in flight at a time, so a slow response cannot land
      // after a newer one and resurrect the older value.
      void modelVisibility
        .setModelVisible(provider, modelId, nextVisible)
        .catch((error: unknown) => {
          setVisibilityError(
            t("settings.providers.models.visibilitySaveFailed", { error: toErrorMessage(error) }),
          );
        })
        .finally(() => {
          setPendingVisibilityModelId((current) => (current === modelId ? null : current));
        });
    },
    [modelVisibility, provider, t],
  );

  const rowVisibility = useMemo<ModelRowVisibility | null>(() => {
    if (modelVisibility.status !== "ready") return null;
    return {
      // Rendered from the config the daemon acknowledged, never from local
      // optimism, so a rejected save shows the state that actually persisted.
      isVisible: (modelId: string) => isModelVisible(providerVisibility, modelId),
      disabled: pendingVisibilityModelId !== null,
      onToggle: handleToggleVisibility,
    };
  }, [
    handleToggleVisibility,
    modelVisibility.status,
    pendingVisibilityModelId,
    providerVisibility,
  ]);

  const handleRetryVisibility = useCallback(() => {
    retryModelSelection({
      status: modelVisibility.status,
      retryVisibility: modelVisibility.retry,
      refreshDiscovery: () => refresh([provider]),
    });
  }, [modelVisibility.retry, modelVisibility.status, provider, refresh]);

  const handleOpenAddSheet = useCallback(() => setAddSheetOpen(true), []);
  const handleCloseAddSheet = useCallback(() => setAddSheetOpen(false), []);
  const handleOpenDiagSheet = useCallback(() => setDiagSheetOpen(true), []);
  const handleCloseDiagSheet = useCallback(() => setDiagSheetOpen(false), []);

  const handleDeleteCustom = useCallback(
    (modelId: string) => {
      setDeletingModelId(modelId);
      void patchConfig({
        providers: {
          [provider]: {
            additionalModels: additionalModels.filter((model) => model.id !== modelId),
          },
        },
      })
        .then(() => refresh([provider]))
        .finally(() => {
          setDeletingModelId((current) => (current === modelId ? null : current));
        });
    },
    [additionalModels, patchConfig, provider, refresh],
  );

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: providerLabel,
      search: {
        onChange: setQuery,
        placeholder: t("settings.providers.models.searchPlaceholder"),
        testID: "provider-settings-search",
      },
    }),
    [providerLabel, t],
  );

  return (
    <>
      <AdaptiveModalSheet
        header={sheetHeader}
        visible={visible}
        onClose={onClose}
        testID="provider-settings-sheet"
        footer={renderProviderSheetFooter({
          fetchedAtLabel,
          isCompact,
          modelsRefreshing,
          t,
          onOpenAddSheet: handleOpenAddSheet,
          onOpenDiagSheet: handleOpenDiagSheet,
          onRefreshModels: handleRefreshModels,
        })}
        snapPoints={MAIN_SNAP_POINTS}
      >
        <ProviderModalBody
          discoveredCount={discoveredModels.length}
          additionalCount={additionalModels.length}
          providerSnapshotRefreshing={providerSnapshotRefreshing}
          providerErrorMessage={providerErrorMessage}
          modelsRefreshing={modelsRefreshing}
          searchActive={Boolean(q)}
          filteredDiscovered={filteredDiscovered}
          filteredCustom={filteredCustom}
          deletingModelId={deletingModelId}
          onRefresh={handleRefreshModels}
          onDeleteCustom={handleDeleteCustom}
          visibility={rowVisibility}
          visibilityStatus={
            modelVisibility.status === "ready" ? "unavailable" : modelVisibility.status
          }
          onRetryVisibility={modelVisibility.status === "error" ? handleRetryVisibility : null}
          visibilityError={visibilityError}
          theme={theme}
        />
      </AdaptiveModalSheet>
      <AddCustomModelSubSheet
        provider={provider}
        serverId={serverId}
        visible={addSheetOpen}
        onClose={handleCloseAddSheet}
        refresh={refresh}
      />
      <DiagnosticSubSheet
        provider={provider}
        serverId={serverId}
        visible={diagSheetOpen}
        onClose={handleCloseDiagSheet}
      />
    </>
  );
}

const sheetStyles = StyleSheet.create((theme) => ({
  mutedText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  monoHint: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
    // Shrink is weighted by basis, so a heavy factor makes the ID give up
    // nearly all of the loss before the human label starts to truncate.
    flexShrink: 4,
    minWidth: 0,
  },
  descriptionInline: {
    flex: 1,
    // A flex child defaults to min-width auto, which refuses to shrink below
    // its content and is enough on its own to overflow the row.
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
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
  iconButton: {
    width: MODEL_ROW_ICON_BUTTON_SIZE,
    height: MODEL_ROW_ICON_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  disabled: {
    opacity: 0.5,
  },
  section: {
    marginBottom: theme.spacing[4],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  sectionHeaderMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    // Guard only: the children below are sized so nothing should reach here.
    overflow: "hidden",
  },
  modelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
    minWidth: 0,
  },
  modelRowFiller: {
    flex: 1,
  },
  modelRowControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    flexShrink: 0,
    // Same width for discovered (switch only) and custom (delete + switch)
    // rows so the switch's right edge lines up across sections.
    width: MODEL_ROW_ICON_BUTTON_SIZE + theme.spacing[2] + switchGeometry.trackWidth,
  },
  visibilityHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
  visibilityRetryRow: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    alignItems: "flex-start",
  },
  visibilityError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  emptyState: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  footerContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  compactFooterContent: {
    flex: 1,
    gap: theme.spacing[2],
  },
  footerMeta: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  compactFooterMeta: {
    flex: 0,
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  compactFooterActions: {
    gap: theme.spacing[2],
  },
  compactFooterButton: {
    alignSelf: "stretch",
  },
  formGroup: {
    gap: theme.spacing[3],
  },
  formLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  codeBlockLoading: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));

const MAIN_SNAP_POINTS = ["65%", "92%"];
const ADD_SNAP_POINTS = ["40%"];
const DIAGNOSTIC_SNAP_POINTS = ["50%", "85%"];
