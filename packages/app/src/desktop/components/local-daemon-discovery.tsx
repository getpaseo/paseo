import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import {
  discoverLocalDaemons,
  type DiscoveredLocalDaemon,
} from "@/desktop/daemon/discover-local-daemons";

export function LocalDaemonDiscovery({
  onSelect,
  disabled,
}: {
  onSelect: (daemon: DiscoveredLocalDaemon) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const {
    data = [],
    isFetching,
    error,
    refetch,
  } = useFetchQuery({
    queryKey: ["local-daemon-discovery"],
    queryFn: discoverLocalDaemons,
    dataShape: "list",
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const handleRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  let hint: string | null = null;
  if (isFetching) hint = t("pairing.localDiscovery.searching");
  else if (error) hint = t("pairing.localDiscovery.failed");
  else if (data.length === 0) hint = t("pairing.localDiscovery.empty");
  return (
    <View style={styles.container} testID="local-daemon-discovery">
      <View style={styles.heading}>
        <Text style={styles.title}>{t("pairing.localDiscovery.title")}</Text>
        <Button variant="ghost" size="sm" disabled={disabled || isFetching} onPress={handleRefresh}>
          {t("pairing.localDiscovery.refresh")}
        </Button>
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {data.map((daemon) => (
        <LocalDaemonDiscoveryRow
          key={`${daemon.host}:${daemon.port}`}
          daemon={daemon}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

function LocalDaemonDiscoveryRow({
  daemon,
  disabled,
  onSelect,
}: {
  daemon: DiscoveredLocalDaemon;
  disabled: boolean;
  onSelect: (daemon: DiscoveredLocalDaemon) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(daemon), [daemon, onSelect]);
  return (
    <Button
      variant="outline"
      disabled={disabled}
      testID={`local-daemon-${daemon.host}:${daemon.port}`}
      onPress={handleSelect}
    >
      {`${daemon.hostname ? `${daemon.hostname} · ` : ""}${daemon.host}:${daemon.port}${daemon.passwordRequired ? ` · ${t("pairing.localDiscovery.passwordRequired")}` : ""}`}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2] },
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
