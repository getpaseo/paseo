import { RefreshCw } from "lucide-react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { providerUsageCopy } from "./copy";
import { ProviderUsageList } from "./list";
import { useProviderUsagePreferences } from "./preferences";
import type { ProviderUsagePercentageDisplay, ProviderUsageView } from "./types";

const percentageDisplayOptions = [
  { value: "used", label: providerUsageCopy.percentageUsed },
  { value: "remaining", label: providerUsageCopy.percentageRemaining },
] satisfies SegmentedControlOption<ProviderUsagePercentageDisplay>[];

export function ProviderUsageSettingsSection({
  view,
  onRefresh,
}: {
  view: ProviderUsageView;
  onRefresh: () => void;
}) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  const percentageDisplay = useProviderUsagePreferences((state) => state.percentageDisplay);
  const setPercentageDisplay = useProviderUsagePreferences((state) => state.setPercentageDisplay);

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
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{providerUsageCopy.percentageDisplayLabel}</Text>
          </View>
          <SegmentedControl
            options={percentageDisplayOptions}
            value={percentageDisplay}
            onValueChange={setPercentageDisplay}
            size="sm"
            testID="provider-usage-percentage-display"
          />
        </View>
      </View>
      <ProviderUsageBody view={view} onRefresh={onRefresh} percentageDisplay={percentageDisplay} />
    </SettingsSection>
  );
}

function ProviderUsageBody({
  view,
  onRefresh,
  percentageDisplay,
}: {
  view: ProviderUsageView;
  onRefresh: () => void;
  percentageDisplay: ProviderUsagePercentageDisplay;
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

  if (view.payload.providers.length === 0) {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{providerUsageCopy.empty}</Text>
      </View>
    );
  }

  return (
    <ProviderUsageList providers={view.payload.providers} percentageDisplay={percentageDisplay} />
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
