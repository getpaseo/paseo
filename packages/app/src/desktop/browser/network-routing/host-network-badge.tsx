import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HostBadge } from "@/hosts/host-badge";
import type { HostColor, HostIcon } from "@/hosts/appearance";

interface HostNetworkBadgeProps {
  isRouted: boolean;
  serverId: string;
  hostLabel: string;
  color: HostColor;
  icon: HostIcon;
}

export function HostNetworkBadge({
  isRouted,
  serverId,
  hostLabel,
  color,
  icon,
}: HostNetworkBadgeProps) {
  const { t } = useTranslation();
  const badge = useMemo(
    () => ({
      serverId,
      label: t("browserRouting.viaHost", { host: hostLabel }),
      color,
      icon,
      showLabel: true,
    }),
    [serverId, hostLabel, color, icon, t],
  );
  if (!isRouted) return null;
  return (
    <View style={styles.wrap}>
      <HostBadge badge={badge} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The URL field beside the badge is `flex: 1` from a zero basis, so it never has a
  // width of its own for the badge to yield to: a long host name would push the URL out
  // of the bar before the badge shrank at all. Cap the badge instead; the label inside
  // it truncates with an ellipsis once the cap is reached.
  wrap: {
    flexDirection: "row",
    maxWidth: "33%",
  },
});
