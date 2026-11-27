import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Globe, Monitor, Network, Terminal, Waypoints } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { TailscaleIcon } from "@/components/icons/tailscale-icon";
import {
  describeActiveConnection,
  describeHostConnection,
  type HostConnectionKind,
} from "@/hosts/connection-display";
import { HostIconGlyph } from "@/hosts/host-icon-glyph";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { formatLatency } from "@/utils/latency";

export { HostIconGlyph };

const CONNECTION_GLYPH_SIZE = 11;

const ThemedMonitor = withUnistyles(Monitor);
const ThemedTerminal = withUnistyles(Terminal);
const ThemedGlobe = withUnistyles(Globe);
const ThemedNetwork = withUnistyles(Network);
const ThemedWaypoints = withUnistyles(Waypoints);
const ThemedTailscale = withUnistyles(TailscaleIcon);

const extraMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

function ConnectionKindGlyph({ kind }: { kind: HostConnectionKind }): ReactElement {
  switch (kind) {
    case "local":
      return (
        <ThemedMonitor
          size={CONNECTION_GLYPH_SIZE}
          style={styles.linkIcon}
          uniProps={extraMutedMapping}
        />
      );
    case "relay":
      return (
        <ThemedGlobe
          size={CONNECTION_GLYPH_SIZE}
          style={styles.linkIcon}
          uniProps={extraMutedMapping}
        />
      );
    case "tailscale":
      return <ThemedTailscale size={CONNECTION_GLYPH_SIZE} uniProps={extraMutedMapping} />;
    case "ssh":
      return (
        <ThemedTerminal
          size={CONNECTION_GLYPH_SIZE}
          style={styles.linkIcon}
          uniProps={extraMutedMapping}
        />
      );
    case "routed":
      return (
        <ThemedWaypoints
          size={CONNECTION_GLYPH_SIZE}
          style={styles.linkIcon}
          uniProps={extraMutedMapping}
        />
      );
    case "direct":
      return (
        <ThemedNetwork
          size={CONNECTION_GLYPH_SIZE}
          style={styles.linkIcon}
          uniProps={extraMutedMapping}
        />
      );
  }
}

function resolvePreferredConnection(host: HostProfile | undefined) {
  if (!host || host.connections.length === 0) return null;
  if (host.preferredConnectionId) {
    const preferred = host.connections.find(
      (connection) => connection.id === host.preferredConnectionId,
    );
    if (preferred) return preferred;
  }
  return host.connections[0] ?? null;
}

export function HostConnectionLine({ serverId }: { serverId: string }): ReactElement | null {
  const { t } = useTranslation();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const localServerId = useLocalDaemonServerId();
  const hosts = useHosts();
  const activeConnection = snapshot?.activeConnection ?? null;
  const hostProfile = useMemo(
    () => hosts.find((candidate) => candidate.serverId === serverId),
    [hosts, serverId],
  );
  const fallbackConnection = useMemo(
    () => (activeConnection ? null : resolvePreferredConnection(hostProfile)),
    [activeConnection, hostProfile],
  );

  const described = useMemo(() => {
    const options = { isLocalHost: serverId === localServerId };
    if (activeConnection) {
      return describeActiveConnection(activeConnection, options);
    }
    if (fallbackConnection) {
      return describeHostConnection(fallbackConnection, options);
    }
    return null;
  }, [activeConnection, fallbackConnection, localServerId, serverId]);

  if (!described) {
    return null;
  }

  const endpoint =
    described.kind === "routed" && described.endpoint
      ? (hosts.find((host) => host.serverId === described.endpoint)?.label ?? described.endpoint)
      : described.endpoint;

  return (
    <View style={styles.connectionRow}>
      <View style={styles.linkIconSlot}>
        <ConnectionKindGlyph kind={described.kind} />
      </View>
      <Text style={styles.connectionKind} numberOfLines={1}>
        {t(`settings.host.connectionKinds.${described.kind}`)}
      </Text>
      {endpoint ? (
        <Text style={styles.connectionEndpoint} numberOfLines={1}>
          {endpoint}
        </Text>
      ) : null}
    </View>
  );
}

export function HostLatencyLabel({ serverId }: { serverId: string }): ReactElement | null {
  const { t } = useTranslation();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const status = snapshot?.connectionStatus;
  const activeConnectionId = snapshot?.activeConnectionId;
  const activeProbe = activeConnectionId
    ? snapshot?.probeByConnectionId.get(activeConnectionId)
    : undefined;
  const latencyMs =
    status === "online" && activeProbe?.status === "available" ? activeProbe.latencyMs : null;

  if (latencyMs !== null) {
    return (
      <Text style={styles.latency} numberOfLines={1}>
        {formatLatency(latencyMs)}
      </Text>
    );
  }

  if (status === "offline" || status === "error") {
    return (
      <Text style={styles.statusText} numberOfLines={1}>
        {t("common.connectionStatus.offline")}
      </Text>
    );
  }

  return null;
}

const styles = StyleSheet.create((theme) => ({
  connectionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  // Matches the 14px host icon width on the row above so connection text aligns on the same rail.
  linkIconSlot: {
    width: 14,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  linkIcon: {
    flexShrink: 0,
  },
  connectionKind: {
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  connectionEndpoint: {
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    color: theme.colors.foregroundExtraMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  latency: {
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  statusText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    color: theme.colors.foregroundExtraMuted,
    flexShrink: 0,
  },
}));
