import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ProviderInstallation,
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

export function ProviderInstallationSection({
  state,
  updates,
}: {
  state: ProviderInstallationState;
  updates: ProviderUpdatesState;
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
          <UpdatesRow updates={updates} updateUrl={state.installation?.updateUrl} />
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
}: {
  updates: Exclude<ProviderUpdatesState, { status: "hidden" }>;
  updateUrl: string | undefined;
}) {
  const { t } = useTranslation();
  const handleUpdate = useCallback(() => {
    if (updateUrl) void openExternalUrl(updateUrl);
  }, [updateUrl]);

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
        {updateUrl ? (
          <Button variant="outline" onPress={handleUpdate}>
            {t("settings.providers.installation.updateInstructions")}
          </Button>
        ) : null}
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
