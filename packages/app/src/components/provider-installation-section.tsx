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

/**
 * What the provider's update check knows. `hidden` until the provider is installed. A null
 * `updateCheck` means the provider cannot check; the check only informs, and never gates Update.
 */
export type ProviderUpdatesState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "ready"; updateCheck: ProviderInstallationUpdateCheck | null }
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
  const installation = state.status === "ready" ? state.installation : null;
  const run = action ? readUpdateRun(action) : null;

  return (
    <View style={settingsStyles.section} testID="provider-installation">
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>
          {t("settings.providers.installation.title")}
        </Text>
      </View>
      <View style={settingsStyles.card}>
        <InstallationRow state={state} />
        {installation?.inspection?.status === "installed" ? (
          <UpdatesRow
            updates={updates}
            updateUrl={installation.updateUrl}
            action={installation.canUpdate ? action : undefined}
          />
        ) : null}
        {run ? <UpdateRunRow run={run} updateUrl={installation?.updateUrl} /> : null}
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

/**
 * The update the provider offers, with what its check knows beside it. Update, or the update
 * instructions, stay in place whatever the check says: an answer can be an hour old, and the
 * provider's own updater reports when there is nothing newer.
 */
function UpdatesRow({
  updates,
  updateUrl,
  action,
}: {
  updates: ProviderUpdatesState;
  updateUrl: string | undefined;
  /** Present when the provider runs its own update. */
  action: ProviderUpdateAction | undefined;
}) {
  const { t } = useTranslation();
  const updateCheck = updates.status === "ready" ? updates.updateCheck : null;
  const offersUpdate = Boolean(action || updateUrl);
  // With nothing to offer, the row waits until the check has something to say.
  if (!offersUpdate && !updateCheck && updates.status !== "error") return null;

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="provider-updates">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {updateCheck?.status === "available"
            ? t("settings.providers.installation.updateAvailable")
            : t("settings.providers.installation.updates")}
        </Text>
        <UpdateCheckSummary updates={updates} />
      </View>
      <UpdateButton action={action} updateUrl={updateUrl} />
    </View>
  );
}

function UpdateCheckSummary({ updates }: { updates: ProviderUpdatesState }) {
  const { t } = useTranslation();
  if (updates.status === "loading") {
    return (
      <View style={styles.trailing}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={settingsStyles.rowHint}>{t("settings.providers.installation.checking")}</Text>
      </View>
    );
  }
  if (updates.status === "hidden") return null;
  const updateCheck = updates.status === "ready" ? updates.updateCheck : null;
  if (updates.status === "ready" && !updateCheck) return null;
  if (updateCheck?.status === "current") {
    return (
      <Text style={settingsStyles.rowHint} testID="provider-updates-current">
        {t("settings.providers.installation.upToDate")}
      </Text>
    );
  }
  if (updateCheck?.status === "available") {
    // Versions are opaque; drop repeats so each one keys its own line.
    const versions = [...new Set(updateCheck.versions ?? [])];
    return (
      <>
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
      </>
    );
  }
  // A check that threw, timed out or could not tell is never shown as up to date.
  const message = updates.status === "error" ? updates.message : updateCheck?.message;
  return (
    <>
      <Text style={settingsStyles.rowHint} testID="provider-updates-unchecked">
        {t("settings.providers.installation.updatesFailed")}
      </Text>
      {message ? <Text style={settingsStyles.rowHint}>{message}</Text> : null}
    </>
  );
}

function isUpdating(action: ProviderUpdateAction): boolean {
  return action.starting || action.current?.operation.status === "running";
}

/**
 * Update runs the provider's updater; without one, the provider's update guide opens. The button
 * carries the update's progress from the tap until it settles.
 */
function UpdateButton({
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
        loading={isUpdating(action)}
        testID="provider-update-start"
      >
        {isUpdating(action)
          ? t("settings.providers.installation.updating")
          : t("settings.providers.installation.update")}
      </Button>
    );
  if (!updateUrl) return null;
  return (
    <Button variant="outline" onPress={handleOpenInstructions}>
      {t("settings.providers.installation.updateInstructions")}
    </Button>
  );
}

type UpdateRun =
  | { status: "running"; update: ProviderInstallationUpdate }
  | { status: "succeeded" | "failed"; update: ProviderInstallationUpdate }
  | { status: "refused"; message: string };

/**
 * What the update's row shows, or null for nothing. While the update starts or runs, Update shows
 * its progress and the row holds only the output so far. A new start clears the previous result.
 */
function readUpdateRun(action: ProviderUpdateAction): UpdateRun | null {
  const update = action.current;
  if (isUpdating(action)) {
    return update?.operation.status === "running" && update.output.length > 0
      ? { status: "running", update }
      : null;
  }
  if (action.startError) return { status: "refused", message: action.startError };
  if (!update || update.operation.status === "running") return null;
  return { status: update.operation.status, update };
}

function UpdateRunRow({ run, updateUrl }: { run: UpdateRun; updateUrl: string | undefined }) {
  const { t } = useTranslation();
  const scroll = useRef<ScrollView>(null);
  const followOutput = useCallback(() => scroll.current?.scrollToEnd({ animated: false }), []);
  const update = run.status === "refused" ? null : run.update;
  const output = update?.output.map((entry) => entry.text).join("") ?? "";
  let message: string | undefined;
  if (run.status === "refused") message = run.message;
  else if (run.update.operation.status !== "running") message = run.update.operation.message;

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="provider-update-run">
      <View style={settingsStyles.rowContent}>
        {run.status === "running" ? null : (
          <Text style={settingsStyles.rowTitle} testID="provider-update-status">
            {run.status === "succeeded"
              ? t("settings.providers.installation.updated")
              : t("settings.providers.installation.updateFailed")}
          </Text>
        )}
        {message ? (
          <Text style={settingsStyles.rowHint} selectable testID="provider-update-message">
            {message}
          </Text>
        ) : null}
        {output ? (
          <ScrollView
            ref={scroll}
            style={
              run.status === "running" ? styles.output : [styles.output, styles.outputAfterResult]
            }
            contentContainerStyle={styles.outputContent}
            onContentSizeChange={followOutput}
            // Android scrolls a ScrollView nested in the provider sheet only with this flag.
            nestedScrollEnabled
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
        {(run.status === "failed" || run.status === "refused") && updateUrl ? (
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
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
  },
  outputAfterResult: {
    marginTop: theme.spacing[2],
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
