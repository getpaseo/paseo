import { useTranslation } from "react-i18next";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import type { UsageDisplay } from "./display";
import { useUsageSetting } from "./setting";
import { UsageControls } from "./controls";
import { UsageList } from "./list";
import type { UsageView } from "./types";

export function UsageSection({
  serverId,
  title,
  view,
  display,
  onRefresh,
  testID,
}: {
  serverId: string;
  title: string;
  view: UsageView;
  display: UsageDisplay;
  onRefresh: () => void;
  testID?: string;
}) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const openOptions = useCallback(() => setOptionsOpen(true), []);
  const trailing = useMemo(
    () => (
      <UsageControls
        serverId={serverId}
        view={view}
        display={display}
        onRefresh={onRefresh}
        optionsOpen={optionsOpen}
        onOptionsOpenChange={setOptionsOpen}
      />
    ),
    [display, onRefresh, optionsOpen, serverId, view],
  );

  return (
    <SettingsSection title={title} testID={testID} trailing={trailing}>
      <UsageBody
        serverId={serverId}
        view={view}
        display={display}
        onRefresh={onRefresh}
        onOpenSources={openOptions}
      />
    </SettingsSection>
  );
}

/** What a host's usage view shows: its reports, or why there are none. */
export function UsageBody({
  serverId,
  view,
  display,
  onRefresh,
  onOpenSources,
}: {
  serverId: string;
  view: UsageView;
  display: UsageDisplay;
  onRefresh: () => void;
  onOpenSources?: () => void;
}) {
  const { t } = useTranslation();
  const setting = useUsageSetting(serverId);
  const visibleReports = useMemo(
    () =>
      view.kind === "ready"
        ? display.arrange(view.reports).filter((entry) => display.isCardOn(entry))
        : [],
    [display, view],
  );
  if (view.kind === "off")
    return (
      <View>
        <UsageMessage text={view.message} />
        {setting.error ? <Alert variant="error" description={setting.error.message} /> : null}
        <Button onPress={setting.turnOn}>{t("providerUsage.turnOn")}</Button>
      </View>
    );
  if (view.kind === "unavailable") {
    return <UsageMessage text={view.message} />;
  }

  if (view.kind === "loading") {
    return <UsageMessage text={t("providerUsage.loading")} />;
  }

  if (view.kind === "error") {
    return (
      <Alert
        size="sm"
        variant="error"
        title={t("providerUsage.errorTitle")}
        description={view.message}
      >
        <Button variant="outline" onPress={onRefresh}>
          {t("providerUsage.retry")}
        </Button>
      </Alert>
    );
  }

  let content: React.ReactNode;
  if (view.reports.length === 0) {
    content = <UsageMessage text={t("providerUsage.empty")} />;
  } else if (visibleReports.length === 0) {
    content = (
      <View style={[settingsStyles.card, styles.emptyCard]} testID="usage-all-hidden">
        <Text style={styles.emptyText}>{t("providerUsage.allSourcesHidden")}</Text>
        {onOpenSources ? (
          <Button variant="outline" onPress={onOpenSources} testID="usage-choose-sources">
            {t("providerUsage.chooseSources")}
          </Button>
        ) : null}
      </View>
    );
  } else {
    content = <UsageList serverId={serverId} reports={visibleReports} display={display} />;
  }

  return (
    <View style={styles.reports}>
      {view.refreshFailed ? (
        <Alert size="sm" variant="error" title={t("providerUsage.refreshFailed")} />
      ) : null}
      {content}
    </View>
  );
}

export function UsageMessage({ text }: { text: string }) {
  return (
    <View style={[settingsStyles.card, styles.emptyCard]}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  reports: { gap: theme.spacing[3] },
  emptyCard: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
