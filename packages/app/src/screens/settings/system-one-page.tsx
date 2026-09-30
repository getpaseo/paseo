import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { StatusBadge } from "@/components/ui/status-badge";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { SystemOneUsageSection } from "./system-one-usage-section";

const CONFIDENCE_OPTIONS = [
  { value: "0.35", label: "35%" },
  { value: "0.5", label: "50%" },
  { value: "0.7", label: "70%" },
  { value: "0.85", label: "85%" },
];
const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const ENDPOINT_OPTIONS = [
  { value: DEFAULT_ENDPOINT, label: "Jev (TypeSafe)" },
  { value: "custom", label: "Custom / self-hosted" },
];

function resolveCredentialLabel(
  source: string | null | undefined,
  t: (key: string) => string,
): string {
  switch (source) {
    case "paseo":
      return t("settings.systemOne.credentials.sources.paseo");
    case "environment":
      return t("settings.systemOne.credentials.sources.environment");
    case "env-file":
      return t("settings.systemOne.credentials.sources.envFile");
    default:
      return t("settings.systemOne.credentials.notConfigured");
  }
}

// The host settings page intentionally keeps all System One controls together.
// oxlint-disable-next-line complexity
export function HostSystemOnePage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const openPaperclip = useCallback(() => router.push("/paperclip" as Href), [router]);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const hasUsage = useHostFeature(serverId, "systemOneUsage");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const systemOne = config?.systemOne;
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(systemOne?.model ?? "jev-latest");
  const [endpoint, setEndpoint] = useState(systemOne?.endpoint ?? DEFAULT_ENDPOINT);
  const [customEndpoint, setCustomEndpoint] = useState(
    systemOne?.endpoint && systemOne.endpoint !== DEFAULT_ENDPOINT ? systemOne.endpoint : "",
  );
  const [minimumConfidence, setMinimumConfidence] = useState(
    String(systemOne?.minimumConfidence ?? 0.5),
  );
  const mutation = useMutation({
    mutationFn: async (patch: Parameters<typeof patchConfig>[0]) => {
      const result = await patchConfig(patch);
      if (!result) throw new Error(t("workspace.terminal.hostDisconnected"));
      return result;
    },
  });

  useEffect(() => {
    if (!systemOne) return;
    setModel(systemOne.model);
    setEndpoint(systemOne.endpoint ?? DEFAULT_ENDPOINT);
    if (systemOne.endpoint && systemOne.endpoint !== DEFAULT_ENDPOINT) {
      setCustomEndpoint(systemOne.endpoint);
    }
    setMinimumConfidence(String(systemOne.minimumConfidence));
  }, [systemOne]);

  const save = useCallback(() => {
    mutation.mutate(
      {
        systemOne: {
          model: model.trim() || "jev-latest",
          endpoint: endpoint === "custom" ? customEndpoint.trim() : endpoint,
          minimumConfidence: Number(minimumConfidence),
        },
        ...(apiKey.trim() ? { systemOneApiKey: apiKey.trim() } : {}),
      },
      { onSuccess: () => setApiKey("") },
    );
  }, [apiKey, customEndpoint, endpoint, minimumConfidence, model, mutation]);
  const clearPaseoKey = useCallback(() => mutation.mutate({ systemOneApiKey: null }), [mutation]);
  const toggleEnabled = useCallback(
    (enabled: boolean) => mutation.mutate({ systemOne: { enabled } }),
    [mutation],
  );
  const toggleBrowserGoals = useCallback(
    (browserGoals: boolean) => mutation.mutate({ systemOne: { browserGoals } }),
    [mutation],
  );
  const credentialLabel = useMemo(
    () => resolveCredentialLabel(systemOne?.credentialSource, t),
    [systemOne?.credentialSource, t],
  );

  if (!isConnected) {
    return (
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <Text style={settingsStyles.rowHint}>{t("settings.systemOne.offline")}</Text>
        </View>
      </View>
    );
  }

  if (!systemOne) {
    return (
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <Text style={settingsStyles.rowHint}>{t("settings.systemOne.updateHost")}</Text>
        </View>
      </View>
    );
  }

  return (
    <View>
      <Button variant="ghost" size="sm" onPress={openPaperclip}>
        {t("onboarding.actions.paperclip")}
      </Button>
      <SettingsSection title={t("settings.systemOne.title")} info={t("settings.systemOne.info")}>
        <SettingsCard testID="host-system-one-settings">
          <SettingsSwitch
            label={t("settings.systemOne.enabled.label")}
            hint={t("settings.systemOne.enabled.hint")}
            value={systemOne.enabled}
            disabled={mutation.isPending}
            onValueChange={toggleEnabled}
          />
          <SettingsRow
            label={t("settings.systemOne.credentials.label")}
            hint={t("settings.systemOne.credentials.hint")}
          >
            <StatusBadge
              label={credentialLabel}
              variant={systemOne.configured ? "success" : "warning"}
            />
          </SettingsRow>
          <SettingsInput
            label={t("settings.systemOne.credentials.input")}
            hint={t("settings.systemOne.credentials.inputHint")}
            initialValue=""
            placeholder={systemOne.configured ? "••••••••••••" : "apikey_…"}
            secureTextEntry
            disabled={mutation.isPending}
            onChangeText={setApiKey}
          />
          <SettingsInput
            label={t("settings.systemOne.model.label")}
            hint={t("settings.systemOne.model.hint")}
            initialValue={model}
            placeholder="jev-latest"
            disabled={mutation.isPending}
            onChangeText={setModel}
          />
          <SettingsSelect
            label={t("settings.systemOne.endpoint.label")}
            hint={t("settings.systemOne.endpoint.hint")}
            value={endpoint === DEFAULT_ENDPOINT ? DEFAULT_ENDPOINT : "custom"}
            options={ENDPOINT_OPTIONS}
            disabled={mutation.isPending}
            onValueChange={setEndpoint}
          />
          {endpoint === "custom" ? (
            <SettingsInput
              label={t("settings.systemOne.endpoint.customLabel")}
              hint={t("settings.systemOne.endpoint.customHint")}
              initialValue={customEndpoint}
              placeholder="https://your-host.example/v1/systemone"
              disabled={mutation.isPending}
              onChangeText={setCustomEndpoint}
            />
          ) : null}
          <SettingsSelect
            label={t("settings.systemOne.confidence.label")}
            hint={t("settings.systemOne.confidence.hint")}
            value={minimumConfidence}
            options={CONFIDENCE_OPTIONS}
            disabled={mutation.isPending}
            onValueChange={setMinimumConfidence}
          />
          <SettingsAction
            label={t("settings.systemOne.save.label")}
            hint={t("settings.systemOne.save.hint")}
            actionLabel={
              mutation.isPending
                ? t("settings.systemOne.save.saving")
                : t("settings.systemOne.save.action")
            }
            disabled={mutation.isPending}
            onPress={save}
          />
          {systemOne.credentialSource === "paseo" ? (
            <SettingsAction
              label={t("settings.systemOne.credentials.removeLabel")}
              hint={t("settings.systemOne.credentials.removeHint")}
              actionLabel={t("settings.systemOne.credentials.removeAction")}
              disabled={mutation.isPending}
              onPress={clearPaseoKey}
            />
          ) : null}
        </SettingsCard>
        {mutation.error ? (
          <Text style={settingsStyles.rowError}>
            {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
          </Text>
        ) : null}
      </SettingsSection>

      {hasUsage ? (
        <SystemOneUsageSection
          serverId={serverId}
          browserGoals={systemOne.browserGoals}
          disabled={mutation.isPending || !systemOne.enabled}
          onBrowserGoalsChange={toggleBrowserGoals}
        />
      ) : null}

      <SettingsSection
        title={t("settings.systemOne.agentUse.title")}
        info={t("settings.systemOne.agentUse.info")}
      >
        <SettingsCard>
          <SettingsRow
            label={t("settings.systemOne.agentUse.splitDecisions")}
            hint={t("settings.systemOne.agentUse.splitDecisionsHint")}
          />
          <SettingsRow
            label={t("settings.systemOne.agentUse.batch")}
            hint={t("settings.systemOne.agentUse.batchHint")}
          />
          <SettingsRow
            label={t("settings.systemOne.agentUse.boundary")}
            hint={t("settings.systemOne.agentUse.boundaryHint")}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
