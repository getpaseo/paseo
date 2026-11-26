import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { sendBuildAlert } from "../shared/alerts";

export function AlertScreen({ params, theme, layout }: PluginScreenProps) {
  const triggerAlert = useRpc(sendBuildAlert);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  const buildId = params.buildId ?? "none";
  const notificationId = params.notificationId ?? "none";
  const summary = params.summary ?? "No build alert selected.";

  const handleSendSampleAlert = useCallback(async () => {
    const result = await triggerAlert({
      buildId: "101",
      title: "Build #101 failed",
      body: "Integration suite timed out on main",
    });
    setLastStatus(result.status);
  }, [triggerAlert]);

  const styles = useMemo(
    () => ({
      container: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      },
      heading: {
        fontSize: 18,
        fontWeight: "600" as const,
        color: theme.colors.foreground,
      },
      body: {
        fontSize: 14,
        color: theme.colors.foreground,
      },
      meta: {
        fontSize: 13,
        color: theme.colors.foregroundMuted,
      },
      button: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      buttonLabel: {
        fontSize: 14,
        fontWeight: "500" as const,
        color: theme.colors.foreground,
      },
    }),
    [layout.compact, theme.colors],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>{`Build alert #${buildId}`}</Text>
      <Text style={styles.body}>{summary}</Text>
      <Text style={styles.meta}>{`Notification ID: ${notificationId}`}</Text>
      {lastStatus ? <Text style={styles.meta}>{`Last send status: ${lastStatus}`}</Text> : null}
      <Pressable accessibilityRole="button" style={styles.button} onPress={handleSendSampleAlert}>
        <Text style={styles.buttonLabel}>Send sample build alert</Text>
      </Pressable>
    </View>
  );
}
