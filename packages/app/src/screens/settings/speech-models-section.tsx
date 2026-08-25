import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Download, FolderOpen, Globe, Mic, RefreshCw, Trash2, Volume2, Waves } from "lucide-react-native";
import { Switch } from "@/components/ui/switch";
import type { SpeechModelItem, SpeechModelKind } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { SelectField, type SelectFieldDisplay, type SelectFieldOption } from "@/components/ui/select-field";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { SettingsGroup } from "@/screens/settings/settings-group";
import { confirmDialog } from "@/utils/confirm-dialog";

import { getDesktopHost } from "@/desktop/host";
import { useSpeechModelsStore } from "@/stores/speech-models-store";

const speechModelsQueryKey = (serverId: string) => ["speech-models", serverId] as const;

const SPEECH_LANGUAGES = [
  { value: "auto", label: "Auto-Detect (Default)" },
  { value: "pt", label: "Português (pt)" },
  { value: "en", label: "English (en)" },
  { value: "es", label: "Español (es)" },
  { value: "fr", label: "Français (fr)" },
  { value: "de", label: "Deutsch (de)" },
  { value: "it", label: "Italiano (it)" },
  { value: "zh", label: "中文 (zh)" },
  { value: "ja", label: "日本語 (ja)" },
];

const FALLBACK_CATALOG_MODELS: SpeechModelItem[] = [
  {
    id: "parakeet-tdt-0.6b-v3-int8",
    name: "Parakeet TDT 0.6B v3",
    kind: "stt",
    description:
      "NVIDIA Parakeet TDT v3 (NeMo transducer, 25 European languages, auto-detected).",
    languages: [
      "bg",
      "hr",
      "cs",
      "da",
      "nl",
      "en",
      "et",
      "fi",
      "fr",
      "de",
      "el",
      "hu",
      "it",
      "lv",
      "lt",
      "mt",
      "pl",
      "pt",
      "ro",
      "sk",
      "sl",
      "es",
      "sv",
      "ru",
      "uk",
    ],
    runtimeSupported: true,
    sizeMB: 465,
    status: "not_installed",
    isDefault: true,
  },
  {
    id: "whisper-large-v3-turbo-int8",
    name: "Whisper Large v3 Turbo",
    kind: "stt",
    description: "OpenAI Whisper Large v3 Turbo (multilingual, 99 languages, 8× faster than large-v3).",
    languages: ["multi"],
    runtimeSupported: true,
    sizeMB: 538,
    status: "not_installed",
  },
  {
    id: "kokoro-multi-v1_0",
    name: "Kokoro TTS v1.0 Multi (82M)",
    kind: "tts",
    description:
      "Kokoro 82M multilingual (53 voices across en-US, en-GB, es-ES, fr-FR, hi-IN, it-IT, ja-JP, pt-BR, zh-CN).",
    languages: ["en", "pt-BR", "es", "fr", "hi", "it", "ja", "zh", "multi"],
    runtimeSupported: true,
    sizeMB: 333,
    status: "not_installed",
    isDefault: true,
  },
  {
    id: "silero-vad",
    name: "Silero VAD (Voice Activity Detection)",
    kind: "vad",
    description: "Silero Voice Activity Detection engine for real-time speech boundary detection.",
    languages: ["universal"],
    runtimeSupported: true,
    sizeMB: 2,
    status: "installed",
    isDefault: true,
  },
];

interface ModelCardProps {
  model: SpeechModelItem;
  isActive: boolean;
  selectedLanguage: string;
  selectedSpeakerId: number | null;
  onSelectLanguage: (modelId: string, language: string) => void;
  onSelectSpeaker: (modelId: string, speakerId: number) => void;
  onSetActive?: (modelId: string) => void;
  onDownload: (modelId: string) => void;
  onDelete: (modelId: string) => void;
  isDownloading: boolean;
  isDeleting: boolean;
  downloadProgress: SpeechModelDownloadProgress | null;
}

interface SpeechModelDownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes?: number | null;
  percent?: number | null;
  stage: "downloading" | "extracting" | "verifying" | "complete";
}

