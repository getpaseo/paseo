import React, { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import {
  areMetadataCustomEndpointDraftsEqual,
  buildMetadataCustomEndpointFieldResetKey,
  createMetadataCustomEndpointPatch,
  getMetadataCustomEndpointCardState,
  readMetadataCustomEndpointFromConfig,
  shouldShowModelSuggestions,
  type MetadataCustomEndpointDraft,
  type MetadataModelDiscoveryStatus,
} from "./metadata-custom-endpoint-config";

interface DiscoveredModel {
  id: string;
  name?: string;
}

function ModelSuggestionChip({
  model,
  selected,
  onSelect,
}: {
  model: DiscoveredModel;
  selected: boolean;
  onSelect: (modelId: string) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(model.id);
  }, [model.id, onSelect]);

  return (
    <Pressable
      onPress={handlePress}
      style={[styles.suggestionChip, selected ? styles.suggestionChipSelected : null]}
      testID={`host-page-metadata-custom-endpoint-model-option-${model.id}`}
    >
      <Text style={[styles.suggestionText, selected ? styles.suggestionTextSelected : null]}>
        {model.name ? `${model.name} (${model.id})` : model.id}
      </Text>
    </Pressable>
  );
}

export function MetadataCustomEndpointCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(metadataCustomEndpoint): added 2026-07-28, remove after 2027-01-28.
  const featureEnabled = useHostFeature(serverId, "metadataCustomEndpoint");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const client = useHostRuntimeClient(serverId);

  const persisted = useMemo(() => readMetadataCustomEndpointFromConfig(config), [config]);
  const fieldResetKey = useMemo(
    () => buildMetadataCustomEndpointFieldResetKey(persisted),
    [persisted],
  );
  const [draft, setDraft] = useState<MetadataCustomEndpointDraft>(persisted);
  const [seededFieldResetKey, setSeededFieldResetKey] = useState(fieldResetKey);
  // Bumped when a model chip is selected so the uncontrolled model input remounts.
  const [modelFieldEpoch, setModelFieldEpoch] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discoveryStatus, setDiscoveryStatus] = useState<MetadataModelDiscoveryStatus>("idle");
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Keep draft aligned with the persisted snapshot before paint when config
  // reloads. AdaptiveTextInput remounts on fieldResetKey and must seed from
  // the same snapshot, not a stale draft from the previous render.
  if (fieldResetKey !== seededFieldResetKey) {
    setSeededFieldResetKey(fieldResetKey);
    setDraft(persisted);
    setModelFieldEpoch(0);
  }

  const cardState = getMetadataCustomEndpointCardState({
    isConnected,
    config,
    featureEnabled,
  });
  const hasChanges = !areMetadataCustomEndpointDraftsEqual(draft, persisted);
  const showSuggestions = shouldShowModelSuggestions({ discoveryStatus, models });

  const handleBaseUrlChange = useCallback((baseUrl: string) => {
    setDraft((current) => ({ ...current, baseUrl }));
    setSaveError(null);
  }, []);

  const handleApiKeyChange = useCallback((apiKey: string) => {
    setDraft((current) => ({ ...current, apiKey }));
    setSaveError(null);
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setDraft((current) => ({ ...current, model }));
    setSaveError(null);
  }, []);

  const handleSelectModel = useCallback((modelId: string) => {
    setDraft((current) => ({ ...current, model: modelId }));
    setModelFieldEpoch((current) => current + 1);
    setSaveError(null);
  }, []);

  const handleEnabledChange = useCallback(
    (next: boolean) => {
      const nextDraft = { ...draft, enabled: next };
      setDraft(nextDraft);
      setSaveError(null);
      if (!next && persisted.enabled) {
        setIsSaving(true);
        void patchConfig(createMetadataCustomEndpointPatch(nextDraft))
          .catch((error) => {
            setSaveError(error instanceof Error ? error.message : String(error));
          })
          .finally(() => setIsSaving(false));
      }
    },
    [draft, patchConfig, persisted.enabled],
  );

  const handleRefreshModels = useCallback(() => {
    if (!client) {
      setDiscoveryStatus("error");
      setDiscoveryError(t("settings.host.orchestration.metadataEndpoint.errors.disconnected"));
      return;
    }
    setDiscoveryStatus("loading");
    setDiscoveryError(null);
    void client
      .listMetadataCustomEndpointModels({
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
      })
      .then((result) => {
        if (result.error) {
          setModels([]);
          setDiscoveryStatus("error");
          setDiscoveryError(result.error.message);
          return null;
        }
        setModels(result.models);
        setDiscoveryStatus("success");
        return null;
      })
      .catch((error) => {
        setModels([]);
        setDiscoveryStatus("error");
        setDiscoveryError(error instanceof Error ? error.message : String(error));
      });
  }, [client, draft.apiKey, draft.baseUrl, t]);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    setSaveError(null);
    void patchConfig(createMetadataCustomEndpointPatch(draft))
      .catch((error) => {
        setSaveError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setIsSaving(false));
  }, [draft, patchConfig]);

  if (!cardState.isVisible) {
    return null;
  }

  return (
    <View style={settingsStyles.card} testID="host-page-metadata-custom-endpoint-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.orchestration.metadataEndpoint.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.orchestration.metadataEndpoint.hint")}
          </Text>
        </View>
        <Switch
          value={draft.enabled}
          onValueChange={handleEnabledChange}
          disabled={isSaving}
          accessibilityLabel={t(
            "settings.host.orchestration.metadataEndpoint.enableAccessibilityLabel",
          )}
          testID="host-page-metadata-custom-endpoint-switch"
        />
      </View>

      {draft.enabled ? (
        <View style={styles.fields}>
          <Field label={t("settings.host.orchestration.metadataEndpoint.baseUrlLabel")}>
            <FormTextInput
              initialValue={draft.baseUrl}
              resetKey={fieldResetKey}
              onChangeText={handleBaseUrlChange}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t("settings.host.orchestration.metadataEndpoint.baseUrlPlaceholder")}
              testID="host-page-metadata-custom-endpoint-base-url"
            />
          </Field>

          <Field label={t("settings.host.orchestration.metadataEndpoint.apiKeyLabel")}>
            <FormTextInput
              initialValue={draft.apiKey}
              resetKey={fieldResetKey}
              onChangeText={handleApiKeyChange}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder={t("settings.host.orchestration.metadataEndpoint.apiKeyPlaceholder")}
              testID="host-page-metadata-custom-endpoint-api-key"
            />
          </Field>

          <Field label={t("settings.host.orchestration.metadataEndpoint.modelLabel")}>
            <FormTextInput
              initialValue={draft.model}
              resetKey={`${fieldResetKey}:model:${modelFieldEpoch}`}
              onChangeText={handleModelChange}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t("settings.host.orchestration.metadataEndpoint.modelPlaceholder")}
              testID="host-page-metadata-custom-endpoint-model"
            />
          </Field>

          {showSuggestions ? (
            <View style={styles.suggestions}>
              {models.map((model) => (
                <ModelSuggestionChip
                  key={model.id}
                  model={model}
                  selected={draft.model === model.id}
                  onSelect={handleSelectModel}
                />
              ))}
            </View>
          ) : null}

          {discoveryError ? (
            <Text
              style={settingsStyles.rowError}
              testID="host-page-metadata-custom-endpoint-discovery-error"
            >
              {discoveryError}
            </Text>
          ) : null}
          {saveError ? (
            <Text
              style={settingsStyles.rowError}
              testID="host-page-metadata-custom-endpoint-save-error"
            >
              {saveError}
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Button
              variant="outline"
              size="sm"
              onPress={handleRefreshModels}
              disabled={discoveryStatus === "loading" || draft.baseUrl.trim().length === 0}
              testID="host-page-metadata-custom-endpoint-refresh-models"
            >
              {discoveryStatus === "loading"
                ? t("settings.host.orchestration.metadataEndpoint.refreshingModels")
                : t("settings.host.orchestration.metadataEndpoint.refreshModels")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleSave}
              disabled={!hasChanges || isSaving}
              testID="host-page-metadata-custom-endpoint-save"
            >
              {isSaving
                ? t("settings.host.orchestration.metadataEndpoint.saving")
                : t("settings.host.orchestration.metadataEndpoint.save")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  suggestions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  suggestionChip: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  suggestionChipSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.secondary,
  },
  suggestionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  suggestionTextSelected: {
    color: theme.colors.primary,
  },
}));
