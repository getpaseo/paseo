import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ProviderInstallation,
  ProviderInstallationUpdate,
  ProviderInstallationUpdateCheck,
} from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
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

/** `hidden` until the provider is installed, and when it cannot check for updates. */
export type ProviderUpdatesState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "ready"; updateCheck: ProviderInstallationUpdateCheck }
  | { status: "error"; message: string };

/** Running the provider's own update. Absent when the host cannot report updates. */
export interface ProviderUpdateAction {
  /** The provider's latest update since the host started, or null. */
  current: ProviderInstallationUpdate | null;
  /** The request to start an update is in flight. */
  starting: boolean;
  /** Why the host did not start the update. */
  startError: string | null;
  start(): void;
}

export function ProviderInstallationSection({
  state,
  updates,
  action,
}: {
  state: ProviderInstallationState;
  updates: ProviderUpdatesState;
  action?: ProviderUpdateAction;
}) {
  const { t } = useTranslation();
  if (state.status === "unsupported") return null;
  if (
    state.status === "ready" &&
    !state.installation?.inspection &&
    !state.installation?.installUrl
  )
    return null;

  return (
    <View style={settingsStyles.section} testID="provider-installation">
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>
          {t("settings.providers.installation.title")}
        </Text>
      </View>
      <View style={settingsStyles.card}>
        <InstallationRow state={state} />
        {updates.status !== "hidden" && state.status === "ready" ? (
          <UpdatesRow
            updates={updates}
            updateUrl={state.installation?.updateUrl}
            action={state.installation?.canUpdate ? action : undefined}
          />
        ) : null}
        {action && (action.current || action.startError) ? (
          <UpdateRunRow
            action={action}
            updateUrl={state.status === "ready" ? state.installation?.updateUrl : undefined}
          />
        ) : null}
      </View>
    </View>
  );
}

