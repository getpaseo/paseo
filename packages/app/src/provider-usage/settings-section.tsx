import { RefreshCw } from "lucide-react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { providerUsageCopy } from "./copy";
import { ProviderUsageList } from "./list";
import type { ProviderUsageView } from "./types";
import { filterVisibleProviders } from "./visibility";

export function ProviderUsageSettingsSection({
  view,
  onRefresh,
  hiddenProviderIds = [],
}: {
  view: ProviderUsageView;
  onRefresh: () => void;
  hiddenProviderIds?: readonly string[];
}) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);

  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={RefreshCw}
        loading={busy}
        onPress={onRefresh}
        accessibilityLabel={providerUsageCopy.refresh}
      >
        {busy ? providerUsageCopy.refreshing : providerUsageCopy.refresh}
      </Button>
    ),
    [busy, onRefresh],
  );

  return (
    <SettingsSection
      title={providerUsageCopy.title}
      testID="provider-usage-card"
      trailing={refreshButton}
    >
      <ProviderUsageBody view={view} onRefresh={onRefresh} hiddenProviderIds={hiddenProviderIds} />
    </SettingsSection>
  );
}

function ProviderUsageBody({
  view,
  onRefresh,
  hiddenProviderIds,
}: {
  view: ProviderUsageView;
  onRefresh: () => void;
  hiddenProviderIds: readonly string[];
}) {
  if (view.kind === "loading") {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{providerUsageCopy.loading}</Text>
      </View>
    );
  }

  if (view.kind === "error") {
    return (
      <Alert variant="error" title={providerUsageCopy.errorTitle} description={view.message}>
        <Button variant="outline" size="sm" onPress={onRefresh}>
          {providerUsageCopy.retry}
        </Button>
      </Alert>
    );
  }

  const visibleProviders = filterVisibleProviders(view.payload.providers, hiddenProviderIds);
  if (visibleProviders.length === 0) {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>
          {view.payload.providers.length > 0
            ? providerUsageCopy.allHidden
            : providerUsageCopy.empty}
        </Text>
      </View>
    );
  }

  return <ProviderUsageList providers={visibleProviders} />;
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
