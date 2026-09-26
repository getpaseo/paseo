import { RefreshCw } from "lucide-react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { usageCopy } from "./copy";
import { UsageList } from "./list";
import type { UsageView } from "./types";

export function UsageSection({
  title,
  view,
  onRefresh,
  testID,
}: {
  title: string;
  view: UsageView;
  onRefresh: () => void;
  testID?: string;
}) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);

  const refreshButton = useMemo(
    () =>
      view.kind === "unavailable" ? null : (
        <Button
          variant="ghost"
          size="sm"
          leftIcon={RefreshCw}
          loading={busy}
          onPress={onRefresh}
          accessibilityLabel={usageCopy.refresh}
        >
          {busy ? usageCopy.refreshing : usageCopy.refresh}
        </Button>
      ),
    [busy, onRefresh, view.kind],
  );

  return (
    <SettingsSection title={title} testID={testID} trailing={refreshButton}>
      <UsageBody view={view} onRefresh={onRefresh} />
    </SettingsSection>
  );
}

function UsageBody({ view, onRefresh }: { view: UsageView; onRefresh: () => void }) {
  if (view.kind === "unavailable") {
    return <UsageMessage text={view.message} />;
  }

  if (view.kind === "loading") {
    return <UsageMessage text={usageCopy.loading} />;
  }

  if (view.kind === "error") {
    return (
      <Alert size="sm" variant="error" title={usageCopy.errorTitle} description={view.message}>
        <Button variant="outline" size="sm" onPress={onRefresh}>
          {usageCopy.retry}
        </Button>
      </Alert>
    );
  }

  if (view.reports.length === 0) {
    return <UsageMessage text={usageCopy.empty} />;
  }

  return <UsageList reports={view.reports} />;
}

export function UsageMessage({ text }: { text: string }) {
  return (
    <View style={[settingsStyles.card, styles.emptyCard]}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
