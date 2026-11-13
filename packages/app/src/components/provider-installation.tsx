import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderInstallation } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export type ProviderInstallationState =
  | { status: "unsupported" }
  | { status: "loading" }
  | { status: "ready"; installation: ProviderInstallation | null }
  | { status: "error"; message: string };

export interface ProviderInstallationRead {
  state: ProviderInstallationState;
  /** Ask the provider again, skipping the host's short cache. */
  refresh: () => void;
}

function installationQueryKey(serverId: string, provider: string) {
  return ["provider-installation", serverId, provider] as const;
}

/** Reads a provider's installation from hosts that advertise `providerInstallation`. */
export function useProviderInstallation(input: {
  serverId: string;
  provider: string;
  visible: boolean;
}): ProviderInstallationRead {
  const { serverId, provider, visible } = input;
  const supported = useHostFeature(serverId, "providerInstallation");
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const queryKey = installationQueryKey(serverId, provider);

  const inspect = useCallback(
    async (refresh: boolean) => {
      if (!client) throw new Error("Host is not connected");
      const result = await client.inspectProviderInstallation(provider, { refresh });
      if (result.error) throw new Error(result.error);
      return result.installation;
    },
    [client, provider],
  );

  // The host caches inspections briefly, so reading on every open is cheap.
  const query = useFetchQuery({
    queryKey,
    queryFn: () => inspect(false),
    enabled: supported && visible && Boolean(client),
    dataShape: "value",
    staleTimeMs: 0,
  });
  const refreshMutation = useMutation({
    mutationFn: () => inspect(true),
    onSuccess: (installation) => queryClient.setQueryData(queryKey, installation),
  });
  const { mutate } = refreshMutation;
  const refresh = useCallback(() => {
    if (supported && client) mutate();
  }, [client, mutate, supported]);

  let state: ProviderInstallationState;
  if (!supported) state = { status: "unsupported" };
  else if (query.isPending || refreshMutation.isPending) state = { status: "loading" };
  else if (query.isError) state = { status: "error", message: query.error.message };
  else state = { status: "ready", installation: query.data ?? null };
  return { state, refresh };
}

export function ProviderInstallationSection({ state }: { state: ProviderInstallationState }) {
  const { t } = useTranslation();
  if (state.status === "unsupported") return null;
  if (state.status === "ready" && !state.installation?.inspection) return null;

  return (
    <View style={settingsStyles.section} testID="provider-installation">
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>
          {t("settings.providers.installation.title")}
        </Text>
      </View>
      <View style={settingsStyles.card}>
        <InstallationRow state={state} />
      </View>
    </View>
  );
}

function InstallationRow({ state }: { state: ProviderInstallationState }) {
  const { t } = useTranslation();
  const installation = state.status === "ready" ? state.installation : null;
  const installUrl = installation?.installUrl;
  const handleInstall = useCallback(() => {
    if (installUrl) void openExternalUrl(installUrl);
  }, [installUrl]);

  if (state.status === "loading") {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowTitle}>{t("settings.providers.installation.version")}</Text>
        <View style={styles.trailing}>
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          <Text style={styles.value}>{t("settings.providers.installation.checking")}</Text>
        </View>
      </View>
    );
  }
  const inspection = installation?.inspection;
  if (state.status === "error" || inspection?.status === "error") {
    const message = state.status === "error" ? state.message : null;
    return (
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.providers.installation.version")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {inspection?.status === "error" ? inspection.message : message}
          </Text>
        </View>
        <Text style={styles.value}>{t("settings.providers.installation.failed")}</Text>
      </View>
    );
  }
  if (inspection?.status === "not_installed") {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.providers.installation.notInstalled")}
        </Text>
        {installUrl ? (
          <Button variant="outline" size="sm" onPress={handleInstall}>
            {t("settings.providers.installation.install")}
          </Button>
        ) : null}
      </View>
    );
  }
  if (inspection?.status === "installed") {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowTitle}>{t("settings.providers.installation.version")}</Text>
        {inspection.version ? (
          <Text
            style={styles.version}
            numberOfLines={1}
            selectable
            dataSet={CODE_SURFACE_DATASET}
            testID="provider-installation-version"
          >
            {inspection.version}
          </Text>
        ) : (
          <Text style={styles.value}>{t("settings.providers.installation.installed")}</Text>
        )}
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create((theme) => ({
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  value: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  version: {
    flexShrink: 1,
    marginLeft: theme.spacing[3],
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
  },
}));
