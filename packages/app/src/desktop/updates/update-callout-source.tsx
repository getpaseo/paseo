import { Gift } from "lucide-react-native";
import { type ReactNode, useEffect, useRef } from "react";
import { useUnistyles } from "react-native-unistyles";
import {
  type SidebarCalloutAction,
  SidebarCalloutDescriptionText,
} from "@/components/sidebar-callout";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { useStableEvent } from "@/hooks/use-stable-event";
import { openExternalUrl } from "@/utils/open-external-url";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const CHANGELOG_URL = "https://paseo.sh/changelog";

function resolveUpdateCalloutTitle(args: {
  isInstalled: boolean;
  isInstalling: boolean;
  isError: boolean;
}): string {
  if (args.isInstalled) return "Update installed";
  if (args.isInstalling) return "Installing update";
  if (args.isError) return "Update failed";
  return "Update available";
}

function resolveUpdateCalloutDescription(args: {
  isInstalled: boolean;
  isInstalling: boolean;
  isError: boolean;
  errorMessage: string | null;
  latestVersion: string | undefined;
}): ReactNode {
  if (args.isInstalled) return "Restart to use the new version.";
  if (args.isInstalling) return "Installing and restarting...";
  if (args.isError) return args.errorMessage ?? "Something went wrong.";
  if (args.latestVersion) {
    return (
      <UpdateAvailableDescription versionLabel={`v${args.latestVersion.replace(/^v/i, "")}`} />
    );
  }
  return <UpdateAvailableDescription />;
}

function buildUpdateCalloutActions(args: {
  isInstalled: boolean;
  isInstalling: boolean;
  isError: boolean;
  openChangelog: () => void;
  retry: () => void;
  install: () => void;
}): SidebarCalloutAction[] {
  const actions: SidebarCalloutAction[] = [{ label: "What's new", onPress: args.openChangelog }];
  if (args.isError) {
    actions.push({ label: "Retry", onPress: args.retry, variant: "primary" });
  } else if (!args.isInstalled) {
    actions.push({
      label: args.isInstalling ? "Installing..." : "Install & restart",
      onPress: args.install,
      variant: "primary",
      disabled: args.isInstalling,
    });
  }
  return actions;
}

export function UpdateCalloutSource() {
  const callouts = useSidebarCallouts();
  const { theme } = useUnistyles();
  const {
    isDesktopApp,
    status,
    availableUpdate,
    errorMessage,
    checkForUpdates,
    installUpdate,
    isInstalling,
  } = useDesktopAppUpdater();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const openChangelog = useStableEvent(() => {
    void openExternalUrl(CHANGELOG_URL);
  });
  const install = useStableEvent(() => {
    void installUpdate();
  });
  const retry = useStableEvent(() => {
    void checkForUpdates();
  });
  useEffect(() => {
    if (!isDesktopApp) return;

    void checkForUpdates({ silent: true });

    intervalRef.current = setInterval(() => {
      void checkForUpdates({ silent: true });
    }, CHECK_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isDesktopApp, checkForUpdates]);

  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }
    if (
      status !== "available" &&
      status !== "installed" &&
      status !== "installing" &&
      status !== "error"
    ) {
      return;
    }

    const isInstalled = status === "installed";
    const isError = status === "error";
    const isAvailable = !isInstalled && !isInstalling && !isError;

    const title = resolveUpdateCalloutTitle({ isInstalled, isInstalling, isError });
    const description = resolveUpdateCalloutDescription({
      isInstalled,
      isInstalling,
      isError,
      errorMessage,
      latestVersion: availableUpdate?.latestVersion ?? undefined,
    });
    const actions = buildUpdateCalloutActions({
      isInstalled,
      isInstalling,
      isError,
      openChangelog,
      retry,
      install,
    });

    return callouts.show({
      id: "desktop-update",
      dismissalKey: `desktop-update:${status}:${availableUpdate?.latestVersion ?? "unknown"}`,
      priority: 200,
      title,
      description,
      icon: isAvailable ? (
        <Gift size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      ) : undefined,
      variant: isError ? "error" : "default",
      actions,
      testID: "update-callout",
    });
  }, [
    availableUpdate?.latestVersion,
    callouts,
    errorMessage,
    install,
    isDesktopApp,
    isInstalling,
    openChangelog,
    retry,
    status,
    theme.colors.foregroundMuted,
    theme.iconSize.sm,
  ]);

  return null;
}

function UpdateAvailableDescription({ versionLabel }: { versionLabel?: string }) {
  return (
    <>
      <SidebarCalloutDescriptionText>
        {versionLabel
          ? `${versionLabel} is ready to install.`
          : "A new version is ready to install."}
      </SidebarCalloutDescriptionText>
      <SidebarCalloutDescriptionText>
        Upgrading the app will stop running agents and close terminal sessions.
      </SidebarCalloutDescriptionText>
    </>
  );
}
