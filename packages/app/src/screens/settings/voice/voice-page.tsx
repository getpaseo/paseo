import { useCallback, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import type { SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import {
  SettingsCard,
  SettingsDetailRow,
  SettingsRow,
  SettingsSection,
} from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-api-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SpeechProviderSheet } from "./speech-provider-sheet";
import { useLocalSpeechModels } from "./use-local-speech-models";
import {
  getSpeechSite,
  summarizeSpeechSite,
  type SpeechSiteId,
  type SpeechSiteSummary,
} from "./voice-settings";

type SavePatch = (patch: SpeechSettingsPatch) => Promise<unknown>;
const EMPTY_ENV_OVERRIDES: Record<string, string> = {};

// The sheet mounts fresh for every open (docs/forms.md); `openCount` keys each mount.
interface OpenSheet {
  siteId: SpeechSiteId;
  visible: boolean;
  openCount: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function HostVoicePage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "speechSettings");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const localModels = useLocalSpeechModels(serverId);
  const { refresh: refreshModels } = localModels;
  const [sheet, setSheet] = useState<OpenSheet | null>(null);

  // Selecting a model changes which models are in use, so the catalog is re-read after a save.
  const save = useCallback<SavePatch>(
    async (patch) => {
      await patchConfig({ features: patch });
      refreshModels();
    },
    [patchConfig, refreshModels],
  );
  const saveSwitch = useCallback(
    (patch: SpeechSettingsPatch) => {
      save(patch).catch((error: unknown) => {
        toast.error(`${t("settings.voice.saveError")}: ${errorMessage(error)}`);
      });
    },
    [save, t, toast],
  );
  const setDictationEnabled = useCallback(
    (enabled: boolean) => saveSwitch({ dictation: { enabled } }),
    [saveSwitch],
  );
  const setVoiceModeEnabled = useCallback(
    (enabled: boolean) => saveSwitch({ voiceMode: { enabled } }),
    [saveSwitch],
  );
  const openSheet = useCallback((siteId: SpeechSiteId) => {
    setSheet((current) => ({
      siteId,
      visible: true,
      openCount: (current?.openCount ?? 0) + 1,
    }));
  }, []);
  const closeSheet = useCallback(() => {
    setSheet((current) => (current ? { ...current, visible: false } : null));
  }, []);
  const dismissSheet = useCallback(() => setSheet(null), []);

  if (!isConnected) {
    return <Alert size="md" variant="warning" title={t("settings.voice.offline")} />;
  }
  if (!supported) {
    return <Alert size="md" variant="warning" title={t("settings.voice.updateHost")} />;
  }
  const features = config?.features;
  if (!features) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }
  const envOverrides = config?.envOverrides ?? EMPTY_ENV_OVERRIDES;
  const siteRow = (siteId: SpeechSiteId, label: string) => (
    <SpeechSiteRow
      siteId={siteId}
      label={label}
      summary={summarizeSpeechSite({
        siteId,
        site: getSpeechSite(features, siteId),
        envOverrides,
        localModels: localModels.models,
      })}
      onOpen={openSheet}
    />
  );
  const sheetSite = sheet ? getSpeechSite(features, sheet.siteId) : null;

  return (
    <View testID="voice-settings">
      <SettingsSection title={t("settings.voice.dictation.title")} testID="voice-dictation">
        <SettingsCard>
          <FeatureSwitchRow
            label={t("settings.voice.dictation.enabled")}
            hint={t("settings.voice.dictation.enabledHint")}
            envVar={envOverrides["features.dictation.enabled"]}
            value={features.dictation.enabled}
            onChange={setDictationEnabled}
          />
          {siteRow("dictation.stt", t("settings.voice.sites.dictationStt"))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        title={t("settings.voice.voiceMode.title")}
        info={t("settings.voice.voiceMode.info")}
        testID="voice-voice-mode"
      >
        <SettingsCard>
          <FeatureSwitchRow
            label={t("settings.voice.voiceMode.enabled")}
            hint={t("settings.voice.voiceMode.enabledHint")}
            envVar={envOverrides["features.voiceMode.enabled"]}
            value={features.voiceMode.enabled}
            onChange={setVoiceModeEnabled}
          />
          {siteRow("voiceMode.stt", t("settings.voice.sites.voiceModeStt"))}
          {siteRow("voiceMode.tts", t("settings.voice.sites.voiceModeTts"))}
        </SettingsCard>
      </SettingsSection>
      {sheet && sheetSite && sheetSite.provider !== "unknown" ? (
        <SpeechProviderSheet
          key={sheet.openCount}
          title={siteLabel(t, sheet.siteId)}
          siteId={sheet.siteId}
          site={sheetSite}
          envOverrides={envOverrides}
          localModels={localModels}
          visible={sheet.visible}
          onClose={closeSheet}
          onDismiss={dismissSheet}
          save={save}
        />
      ) : null}
    </View>
  );
}

function siteLabel(t: TFunction, siteId: SpeechSiteId): string {
  switch (siteId) {
    case "dictation.stt":
      return t("settings.voice.sites.dictationStt");
    case "voiceMode.stt":
      return t("settings.voice.sites.voiceModeStt");
    case "voiceMode.tts":
      return t("settings.voice.sites.voiceModeTts");
  }
}

function FeatureSwitchRow({
  label,
  hint,
  envVar,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  envVar: string | undefined;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow label={label} hint={envVar ? t("settings.voice.setBy", { name: envVar }) : hint}>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={Boolean(envVar)}
        accessibilityLabel={label}
      />
    </SettingsRow>
  );
}

function SpeechSiteRow({
  siteId,
  label,
  summary,
  onOpen,
}: {
  siteId: SpeechSiteId;
  label: string;
  summary: SpeechSiteSummary;
  onOpen: (siteId: SpeechSiteId) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(siteId), [onOpen, siteId]);
  return (
    <SettingsDetailRow
      label={label}
      summary={summaryLabel(t, summary)}
      onPress={open}
      disabled={summary.kind === "unknown"}
      testID={`voice-site-${siteId}`}
    />
  );
}

function summaryLabel(t: TFunction, summary: SpeechSiteSummary): string {
  switch (summary.kind) {
    case "local":
      return summary.model
        ? `${t("settings.voice.providers.local")} · ${summary.model}`
        : t("settings.voice.providers.local");
    case "openai":
      return `${t("settings.voice.providers.openai")} · ${
        summary.missingKey ? t("settings.voice.openai.missingKey") : summary.model
      }`;
    case "unknown":
      return t("settings.voice.unknownProvider", { provider: summary.provider });
  }
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
}));
