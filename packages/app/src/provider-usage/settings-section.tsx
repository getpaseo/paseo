import { Plus, RefreshCw } from "@/components/icons/ui-icons";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { AddAccountSheet } from "./add-account-sheet";
import { addAccountCopy, providerUsageCopy } from "./copy";
import { ProviderUsageList } from "./list";
import type { ProviderUsageView } from "./types";

export function ProviderUsageSettingsSection({
  serverId,
  view,
  onRefresh,
}: {
  serverId: string;
  view: ProviderUsageView;
  onRefresh: () => void;
}) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  const [adding, setAdding] = useState(false);
  const handleOpenAdd = useCallback(() => setAdding(true), []);
  const handleCloseAdd = useCallback(() => {
    setAdding(false);
    onRefresh();
  }, [onRefresh]);

  const refreshButton = useMemo(
    () => (
      <View style={styles.trailing}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Plus}
          onPress={handleOpenAdd}
          testID="provider-usage-add-account"
        >
          {addAccountCopy.add}
        </Button>
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
      </View>
    ),
    [busy, handleOpenAdd, onRefresh],
  );

  return (
    <SettingsSection
      title={providerUsageCopy.title}
      testID="provider-usage-card"
      trailing={refreshButton}
    >
      <ProviderUsageBody view={view} onRefresh={onRefresh} />
      <AddAccountSheet serverId={serverId} visible={adding} onClose={handleCloseAdd} />
    </SettingsSection>
  );
}

function ProviderUsageBody({
  view,
  onRefresh,
}: {
  view: ProviderUsageView;
  onRefresh: () => void;
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
      <Alert
        size="sm"
        variant="error"
        title={providerUsageCopy.errorTitle}
        description={view.message}
      >
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

  return <ProviderUsageList providers={view.payload.providers} />;
}

const styles = StyleSheet.create((theme) => ({
  trailing: { flexDirection: "row", gap: theme.spacing[1] },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
