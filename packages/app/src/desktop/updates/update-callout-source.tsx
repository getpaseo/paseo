import { Gift } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  type SidebarCalloutAction,
  SidebarCalloutDescriptionText,
} from "@/components/sidebar-callout";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import {
  resolveUpdateCalloutDescriptor,
  type UpdateCalloutActionDescriptor,
  type UpdateCalloutBody,
} from "@/desktop/updates/resolve-update-callout";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { useStableEvent } from "@/hooks/use-stable-event";
import { openChangelog } from "@/changelog";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

function renderBody(body: UpdateCalloutBody, t: ReturnType<typeof useTranslation>["t"]): ReactNode {
  if (body.kind === "downloading") {
    return (
      <UpdateDownloadingDescription
        versionLabel={body.versionLabel ?? undefined}
        percent={body.percent}
        t={t}
      />
    );
  }
  if (body.kind === "installing") return t("desktop.updates.callout.installingDescription");
  if (body.kind === "error") return body.message;
  return (
    <UpdateAvailableDescription
      versionLabel={body.versionLabel ?? undefined}
      readyToInstall={body.readyToInstall !== false}
      t={t}
    />
  );
}

function materializeActions(
  actions: readonly UpdateCalloutActionDescriptor[],
  handlers: { changelog: () => void; install: () => void; retry: () => void },
): SidebarCalloutAction[] {
  return actions.map((action) => ({
    label: action.label,
    onPress: handlers[action.role],
    variant: action.variant,
    disabled: action.disabled,
  }));
}

export function UpdateCalloutSource() {
  const { t } = useTranslation();
  const callouts = useSidebarCallouts();
  const { theme } = useUnistyles();
  const {
    isDesktopApp,
    updateMode,
    isLoadingSettings,
    status,
    availableUpdate,
    downloadProgress,
    errorMessage,
    checkForUpdates,
    installUpdate,
    isInstalling,
  } = useDesktopAppUpdater();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const install = useStableEvent(() => {
    void installUpdate();
  });
  const retry = useStableEvent(() => {
    void checkForUpdates();
  });
  useEffect(() => {
    if (!isDesktopApp || isLoadingSettings || updateMode === "off") return;

    void checkForUpdates({ intent: "automatic", silent: true });

    intervalRef.current = setInterval(() => {
      void checkForUpdates({ intent: "automatic", silent: true });
    }, CHECK_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isDesktopApp, isLoadingSettings, updateMode, checkForUpdates]);

  useEffect(() => {
    const descriptor = resolveUpdateCalloutDescriptor({
      isDesktopApp,
      status,
      isInstalling,
      availableUpdate,
      downloadProgress,
      errorMessage,
    });
    if (!descriptor) return;

    return callouts.show({
      id: descriptor.id,
      dismissalKey: descriptor.dismissalKey,
      priority: descriptor.priority,
      title: descriptor.title,
      description: renderBody(descriptor.body, t),
      icon: descriptor.showGiftIcon ? (
        <Gift size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      ) : undefined,
      variant: descriptor.variant,
      actions: materializeActions(descriptor.actions, {
        changelog: openChangelog,
        install,
        retry,
      }),
      testID: descriptor.testID,
    });
  }, [
    availableUpdate,
    callouts,
    downloadProgress,
    errorMessage,
    install,
    isDesktopApp,
    isInstalling,
    retry,
    status,
    theme.colors.foregroundMuted,
    theme.iconSize.sm,
    t,
  ]);

  return null;
}

function formatAvailableSummary(
  t: ReturnType<typeof useTranslation>["t"],
  versionLabel: string | undefined,
  readyToInstall: boolean,
): string {
  if (readyToInstall) {
    return versionLabel
      ? t("desktop.updates.callout.versionReady", { version: versionLabel })
      : t("desktop.updates.callout.newVersionReady");
  }
  return versionLabel
    ? t("desktop.updates.callout.versionAvailable", { version: versionLabel })
    : t("desktop.updates.callout.newVersionAvailable");
}

function UpdateAvailableDescription({
  versionLabel,
  readyToInstall,
  t,
}: {
  versionLabel?: string;
  readyToInstall: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const summary = formatAvailableSummary(t, versionLabel, readyToInstall);

  return (
    <>
      <SidebarCalloutDescriptionText>{summary}</SidebarCalloutDescriptionText>
      <SidebarCalloutDescriptionText>
        {t("desktop.updates.callout.restartWarning")}
      </SidebarCalloutDescriptionText>
    </>
  );
}

function UpdateDownloadingDescription({
  versionLabel,
  percent,
  t,
}: {
  versionLabel?: string;
  percent: number;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const accessibilityValue = useMemo(
    () => ({ min: 0, max: 100, now: clampedPercent }),
    [clampedPercent],
  );
  const progressFillStyle = useMemo(
    () => [styles.progressFill, { width: `${clampedPercent}%` as const }],
    [clampedPercent],
  );
  return (
    <View style={styles.progressContainer}>
      <SidebarCalloutDescriptionText>
        {versionLabel
          ? t("desktop.updates.callout.downloadingVersionDescription", {
              version: versionLabel,
              percent: clampedPercent,
            })
          : t("desktop.updates.callout.downloadingDescription", { percent: clampedPercent })}
      </SidebarCalloutDescriptionText>
      <View
        style={styles.progressTrack}
        accessibilityRole="progressbar"
        accessibilityValue={accessibilityValue}
      >
        <View style={progressFillStyle} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  progressContainer: {
    gap: theme.spacing[2],
  },
  progressTrack: {
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
}));
