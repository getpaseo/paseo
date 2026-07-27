import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import {
  createVoiceFeaturePatch,
  getVoiceFeaturesCardState,
  getVoiceFeaturesMutationViewState,
  type VoiceFeatureId,
} from "./voice-features-config";

function VoiceFeatureRow({
  feature,
  isEnabled,
  showBorder,
  isPending,
  loadingText,
  errorText,
  disabled,
  onValueChange,
}: {
  feature: VoiceFeatureId;
  isEnabled: boolean;
  showBorder: boolean;
  isPending: boolean;
  loadingText: string | null;
  errorText: string | null;
  disabled: boolean;
  onValueChange: (feature: VoiceFeatureId, next: boolean) => void;
}) {
  const { t } = useTranslation();
  const title =
    feature === "dictation"
      ? t("settings.host.voice.dictation.title")
      : t("settings.host.voice.voiceMode.title");
  const hint =
    feature === "dictation"
      ? t("settings.host.voice.dictation.hint")
      : t("settings.host.voice.voiceMode.hint");
  const accessibilityLabel =
    feature === "dictation"
      ? t("settings.host.voice.dictation.accessibilityLabel")
      : t("settings.host.voice.voiceMode.accessibilityLabel");

  const handleChange = useCallback(
    (next: boolean) => {
      onValueChange(feature, next);
    },
    [feature, onValueChange],
  );

  return (
    <View
      style={[settingsStyles.row, showBorder ? settingsStyles.rowBorder : undefined]}
      testID={`host-page-voice-feature-row-${feature}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
        {isPending && loadingText ? (
          <Text
            style={settingsStyles.rowHint}
            testID={`host-page-voice-feature-loading-${feature}`}
          >
            {loadingText}
          </Text>
        ) : null}
        {errorText ? (
          <Text style={settingsStyles.rowError} testID={`host-page-voice-feature-error-${feature}`}>
            {errorText}
          </Text>
        ) : null}
      </View>
      <Switch
        value={isEnabled}
        onValueChange={handleChange}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel}
        testID={`host-page-voice-feature-switch-${feature}`}
      />
    </View>
  );
}

export function VoiceFeaturesCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const state = getVoiceFeaturesCardState({ isConnected, config });
  const [pendingFeature, setPendingFeature] = useState<VoiceFeatureId | null>(null);

  const mutation = useMutation({
    mutationFn: async (input: { feature: VoiceFeatureId; enabled: boolean }) => {
      setPendingFeature(input.feature);
      const result = await patchConfig(createVoiceFeaturePatch(input.feature, input.enabled));
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });

  const mutationView = getVoiceFeaturesMutationViewState({
    isPending: mutation.isPending,
    error: mutation.error,
    updatingLabel: t("settings.host.voice.updating"),
  });

  const handleValueChange = useCallback(
    (feature: VoiceFeatureId, next: boolean) => {
      mutation.mutate({ feature, enabled: next });
    },
    [mutation],
  );

  if (!state.isVisible) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-voice-features-card">
      {state.rows.map((row, index) => (
        <VoiceFeatureRow
          key={row.id}
          feature={row.id}
          isEnabled={row.isEnabled}
          showBorder={index > 0}
          isPending={mutation.isPending && pendingFeature === row.id}
          loadingText={
            mutation.isPending && pendingFeature === row.id ? mutationView.loadingText : null
          }
          errorText={
            !mutation.isPending && mutationView.errorText && pendingFeature === row.id
              ? mutationView.errorText
              : null
          }
          disabled={mutationView.isSwitchDisabled}
          onValueChange={handleValueChange}
        />
      ))}
    </View>
  );
}