function InstallInstructionsLink({ installUrl }: { installUrl: string }) {
  const { t } = useTranslation();
  return (
    <ExternalLink
      href={installUrl}
      label={t("settings.providers.installation.installInstructions")}
      testID="provider-installation-install-instructions"
    />
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
  if (inspection?.status === "not_installed") {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.providers.installation.notInstalled")}
        </Text>
        {installUrl ? (
          <Button variant="outline" onPress={handleInstall}>
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
  // The installed state is unknown: the check failed, or the provider only links to a guide.
  let message: string | null = null;
  if (state.status === "error") message = state.message;
  else if (inspection?.status === "error") message = inspection.message;
  if (!message) {
    return installUrl ? (
      <View style={settingsStyles.row}>
        <InstallInstructionsLink installUrl={installUrl} />
      </View>
    ) : null;
  }
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.providers.installation.failed")}</Text>
        <Text style={settingsStyles.rowHint}>{message}</Text>
        {installUrl ? (
          <View style={styles.link}>
            <InstallInstructionsLink installUrl={installUrl} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function UpdatesRow({
  updates,
  updateUrl,
  action,
}: {
  updates: Exclude<ProviderUpdatesState, { status: "hidden" }>;
  updateUrl: string | undefined;
  /** Present when the provider runs its own update. */
  action: ProviderUpdateAction | undefined;
}) {
  const { t } = useTranslation();

  if (updates.status === "loading") {
    return (
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <Text style={settingsStyles.rowTitle}>{t("settings.providers.installation.updates")}</Text>
        <View style={styles.trailing}>
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          <Text style={styles.value}>{t("settings.providers.installation.checking")}</Text>
        </View>
      </View>
    );
  }
  const updateCheck = updates.status === "ready" ? updates.updateCheck : null;
  if (updateCheck?.status === "current") {
    return (
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <Text style={settingsStyles.rowTitle}>{t("settings.providers.installation.updates")}</Text>
        <Text style={styles.value} testID="provider-updates-current">
          {t("settings.providers.installation.upToDate")}
        </Text>
      </View>
    );
  }
  if (updateCheck?.status === "available") {
    // Versions are opaque; drop repeats so each one keys its own line.
    const versions = [...new Set(updateCheck.versions ?? [])];
    return (
      <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="provider-updates">
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.providers.installation.updateAvailable")}
          </Text>
          {versions.map((version) => (
            <Text
              key={version}
              style={styles.availableVersion}
              selectable
              dataSet={CODE_SURFACE_DATASET}
              testID="provider-updates-version"
            >
              {version}
            </Text>
          ))}
          {updateCheck.message ? (
            <Text style={settingsStyles.rowHint}>{updateCheck.message}</Text>
          ) : null}
        </View>
        <AvailableUpdateButton action={action} updateUrl={updateUrl} />
      </View>
    );
  }
  // A check that threw, timed out or could not tell is never shown as up to date.
  let message: string | undefined;
  if (updates.status === "error") message = updates.message;
  else if (updateCheck?.status === "unknown" || updateCheck?.status === "error")
    message = updateCheck.message;
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="provider-updates">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.providers.installation.updatesFailed")}
        </Text>
        {message ? <Text style={settingsStyles.rowHint}>{message}</Text> : null}
        {updateUrl ? (
          <View style={styles.link}>
            <ExternalLink
              href={updateUrl}
              label={t("settings.providers.installation.updateInstructions")}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Update runs the provider's updater; without one, the provider's update guide opens. */
function AvailableUpdateButton({
  action,
  updateUrl,
}: {
  action: ProviderUpdateAction | undefined;
  updateUrl: string | undefined;
}) {
  const { t } = useTranslation();
  const handleOpenInstructions = useCallback(() => {
    if (updateUrl) void openExternalUrl(updateUrl);
  }, [updateUrl]);
  if (action)
    return (
      <Button
        variant="outline"
        onPress={action.start}
        loading={action.starting || action.current?.operation.status === "running"}
        testID="provider-update-start"
      >
        {t("settings.providers.installation.update")}
      </Button>
    );
  if (!updateUrl) return null;
  return (
    <Button variant="outline" onPress={handleOpenInstructions}>
      {t("settings.providers.installation.updateInstructions")}
    </Button>
  );
}

function UpdateRunRow({
  action,
  updateUrl,
}: {
  action: ProviderUpdateAction;
  updateUrl: string | undefined;
}) {
  const { t } = useTranslation();
  const scroll = useRef<ScrollView>(null);
  const followOutput = useCallback(() => scroll.current?.scrollToEnd({ animated: false }), []);
  // A refused start replaces the previous update's result.
  const update = action.startError ? null : action.current;
  const status = update?.operation.status ?? "failed";
  let title = t("settings.providers.installation.updateFailed");
  if (status === "running") title = t("settings.providers.installation.updating");
  else if (status === "succeeded") title = t("settings.providers.installation.updated");
  let message = action.startError ?? undefined;
  if (update && update.operation.status !== "running") message = update.operation.message;
  const output = update?.output.map((entry) => entry.text).join("") ?? "";

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="provider-update-run">
      <View style={settingsStyles.rowContent}>
        <View style={styles.trailing}>
          {status === "running" ? (
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          ) : null}
          <Text style={settingsStyles.rowTitle} testID="provider-update-status">
            {title}
          </Text>
        </View>
        {message ? (
          <Text style={settingsStyles.rowHint} selectable testID="provider-update-message">
            {message}
          </Text>
        ) : null}
        {output ? (
          <ScrollView
            ref={scroll}
            style={styles.output}
            contentContainerStyle={styles.outputContent}
            onContentSizeChange={followOutput}
          >
            {update?.truncated ? (
              <Text style={styles.outputNote}>
                {t("settings.providers.installation.outputTruncated")}
              </Text>
            ) : null}
            <Text
              style={styles.outputText}
              selectable
              dataSet={CODE_SURFACE_DATASET}
              testID="provider-update-output"
            >
              {output}
            </Text>
          </ScrollView>
        ) : null}
        {status === "failed" && updateUrl ? (
          <View style={styles.link}>
            <ExternalLink
              href={updateUrl}
              label={t("settings.providers.installation.updateInstructions")}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  output: {
    maxHeight: 240,
    marginTop: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
  },
  outputContent: {
    padding: theme.spacing[3],
  },
  outputText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  outputNote: {
    marginBottom: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
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
  availableVersion: {
    marginTop: theme.spacing[1],
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
  },
  link: {
    flexDirection: "row",
    marginTop: theme.spacing[1],
  },
}));
