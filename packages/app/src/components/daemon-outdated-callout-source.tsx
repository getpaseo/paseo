import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type SidebarCalloutAction,
  SidebarCalloutDescriptionText,
} from "@/components/sidebar-callout";
import {
  type DaemonOutdatedUpdateState,
  resolveDaemonOutdatedCallout,
} from "@/components/resolve-daemon-outdated-callout";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { updateDaemonFromSettings } from "@/screens/settings/daemon-lifecycle";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";
import { resolveAppVersion } from "@/utils/app-version";
import { confirmDialog } from "@/utils/confirm-dialog";

interface HostUpdateState {
  serverId: string;
  update: DaemonOutdatedUpdateState;
}

const IDLE: DaemonOutdatedUpdateState = { status: "idle" };

function DaemonOutdatedDescription({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line) => (
        <SidebarCalloutDescriptionText key={line}>{line}</SidebarCalloutDescriptionText>
      ))}
    </>
  );
}

interface ConfirmAndUpdateDaemonInput {
  serverId: string;
  hostLabel: string;
  client: DaemonClient;
  t: TFunction;
  onState: (next: DaemonOutdatedUpdateState) => void;
}

async function confirmAndUpdateDaemon(input: ConfirmAndUpdateDaemonInput): Promise<void> {
  const { serverId, hostLabel, client, t, onState } = input;
  let confirmed: boolean;
  try {
    confirmed = await confirmDialog({
      title: t("settings.host.daemon.update.confirmTitle", { name: hostLabel }),
      message: t("settings.host.daemon.update.confirmMessage"),
      confirmLabel: t("settings.host.daemon.update.confirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: false,
    });
  } catch (error) {
    console.error("[DaemonOutdatedCallout] Failed to open update confirmation", error);
    onState({ status: "failed", message: t("settings.host.daemon.update.dialogFailedMessage") });
    return;
  }
  if (!confirmed) return;

  const phaseLabels = {
    starting: t("settings.host.daemon.update.phaseStarting"),
    downloading: t("settings.host.daemon.update.phaseDownloading"),
    installing: t("settings.host.daemon.update.phaseInstalling"),
    complete: t("settings.host.daemon.update.phaseComplete"),
  };
  onState({ status: "updating", phase: phaseLabels.starting });
  const requestId = `sidebar_daemon_update_${serverId}`;
  const unsubscribe = client.on("daemon.update.progress", (message) => {
    if (message.payload.requestId !== requestId) return;
    onState({ status: "updating", phase: phaseLabels[message.payload.phase] });
  });
  try {
    await updateDaemonFromSettings(serverId, {
      updateDaemon: () => client.updateDaemon(requestId),
      getStatus: async () => ({
        ...(await client.getDaemonStatus()),
        serverId: client.getLastServerInfoMessage()?.serverId ?? "",
        version: client.getLastServerInfoMessage()?.version ?? null,
      }),
    });
    onState({ status: "idle" });
  } catch (error) {
    console.error(`[DaemonOutdatedCallout] Failed to update daemon ${hostLabel}`, error);
    onState({
      status: "failed",
      message: t("settings.host.daemon.update.requestFailedMessage", {
        error: error instanceof Error ? error.message : String(error),
      }),
    });
  } finally {
    unsubscribe();
  }
}

/** Sidebar notice when the active host's daemon is older than this app. */
export function DaemonOutdatedCalloutSource() {
  const { t } = useTranslation();
  const callouts = useSidebarCallouts();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const lastWorkspaceSelection = useLastWorkspaceSelection();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  // Same host resolution as settings: the last workspace's host, else the local daemon, else the first.
  const serverId = resolveActiveHostServerId({
    selectedServerId: lastWorkspaceSelection?.serverId ?? null,
    localServerId,
    hosts,
    orderedHosts,
  });
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? "";
  const daemonClient = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const serverInfo = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.serverInfo ?? null) : null,
  );
  const [hostUpdate, setHostUpdate] = useState<HostUpdateState | null>(null);
  const update = hostUpdate && hostUpdate.serverId === serverId ? hostUpdate.update : IDLE;

  const runUpdate = useStableEvent(() => {
    if (!serverId || !daemonClient) return;
    void confirmAndUpdateDaemon({
      serverId,
      hostLabel,
      client: daemonClient,
      t,
      onState: (next) => setHostUpdate({ serverId, update: next }),
    });
  });

  useEffect(() => {
    if (!serverId || !serverInfo) return;
    const descriptor = resolveDaemonOutdatedCallout({
      serverId,
      hostLabel,
      appVersion: resolveAppVersion(),
      daemonVersion: serverInfo.version,
      supportsSelfUpdate: serverInfo.features?.daemonSelfUpdate === true,
      desktopManaged: serverInfo.desktopManaged === true,
      // COMPAT(terminalsSurviveRestart): added in v0.12.0, remove gate after 2027-04-21.
      terminalsSurviveRestart: serverInfo.features?.terminalsSurviveRestart === true,
      isConnected,
      update,
    });
    if (!descriptor) return;

    const actions: SidebarCalloutAction[] = descriptor.updateAction
      ? [
          {
            label: descriptor.updateAction.label,
            onPress: runUpdate,
            variant: "primary",
            disabled: descriptor.updateAction.disabled,
            testID: "daemon-outdated-callout-update",
          },
        ]
      : [];
    return callouts.show({
      id: descriptor.id,
      dismissalKey: descriptor.dismissalKey,
      priority: descriptor.priority,
      title: descriptor.title,
      description: <DaemonOutdatedDescription lines={descriptor.description} />,
      variant: descriptor.variant,
      actions,
      testID: descriptor.testID,
      native: true,
    });
    // t: the resolver reads the active language through i18n, so a language change rebuilds the copy.
  }, [callouts, hostLabel, isConnected, runUpdate, serverId, serverInfo, t, update]);

  return null;
}
