import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useHostFeature, useHostFeatureMap } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useProjects } from "@/hooks/use-projects";
import type { ProjectHostEntry } from "@/utils/projects";
import { LocalFilesSheet } from "./sheet";
import type { LocalFilesTarget } from "./form";

interface Props {
  host: ProjectHostEntry;
  client: DaemonClient;
  configuredPaths: string[];
  missingOnly?: boolean;
}
export function LocalFilesSection(props: Props) {
  const { t } = useTranslation();
  const supported = useHostFeature(props.host.serverId, "projectLocalFiles");
  if (!supported)
    return (
      <SettingsSection title={t("localFiles.title")}>
        <Text style={settingsStyles.rowHint}>{t("localFiles.updateHost")}</Text>
      </SettingsSection>
    );
  return <SupportedLocalFilesSection {...props} />;
}

function SupportedLocalFilesSection({ host, client, configuredPaths, missingOnly }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { projects } = useProjects();
  const queryClient = useQueryClient();
  const hosts = projects.flatMap((project) => project.hosts);
  const capabilities = useHostFeatureMap(
    hosts.map((entry) => entry.serverId),
    "projectLocalFiles",
  );
  const target = useMemo<LocalFilesTarget>(
    () => ({
      client,
      serverId: host.serverId,
      projectId: host.projectId,
      root: host.repoRoot,
      label: host.serverName,
    }),
    [client, host.serverId, host.projectId, host.repoRoot, host.serverName],
  );
  const queryKey = ["project-local-files", host.serverId, host.projectId, configuredPaths];
  const inspection = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    queryKey,
    queryFn: () => client.inspectProjectLocalFiles({ projectId: host.projectId }),
    retry: false,
  });
  const sources: LocalFilesTarget[] = [];
  for (const entry of hosts) {
    if (entry.serverId === host.serverId && entry.projectId === host.projectId) continue;
    if (!entry.isOnline || !capabilities.get(entry.serverId)) continue;
    const sourceClient = getHostRuntimeStore().getSnapshot(entry.serverId)?.client;
    if (!sourceClient) continue;
    sources.push({
      client: sourceClient,
      serverId: entry.serverId,
      projectId: entry.projectId,
      root: entry.repoRoot,
      label: entry.serverName + " · " + entry.projectName,
    });
  }
  const visibleFiles =
    inspection.data?.files.filter((file) =>
      missingOnly
        ? configuredPaths.includes(file.path) && file.status !== "ready"
        : file.status === "ready" || configuredPaths.includes(file.path),
    ) ?? [];
  const failed = inspection.isError || Boolean(inspection.data?.error);
  const close = useCallback(() => {
    setOpen(false);
    void queryClient.invalidateQueries({
      queryKey: ["project-local-files", host.serverId, host.projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["project-config", host.serverId, host.repoRoot],
    });
  }, [host.serverId, host.projectId, host.repoRoot, queryClient]);
  const showImport = useCallback(() => setOpen(true), []);
  const refetch = inspection.refetch;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (missingOnly && !failed && visibleFiles.length === 0) return null;
  return (
    <SettingsSection
      title={t(missingOnly ? "localFiles.missingTitle" : "localFiles.title")}
      info={t("localFiles.info")}
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{host.serverName}</Text>
            <Text style={settingsStyles.rowHint} selectable>
              {host.repoRoot}
            </Text>
          </View>
          <Button variant="outline" onPress={showImport} testID="local-files-open">
            {t("localFiles.import")}
          </Button>
        </View>
        {inspection.isPending ? (
          <Text style={settingsStyles.rowHint}>{t("common.loading")}</Text>
        ) : null}
        {failed ? (
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowError}>{t("localFiles.errors.load_failed")}</Text>
            <Button variant="outline" onPress={refresh}>
              {t("localFiles.refresh")}
            </Button>
          </View>
        ) : null}
        {visibleFiles.map((file) => (
          <View key={file.path} style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={settingsStyles.rowTitle}>{file.path}</Text>
            <Text style={settingsStyles.rowHint}>{t("localFiles.status." + file.status)}</Text>
          </View>
        ))}
      </View>
      {open ? (
        <LocalFilesSheet
          key={host.serverId + host.projectId}
          target={target}
          sources={sources}
          onClose={close}
        />
      ) : null}
    </SettingsSection>
  );
}
