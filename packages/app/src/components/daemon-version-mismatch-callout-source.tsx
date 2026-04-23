import { useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { formatVersionWithPrefix, isVersionMismatch } from "@/desktop/updates/desktop-updates";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { resolveAppVersion } from "@/utils/app-version";
import { buildSettingsHostRoute } from "@/utils/host-routes";

interface DaemonVersionMismatch {
  serverId: string;
  label: string;
  appVersion: string;
  daemonVersion: string;
}

function useDaemonVersionMismatches(): DaemonVersionMismatch[] {
  const hosts = useHosts();
  const sessions = useSessionStore((state) => state.sessions);
  const appVersion = resolveAppVersion();

  return useMemo(() => {
    if (!appVersion) {
      return [];
    }

    return hosts
      .map((entry) => ({
        serverId: entry.serverId,
        label: entry.label?.trim() || sessions[entry.serverId]?.serverInfo?.hostname || "Daemon",
        appVersion,
        daemonVersion: sessions[entry.serverId]?.serverInfo?.version ?? null,
      }))
      .filter((entry): entry is DaemonVersionMismatch =>
        isVersionMismatch(entry.appVersion, entry.daemonVersion),
      );
  }, [appVersion, hosts, sessions]);
}

function DaemonVersionMismatchRegistration({ mismatch }: { mismatch: DaemonVersionMismatch }) {
  const callouts = useSidebarCallouts();
  const router = useRouter();
  const { appVersion, daemonVersion, label, serverId } = mismatch;
  const openSettings = useStableEvent(() => {
    router.navigate(buildSettingsHostRoute(serverId));
  });

  useEffect(() => {
    return callouts.show({
      id: `daemon-version-mismatch:${serverId}`,
      dismissalKey: `daemon-version-mismatch:${serverId}:${appVersion}:${daemonVersion}`,
      priority: 300,
      title: "Daemon version mismatch",
      description: `${label} is running ${formatVersionWithPrefix(
        daemonVersion,
      )}. This app is ${formatVersionWithPrefix(
        appVersion,
      )}. For the best experience, keep the daemon and client on the same version.`,
      variant: "error",
      actions: [{ label: "Open settings", onPress: openSettings, variant: "primary" }],
      testID: `daemon-version-mismatch-callout-${serverId}`,
    });
  }, [appVersion, callouts, daemonVersion, label, openSettings, serverId]);

  return null;
}

export function DaemonVersionMismatchCalloutSource() {
  const mismatches = useDaemonVersionMismatches();

  return (
    <>
      {mismatches.map((mismatch) => (
        <DaemonVersionMismatchRegistration key={mismatch.serverId} mismatch={mismatch} />
      ))}
    </>
  );
}