const DOWNLOAD_STAGE_LABELS: Record<SpeechModelDownloadProgress["stage"], string> = {
  downloading: "Downloading model archive...",
  extracting: "Extracting model archive...",
  verifying: "Verifying model integrity...",
  complete: "Finalizing...",
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

const LANGUAGE_LABELS: Record<string, string> = {
  auto: "Auto-Detect (Default)",
  af: "Afrikaans (af)",
  am: "Amharic (am)",
  ar: "Arabic (ar)",
  as: "Assamese (as)",
  az: "Azerbaijani (az)",
  ba: "Bashkir (ba)",
  be: "Belarusian (be)",
  bg: "Български (bg)",
  bn: "Bengali (bn)",
  bo: "Tibetan (bo)",
  br: "Breton (br)",
  bs: "Bosnian (bs)",
  ca: "Catalan (ca)",
  cs: "Čeština (cs)",
  cy: "Welsh (cy)",
  da: "Dansk (da)",
  de: "Deutsch (de)",
  el: "Ελληνικά (el)",
  en: "English (en)",
  "en-GB": "English GB (en-GB)",
  es: "Español (es)",
  et: "Eesti (et)",
  eu: "Basque (eu)",
  fa: "Persian (fa)",
  fi: "Suomi (fi)",
  fo: "Faroese (fo)",
  fr: "Français (fr)",
  gl: "Galician (gl)",
  gu: "Gujarati (gu)",
  ha: "Hausa (ha)",
  haw: "Hawaiian (haw)",
  he: "Hebrew (he)",
  hi: "Hindi (hi)",
  hr: "Hrvatski (hr)",
  ht: "Haitian Creole (ht)",
  hu: "Magyar (hu)",
  hy: "Armenian (hy)",
  id: "Indonesian (id)",
  is: "Icelandic (is)",
  it: "Italiano (it)",
  ja: "日本語 (ja)",
  jw: "Javanese (jw)",
  ka: "Georgian (ka)",
  kk: "Kazakh (kk)",
  km: "Khmer (km)",
  kn: "Kannada (kn)",
  ko: "한국어 (ko)",
  la: "Latin (la)",
  lb: "Luxembourgish (lb)",
  ln: "Lingala (ln)",
  lo: "Lao (lo)",
  lt: "Lietuvių (lt)",
  lv: "Latviešu (lv)",
  mg: "Malagasy (mg)",
  mi: "Maori (mi)",
  mk: "Macedonian (mk)",
  ml: "Malayalam (ml)",
  mn: "Mongolian (mn)",
  mr: "Marathi (mr)",
  ms: "Malay (ms)",
  mt: "Malti (mt)",
  my: "Myanmar (my)",
  ne: "Nepali (ne)",
  nl: "Nederlands (nl)",
  nn: "Nynorsk (nn)",
  no: "Norwegian (no)",
  oc: "Occitan (oc)",
  pa: "Punjabi (pa)",
  pl: "Polski (pl)",
  ps: "Pashto (ps)",
  pt: "Português (pt)",
  "pt-BR": "Português pt-BR (pt-BR)",
  ro: "Română (ro)",
  ru: "Русский (ru)",
  sa: "Sanskrit (sa)",
  sd: "Sindhi (sd)",
  si: "Sinhala (si)",
  sk: "Slovenčina (sk)",
  sl: "Slovenščina (sl)",
  sn: "Shona (sn)",
  so: "Somali (so)",
  sq: "Albanian (sq)",
  sr: "Serbian (sr)",
  su: "Sundanese (su)",
  sv: "Svenska (sv)",
  sw: "Swahili (sw)",
  ta: "Tamil (ta)",
  te: "Telugu (te)",
  tg: "Tajik (tg)",
  th: "Thai (th)",
  tk: "Turkmen (tk)",
  tl: "Tagalog (tl)",
  tr: "Turkish (tr)",
  tt: "Tatar (tt)",
  uk: "Українська (uk)",
  ur: "Urdu (ur)",
  uz: "Uzbek (uz)",
  vi: "Vietnamese (vi)",
  yi: "Yiddish (yi)",
  yo: "Yoruba (yo)",
  yue: "粤语 (yue)",
  zh: "中文 (zh)",
};

function IndeterminateProgressBar() {
  const translate = useSharedValue(-0.5);

  useEffect(() => {
    translate.value = withRepeat(
      withTiming(1.2, { duration: 1100, easing: Easing.linear }),
      -1,
      false,
    );
  }, [translate]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translate.value * 280 }],
  }));

  return (
    <View style={styles.progressTrack}>
      <View style={styles.indeterminateClip}>
        <Animated.View style={[styles.progressFillIndeterminate, animatedStyle]} />
      </View>
    </View>
  );
}

