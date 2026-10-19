import { useCallback, useMemo, useRef, useState } from "react";
import { Alert as NativeAlert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import { Download, Languages, Trash2 } from "lucide-react-native";
import type {
  LocalSpeechModel,
  SpeechSettings,
  SpeechSettingsPatch,
} from "@getpaseo/protocol/speech/rpc-schemas";
import {
  SettingsCard,
  SettingsCollapsibleRow,
  SettingsInfoTip,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useLocalSpeechModels, type LocalSpeechModels } from "./use-local-speech-models";
import {
  SPEECH_PROVIDERS,
  buildModelOptions,
  buildOpenAiVoiceOptions,
  formatLanguages,
  formatModelSize,
  getLocalModelState,
  resolveSelectedModel,
  resolveSelectedVoice,
  summarizeLocalModels,
  toSpeechProvider,
  usesOpenAi,
  type SpeechModelKind,
  type SpeechProvider,
} from "./voice-settings";

type SavePatch = (patch: SpeechSettingsPatch) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function HostVoicePage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "speechSettings");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const localModels = useLocalSpeechModels(serverId);
  const { refresh: refreshModels } = localModels;

  const save = useCallback<SavePatch>(
    (patch) => {
      patchConfig({ speech: patch })
        .then(refreshModels)
        .catch((error: unknown) => {
          NativeAlert.alert(t("settings.voice.saveError"), errorMessage(error));
        });
    },
    [patchConfig, refreshModels, t],
  );

  if (!isConnected) {
    return <Alert size="md" variant="warning" title={t("settings.voice.offline")} />;
  }
  if (!supported) {
    return <Alert size="md" variant="warning" title={t("settings.voice.updateHost")} />;
  }
  const speech = config?.speech;
  if (!speech) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  return (
    <View testID="voice-settings">
      <DictationSection speech={speech} localModels={localModels.models} save={save} />
      <VoiceModeSection speech={speech} localModels={localModels.models} save={save} />
      <ProvidersSection speech={speech} localModels={localModels} save={save} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Feature sections
// ---------------------------------------------------------------------------

interface FeatureSectionProps {
  speech: SpeechSettings;
  localModels: LocalSpeechModel[];
  save: SavePatch;
}

function DictationSection({ speech, localModels, save }: FeatureSectionProps) {
  const { t } = useTranslation();
  const { dictation } = speech;
  const setEnabled = useCallback((enabled: boolean) => save({ dictation: { enabled } }), [save]);
  const setProvider = useCallback(
    (provider: SpeechProvider) => save({ dictation: { stt: { provider } } }),
    [save],
  );
  const setModel = useCallback((model: string) => save({ dictation: { stt: { model } } }), [save]);

  return (
    <SettingsSection title={t("settings.voice.dictation.title")} testID="voice-dictation">
      <SettingsCard>
        <SettingsRow
          label={t("settings.voice.dictation.enabled")}
          hint={t("settings.voice.dictation.enabledHint")}
        >
          <Switch
            value={dictation.enabled}
            onValueChange={setEnabled}
            accessibilityLabel={t("settings.voice.dictation.enabled")}
          />
        </SettingsRow>
        {dictation.enabled ? (
          <ProviderRow
            label={t("settings.voice.provider")}
            value={toSpeechProvider(dictation.stt.provider)}
            onChange={setProvider}
            testID="voice-dictation-provider"
          />
        ) : null}
        {dictation.enabled ? (
          <ModelRow
            kind="stt"
            provider={toSpeechProvider(dictation.stt.provider)}
            model={dictation.stt.model}
            localModels={localModels}
            onChange={setModel}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function VoiceModeSection({ speech, localModels, save }: FeatureSectionProps) {
  const { t } = useTranslation();
  const { voiceMode } = speech;
  const sttProvider = toSpeechProvider(voiceMode.stt.provider);
  const ttsProvider = toSpeechProvider(voiceMode.tts.provider);
  const setEnabled = useCallback((enabled: boolean) => save({ voiceMode: { enabled } }), [save]);
  const setSttProvider = useCallback(
    (provider: SpeechProvider) => save({ voiceMode: { stt: { provider } } }),
    [save],
  );
  const setSttModel = useCallback(
    (model: string) => save({ voiceMode: { stt: { model } } }),
    [save],
  );
  const setTtsProvider = useCallback(
    (provider: SpeechProvider) => save({ voiceMode: { tts: { provider } } }),
    [save],
  );
  const setTtsModel = useCallback(
    (model: string) => save({ voiceMode: { tts: { model } } }),
    [save],
  );
  const setTtsVoice = useCallback(
    (voice: string) => save({ voiceMode: { tts: { voice } } }),
    [save],
  );
  const voiceOptions = useMemo(
    () => buildOpenAiVoiceOptions(resolveSelectedVoice(voiceMode.tts.voice)),
    [voiceMode.tts.voice],
  );

  return (
    <SettingsSection
      title={t("settings.voice.voiceMode.title")}
      info={t("settings.voice.voiceMode.info")}
      testID="voice-voice-mode"
    >
      <SettingsCard>
        <SettingsRow
          label={t("settings.voice.voiceMode.enabled")}
          hint={t("settings.voice.voiceMode.enabledHint")}
        >
          <Switch
            value={voiceMode.enabled}
            onValueChange={setEnabled}
            accessibilityLabel={t("settings.voice.voiceMode.enabled")}
          />
        </SettingsRow>
        {voiceMode.enabled ? (
          <ProviderRow
            label={t("settings.voice.voiceMode.sttProvider")}
            value={sttProvider}
            onChange={setSttProvider}
            testID="voice-mode-stt-provider"
          />
        ) : null}
        {voiceMode.enabled ? (
          <ModelRow
            kind="stt"
            provider={sttProvider}
            model={voiceMode.stt.model}
            localModels={localModels}
            onChange={setSttModel}
          />
        ) : null}
        {voiceMode.enabled ? (
          <ProviderRow
            label={t("settings.voice.voiceMode.ttsProvider")}
            value={ttsProvider}
            onChange={setTtsProvider}
            testID="voice-mode-tts-provider"
          />
        ) : null}
        {voiceMode.enabled ? (
          <ModelRow
            kind="tts"
            provider={ttsProvider}
            model={voiceMode.tts.model}
            localModels={localModels}
            onChange={setTtsModel}
          />
        ) : null}
        {voiceMode.enabled && ttsProvider === "openai" ? (
          <SettingsSelect
            label={t("settings.voice.voice")}
            value={resolveSelectedVoice(voiceMode.tts.voice)}
            options={voiceOptions}
            onValueChange={setTtsVoice}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function ProviderRow({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: SpeechProvider;
  onChange: (provider: SpeechProvider) => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      SPEECH_PROVIDERS.map((provider) => ({
        value: provider,
        label: t(`settings.voice.providers.${provider}`),
      })),
    [t],
  );
  return (
    <SettingsSelect
      label={label}
      value={value}
      options={options}
      onValueChange={onChange}
      testID={testID}
    />
  );
}

function ModelRow({
  kind,
  provider,
  model,
  localModels,
  onChange,
}: {
  kind: SpeechModelKind;
  provider: SpeechProvider;
  model: string | undefined;
  localModels: LocalSpeechModel[];
  onChange: (model: string) => void;
}) {
  const { t } = useTranslation();
  const selected = resolveSelectedModel({ kind, provider, model, localModels });
  const options = useMemo(
    () =>
      buildModelOptions({
        kind,
        provider,
        selected,
        localModels,
        notDownloadedLabel: (label) => t("settings.voice.notDownloadedOption", { label }),
      }),
    [kind, localModels, provider, selected, t],
  );
  return (
    <SettingsSelect
      label={kind === "stt" ? t("settings.voice.sttModel") : t("settings.voice.ttsModel")}
      value={selected}
      options={options}
      onValueChange={onChange}
    />
  );
}

// ---------------------------------------------------------------------------
// Providers: one collapsible row per provider, each with a one-line summary
// ---------------------------------------------------------------------------

function ProvidersSection({
  speech,
  localModels,
  save,
}: {
  speech: SpeechSettings;
  localModels: LocalSpeechModels;
  save: SavePatch;
}) {
  const { t } = useTranslation();
  const missingKey = usesOpenAi(speech) && !speech.openai.apiKeyConfigured;
  return (
    <SettingsSection
      title={t("settings.voice.providerSettings.title")}
      info={t("settings.voice.providerSettings.info")}
      testID="voice-providers"
    >
      {missingKey ? (
        <View style={styles.sectionAlert}>
          <Alert size="sm" variant="warning" title={t("settings.voice.openai.missingKeyWarning")} />
        </View>
      ) : null}
      <SettingsCard>
        <LocalProviderRow kind="stt" localModels={localModels} />
        <LocalProviderRow kind="tts" localModels={localModels} />
        <OpenAiProviderRow speech={speech} save={save} />
      </SettingsCard>
    </SettingsSection>
  );
}

function LocalProviderRow({
  kind,
  localModels,
}: {
  kind: SpeechModelKind;
  localModels: LocalSpeechModels;
}) {
  const { t } = useTranslation();
  const { models, isLoading, error, refresh, download, remove } = localModels;
  const kindModels = useMemo(() => models.filter((model) => model.kind === kind), [kind, models]);
  const label =
    kind === "stt"
      ? t("settings.voice.providerSettings.localStt")
      : t("settings.voice.providerSettings.localTts");

  if (error && kindModels.length === 0) {
    return (
      <SettingsCollapsibleRow
        label={label}
        summary={t("settings.voice.models.loadError")}
        testID={`voice-provider-local-${kind}`}
      >
        <SettingsRow label={t("settings.voice.models.loadError")} hint={error.message}>
          <Button variant="outline" onPress={refresh}>
            {t("settings.voice.retry")}
          </Button>
        </SettingsRow>
      </SettingsCollapsibleRow>
    );
  }
  return (
    <SettingsCollapsibleRow
      label={label}
      summary={isLoading ? t("settings.voice.models.loading") : localSummaryLabel(models, kind, t)}
      testID={`voice-provider-local-${kind}`}
    >
      {kindModels.map((model) => (
        <LocalModelRow key={model.id} model={model} onDownload={download} onDelete={remove} />
      ))}
    </SettingsCollapsibleRow>
  );
}

function localSummaryLabel(
  models: readonly LocalSpeechModel[],
  kind: SpeechModelKind,
  t: TFunction,
): string {
  const summary = summarizeLocalModels(models, kind);
  switch (summary.kind) {
    case "downloading":
      return summary.percent === null
        ? t("settings.voice.models.downloading")
        : t("settings.voice.models.downloadingPercent", { percent: summary.percent });
    case "extracting":
      return t("settings.voice.models.extracting");
    case "downloaded":
      return t("settings.voice.providerSettings.downloaded", { count: summary.count });
  }
}

function OpenAiProviderRow({ speech, save }: { speech: SpeechSettings; save: SavePatch }) {
  const { t } = useTranslation();
  const { apiKeyConfigured, baseUrl } = speech.openai;
  const keyInput = useRef<EditingTextInputHandle>(null);
  const [draftKey, setDraftKey] = useState("");
  const [draftBaseUrl, setDraftBaseUrl] = useState<string | null>(null);

  const saveKey = useCallback(() => {
    save({ openai: { apiKey: draftKey } });
    keyInput.current?.replaceText("");
    setDraftKey("");
  }, [draftKey, save]);
  const removeKey = useCallback(() => {
    void confirmDialog({
      title: t("settings.voice.openai.removeKeyTitle"),
      message: t("settings.voice.openai.removeKeyMessage"),
      confirmLabel: t("settings.voice.openai.removeKey"),
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) save({ openai: { apiKey: null } });
      return undefined;
    });
  }, [save, t]);
  const saveBaseUrl = useCallback(() => {
    if (draftBaseUrl === null) return;
    save({ openai: { baseUrl: draftBaseUrl.trim() || null } });
    setDraftBaseUrl(null);
  }, [draftBaseUrl, save]);

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
    <SettingsCollapsibleRow
      label={t("settings.voice.providerSettings.openai")}
      summary={
        apiKeyConfigured
          ? t("settings.voice.providerSettings.configured")
          : t("settings.voice.providerSettings.notConfigured")
      }
      testID="voice-provider-openai"
    >
      <SettingsRow label={t("settings.voice.openai.apiKey")} labelAccessory={apiKeyInfo}>
        <View style={styles.inputControls}>
          <FormTextInput
            ref={keyInput}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={
              apiKeyConfigured
                ? t("settings.voice.openai.replaceKeyPlaceholder")
                : t("settings.voice.openai.keyPlaceholder")
            }
            onChangeText={setDraftKey}
            accessibilityLabel={t("settings.voice.openai.apiKey")}
            style={styles.input}
            testID="voice-openai-key-input"
          />
          <Button
            variant="outline"
            onPress={saveKey}
            disabled={draftKey.trim().length === 0}
            testID="voice-openai-key-save"
          >
            {t("settings.voice.save")}
          </Button>
          {apiKeyConfigured ? (
            <Button variant="ghost" onPress={removeKey}>
              {t("settings.voice.openai.removeKey")}
            </Button>
          ) : null}
        </View>
      </SettingsRow>
      <SettingsRow label={t("settings.voice.openai.baseUrl")} labelAccessory={baseUrlInfo}>
        <View style={styles.inputControls}>
          <FormTextInput
            autoCapitalize="none"
            autoCorrect={false}
            initialValue={baseUrl ?? ""}
            placeholder="https://api.openai.com/v1"
            onChangeText={setDraftBaseUrl}
            accessibilityLabel={t("settings.voice.openai.baseUrl")}
            style={styles.input}
          />
          <Button
            variant="outline"
            onPress={saveBaseUrl}
            disabled={draftBaseUrl === null || draftBaseUrl.trim() === (baseUrl ?? "")}
          >
            {t("settings.voice.save")}
          </Button>
        </View>
      </SettingsRow>
    </SettingsCollapsibleRow>
  );
}

function LocalModelRow({
  model,
  onDownload,
  onDelete,
}: {
  model: LocalSpeechModel;
  onDownload: (modelId: string) => Promise<void>;
  onDelete: (modelId: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const state = getLocalModelState(model);
  const [actionError, setActionError] = useState<string | null>(null);

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
        <Text style={styles.modelSize}>{formatModelSize(model.downloadSizeBytes)}</Text>
        {state.kind === "installed" ? (
          <StatusBadge
            size="xs"
            variant="success"
            label={
              model.inUse ? t("settings.voice.models.inUse") : t("settings.voice.models.downloaded")
            }
          />
        ) : null}
        {model.isDefault ? (
          <StatusBadge size="xs" label={t("settings.voice.models.recommended")} />
        ) : null}
      </View>
    ),
    [
      languages,
      model.description,
      model.downloadSizeBytes,
      model.id,
      model.inUse,
      model.isDefault,
      model.label,
      state.kind,
      t,
    ],
  );

  let control = null;
  if (state.kind === "downloading") {
    control = (
      <View style={styles.progress}>
        <LoadingSpinner size="small" color={styles.spinnerColor.color} />
        <Text style={styles.progressText}>
          {state.percent === null
            ? t("settings.voice.models.downloading")
            : t("settings.voice.models.downloadingPercent", { percent: state.percent })}
        </Text>
      </View>
    );
  } else if (state.kind === "extracting") {
    control = (
      <View style={styles.progress}>
        <LoadingSpinner size="small" color={styles.spinnerColor.color} />
        <Text style={styles.progressText}>{t("settings.voice.models.extracting")}</Text>
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
        {t("settings.voice.models.delete")}
      </Button>
    );
  } else {
    control = (
      <Button
        variant="outline"
        leftIcon={Download}
        onPress={download}
        testID={`voice-model-download-${model.id}`}
      >
        {state.kind === "failed" ? t("settings.voice.retry") : t("settings.voice.models.download")}
      </Button>
    );
  }

  return (
    <SettingsRow
      label={model.label}
      labelAccessory={details}
      error={actionError ?? (state.kind === "failed" ? state.error : null)}
      testID={`voice-model-${model.id}`}
    >
      {control}
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  sectionAlert: {
    marginBottom: theme.spacing[3],
  },
  inputControls: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  input: {
    minWidth: 220,
  },
  details: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modelSize: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  progress: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  progressText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
