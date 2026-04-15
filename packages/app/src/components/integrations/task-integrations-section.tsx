// TaskIntegrationsSection — Settings section for managing task integrations
// Works on ALL platforms (mobile, web, desktop). Shows IntegrationsCard with
// connect/disconnect flow that opens setup forms in AdaptiveModalSheet.

import { useCallback, useState } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { IntegrationsCard } from "./integrations-card";
import { LinearSetupForm } from "./linear-setup-form";
import { JiraSetupForm } from "./jira-setup-form";
import { GitLabSetupForm } from "./gitlab-setup-form";
import { ForgejoSetupForm } from "./forgejo-setup-form";
import { PlainSetupForm } from "./plain-setup-form";
import {
  useIntegrationStatus,
  useIntegrationConnect,
  useIntegrationDisconnect,
} from "@/hooks/use-integration-status";
import type { IntegrationId, IntegrationStatusMap } from "@/types/kanban";
import { INTEGRATION_LABELS } from "@/types/kanban";

// GitHub and Sentry only need a single token field — inline form
import { GitHubSetupForm } from "./github-setup-form";
import { SentrySetupForm } from "./sentry-setup-form";

interface TaskIntegrationsSectionProps {
  serverId: string | undefined;
}

export function TaskIntegrationsSection({ serverId }: TaskIntegrationsSectionProps) {
  const { statusMap, isLoading } = useIntegrationStatus(serverId);
  const connectMutation = useIntegrationConnect(serverId);
  const disconnectMutation = useIntegrationDisconnect(serverId);

  const [setupModal, setSetupModal] = useState<IntegrationId | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Convert full status map to boolean map expected by IntegrationsCard
  const booleanMap: IntegrationStatusMap = {
    github: statusMap.github?.connected ?? false,
    linear: statusMap.linear?.connected ?? false,
    jira: statusMap.jira?.connected ?? false,
    gitlab: statusMap.gitlab?.connected ?? false,
    plain: statusMap.plain?.connected ?? false,
    forgejo: statusMap.forgejo?.connected ?? false,
    sentry: statusMap.sentry?.connected ?? false,
  };

  const handleConnect = useCallback((id: IntegrationId) => {
    setSetupError(null);
    setSetupModal(id);
  }, []);

  const handleDisconnect = useCallback(
    (id: IntegrationId) => {
      disconnectMutation.mutate(id);
    },
    [disconnectMutation],
  );

  const handleCloseSetup = useCallback(() => {
    setSetupModal(null);
    setSetupError(null);
  }, []);

  const handleSubmitCredentials = useCallback(
    async (integrationId: IntegrationId, credentials: Record<string, string>) => {
      setSetupError(null);
      try {
        const result = await connectMutation.mutateAsync({ integrationId, credentials });
        if (result.success) {
          setSetupModal(null);
        } else {
          setSetupError(result.error ?? "Connection failed");
        }
      } catch (err) {
        setSetupError(err instanceof Error ? err.message : "Connection failed");
      }
    },
    [connectMutation],
  );

  const modalTitle = setupModal ? `${INTEGRATION_LABELS[setupModal]} Setup` : "Setup";

  return (
    <View style={sectionStyles.container}>
      <IntegrationsCard
        statusMap={booleanMap}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
      />

      {isLoading ? <Text style={sectionStyles.loadingText}>Checking connections...</Text> : null}

      {/* Setup form modal */}
      <AdaptiveModalSheet
        title={modalTitle}
        visible={setupModal !== null}
        onClose={handleCloseSetup}
        snapPoints={["55%", "80%"]}
      >
        {setupModal === "github" ? (
          <GitHubSetupForm
            onSubmit={(token) => handleSubmitCredentials("github", { token })}
            onClose={handleCloseSetup}
            isLoading={connectMutation.isPending}
            error={setupError}
          />
        ) : null}
        {setupModal === "linear" ? (
          <LinearSetupForm
            onSubmit={(apiKey) => handleSubmitCredentials("linear", { token: apiKey })}
            onClose={handleCloseSetup}
            isLoading={connectMutation.isPending}
            error={setupError}
          />
        ) : null}
        {setupModal === "jira" ? (
          <JiraSetupForm
            onSubmit={(creds) => handleSubmitCredentials("jira", creds)}
            onClose={handleCloseSetup}
            isLoading={connectMutation.isPending}
            error={setupError}
          />
        ) : null}
        {setupModal === "gitlab" ? (
          <GitLabSetupForm
            onSubmit={(creds) => handleSubmitCredentials("gitlab", creds)}
            onClose={handleCloseSetup}
            isLoading={connectMutation.isPending}
            error={setupError}
          />
        ) : null}
        {setupModal === "plain" ? (
          <PlainSetupForm
            onSubmit={(apiKey) => handleSubmitCredentials("plain", { token: apiKey })}
            onClose={handleCloseSetup}
            isLoading={connectMutation.isPending}
            error={setupError}
          />
        ) : null}
        {setupModal === "forgejo" ? (
          <ForgejoSetupForm
            onSubmit={(creds) => handleSubmitCredentials("forgejo", creds)}
            onClose={handleCloseSetup}
            isLoading={connectMutation.isPending}
            error={setupError}
          />
        ) : null}
        {setupModal === "sentry" ? (
          <SentrySetupForm
            onSubmit={(token) => handleSubmitCredentials("sentry", { token })}
            onClose={handleCloseSetup}
            isLoading={connectMutation.isPending}
            error={setupError}
          />
        ) : null}
      </AdaptiveModalSheet>
    </View>
  );
}

const sectionStyles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[4],
  },
  loadingText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