function ModelCard({
  model,
  isActive,
  selectedLanguage,
  selectedSpeakerId,
  onSelectLanguage,
  onSelectSpeaker,
  onSetActive,
  onDownload,
  onDelete,
  isDownloading,
  isDeleting,
  downloadProgress,
}: ModelCardProps) {
  const { theme } = useUnistyles();
  const isInstalled = model.status === "installed";
  const isDownloadingActive = isDownloading || model.status === "downloading";
  const isProcessing = isDownloadingActive || isDeleting;
  const hasVoices = (model.voices?.length ?? 0) > 0;

  const isMultilingual = useMemo(
    () => model.languages.length > 1 || model.languages.includes("multi"),
    [model.languages],
  );

  const languageOptions = useMemo<SelectFieldOption<string>[]>(() => {
    if (!isMultilingual) return [];

    const supportedCodes = new Set<string>();
    for (const code of model.languages) {
      if (code === "multi") continue;
      supportedCodes.add(code.toLowerCase());
    }

    const options: SelectFieldOption<string>[] = [];

    // STT models support auto-detection; TTS requires an explicit voice/language.
    if (model.kind === "stt") {
      options.push({
        id: "auto",
        value: "auto",
        label: "Auto-Detect (Default)",
        description: "Automatically detect spoken language",
      });
    }

    for (const [code, label] of Object.entries(LANGUAGE_LABELS)) {
      if (code === "auto") continue;
      if (supportedCodes.size === 0 || supportedCodes.has(code.toLowerCase())) {
        options.push({
          id: code,
          value: code,
          label,
        });
      }
    }

    return options;
  }, [isMultilingual, model.languages, model.kind]);

  const voicesForLanguage = useMemo(() => {
    if (!hasVoices) return [];
    return (model.voices ?? []).filter(
      (voice) => voice.language.toLowerCase() === selectedLanguage.toLowerCase(),
    );
  }, [hasVoices, model.voices, selectedLanguage]);

  const speakerOptions = useMemo<SelectFieldOption<number>[]>(
    () =>
      voicesForLanguage.map((voice) => ({
        id: String(voice.id),
        value: voice.id,
        label: voice.name,
      })),
    [voicesForLanguage],
  );

  const selectedLanguageDisplay = useMemo<SelectFieldDisplay>(() => {
    const label = LANGUAGE_LABELS[selectedLanguage] ?? selectedLanguage;
    return { label };
  }, [selectedLanguage]);

  const selectedSpeakerDisplay = useMemo<SelectFieldDisplay | null>(() => {
    const voice = (model.voices ?? []).find((entry) => entry.id === selectedSpeakerId);
    return voice ? { label: voice.name } : null;
  }, [model.voices, selectedSpeakerId]);

  return (
    <View style={[styles.cardContainer, isActive && styles.activeCardContainer]}>
      <View style={styles.cardHeader}>
        <View style={styles.titleRow}>
          <Text style={styles.modelName}>{model.name}</Text>
          {isActive && (
            <StatusBadge label="Active" variant="success" />
          )}
          {model.isDefault && (
            <StatusBadge label="Default" variant="muted" />
          )}
          <StatusBadge
            label={
              isInstalled
                ? "Installed"
                : isDownloadingActive
                  ? "Downloading"
                  : "Available"
            }
            variant={isInstalled ? "success" : isDownloadingActive ? "warning" : "muted"}
          />
        </View>
        <Text style={styles.modelDescription}>{model.description}</Text>
      </View>

      <View style={styles.metadataRow}>
        <Text style={styles.metaText}>
          <Text style={styles.metaLabel}>Size: </Text>
          {model.sizeMB} MB
        </Text>
        <Text style={styles.metaText}>
          <Text style={styles.metaLabel}>Languages: </Text>
          {(() => {
            if (model.id === "whisper-large-v3-turbo-int8") return "99 languages";
            const real = model.languages.filter((l) => l !== "multi");
            if (real.length > 6) return `${real.length} languages`;
            return real.join(", ").toUpperCase();
          })()}
        </Text>
      </View>

      {isInstalled && ((isMultilingual && model.kind === "stt") || hasVoices) ? (
        <View style={styles.languageDropdownRow}>
          <View style={styles.languageLabelContainer}>
            <Globe size={14} color={theme.colors.foregroundMuted} />
            <Text style={styles.languageSelectLabel}>Language:</Text>
          </View>
          <View style={styles.languageSelectWrapper}>
            <SelectField
              label="Spoken Language"
              field={false}
              size="sm"
              value={selectedLanguage}
              selectedDisplay={selectedLanguageDisplay}
              options={languageOptions}
              placeholder="Select language"
              emptyText="No languages available"
              searchable={languageOptions.length > 6}
              searchPlaceholder="Search language..."
              onChange={(val) => onSelectLanguage(model.id, val)}
            />
          </View>
        </View>
      ) : null}

      {isInstalled && hasVoices && speakerOptions.length > 0 ? (
        <View style={styles.languageDropdownRow}>
          <View style={styles.languageLabelContainer}>
            <Volume2 size={14} color={theme.colors.foregroundMuted} />
            <Text style={styles.languageSelectLabel}>Voice:</Text>
          </View>
          <View style={styles.languageSelectWrapper}>
            <SelectField
              label="Speaker Voice"
              field={false}
              size="sm"
              value={selectedSpeakerId ?? speakerOptions[0]?.value ?? null}
              selectedDisplay={selectedSpeakerDisplay}
              options={speakerOptions}
              placeholder="Select voice"
              emptyText="No voices for this language"
              onChange={(val) => onSelectSpeaker(model.id, val)}
            />
          </View>
        </View>
      ) : null}

      {isDownloadingActive && (
        <View style={styles.downloadProgressSection}>
          <View style={styles.downloadProgressHeader}>
            <View style={styles.downloadProgressLabelRow}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text style={styles.downloadProgressText}>
                {DOWNLOAD_STAGE_LABELS[downloadProgress?.stage ?? "downloading"]}
              </Text>
            </View>
            <Text style={styles.downloadProgressSize}>
              {typeof downloadProgress?.percent === "number"
                ? `${downloadProgress.percent}%`
                : model.sizeMB > 0
                  ? `${model.sizeMB} MB`
                  : ""}
            </Text>
          </View>
          {typeof downloadProgress?.percent === "number" ? (
            <View style={styles.progressTrack}>
              <View
                style={[styles.progressFill, { width: `${Math.min(100, downloadProgress.percent)}%` }]}
              />
            </View>
          ) : (
            <IndeterminateProgressBar />
          )}
          {typeof downloadProgress?.totalBytes === "number" && (
            <Text style={styles.downloadProgressBytes}>
              {formatBytes(downloadProgress.receivedBytes)} / {formatBytes(downloadProgress.totalBytes)}
            </Text>
          )}
        </View>
      )}

      <View style={styles.actionsRow}>
        {!isInstalled ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={isProcessing}
            onPress={() => onDownload(model.id)}
          >
            {isDownloadingActive ? (
              <View style={styles.buttonInner}>
                <Text style={styles.buttonLabel}>Downloading...</Text>
              </View>
            ) : (
              <View style={styles.buttonInner}>
                <Download size={14} color={theme.colors.foregroundMuted} />
                <Text style={styles.buttonLabel}>Download Model</Text>
              </View>
            )}
          </Button>
        ) : (
          <View style={styles.installedActions}>
            {model.runtimeSupported === true ? (
              <>
                {!isActive && onSetActive && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isProcessing}
                    onPress={() => onSetActive(model.id)}
                  >
                    <View style={styles.buttonInner}>
                      <Check size={14} color={theme.colors.foreground} />
                      <Text style={styles.buttonLabel}>Set as Active</Text>
                    </View>
                  </Button>
                )}
              </>
            ) : (
              <Text style={styles.runtimeUnsupportedText}>Runtime support coming soon</Text>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={isProcessing}
              onPress={() => onDelete(model.id)}
            >
              {isDeleting ? (
                <ActivityIndicator size="small" />
              ) : (
                <View style={styles.buttonInner}>
                  <Trash2 size={14} color={theme.colors.destructive} />
                  <Text style={[styles.buttonLabel, styles.destructiveLabel]}>Delete</Text>
                </View>
              )}
            </Button>
          </View>
        )}
      </View>
    </View>
  );
}

