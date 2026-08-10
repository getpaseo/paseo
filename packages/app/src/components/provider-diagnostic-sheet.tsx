import * as Clipboard from "expo-clipboard";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  Copy,
  FileText,
  Image as ImageIcon,
  Mic,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  Type,
  Video,
  Wrench,
} from "lucide-react-native";
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
import { Combobox } from "@/components/ui/combobox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScrollableCodeSurface, SurfaceCard } from "@/components/ui/scrollable-code-surface";
import {
  applyCandidateToFields,
  buildSavedCustomModel,
  candidateSourceId,
  CUSTOM_MODEL_METADATA_SOURCE_ID,
  describeCandidateOption,
  formatTokenCount,
  parsePositiveTokenInput,
  resolveCustomModelFormFields,
  resolveCustomModelLookup,
  type ModelsDevCandidateLike,
} from "@/components/provider-custom-model-form";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
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

function DiscoveredModelRow({ model }: { model: AgentModelDefinition }) {
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
      ) : null}
    </View>
  );
}

function formatContextWindowTokens(tokens: number | undefined): string | null {
  return formatTokenCount(tokens);
}

function CustomModelRow({
  model,
  deleting,
  onEdit,
  onDelete,
}: {
  model: ProviderProfileModel;
  deleting: boolean;
  onEdit: (model: ProviderProfileModel) => void;
  onDelete: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const handleEdit = useCallback(() => onEdit(model), [model, onEdit]);
  const handleDelete = useCallback(() => onDelete(model.id), [model.id, onDelete]);
  const iconButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      deleting ? sheetStyles.disabled : null,
    ],
    [deleting],
  );
  const contextWindowLabel = formatContextWindowTokens(model.contextWindowMaxTokens);
  const maxOutputLabel = formatContextWindowTokens(model.maxOutputTokens);
  const limitsLabel = [contextWindowLabel, maxOutputLabel ? `out ${maxOutputLabel}` : null]
    .filter(Boolean)
    .join(" · ");

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
      {limitsLabel ? (
        <Text style={sheetStyles.descriptionInline} numberOfLines={1}>
          {limitsLabel}
        </Text>
      ) : null}
      <View style={sheetStyles.modelRowFiller} />
      <Pressable
        onPress={handleEdit}
        disabled={deleting}
        hitSlop={8}
        style={iconButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.models.editModel", { id: model.id })}
      >
        <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </Pressable>
      <Pressable
        onPress={handleDelete}
        disabled={deleting}
        hitSlop={8}
        style={iconButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.models.removeModel", { id: model.id })}
      >
        <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />
      </Pressable>
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

function parseContextWindowInput(value: string): number | undefined | "invalid" {
  return parsePositiveTokenInput(value);
}

function resolveCustomModelSaveLabel(
  t: TFunction,
  options: { isEdit: boolean; saving: boolean },
): string {
  if (options.saving) {
    if (options.isEdit) {
      return t("settings.providers.models.saving");
    }
    return t("settings.providers.models.adding");
  }
  if (options.isEdit) {
    return t("settings.providers.models.save");
  }
  return t("settings.providers.models.add");
}

function buildCustomModelList(
  additionalModels: ProviderProfileModel[],
  nextModel: ProviderProfileModel,
  originalId: string | null,
): ProviderProfileModel[] {
  if (originalId === null) {
    return [...additionalModels, nextModel];
  }
  return additionalModels.map((model) => (model.id === originalId ? nextModel : model));
}

const ADD_CUSTOM_MODEL_MODE = { kind: "add" } as const;

function modalityIcon(kind: string, color: string) {
  const size = 14;
  switch (kind) {
    case "text":
      return <Type size={size} color={color} />;
    case "image":
      return <ImageIcon size={size} color={color} />;
    case "audio":
      return <Mic size={size} color={color} />;
    case "video":
      return <Video size={size} color={color} />;
    case "pdf":
      return <FileText size={size} color={color} />;
    default:
      return <Type size={size} color={color} />;
  }
}

function capabilityIcon(kind: string, color: string) {
  if (kind === "tools") {
    return <Wrench size={14} color={color} />;
  }
  if (kind === "reasoning" || kind === "interleaved") {
    return <Brain size={14} color={color} />;
  }
  return <Type size={14} color={color} />;
}

function ModelMetadataSummary({ summary }: { summary: ModelsDevCandidateLike | null }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  if (!summary) {
    return null;
  }
  const contextLabel =
    summary.contextWindowMaxTokens > 0
      ? (formatTokenCount(summary.contextWindowMaxTokens) ?? String(summary.contextWindowMaxTokens))
      : "—";
  const maxOutputLabel =
    typeof summary.maxOutputTokens === "number"
      ? (formatTokenCount(summary.maxOutputTokens) ?? String(summary.maxOutputTokens))
      : "—";
  const inputs = summary.inputModalities ?? [];
  const outputs = summary.outputModalities ?? [];
  const capabilities = summary.capabilities ?? [];
  if (
    summary.contextWindowMaxTokens <= 0 &&
    summary.maxOutputTokens === undefined &&
    inputs.length === 0 &&
    outputs.length === 0 &&
    capabilities.length === 0
  ) {
    return null;
  }

  return (
    <View style={sheetStyles.summaryCard} testID="custom-model-metadata-summary">
      <View style={sheetStyles.summaryGrid}>
        <View style={sheetStyles.summaryCell}>
          <Text style={sheetStyles.summaryLabel}>
            {t("settings.providers.models.contextWindow")}
          </Text>
          <Text style={sheetStyles.summaryValue}>{contextLabel}</Text>
        </View>
        <View style={sheetStyles.summaryCell}>
          <Text style={sheetStyles.summaryLabel}>{t("settings.providers.models.maxOutput")}</Text>
          <Text style={sheetStyles.summaryValue}>{maxOutputLabel}</Text>
        </View>
      </View>
      {inputs.length > 0 ? (
        <View style={sheetStyles.summaryRow}>
          <Text style={sheetStyles.summaryLabel}>{t("settings.providers.models.inputTypes")}</Text>
          <View style={sheetStyles.iconRow}>
            {inputs.map((item) => (
              <View key={`in-${item}`} style={sheetStyles.iconChip} accessibilityLabel={item}>
                {modalityIcon(item, theme.colors.foregroundMuted)}
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {outputs.length > 0 ? (
        <View style={sheetStyles.summaryRow}>
          <Text style={sheetStyles.summaryLabel}>{t("settings.providers.models.outputTypes")}</Text>
          <View style={sheetStyles.iconRow}>
            {outputs.map((item) => (
              <View key={`out-${item}`} style={sheetStyles.iconChip} accessibilityLabel={item}>
                {modalityIcon(item, theme.colors.foregroundMuted)}
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {capabilities.length > 0 ? (
        <View style={sheetStyles.summaryRow}>
          <Text style={sheetStyles.summaryLabel}>
            {t("settings.providers.models.capabilities")}
          </Text>
          <View style={sheetStyles.iconRow}>
            {capabilities.map((item) => (
              <View key={`cap-${item}`} style={sheetStyles.capabilityChip}>
                {capabilityIcon(item, theme.colors.foregroundMuted)}
                <Text style={sheetStyles.capabilityText}>{item}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function resolveSelectedCandidate(
  sourceId: string,
  candidates: ModelsDevCandidateLike[],
  summary: ModelsDevCandidateLike | null,
): ModelsDevCandidateLike | null {
  if (sourceId === CUSTOM_MODEL_METADATA_SOURCE_ID) {
    return null;
  }
  return candidates.find((entry) => candidateSourceId(entry) === sourceId) ?? summary;
}

function createEmptyAutofillSnapshot(): {
  label: string;
  contextWindow: string;
  maxOutput: string;
} {
  return { label: "", contextWindow: "", maxOutput: "" };
}

// Form has progressive disclosure branches for lookup/source/manual values.
// eslint-disable-next-line complexity -- multi-case custom model form UI
function CustomModelFormSubSheet({
  provider,
  serverId,
  visible,
  mode,
  onClose,
  refresh,
}: {
  provider: string;
  serverId: string;
  visible: boolean;
  mode: { kind: "add" } | { kind: "edit"; model: ProviderProfileModel };
  onClose: () => void;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [modelId, setModelId] = useState("");
  const [label, setLabel] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutput, setMaxOutput] = useState("");
  const [sourceId, setSourceId] = useState(CUSTOM_MODEL_METADATA_SOURCE_ID);
  const [candidates, setCandidates] = useState<ModelsDevCandidateLike[]>([]);
  const [summary, setSummary] = useState<ModelsDevCandidateLike | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceAnchorRef = useRef<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookupHint, setLookupHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const lastAutofilledRef = useRef({ label: "", contextWindow: "", maxOutput: "" });
  const lookupRequestIdRef = useRef(0);

  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider],
  );
  const isEdit = mode.kind === "edit";
  const originalId = mode.kind === "edit" ? mode.model.id : null;
  const trimmedId = modelId.trim();
  const trimmedLabel = label.trim();
  const parsedContext = parseContextWindowInput(contextWindow);
  const parsedMaxOutput = parseContextWindowInput(maxOutput);
  const idConflict =
    trimmedId.length > 0 &&
    additionalModels.some((model) => model.id === trimmedId && model.id !== originalId);
  const canSave =
    trimmedId.length > 0 &&
    !idConflict &&
    parsedContext !== "invalid" &&
    parsedMaxOutput !== "invalid" &&
    !saving;
  const saveLabel = resolveCustomModelSaveLabel(t, { isEdit, saving });

  const sourceOptions = useMemo(() => {
    const customOption = {
      id: CUSTOM_MODEL_METADATA_SOURCE_ID,
      label: t("settings.providers.models.metadataSourceCustom"),
      description: t("settings.providers.models.metadataSourceCustomDescription"),
    };
    return [customOption, ...candidates.map(describeCandidateOption)];
  }, [candidates, t]);

  const selectedSourceOption = useMemo(
    () => sourceOptions.find((option) => option.id === sourceId) ?? sourceOptions[0]!,
    [sourceId, sourceOptions],
  );

  const showSourcePicker = candidates.length > 1;

  useEffect(() => {
    if (!visible) {
      setModelId("");
      setLabel("");
      setContextWindow("");
      setMaxOutput("");
      setSourceId(CUSTOM_MODEL_METADATA_SOURCE_ID);
      setCandidates([]);
      setSummary(null);
      setSourceOpen(false);
      setError(null);
      setLookupHint(null);
      setLookingUp(false);
      lastAutofilledRef.current = createEmptyAutofillSnapshot();
      return;
    }
    const fields = resolveCustomModelFormFields(mode);
    setModelId(fields.modelId);
    setLabel(fields.label);
    setContextWindow(fields.contextWindow);
    setMaxOutput(fields.maxOutput);
    setSourceId(fields.sourceId);
    setSummary(fields.summary);
    setCandidates([]);
    setError(null);
    setLookupHint(null);
    lastAutofilledRef.current = createEmptyAutofillSnapshot();
  }, [mode, visible]);

  const applyCandidate = useCallback(
    (candidate: ModelsDevCandidateLike, options?: { forceSource?: boolean }) => {
      const applied = applyCandidateToFields(
        candidate,
        {
          label,
          contextWindow,
          maxOutput,
        },
        lastAutofilledRef.current,
      );
      setLabel(applied.next.label);
      setContextWindow(applied.next.contextWindow);
      setMaxOutput(applied.next.maxOutput);
      lastAutofilledRef.current = applied.lastAutofilled;
      setSummary(candidate);
      if (options?.forceSource !== false) {
        setSourceId(candidateSourceId(candidate));
      }
    },
    [contextWindow, label, maxOutput],
  );

  const runModelsDevLookup = useCallback(async () => {
    const query = modelId.trim();
    if (!query || !client) {
      return;
    }

    const requestId = ++lookupRequestIdRef.current;
    setLookingUp(true);
    setLookupHint(t("settings.providers.models.lookingUpModel"));
    try {
      const preferredProviderId = mode.kind === "edit" ? mode.model.modelsDevProviderId : undefined;
      const lookup = await resolveCustomModelLookup({
        client,
        modelId: query,
        preferredProviderId,
      });
      if (requestId !== lookupRequestIdRef.current) {
        return;
      }
      if (lookup.kind !== "found" || !lookup.preferred) {
        setCandidates([]);
        setSourceId(CUSTOM_MODEL_METADATA_SOURCE_ID);
        setLookupHint(t("settings.providers.models.modelsDevNotFound"));
        return;
      }

      setCandidates(lookup.candidates);
      applyCandidate(lookup.preferred);
      setLookupHint(
        lookup.candidates.length > 1
          ? t("settings.providers.models.modelsDevChooseSource")
          : t("settings.providers.models.modelsDevAutofilled"),
      );
    } catch {
      if (requestId === lookupRequestIdRef.current) {
        setLookupHint(t("settings.providers.models.modelsDevLookupFailed"));
      }
    } finally {
      if (requestId === lookupRequestIdRef.current) {
        setLookingUp(false);
      }
    }
  }, [applyCandidate, client, mode, modelId, t]);

  const handleModelIdLookup = useCallback(() => {
    void runModelsDevLookup();
  }, [runModelsDevLookup]);

  const openSourcePicker = useCallback(() => {
    setSourceOpen(true);
  }, []);

  const handleSourceSelect = useCallback(
    (nextSourceId: string) => {
      setSourceOpen(false);
      const candidate = resolveSelectedCandidate(nextSourceId, candidates, null);
      if (!candidate) {
        setSourceId(CUSTOM_MODEL_METADATA_SOURCE_ID);
        return;
      }
      applyCandidate(candidate);
    },
    [applyCandidate, candidates],
  );

  const handleSave = useCallback(() => {
    const contextTokens = parseContextWindowInput(contextWindow);
    const maxOutputTokens = parseContextWindowInput(maxOutput);
    if (!canSave || contextTokens === "invalid" || maxOutputTokens === "invalid") {
      return;
    }
    if (idConflict) {
      setError(t("settings.providers.models.duplicateId"));
      return;
    }

    const nextModel = buildSavedCustomModel({
      id: trimmedId,
      label: trimmedLabel.length > 0 ? trimmedLabel : trimmedId,
      contextTokens: contextTokens === undefined ? undefined : contextTokens,
      maxOutputTokens: maxOutputTokens === undefined ? undefined : maxOutputTokens,
      sourceId,
      selectedCandidate: resolveSelectedCandidate(sourceId, candidates, summary),
    });
    const nextModels = buildCustomModelList(additionalModels, nextModel, originalId);

    setError(null);
    setSaving(true);
    void patchConfig({
      providers: {
        [provider]: {
          additionalModels: nextModels,
        },
      },
    })
      .then(() => refresh([provider as AgentProvider]))
      .then(() => onClose())
      .catch((err) => {
        setError(err instanceof Error ? err.message : t("settings.providers.models.failedToSave"));
      })
      .finally(() => setSaving(false));
  }, [
    additionalModels,
    canSave,
    candidates,
    contextWindow,
    idConflict,
    maxOutput,
    onClose,
    originalId,
    patchConfig,
    provider,
    refresh,
    sourceId,
    summary,
    t,
    trimmedId,
    trimmedLabel,
  ]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: isEdit
        ? t("settings.providers.models.editCustomTitle")
        : t("settings.providers.models.addCustomTitle"),
    }),
    [isEdit, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={480}
      snapPoints={ADD_SNAP_POINTS}
      testID={isEdit ? "edit-custom-model-sheet" : "add-custom-model-sheet"}
    >
      <View style={sheetStyles.formGroup}>
        <Text style={sheetStyles.formLabel}>{t("settings.providers.models.modelId")}</Text>
        <AdaptiveTextInput
          initialValue={modelId}
          resetKey={`custom-model-id-${visible}-${originalId ?? "add"}`}
          value={modelId}
          onChangeText={setModelId}
          onBlur={handleModelIdLookup}
          onSubmitEditing={handleModelIdLookup}
          placeholder={t("settings.providers.models.modelIdPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
          // @ts-expect-error - outlineStyle is web-only
          style={[sheetStyles.formInput, isWeb && { outlineStyle: "none" }]}
        />

        <Text style={sheetStyles.formLabel}>{t("settings.providers.models.label")}</Text>
        <AdaptiveTextInput
          initialValue={label}
          resetKey={`custom-model-label-${visible}-${originalId ?? "add"}`}
          value={label}
          onChangeText={setLabel}
          placeholder={t("settings.providers.models.labelPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          // @ts-expect-error - outlineStyle is web-only
          style={[sheetStyles.formInput, isWeb && { outlineStyle: "none" }]}
        />

        {lookingUp || lookupHint ? (
          <Text style={sheetStyles.descriptionInline}>{lookupHint}</Text>
        ) : null}

        {showSourcePicker ? (
          <>
            <Text style={sheetStyles.formLabel}>
              {t("settings.providers.models.metadataSource")}
            </Text>
            <Text style={sheetStyles.descriptionInline}>
              {t("settings.providers.models.metadataSourceHint")}
            </Text>
            <View ref={sourceAnchorRef} collapsable={false}>
              <Pressable
                onPress={openSourcePicker}
                style={sheetStyles.sourceTrigger}
                testID="custom-model-metadata-source"
              >
                <View style={sheetStyles.sourceTriggerText}>
                  <Text style={sheetStyles.sourceTriggerLabel} numberOfLines={1}>
                    {selectedSourceOption.label}
                  </Text>
                  {selectedSourceOption.description ? (
                    <Text style={sheetStyles.descriptionInline} numberOfLines={1}>
                      {selectedSourceOption.description}
                    </Text>
                  ) : null}
                </View>
                <ChevronDown size={16} color={theme.colors.foregroundMuted} />
              </Pressable>
            </View>
            <Combobox
              options={sourceOptions}
              value={sourceId}
              onSelect={handleSourceSelect}
              searchable
              searchPlaceholder={t("settings.providers.models.metadataSourceSearch")}
              emptyText={t("settings.providers.models.metadataSourceEmpty")}
              title={t("settings.providers.models.metadataSource")}
              open={sourceOpen}
              onOpenChange={setSourceOpen}
              anchorRef={sourceAnchorRef}
              desktopPlacement="bottom-start"
              desktopMinWidth={360}
            />
          </>
        ) : null}

        <ModelMetadataSummary summary={summary} />

        <Text style={sheetStyles.formLabel}>{t("settings.providers.models.contextWindow")}</Text>
        <Text style={sheetStyles.descriptionInline}>
          {t("settings.providers.models.contextWindowHint")}
        </Text>
        <AdaptiveTextInput
          initialValue={contextWindow}
          resetKey={`custom-model-window-${visible}-${originalId ?? "add"}`}
          value={contextWindow}
          onChangeText={setContextWindow}
          placeholder={t("settings.providers.models.contextWindowPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="number-pad"
          // @ts-expect-error - outlineStyle is web-only
          style={[sheetStyles.formInput, isWeb && { outlineStyle: "none" }]}
        />
        {parsedContext === "invalid" ? (
          <Text style={sheetStyles.errorText}>
            {t("settings.providers.models.contextWindowInvalid")}
          </Text>
        ) : null}

        <Text style={sheetStyles.formLabel}>{t("settings.providers.models.maxOutput")}</Text>
        <Text style={sheetStyles.descriptionInline}>
          {t("settings.providers.models.maxOutputHint")}
        </Text>
        <AdaptiveTextInput
          initialValue={maxOutput}
          resetKey={`custom-model-max-output-${visible}-${originalId ?? "add"}`}
          value={maxOutput}
          onChangeText={setMaxOutput}
          onSubmitEditing={handleSave}
          placeholder={t("settings.providers.models.maxOutputPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="number-pad"
          returnKeyType="done"
          // @ts-expect-error - outlineStyle is web-only
          style={[sheetStyles.formInput, isWeb && { outlineStyle: "none" }]}
        />
        {parsedMaxOutput === "invalid" ? (
          <Text style={sheetStyles.errorText}>
            {t("settings.providers.models.maxOutputInvalid")}
          </Text>
        ) : null}

        {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
        <View style={sheetStyles.formActions}>
          <Button variant="secondary" size="sm" onPress={onClose} disabled={saving}>
            {t("common.actions.cancel")}
          </Button>
          <Button variant="default" size="sm" onPress={handleSave} disabled={!canSave}>
            {saveLabel}
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
  onEditCustom: (model: ProviderProfileModel) => void;
  onDeleteCustom: (modelId: string) => void;
  theme: { iconSize: { md: number }; colors: { foregroundMuted: string } };
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
    onEditCustom,
    onDeleteCustom,
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
      {filteredDiscovered.length > 0 ? (
        <View style={sheetStyles.section}>
          <SectionHeader
            title={t("settings.providers.models.discovered")}
            count={filteredDiscovered.length}
          />
          <View style={settingsStyles.card}>
            {filteredDiscovered.map((model) => (
              <DiscoveredModelRow key={model.id} model={model} />
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
                onEdit={onEditCustom}
                onDelete={onDeleteCustom}
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
  const [formMode, setFormMode] = useState<
    null | { kind: "add" } | { kind: "edit"; model: ProviderProfileModel }
  >(null);
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
      setFormMode(null);
      setDiagSheetOpen(false);
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

  const handleOpenAddSheet = useCallback(() => setFormMode({ kind: "add" }), []);
  const handleCloseFormSheet = useCallback(() => setFormMode(null), []);
  const handleOpenDiagSheet = useCallback(() => setDiagSheetOpen(true), []);
  const handleCloseDiagSheet = useCallback(() => setDiagSheetOpen(false), []);
  const handleEditCustom = useCallback((model: ProviderProfileModel) => {
    setFormMode({ kind: "edit", model });
  }, []);

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
          onEditCustom={handleEditCustom}
          onDeleteCustom={handleDeleteCustom}
          theme={theme}
        />
      </AdaptiveModalSheet>
      <CustomModelFormSubSheet
        provider={provider}
        serverId={serverId}
        visible={formMode !== null}
        mode={formMode ?? ADD_CUSTOM_MODEL_MODE}
        onClose={handleCloseFormSheet}
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
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.xs,
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
    fontSize: theme.fontSize.sm,
  },
  iconButton: {
    width: 28,
    height: 28,
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
  },
  modelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  modelRowFiller: {
    flex: 1,
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
    fontSize: theme.fontSize.xs,
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
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  sourceTrigger: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  sourceTriggerText: {
    flex: 1,
    gap: 2,
  },
  sourceTriggerLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  summaryCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  summaryGrid: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  summaryCell: {
    flex: 1,
    gap: 2,
  },
  summaryRow: {
    gap: theme.spacing[1],
  },
  summaryLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
  },
  summaryValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  iconRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    alignItems: "center",
  },
  iconChip: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
  },
  capabilityChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    backgroundColor: theme.colors.surface1,
  },
  capabilityText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
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
const ADD_SNAP_POINTS = ["70%", "92%"];
const DIAGNOSTIC_SNAP_POINTS = ["50%", "85%"];
