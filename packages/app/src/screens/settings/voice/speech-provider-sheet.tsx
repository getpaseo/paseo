import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Download, Languages, Trash2 } from "lucide-react-native";
import type { LocalSpeechModel, SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import {
  SettingsCard,
  SettingsInfoTip,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
} from "@/components/settings";
import { Button } from "@/components/ui/button";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import { useContainedControlSize } from "@/components/ui/control-size";
import { foregroundIconColorMapping } from "@/components/ui/icon-color";
import { PressHighlight } from "@/components/ui/press-highlight";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import { ICON_SIZE } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { LocalSpeechModels } from "./use-local-speech-models";
import {
  openSpeechProviderForm,
  type SpeechProviderFieldSource,
  type SpeechProviderFormModel,
  type SpeechProviderFormSnapshot,
  type SpeechProviderFormState,
} from "./speech-provider-form";
import {
  SPEECH_PROVIDERS,
  buildOpenAiModelOptions,
  buildOpenAiVoiceOptions,
  formatLanguages,
  formatModelSize,
  getLocalModelState,
  resolveLocalModel,
  type LocalModelState,
  type SpeechProvider,
} from "./voice-settings";

const ThemedCheck = withUnistyles(Check);

export interface SpeechProviderSheetProps extends SpeechProviderFormSnapshot {
  title: string;
  localModels: LocalSpeechModels;
  visible: boolean;
  onClose: () => void;
  onDismiss: () => void;
  save: (patch: SpeechSettingsPatch) => Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The form opens from the props of the first render; later config changes do not reset input.
function useSpeechProviderForm(snapshot: SpeechProviderFormSnapshot): SpeechProviderFormModel {
  const [model] = useState(() => openSpeechProviderForm(snapshot));
  useEffect(() => () => model.close(), [model]);
  return model;
}

/** One speech site's provider and that provider's settings. Mount it fresh for each open. */
export function SpeechProviderSheet({
  title,
  siteId,
  site,
  envOverrides,
  localModels,
  visible,
  onClose,
  onDismiss,
  save,
}: SpeechProviderSheetProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const model = useSpeechProviderForm({ siteId, site, envOverrides });
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  const submit = useCallback(() => {
    void model.save(save).then((result) => {
      if (result.status === "saved") onClose();
      if (result.status === "failed") {
        toast.error(`${t("settings.voice.saveError")}: ${errorMessage(result.error)}`);
      }
      return undefined;
    });
  }, [model, onClose, save, t, toast]);

  const header = useMemo<SheetHeader>(() => ({ title }), [title]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={state.saving}
        >
          {t("settings.voice.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={submit}
          disabled={!state.canSave}
          loading={state.saving}
          testID="voice-provider-save"
        >
          {t("settings.voice.save")}
        </Button>
      </View>
    ),
    [onClose, state.canSave, state.saving, submit, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={footer}
      testID="voice-provider-sheet"
    >
      <SettingsCard>
        <ProviderRow state={state} model={model} />
      </SettingsCard>
      {state.provider === "local" ? (
        <>
          {state.kind === "stt" ? (
            <SettingsCard>
              <LanguageField state={state} model={model} />
            </SettingsCard>
          ) : null}
          <LocalModelList state={state} model={model} localModels={localModels} />
        </>
      ) : (
        <OpenAiFields state={state} model={model} />
      )}
    </AdaptiveModalSheet>
  );
}

interface FormProps {
  state: SpeechProviderFormState;
  model: SpeechProviderFormModel;
}

function setByHint(t: TFunction, source: SpeechProviderFieldSource): string | undefined {
  return source.envVar ? t("settings.voice.setBy", { name: source.envVar }) : undefined;
}

function ProviderRow({ state, model }: FormProps) {
  const { t } = useTranslation();
  const source = state.fields.provider;
  const options = useMemo(
    () =>
      SPEECH_PROVIDERS.map((provider) => ({
        value: provider,
        label: t(`settings.voice.providers.${provider}`),
        disabled: source.readOnly,
      })),
    [source.readOnly, t],
  );
  return (
    <SettingsRow label={t("settings.voice.provider")} hint={setByHint(t, source)}>
      <SegmentedControl<SpeechProvider>
        options={options}
        value={state.provider}
        onValueChange={model.setProvider}
        testID="voice-provider-picker"
      />
    </SettingsRow>
  );
}

function LanguageField({ state, model }: FormProps) {
  const { t } = useTranslation();
  return (
    <SettingsInput
      label={t("settings.voice.language")}
      hint={setByHint(t, state.fields.language)}
      initialValue={state.language}
      onChangeText={model.setLanguage}
      placeholder={t("settings.voice.languagePlaceholder")}
      disabled={state.fields.language.readOnly}
    />
  );
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

function OpenAiFields({ state, model }: FormProps) {
  const { t } = useTranslation();
  const modelOptions = useMemo(
    () => buildOpenAiModelOptions(state.kind, state.openAiModel),
    [state.kind, state.openAiModel],
  );
  const voiceOptions = useMemo(() => buildOpenAiVoiceOptions(state.voice), [state.voice]);
  const apiKeyInfo = useMemo(
    () => (
      <SettingsInfoTip
        title={t("settings.voice.openai.apiKey")}
        info={t("settings.voice.openai.apiKeyHint")}
      />
    ),
    [t],
  );
  const baseUrlInfo = useMemo(
    () => (
      <SettingsInfoTip
        title={t("settings.voice.openai.baseUrl")}
        info={t("settings.voice.openai.baseUrlHint")}
      />
    ),
    [t],
  );

  return (
    <SettingsCard>
      <SettingsInput
        label={t("settings.voice.openai.apiKey")}
        labelAccessory={apiKeyInfo}
        hint={setByHint(t, state.fields.apiKey)}
        initialValue={state.apiKey}
        onChangeText={model.setApiKey}
        secureTextEntry
        placeholder={
          state.hasSavedApiKey
            ? t("settings.voice.openai.savedKeyPlaceholder")
            : t("settings.voice.openai.keyPlaceholder")
        }
      />
      <SettingsInput
        label={t("settings.voice.openai.baseUrl")}
        labelAccessory={baseUrlInfo}
        hint={setByHint(t, state.fields.baseUrl)}
        initialValue={state.baseUrl}
        onChangeText={model.setBaseUrl}
        placeholder="https://api.openai.com/v1"
      />
      <SettingsSelect
        label={t("settings.voice.model")}
        hint={setByHint(t, state.fields.model)}
        value={state.openAiModel}
        options={modelOptions}
        onValueChange={model.setOpenAiModel}
        disabled={state.fields.model.readOnly}
      />
      {state.kind === "stt" ? (
        <LanguageField state={state} model={model} />
      ) : (
        <SettingsSelect
          label={t("settings.voice.voice")}
          hint={setByHint(t, state.fields.voice)}
          value={state.voice}
          options={voiceOptions}
          onValueChange={model.setVoice}
          disabled={state.fields.voice.readOnly}
        />
      )}
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Local: the catalog, with the selected model checked
// ---------------------------------------------------------------------------

function LocalModelList({
  state,
  model,
  localModels,
}: FormProps & { localModels: LocalSpeechModels }) {
  const { t } = useTranslation();
  const { models, isLoading, error, refresh, download, remove } = localModels;
  const kindModels = useMemo(
    () => models.filter((entry) => entry.kind === state.kind),
    [models, state.kind],
  );
  const selectedId =
    state.localModel ??
    resolveLocalModel({ kind: state.kind, model: state.savedLocalModel, localModels: models })?.id;
  const source = state.fields.model;

  if (kindModels.length === 0) {
    if (error) {
      return (
        <SettingsCard>
          <SettingsRow label={t("settings.voice.models.loadError")} hint={error.message}>
            <Button variant="outline" onPress={refresh}>
              {t("settings.voice.retry")}
            </Button>
          </SettingsRow>
        </SettingsCard>
      );
    }
    return (
      <SettingsCard>
        <SettingsRow
          label={isLoading ? t("settings.voice.models.loading") : t("settings.voice.models.none")}
        />
      </SettingsCard>
    );
  }
  return (
    <SettingsCard testID="voice-local-models">
      {kindModels.map((entry) => (
        <LocalModelRow
          key={entry.id}
          model={entry}
          selected={entry.id === selectedId}
          selectionLocked={source.readOnly}
          hint={entry.id === selectedId ? setByHint(t, source) : undefined}
          onSelect={model.setLocalModel}
          onDownload={download}
          onDelete={remove}
        />
      ))}
    </SettingsCard>
  );
}

function progressLabel(
  t: TFunction,
  state: Extract<LocalModelState, { kind: "downloading" | "extracting" }>,
): string {
  if (state.kind === "extracting") return t("settings.voice.models.extracting");
  if (state.percent === null) return t("settings.voice.models.downloading");
  return t("settings.voice.models.downloadingPercent", { percent: state.percent });
}

type HoverState = PressableStateCallbackType & { hovered?: boolean };

function LocalModelRow({
  model,
  selected,
  selectionLocked,
  hint,
  onSelect,
  onDownload,
  onDelete,
}: {
  model: LocalSpeechModel;
  selected: boolean;
  selectionLocked: boolean;
  /** Why the selection is fixed, shown on the selected row. */
  hint: string | undefined;
  onSelect: (modelId: string) => void;
  onDownload: (modelId: string) => Promise<void>;
  onDelete: (modelId: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const state = getLocalModelState(model);
  const [actionError, setActionError] = useState<string | null>(null);

  const select = useCallback(() => onSelect(model.id), [model.id, onSelect]);
  const download = useCallback(() => {
    setActionError(null);
    onDownload(model.id).catch((error: unknown) => setActionError(errorMessage(error)));
  }, [model.id, onDownload]);
  const remove = useCallback(() => {
    void confirmDialog({
      title: t("settings.voice.models.deleteTitle", { label: model.label }),
      message: t("settings.voice.models.deleteMessage", {
        size: formatModelSize(model.downloadSizeBytes),
      }),
      confirmLabel: t("settings.voice.models.delete"),
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed) return undefined;
        setActionError(null);
        return onDelete(model.id);
      })
      .catch((error: unknown) => setActionError(errorMessage(error)));
  }, [model.downloadSizeBytes, model.id, model.label, onDelete, t]);

  const languages = formatLanguages({
    languages: model.languages,
    locale: i18n.language,
    formatMore: (listed, count) =>
      t("settings.voice.models.moreLanguages", { languages: listed, count }),
  });
  const details = useMemo(
    () => (
      <View style={styles.details}>
        <SettingsInfoTip
          title={model.label}
          info={model.description}
          testID={`voice-model-${model.id}-description`}
        />
        <SettingsInfoTip
          title={model.label}
          info={languages}
          icon={Languages}
          accessibilityLabel={t("settings.voice.models.languages", { label: model.label })}
          testID={`voice-model-${model.id}-languages`}
        />
        <Text style={styles.metaText}>{formatModelSize(model.downloadSizeBytes)}</Text>
        {state.kind === "installed" ? (
          <StatusBadge
            size="xs"
            variant="success"
            label={
              model.inUse ? t("settings.voice.models.inUse") : t("settings.voice.models.downloaded")
            }
          />
        ) : null}
        {hint ? <Text style={styles.metaText}>{hint}</Text> : null}
      </View>
    ),
    [
      hint,
      languages,
      model.description,
      model.downloadSizeBytes,
      model.id,
      model.inUse,
      model.label,
      state.kind,
      t,
    ],
  );

  const recommended = useMemo(
    () =>
      model.isDefault ? (
        <StatusBadge size="xs" label={t("settings.voice.models.recommended")} />
      ) : undefined,
    [model.isDefault, t],
  );

  // Phone rows have no room beside the label for a labelled button, so actions show their icon.
  const compact = useIsCompactFormFactor();
  const downloadLabel =
    state.kind === "failed" ? t("settings.voice.retry") : t("settings.voice.models.download");
  let control = null;
  if (state.kind === "downloading" || state.kind === "extracting") {
    control = (
      <View style={styles.progress}>
        <LoadingSpinner size="small" color={styles.spinnerColor.color} />
        <Text style={styles.metaText}>{progressLabel(t, state)}</Text>
      </View>
    );
  } else if (state.kind === "installed") {
    control = model.inUse ? null : (
      <Button
        variant="ghost"
        leftIcon={Trash2}
        onPress={remove}
        accessibilityLabel={t("settings.voice.models.deleteAction", { label: model.label })}
        testID={`voice-model-delete-${model.id}`}
      >
        {compact ? null : t("settings.voice.models.delete")}
      </Button>
    );
  } else {
    control = (
      <Button
        variant="outline"
        leftIcon={Download}
        onPress={download}
        accessibilityLabel={t("settings.voice.models.downloadAction", { label: model.label })}
        testID={`voice-model-download-${model.id}`}
      >
        {compact ? null : downloadLabel}
      </Button>
    );
  }

  const rowStyle = useCallback(
    ({ hovered, pressed }: HoverState) => [
      !selectionLocked && hovered && styles.rowHovered,
      !selectionLocked && pressed && styles.rowPressed,
    ],
    [selectionLocked],
  );
  const accessibilityState = useMemo(
    () => ({ checked: selected, disabled: selectionLocked }),
    [selected, selectionLocked],
  );

  return (
    <PressHighlight
      accessibilityRole="radio"
      accessibilityLabel={model.label}
      accessibilityState={accessibilityState}
      aria-checked={selected}
      disabled={selectionLocked}
      onPress={select}
      style={rowStyle}
      highlightStyle={styles.rowPressed}
      testID={`voice-model-${model.id}`}
    >
      <SettingsRow
        label={model.label}
        labelAccessory={recommended}
        hint={details}
        error={actionError ?? (state.kind === "failed" ? state.error : null)}
      >
        <TrailingControls>
          {control}
          <View style={styles.checkSlot}>
            {selected ? (
              <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundIconColorMapping} />
            ) : null}
          </View>
        </TrailingControls>
      </SettingsRow>
    </PressHighlight>
  );
}

// Every catalog row is as tall as one holding a button, so a row does not shrink when its
// download finishes and the button goes away.
function TrailingControls({ children }: { children: ReactNode }) {
  const size = useContainedControlSize() ?? "sm";
  const style = useMemo(() => [styles.trailing, { minHeight: buttonControlHeight[size] }], [size]);
  return <View style={style}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  // The model's details sit on the hint line, so every catalog row has the same two lines.
  details: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  checkSlot: {
    width: ICON_SIZE.sm,
    alignItems: "center",
  },
  progress: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
}));