export function SpeechModelsSection({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [activeTab, setActiveTab] = useState<SpeechModelKind>("stt");
  const [activeDownloadingId, setActiveDownloadingId] = useState<string | null>(null);
  const [activeDeletingId, setActiveDeletingId] = useState<string | null>(null);
  const [downloadProgressMap, setDownloadProgressMap] = useState<
    Record<string, SpeechModelDownloadProgress>
  >({});

  useEffect(() => {
    if (!client) {
      return;
    }
    return client.onSpeechModelDownloadProgress((progress) => {
      setDownloadProgressMap((prev) => ({
        ...prev,
        [progress.modelId]: progress,
      }));
    });
  }, [client]);

  const activeSttModelId = useSpeechModelsStore((state) => state.activeSttModelId);
  const activeTtsModelId = useSpeechModelsStore((state) => state.activeTtsModelId);
  const modelLanguages = useSpeechModelsStore((state) => state.modelLanguages);
  const modelSpeakers = useSpeechModelsStore((state) => state.modelSpeakers);
  const setActiveSttModelId = useSpeechModelsStore((state) => state.setActiveSttModelId);
  const setActiveTtsModelId = useSpeechModelsStore((state) => state.setActiveTtsModelId);
  const setModelLanguage = useSpeechModelsStore((state) => state.setModelLanguage);
  const setModelSpeaker = useSpeechModelsStore((state) => state.setModelSpeaker);

  const { data, isLoading, refetch, isRefetching } = useFetchQuery({
    queryKey: speechModelsQueryKey(serverId),
    queryFn: async () => {
      if (!client) throw new Error("Client not available");
      return client.listSpeechModels();
    },
    enabled: isConnected && Boolean(client),
    dataShape: "value",
    staleTimeMs: 1_000,
  });

  const preferencesSynced = useRef(false);
  useEffect(() => {
    if (preferencesSynced.current || !data?.preferences) {
      return;
    }
    preferencesSynced.current = true;
    const {
      activeSttModelId: sttId,
      activeTtsModelId: ttsId,
      modelLanguages: langs,
      ttsSpeakerId,
    } = data.preferences;
    if (sttId) {
      setActiveSttModelId(sttId);
    }
    if (ttsId) {
      setActiveTtsModelId(ttsId);
      if (typeof ttsSpeakerId === "number") {
        setModelSpeaker(ttsId, ttsSpeakerId);
      }
    }
    for (const [modelId, language] of Object.entries(langs ?? {})) {
      setModelLanguage(modelId, language);
    }
  }, [data?.preferences, setActiveSttModelId, setActiveTtsModelId, setModelLanguage, setModelSpeaker]);

  // Feature flags follow the daemon config on every preferences change, so
  // toggles stay correct across tab switches and external config edits.
  useEffect(() => {
    if (!data?.preferences) {
      return;
    }
    if (typeof data.preferences.dictationEnabled === "boolean") {
      setDictationEnabled(data.preferences.dictationEnabled);
    }
    if (typeof data.preferences.voiceModeEnabled === "boolean") {
      setVoiceModeEnabled(data.preferences.voiceModeEnabled);
    }
  }, [data?.preferences]);

  const setActiveMutation = useMutation({
    mutationFn: async (modelId: string) => {
      if (!client) throw new Error("Client not available");
      await client.setActiveSpeechModel(modelId);
      return modelId;
    },
    onSuccess: (modelId: string) => {
      if (activeTab === "stt") {
        setActiveSttModelId(modelId);
      } else if (activeTab === "tts") {
        setActiveTtsModelId(modelId);
      }
    },
    onError: (error: Error) => {
      Alert.alert("Failed to Activate Model", error.message);
    },
  });

  const setLanguageMutation = useMutation({
    mutationFn: async ({ modelId, language }: { modelId: string; language: string }) => {
      if (!client) throw new Error("Client not available");
      await client.setSpeechModelLanguage(modelId, language);
      return { modelId, language };
    },
    onSuccess: ({ modelId, language }: { modelId: string; language: string }) => {
      setModelLanguage(modelId, language);
    },
    onError: (error: Error) => {
      Alert.alert("Failed to Set Language", error.message);
    },
  });

  const handleSelectLanguage = useCallback(
    (modelId: string, language: string) => {
      setLanguageMutation.mutate({ modelId, language });
      // Selecting a language for a TTS model switches to that language's
      // default voice on the server; mirror it locally using the model's
      // official voice list.
      const model = data?.models.find((entry) => entry.id === modelId);
      const defaultVoice = (model?.voices ?? []).find(
        (voice) => voice.language.toLowerCase() === language.toLowerCase(),
      );
      if (defaultVoice) {
        setModelSpeaker(modelId, defaultVoice.id);
      }
    },
    [setLanguageMutation, data?.models, setModelSpeaker],
  );

  const setSpeakerMutation = useMutation({
    mutationFn: async ({ modelId, speakerId }: { modelId: string; speakerId: number }) => {
      if (!client) throw new Error("Client not available");
      await client.setSpeechModelSpeaker(modelId, speakerId);
      return { modelId, speakerId };
    },
    onSuccess: ({ modelId, speakerId }: { modelId: string; speakerId: number }) => {
      setModelSpeaker(modelId, speakerId);
    },
    onError: (error: Error) => {
      Alert.alert("Failed to Set Voice", error.message);
    },
  });

  const handleSelectSpeaker = useCallback(
    (modelId: string, speakerId: number) => {
      setSpeakerMutation.mutate({ modelId, speakerId });
    },
    [setSpeakerMutation],
  );

  const [dictationEnabled, setDictationEnabled] = useState(true);
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(true);

  const setFeatureMutation = useMutation({
    mutationFn: async ({
      feature,
      enabled,
    }: {
      feature: "dictation" | "voiceMode";
      enabled: boolean;
    }) => {
      if (!client) throw new Error("Client not available");
      await client.setSpeechFeatureEnabled(feature, enabled);
      return { feature, enabled };
    },
    onSuccess: () => {
      // Refresh cached preferences so the toggle state survives tab switches.
      void queryClient.invalidateQueries({ queryKey: speechModelsQueryKey(serverId) });
    },
    onError: (error: Error) => {
      Alert.alert("Failed to Update Speech Feature", error.message);
      void refetch();
    },
  });

  const handleToggleFeature = useCallback(
    (feature: "dictation" | "voiceMode", enabled: boolean) => {
      if (feature === "dictation") {
        setDictationEnabled(enabled);
      } else {
        setVoiceModeEnabled(enabled);
      }
      setFeatureMutation.mutate({ feature, enabled });
    },
    [setFeatureMutation],
  );

  const downloadMutation = useMutation({
    mutationFn: async (modelId: string) => {
      if (!client) throw new Error("Client not available");
      setActiveDownloadingId(modelId);
      return client.downloadSpeechModel(modelId);
    },
    onError: (error: Error, modelId: string) => {
      Alert.alert(
        "Download Failed",
        `Failed to download model "${modelId}": ${error.message}`,
      );
    },
    onSettled: (_data, _error, modelId: string) => {
      setActiveDownloadingId(null);
      setDownloadProgressMap((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: speechModelsQueryKey(serverId) });
      // Belt-and-suspenders: the invalidation above can race the daemon flipping
      // activeDownloads; an immediate refetch guarantees the Installed badge.
      setTimeout(() => {
        void refetch();
      }, 500);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (modelId: string) => {
      if (!client) throw new Error("Client not available");
      setActiveDeletingId(modelId);
      return client.deleteSpeechModel(modelId);
    },
    onSettled: () => {
      setActiveDeletingId(null);
      void queryClient.invalidateQueries({ queryKey: speechModelsQueryKey(serverId) });
    },
  });

  const handleDownload = useCallback(
    (modelId: string) => {
      downloadMutation.mutate(modelId);
    },
    [downloadMutation],
  );

  const handleDelete = useCallback(
    (modelId: string) => {
      void confirmDialog({
        title: "Delete Speech Model",
        message: `Are you sure you want to delete the model "${modelId}"? You will need to download it again to use offline speech.`,
        confirmLabel: "Delete",
        destructive: true,
      }).then((confirmed) => {
        if (confirmed) {
          deleteMutation.mutate(modelId);
        }
      });
    },
    [deleteMutation],
  );

  const handleSetActive = useCallback(
    (modelId: string) => {
      setActiveMutation.mutate(modelId);
    },
    [setActiveMutation],
  );

  const activeModelsList = useMemo(() => {
    const rawList = data?.models && data.models.length > 0 ? data.models : FALLBACK_CATALOG_MODELS;
    return rawList.filter((model) => model.kind === activeTab);
  }, [data?.models, activeTab]);

  const handleOpenStorageFolder = useCallback(async () => {
    if (!data?.storageDir) return;
    const desktop = getDesktopHost();
    if (desktop?.editor) {
      try {
        const targets = await desktop.editor.listTargets?.();
        const fileManager = targets?.find((t) => t.kind === "file-manager");
        const editorId = fileManager ? fileManager.id : "explorer";
        await desktop.editor.openTarget?.({
          editorId,
          workspacePath: data.storageDir,
        });
        return;
      } catch {
        // fallback
      }
    }
    void Linking.openURL(`file://${data.storageDir}`).catch(() => undefined);
  }, [data?.storageDir]);

  return (
    <SettingsSection title="Speech Models">
      <Text style={styles.sectionDescription}>
        Manage local Speech-to-Text (STT), Text-to-Speech (TTS), and Voice Activity Detection
        (VAD) models for offline transcription and voice assistant.
      </Text>
      <View style={styles.featureTogglesRow}>
        <Pressable
          style={styles.featureToggle}
          onPress={() => handleToggleFeature("dictation", !dictationEnabled)}
        >
          <Mic size={14} color={dictationEnabled ? theme.colors.foreground : theme.colors.foregroundMuted} />
          <Text style={styles.featureToggleLabel}>Dictation</Text>
          <Switch
            value={dictationEnabled}
            onValueChange={(value: boolean) => handleToggleFeature("dictation", value)}
          />
        </Pressable>
        <Pressable
          style={styles.featureToggle}
          onPress={() => handleToggleFeature("voiceMode", !voiceModeEnabled)}
        >
          <Volume2 size={14} color={voiceModeEnabled ? theme.colors.foreground : theme.colors.foregroundMuted} />
          <Text style={styles.featureToggleLabel}>Voice Mode</Text>
          <Switch
            value={voiceModeEnabled}
            onValueChange={(value: boolean) => handleToggleFeature("voiceMode", value)}
          />
        </Pressable>
      </View>

      <View style={styles.headerControls}>
        <View style={styles.tabBar}>
          <Pressable
            style={[styles.tabButton, activeTab === "stt" && styles.tabButtonActive]}
            onPress={() => setActiveTab("stt")}
          >
            <Mic size={14} color={activeTab === "stt" ? theme.colors.foreground : theme.colors.foregroundMuted} />
            <Text style={[styles.tabButtonText, activeTab === "stt" && styles.tabButtonTextActive]}>
              STT (Dictation)
            </Text>
          </Pressable>
          <Pressable
            style={[styles.tabButton, activeTab === "tts" && styles.tabButtonActive]}
            onPress={() => setActiveTab("tts")}
          >
            <Volume2 size={14} color={activeTab === "tts" ? theme.colors.foreground : theme.colors.foregroundMuted} />
            <Text style={[styles.tabButtonText, activeTab === "tts" && styles.tabButtonTextActive]}>
              TTS (Speech)
            </Text>
          </Pressable>
          <Pressable
            style={[styles.tabButton, activeTab === "vad" && styles.tabButtonActive]}
            onPress={() => setActiveTab("vad")}
          >
            <Waves size={14} color={activeTab === "vad" ? theme.colors.foreground : theme.colors.foregroundMuted} />
            <Text style={[styles.tabButtonText, activeTab === "vad" && styles.tabButtonTextActive]}>
              VAD (Voice Activity)
            </Text>
          </Pressable>
        </View>

        <Button
          size="sm"
          variant="secondary"
          disabled={isLoading || isRefetching}
          onPress={() => refetch()}
        >
          <View style={styles.buttonInner}>
            <RefreshCw size={14} color={theme.colors.foregroundMuted} />
            <Text style={styles.buttonLabel}>Refresh</Text>
          </View>
        </Button>
      </View>

      <SettingsGroup
        title={
          activeTab === "stt"
            ? "STT Models (Speech-to-Text)"
            : activeTab === "tts"
              ? "TTS Models (Text-to-Speech)"
              : "VAD Models (Voice Activity Detection)"
        }
      >
        {isLoading && !data ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="small" />
            <Text style={styles.emptyText}>Loading model catalog...</Text>
          </View>
        ) : activeModelsList.length === 0 ? (
          <View style={styles.centerContainer}>
            <Text style={styles.emptyText}>No models available for this category.</Text>
          </View>
        ) : (
          <View style={styles.cardsList}>
            {activeModelsList.map((model) => {
              const isActive =
                activeTab === "stt"
                  ? activeSttModelId === model.id
                  : activeTab === "tts"
                    ? activeTtsModelId === model.id
                    : model.status === "installed";

              return (
                <ModelCard
                  key={model.id}
                  model={model}
                  isActive={isActive}
                  selectedLanguage={modelLanguages[model.id] ?? "auto"}
                  selectedSpeakerId={modelSpeakers[model.id] ?? null}
                  onSelectLanguage={handleSelectLanguage}
                  onSelectSpeaker={handleSelectSpeaker}
                  onSetActive={handleSetActive}
                  onDownload={handleDownload}
                  onDelete={handleDelete}
                  isDownloading={activeDownloadingId === model.id || model.status === "downloading"}
                  isDeleting={activeDeletingId === model.id}
                  downloadProgress={downloadProgressMap[model.id] ?? null}
                />
              );
            })}
          </View>
        )}
      </SettingsGroup>

      {data?.storageDir && (
        <View style={styles.storageFooter}>
          <Text style={styles.storagePathText}>
            Storage Location: <Text style={styles.storagePath}>{data.storageDir}</Text>
          </Text>
          <Button size="sm" variant="ghost" onPress={handleOpenStorageFolder}>
            <View style={styles.buttonInner}>
              <FolderOpen size={14} color={theme.colors.foregroundMuted} />
              <Text style={styles.buttonLabel}>Open Folder</Text>
            </View>
          </Button>
        </View>
      )}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
    marginBottom: theme.spacing[3],
  },
  headerControls: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  featureTogglesRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  featureToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.base,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  featureToggleLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  tabBar: {
    flexDirection: "row",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing[1],
  },
  tabButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  tabButtonActive: {
    backgroundColor: theme.colors.surface1,
  },
  tabButtonText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tabButtonTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  cardsList: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  cardContainer: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.base,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  activeCardContainer: {
    borderColor: theme.colors.primary,
  },
  languageDropdownRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  languageLabelContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  languageSelectLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  languageSelectWrapper: {
    minWidth: 160,
  },
  installedActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  runtimeUnsupportedText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  cardHeader: {
    gap: theme.spacing[1],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modelName: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  modelDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  metadataRow: {
    flexDirection: "row",
    gap: theme.spacing[4],
    marginTop: theme.spacing[1],
  },
  metaText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  metaLabel: {
    color: theme.colors.foregroundMuted,
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    marginTop: theme.spacing[2],
  },
  buttonInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  buttonLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  destructiveLabel: {
    color: theme.colors.destructive,
  },
  downloadProgressSection: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    padding: theme.spacing[2],
    gap: theme.spacing[1.5],
    marginTop: theme.spacing[1],
  },
  downloadProgressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  downloadProgressLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  downloadProgressText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  downloadProgressSize: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  downloadProgressBytes: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  progressTrack: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
    width: "100%",
  },
  progressFill: {
    height: "100%",
    width: "100%",
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.full,
  },
  indeterminateClip: {
    flex: 1,
    height: "100%",
    overflow: "hidden",
  },
  progressFillIndeterminate: {
    height: "100%",
    width: "45%",
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.full,
  },
  centerContainer: {
    padding: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  storageFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  storagePathText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  storagePath: {
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
}));
